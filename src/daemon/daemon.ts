import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, fstatSync, mkdirSync, openSync, readSync, rmSync } from "node:fs";
import net from "node:net";
import { isAbsolute, join } from "node:path";
import {
  ACK_TIMEOUT_MS, AsenqError, CONTROL_ACTIONS, GRACE_MS, INBOUND, KINDS, MAX_ATTEMPTS, MAX_LINE, MAX_TEXT, NAME_RE, PROBE_MS,
  PROTOCOL, RESERVED, RETRY_MS, slug,
  type ControlAction, type FileReference, type Harness, type HistoryPageRequest, type Inbound, type Kind, type MsgStatus, type PositionedEvent,
  type Push, type ReadMutationResult, type ReadScope, type Req, type SendResult, type TailEvent,
} from "../shared/protocol.js";
import { renderInbound } from "../shared/render.js";
import type { Db } from "../shared/sqlite.js";
import { version } from "../shared/version.js";
import { claudeFrame, parseEnvelopeReply, probe, replyAddr, writeLine } from "./claude.js";
import { claudeLineage } from "./claude-lineage.js";
import { Store, toStored, toWire, type MsgRow, type SessionRow } from "./store.js";

export type DaemonOpts = {
  socket: string;
  db: Db;
  replyDir: string;
  now?: () => number;
  ackTimeoutMs?: number;
  graceMs?: number;
  /** Overrides the sweep (10 s), retry (30 s) and Claude probe (30 s) intervals. */
  tickMs?: number;
  /** Run the retry/sweep/probe/prune timers. Tests drive them by hand instead. */
  timers?: boolean;
  envelope?: boolean;
  historyDays?: number;
  log?: (line: string) => void;
};

type Params = Record<string, unknown>;
type Result = Record<string, unknown>;

/** Who is sending: a bound session, the human CLI user, or the daemon itself. */
type Sender = { kind: "agent"; session: SessionRow } | { kind: "human" } | { kind: "asenq" };

type Ack = { ok: boolean; reason?: string };
type LineageDecision = { identityId?: string; reason?: string };
type Inflight = { conn: Conn; timer: NodeJS.Timeout; settle(a: Ack): void };

const DUP_WINDOW_MS = 30_000;
const BUCKET_SIZE = 30;
const BUCKET_REFILL_PER_MS = 0.5 / 1000;
const QUEUE_LIMIT = 50;
const POLL_BUDGET = 9_000;
const CLAUDE_IDLE_MS = 12 * 3600_000;
const HARNESSES: Harness[] = ["claude", "opencode", "omp"];

class Conn {
  buf = "";
  /** Sessions whose delivery channel is this connection (OpenCode/omp; several per OpenCode plugin). */
  bound = new Set<string>();
  /** Claude MCP connection: sender identity only, never a delivery channel. */
  attached?: string;
  tail = false;
  constructor(readonly sock: net.Socket) {}
  write(obj: unknown): void {
    if (!this.sock.destroyed) this.sock.write(JSON.stringify(obj) + "\n");
  }
}

function str(p: Params, k: string, required: true): string;
function str(p: Params, k: string, required?: false): string | undefined;
function str(p: Params, k: string, required = false): string | undefined {
  const v = p[k];
  if (v === undefined || v === null) {
    if (required) throw new AsenqError("bad_request", `missing "${k}"`);
    return undefined;
  }
  if (typeof v !== "string") throw new AsenqError("bad_request", `"${k}" must be a string`);
  return v;
}

function limitParam(p: Params, def: number, max: number): number {
  const v = p.limit;
  if (v === undefined || v === null) return def;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) throw new AsenqError("bad_request", '"limit" must be a positive integer');
  return Math.min(v, max);
}

function integerParam(p: Params, key: string, required = false): number | undefined {
  const value = p[key];
  if (value === undefined || value === null) {
    if (required) throw new AsenqError("bad_request", `missing "${key}"`);
    return undefined;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new AsenqError("bad_request", `"${key}" must be a non-negative safe integer`);
  }
  return value;
}

function readScope(p: Params): ReadScope {
  const scope = str(p, "scope", true);
  if (scope === "session") return { scope, sessionId: str(p, "sessionId", true) };
  if (scope === "channel") return { scope, channel: str(p, "channel", true) };
  throw new AsenqError("bad_request", 'scope must be "session" or "channel"');
}

const newId = (prefix: string): string => prefix + randomBytes(6).toString("hex");

/** Open nonblocking so a FIFO cannot stall the daemon; inspect and read the same descriptor. */
function hashFile(path: string): { sha256: string; size: number } {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) throw new Error("not a regular file");
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let size = 0;
    let bytes: number;
    while ((bytes = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytes));
      size += bytes;
    }
    return { sha256: hash.digest("hex"), size };
  } finally {
    closeSync(fd);
  }
}

function fileParam(value: unknown): FileReference | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AsenqError("bad_request", "file must contain path and summary");
  }
  const p = value as Params;
  const path = str(p, "path", true);
  const summary = str(p, "summary", true);
  if (!isAbsolute(path)) throw new AsenqError("bad_request", "file path must be absolute");
  if (!summary.trim() || summary.length > 500) {
    throw new AsenqError("bad_request", "file summary must be nonempty and at most 500 characters");
  }
  try {
    return { path, summary, ...hashFile(path) };
  } catch (error) {
    throw new AsenqError("bad_request", `cannot read regular file "${path}": ${error instanceof Error ? error.message : String(error)}`);
  }
}

export class Daemon {
  readonly store: Store;
  private server?: net.Server;
  private conns = new Set<Conn>();
  private delivery = new Map<string, Conn>();
  private inflight = new Map<string, Inflight>();
  private flushing = new Set<string>();
  /** Messages with a delivery attempt in progress; timers and sends must not write them twice. */
  private delivering = new Set<string>();
  private dupSeen = new Map<string, number>();
  private buckets = new Map<string, { tokens: number; at: number }>();
  private lastSeen = new Map<string, number>();
  private replyServers = new Map<string, net.Server>();
  private envelopeIds = new Map<string, string>();
  private intervals: NodeJS.Timeout[] = [];
  private closing = false;
  private readonly now: () => number;
  private readonly ackTimeoutMs: number;
  private readonly graceMs: number;
  private readonly startedAt: number;

  constructor(private opts: DaemonOpts) {
    this.store = new Store(opts.db);
    this.now = opts.now ?? Date.now;
    this.ackTimeoutMs = opts.ackTimeoutMs ?? ACK_TIMEOUT_MS;
    this.graceMs = opts.graceMs ?? GRACE_MS;
    this.startedAt = this.now();
    // Adapters get the grace window to reconnect after a daemon restart; Claude rows are probed instead.
    for (const row of this.store.db.all<SessionRow>(
      "SELECT * FROM sessions WHERE harness!='claude' AND state='live'",
    )) this.markGone(row);
  }

  private log(line: string): void {
    (this.opts.log ?? ((l: string) => process.stderr.write(l + "\n")))(`${new Date().toISOString()} ${line}`);
  }

  async listen(): Promise<void> {
    rmSync(this.opts.socket, { force: true });
    const server = net.createServer((sock) => this.accept(sock));
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    server.once("error", reject);
    server.listen(this.opts.socket, () => { server.removeListener("error", reject); resolve(); });
    await promise;
    chmodSync(this.opts.socket, 0o600);
    this.server = server;
    if (this.opts.timers !== false) {
      this.intervals.push(
        setInterval(() => this.sweep(), this.opts.tickMs ?? 10_000),
        setInterval(() => void this.retry(), this.opts.tickMs ?? RETRY_MS),
        setInterval(() => void this.probeClaude(), this.opts.tickMs ?? PROBE_MS),
        setInterval(() => this.prune(), 3600_000),
      );
      this.prune();
      void this.probeClaude();
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    for (const t of this.intervals) clearInterval(t);
    for (const f of this.inflight.values()) clearTimeout(f.timer);
    for (const s of this.replyServers.values()) s.close();
    for (const c of this.conns) c.sock.destroy();
    const server = this.server;
    if (server) {
      const { promise, resolve } = Promise.withResolvers<void>();
      server.close(() => resolve());
      await promise;
    }
    rmSync(this.opts.socket, { force: true });
  }

  // ---------------------------------------------------------------- connections

  private accept(sock: net.Socket): void {
    const c = new Conn(sock);
    this.conns.add(c);
    sock.setEncoding("utf8");
    sock.on("error", () => {});
    sock.on("close", () => this.dropConn(c));
    sock.on("data", (chunk: string) => {
      c.buf += chunk;
      let i: number;
      while ((i = c.buf.indexOf("\n")) >= 0) {
        const line = c.buf.slice(0, i);
        c.buf = c.buf.slice(i + 1);
        if (line.length > MAX_LINE) return this.tooLarge(c);
        if (line.trim()) void this.onLine(c, line);
      }
      if (c.buf.length > MAX_LINE) this.tooLarge(c);
    });
  }

  private tooLarge(c: Conn): void {
    c.write({ id: 0, ok: false, error: { code: "too_large", message: "request line exceeds 1 MiB" } });
    c.buf = "";
    c.sock.end();
  }

  private dropConn(c: Conn): void {
    this.conns.delete(c);
    if (this.closing) return; // sessions stay as they are; the next daemon start marks them gone
    for (const [msgId, f] of this.inflight) if (f.conn === c) f.settle({ ok: false, reason: "connection closed" });
    for (const id of c.bound) {
      if (this.delivery.get(id) !== c) continue;
      this.delivery.delete(id);
      const row = this.store.session(id);
      if (row?.state === "live") this.markGone(row);
    }
  }

  private async onLine(c: Conn, line: string): Promise<void> {
    if (this.closing) return;
    let req: Req;
    try {
      req = JSON.parse(line);
      if (!req || typeof req !== "object" || typeof req.op !== "string") throw new Error();
    } catch {
      return c.write({ id: 0, ok: false, error: { code: "bad_request", message: "invalid request line" } });
    }
    try {
      const result = await this.handle(c, req);
      c.write({ ...result, id: req.id, ok: true });
    } catch (e) {
      if (e instanceof AsenqError) return c.write({ id: req.id, ok: false, error: { code: e.code, message: e.message } });
      this.log(`internal error in ${req.op}: ${e instanceof Error ? e.stack : String(e)}`);
      c.write({ id: req.id, ok: false, error: { code: "internal", message: e instanceof Error ? e.message : String(e) } });
    }
  }

  /** Sender identity comes from the connection binding, never from request fields. */
  private sender(c: Conn, p: Params): Sender {
    const as = str(p, "as");
    let id: string | undefined;
    if (as !== undefined) {
      if (!c.bound.has(as)) throw new AsenqError("bad_request", `session ${as} is not bound to this connection`);
      id = as;
    } else if (c.bound.size > 1) {
      throw new AsenqError("bad_request", '"as" is required on connections hosting several sessions');
    } else if (c.bound.size === 1) {
      id = [...c.bound][0];
    } else if (c.attached) {
      id = c.attached;
    }
    if (id === undefined) return { kind: "human" };
    const session = this.store.session(id);
    if (!session) throw new AsenqError("not_registered", "this session is no longer registered on asenq");
    return { kind: "agent", session };
  }

  private requireHuman(s: Sender, what: string): void {
    if (s.kind !== "human") throw new AsenqError("bad_request", `only the user (asenq CLI) can ${what}`);
  }

  private async handle(c: Conn, p: Req): Promise<Result> {
    switch (p.op) {
      case "hello":
        return { protocol: PROTOCOL, version: version() };
      case "register":
        return this.opRegister(c, p);
      case "claude_hook":
        return this.opClaudeHook(p);
      case "claude_attach": {
        let row = this.store.sessionByClaudeId(str(p, "sessionId", true));
        if (!row) throw new AsenqError("no_session", "this Claude session is not registered yet (SessionStart hook missing? run: asenq doctor)");
        row = this.reconcileClaudeLineage(row, str(p, "transcriptPath"));
        c.attached = row.id;
        return { session: { id: row.id, name: row.name } };
      }
      case "unregister": {
        const s = this.sender(c, p);
        if (s.kind !== "agent") throw new AsenqError("not_registered", "no session bound to this connection");
        c.bound.delete(s.session.id);
        this.removeSession(s.session);
        return {};
      }
      case "rename":
        return this.opRename(c, p);
      case "set_inbound": {
        this.requireHuman(this.sender(c, p), "change inbound policy");
        const mode = str(p, "mode", true) as Inbound;
        if (!INBOUND.includes(mode)) throw new AsenqError("bad_request", "mode must be accept, hold or refuse");
        const row = this.mustSession(str(p, "name", true));
        this.store.db.run("UPDATE sessions SET inbound=? WHERE id=?", mode, row.id);
        this.store.setIdentityInbound(row.id, mode);
        this.emitSession("updated", { ...row, inbound: mode });
        return {};
      }
      case "set_role": {
        if (c.bound.size > 0 || c.attached) {
          throw new AsenqError("not_permitted", "only the user (asenq CLI) can change session roles");
        }
        const role = p.role;
        if (role !== null && role !== "orchestrator" && role !== "worker") {
          throw new AsenqError("bad_request", "role must be orchestrator, worker or null");
        }
        const row = this.mustSession(str(p, "name", true));
        this.store.setIdentityRole(row.id, role);
        this.emitSession("updated", row);
        return {};
      }
      case "send":
        return { results: await this.send(this.sender(c, p), p) };
      case "file_check":
        return this.opFileCheck(this.sender(c, p), p);
      case "ack": {
        const msgId = str(p, "msgId", true);
        const ack: Ack = { ok: p.ok === true, reason: str(p, "reason") };
        const f = this.inflight.get(msgId);
        if (f) f.settle(ack);
        else if (ack.ok && this.store.msg(msgId)?.status === "queued") this.setStatus(msgId, "delivered");
        return {};
      }
      case "sync":
        this.requireHuman(this.sender(c, p), "synchronize human state");
        return this.opSync(c);
      case "replay":
        this.requireHuman(this.sender(c, p), "replay human state");
        return this.opReplay(p);
      case "history_page":
        this.requireHuman(this.sender(c, p), "read retained history");
        return this.opHistoryPage(p);
      case "inbox_summaries":
        this.requireHuman(this.sender(c, p), "read inbox summaries");
        return { summaries: this.store.inboxSummaries() };
      case "recent_events":
        this.requireHuman(this.sender(c, p), "read recent events");
        return {
          events: this.store.recentEvents(limitParam(p, 200, 200)),
          watermark: this.store.eventWatermark(),
          eventFloor: this.store.eventFloor(),
        };
      case "read_state":
        this.requireHuman(this.sender(c, p), "read human markers");
        return this.opReadState(p);
      case "mark_read":
        this.requireHuman(this.sender(c, p), "mark human streams read");
        return this.opMarkRead(p);
      case "mark_unread":
        this.requireHuman(this.sender(c, p), "mark human streams unread");
        return this.opMarkUnread(p);
      case "inbox":
        return this.opInbox(this.sender(c, p), p);
      case "thread_read":
        return this.opThreadRead(this.sender(c, p), p);
      case "list": {
        const s = this.sender(c, p);
        const me = s.kind === "agent" ? s.session.id : undefined;
        return {
          sessions: this.store.sessions().map((r) => ({
            name: r.name, harness: r.harness, cwd: r.cwd, state: r.state, inbound: r.inbound, you: r.id === me,
            role: this.store.identity(r.id)?.role ?? null,
          })),
        };
      }
      case "channel_send":
        return this.opChannelSend(this.sender(c, p), p);
      case "channel_read": {
        const channel = str(p, "channel", true);
        const rows = this.store.db.all<MsgRow>(
          "SELECT * FROM (SELECT * FROM messages WHERE channel=? ORDER BY ord DESC LIMIT ?) ORDER BY ord",
          channel, limitParam(p, 20, 100));
        return { messages: rows.map(toWire) };
      }
      case "channel_list":
        return { channels: this.store.channelSummaries() };
      case "held": {
        const name = str(p, "name");
        const rows = name
          ? this.store.db.all<MsgRow>("SELECT * FROM messages WHERE status='held' AND to_name=? ORDER BY ord", name)
          : this.store.db.all<MsgRow>("SELECT * FROM messages WHERE status='held' ORDER BY ord");
        return { messages: rows.map((r) => ({ ...toWire(r), status: r.status })) };
      }
      case "release": {
        this.requireHuman(this.sender(c, p), "release held messages");
        const row = this.mustHeld(str(p, "msgId", true));
        this.setStatus(row.id, "queued");
        return { status: await this.deliver(row.id) };
      }
      case "drop": {
        this.requireHuman(this.sender(c, p), "drop held messages");
        const row = this.mustHeld(str(p, "msgId", true));
        this.setStatus(row.id, "dropped", "dropped by user");
        return {};
      }
      case "tail":
        c.tail = true;
        return {};
      case "log":
        return this.opLog(p);
      default:
        throw new AsenqError("bad_request", `unknown op "${p.op}"`);
    }
  }

  private directScope(s: Sender): { sql: string; params: (string | number)[] } {
    return s.kind === "agent"
      ? {
        sql: "channel IS NULL AND (from_session=? OR (to_session=? AND status IN ('delivered','queued')))",
        params: [s.session.id, s.session.id],
      }
      : { sql: "channel IS NULL AND (from_name='human' OR to_name='human')", params: [] };
  }

  private opFileCheck(s: Sender, p: Params): Result {
    const scope = this.directScope(s);
    const row = this.store.db.get<MsgRow>(
      `SELECT * FROM messages WHERE id=? AND ${scope.sql}`, str(p, "msgId", true), ...scope.params,
    );
    if (!row?.file) throw new AsenqError("bad_request", "no retained file reference for the caller");
    const file = toWire(row).file!;
    try {
      return { status: hashFile(file.path).sha256 === file.sha256 ? "match" : "changed" };
    } catch {
      return { status: "missing" };
    }
  }

  private messageCursor(
    p: Params, key: "since" | "before", s: Sender,
  ): { sql: string; params: (string | number)[] } {
    const value = p[key];
    if (value === undefined || value === null) return { sql: "", params: [] };
    const comparison = key === "since" ? ">" : "<";
    let timestamp: number | undefined;
    if (typeof value === "number") timestamp = value;
    else if (typeof value === "string" && /^\d+$/.test(value)) timestamp = Number(value);
    else if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)) timestamp = Date.parse(value);
    if (timestamp !== undefined && Number.isSafeInteger(timestamp) && timestamp >= 0) {
      return { sql: ` AND created_at${comparison}?`, params: [timestamp] };
    }
    if (timestamp === undefined && typeof value === "string") {
      const scope = this.directScope(s);
      const row = this.store.db.get<{ ord: number }>(
        `SELECT ord FROM messages WHERE id=? AND ${scope.sql}`, value, ...scope.params,
      );
      if (row) return { sql: ` AND ord${comparison}?`, params: [row.ord] };
    }
    throw new AsenqError("bad_request", `"${key}" must be a timestamp or a retained direct message id for the caller`);
  }

  private opThreadRead(s: Sender, p: Params): Result {
    const thread = str(p, "thread", true);
    const scope = this.directScope(s);
    const since = this.messageCursor(p, "since", s);
    const rows = this.store.db.all<MsgRow>(
      `SELECT * FROM messages WHERE ${scope.sql} AND thread=?${since.sql} ORDER BY ord`,
      ...scope.params, thread, ...since.params,
    );
    return { messages: rows.map(toStored) };
  }
  private unreadInbox(s: Sender): { sql: string; params: (string | number)[] } {
    if (s.kind === "agent") {
      return {
        sql: " AND status='delivered' AND delivery_seq>(SELECT inbox_position FROM session_identities WHERE id=?)",
        params: [s.session.id],
      };
    }
    return {
      sql: ` AND from_session IS NOT NULL AND (
        ord>COALESCE((SELECT position FROM human_read_positions WHERE scope='session' AND stream_key=messages.from_session),0)
        OR ord=(SELECT reminder FROM human_read_positions WHERE scope='session' AND stream_key=messages.from_session))`,
      params: [],
    };
  }

  private opInbox(s: Sender, p: Params): Result {
    const id = str(p, "msgId");
    if (id !== undefined) {
      const scope = this.directScope(s);
      const row = this.store.db.get<MsgRow>(
        `SELECT * FROM messages WHERE id=? AND ${scope.sql}`, id, ...scope.params,
      );
      if (!row) throw new AsenqError("bad_request", '"msgId" must be a retained direct message id for the caller');
      return { messages: [toStored(row)], hasMore: false };
    }
    const limit = limitParam(p, 20, 200);
    const budget = integerParam(p, "max_chars");
    if (budget === 0) throw new AsenqError("bad_request", '"max_chars" must be a positive integer');
    if (p.unread_only !== undefined && p.unread_only !== null && typeof p.unread_only !== "boolean") {
      throw new AsenqError("bad_request", '"unread_only" must be a boolean');
    }
    const thread = str(p, "thread");
    const from = str(p, "from");
    const since = this.messageCursor(p, "since", s);
    const before = this.messageCursor(p, "before", s);
    let sql = s.kind === "agent"
      ? "channel IS NULL AND to_session=? AND status IN ('delivered','queued')"
      : "channel IS NULL AND to_name='human'";
    const params: (string | number)[] = s.kind === "agent" ? [s.session.id] : [];
    if (thread !== undefined) {
      sql += " AND thread=?";
      params.push(thread);
    }
    if (from !== undefined) {
      const session = this.store.sessionByName(from);
      sql += session ? " AND from_session=?" : " AND from_name=?";
      params.push(session?.id ?? from);
    }
    sql += since.sql + before.sql;
    params.push(...since.params, ...before.params);
    const unread = p.unread_only === true;
    if (unread) {
      const filter = this.unreadInbox(s);
      sql += filter.sql;
      params.push(...filter.params);
    }
    const advances = s.kind === "agent" && unread && thread === undefined && from === undefined
      && since.sql === "" && before.sql === "";
    const rows = this.store.db.all<MsgRow>(
      `SELECT * FROM messages WHERE ${sql} ORDER BY ${advances ? "delivery_seq ASC" : "ord DESC"} LIMIT ?`,
      ...params, limit + 1,
    );
    const messages = [];
    let chars = 0;
    for (const row of rows) {
      if (messages.length === limit) break;
      const message = toStored(row);
      if (budget !== undefined) {
        const size = JSON.stringify(message).length + 2;
        if (messages.length > 0 && chars + size > budget) break;
        chars += size;
      }
      messages.push(message);
    }
    if (advances && s.kind === "agent" && messages.length > 0) {
      this.store.db.run(
        "UPDATE session_identities SET inbox_position=? WHERE id=?", rows[messages.length - 1].delivery_seq!, s.session.id,
      );
    }
    return { messages, hasMore: rows.length > messages.length };
  }


  private validateReadScope(scope: ReadScope): void {
    if (scope.scope === "session") {
      if (!this.store.identity(scope.sessionId)) {
        throw new AsenqError("no_session", `no retained session ${scope.sessionId}`);
      }
      return;
    }
    if (!NAME_RE.test(scope.channel)) {
      throw new AsenqError("invalid_name", `invalid channel name "${scope.channel}"`);
    }
    const exists = this.store.db.get<{ one: number }>(
      `SELECT 1 AS one FROM messages WHERE channel=?
       UNION ALL SELECT 1 AS one FROM human_read_positions WHERE scope='channel' AND stream_key=? LIMIT 1`,
      scope.channel, scope.channel,
    );
    if (!exists) throw new AsenqError("bad_request", `no retained channel ${scope.channel}`);
  }

  private opSync(c: Conn): Result {
    c.tail = true;
    const sessions = this.store.identities();
    const channels = this.store.channelSummaries();
    for (const session of sessions) this.store.ensureRead({ scope: "session", sessionId: session.id });
    for (const channel of channels) this.store.ensureRead({ scope: "channel", channel: channel.name });
    return {
      watermark: this.store.eventWatermark(),
      eventFloor: this.store.eventFloor(),
      sessions,
      channels,
      readStates: this.store.readStates(),
      sessionLastOrders: this.store.sessionLastOrders(),
    };
  }

  private opReplay(p: Params): Result {
    const position = integerParam(p, "position", true)!;
    const limit = limitParam(p, 500, 1000);
    const eventFloor = this.store.eventFloor();
    const watermark = this.store.eventWatermark();
    const rows = this.store.eventsAfter(Math.max(position, eventFloor), limit + 1);
    return {
      events: rows.slice(0, limit),
      gap: position < eventFloor,
      hasMore: rows.length > limit,
      eventFloor,
      watermark,
    };
  }

  private opHistoryPage(p: Params): Result {
    const scope = str(p, "scope", true) as HistoryPageRequest["scope"];
    const before = integerParam(p, "before") ?? Number.MAX_SAFE_INTEGER;
    const limit = limitParam(p, 50, 200);
    let rows: MsgRow[];
    if (scope === "session") {
      const sessionId = str(p, "sessionId", true);
      if (!this.store.identity(sessionId)) throw new AsenqError("no_session", `no retained session ${sessionId}`);
      rows = this.store.db.all<MsgRow>(
        `SELECT * FROM messages WHERE channel IS NULL AND ord<?
         AND (from_session=? OR to_session=?) ORDER BY ord DESC LIMIT ?`,
        before, sessionId, sessionId, limit + 1,
      );
    } else if (scope === "inbox") {
      rows = this.store.db.all<MsgRow>(
        "SELECT * FROM messages WHERE channel IS NULL AND to_name='human' AND ord<? ORDER BY ord DESC LIMIT ?",
        before, limit + 1,
      );
    } else if (scope === "channel") {
      const channel = str(p, "channel", true);
      if (!NAME_RE.test(channel)) throw new AsenqError("invalid_name", `invalid channel name "${channel}"`);
      rows = this.store.db.all<MsgRow>(
        "SELECT * FROM messages WHERE channel=? AND ord<? ORDER BY ord DESC LIMIT ?",
        channel, before, limit + 1,
      );
    } else {
      throw new AsenqError("bad_request", 'scope must be "session", "inbox" or "channel"');
    }
    const hasMore = rows.length > limit;
    if (hasMore) rows.length = limit;
    rows.reverse();
    return { messages: rows.map(toStored), hasMore };
  }

  private opReadState(p: Params): Result {
    if (p.scope === undefined || p.scope === null) return { states: this.store.readStates() };
    const scope = readScope(p);
    this.validateReadScope(scope);
    return { state: this.store.ensureRead(scope) };
  }

  private opMarkRead(p: Params): ReadMutationResult {
    const scope = readScope(p);
    this.validateReadScope(scope);
    const through = integerParam(p, "through", true)!;
    const expectedVersion = integerParam(p, "expectedVersion", true)!;
    const current = this.store.ensureRead(scope);
    if (current.version !== expectedVersion) return { applied: false, state: current };
    if (through !== 0 && !this.store.isEligible(scope, through)) {
      throw new AsenqError("bad_request", `"through" is not an eligible retained message in this stream`);
    }
    const position = Math.max(current.position, through);
    const reminder = current.reminder !== null && current.reminder <= through ? null : current.reminder;
    if (position === current.position && reminder === current.reminder) return { applied: true, state: current };
    this.store.updateRead(scope, position, reminder, current.version + 1);
    const state = this.store.ensureRead(scope);
    this.emit({ type: "read", state });
    return { applied: true, state };
  }

  private opMarkUnread(p: Params): ReadMutationResult {
    const scope = readScope(p);
    this.validateReadScope(scope);
    const expectedVersion = integerParam(p, "expectedVersion");
    const current = this.store.ensureRead(scope);
    if (expectedVersion !== undefined && current.version !== expectedVersion) {
      return { applied: false, state: current };
    }
    const reminder = this.store.latestEligible(scope) || null;
    if (reminder === current.reminder) return { applied: true, state: current };
    this.store.updateRead(scope, current.position, reminder, current.version + 1);
    const state = this.store.ensureRead(scope);
    this.emit({ type: "read", state });
    return { applied: true, state };
  }

  private mustSession(name: string): SessionRow {
    const row = this.store.sessionByName(name);
    if (!row) throw this.unknownTarget(name);
    return row;
  }

  private mustHeld(msgId: string): MsgRow {
    const row = this.store.msg(msgId);
    if (!row) throw new AsenqError("bad_request", `no message ${msgId}`);
    if (row.status !== "held") throw new AsenqError("bad_request", `message ${msgId} is ${row.status}, not held`);
    return row;
  }

  private unknownTarget(name: string): AsenqError {
    const live = this.store.live().map((r) => r.name).join(", ") || "(none)";
    return new AsenqError("unknown_target", `unknown session "${name}"; live: ${live}`);
  }

  // ---------------------------------------------------------------- sessions

  private publish(positioned: PositionedEvent): void {
    const push: Push = { push: "event", ...positioned };
    for (const c of this.conns) if (c.tail) c.write(push);
  }

  private emit(event: TailEvent): void {
    this.publish(this.store.appendEvent(event, this.now()));
  }

  private emitSession(
    action: "registered" | "renamed" | "gone" | "removed" | "updated",
    row: SessionRow,
    oldName?: string,
    reason?: string,
  ): void {
    const session = this.store.identity(row.id) ?? this.store.syncIdentity(row);
    this.emit({
      type: "session",
      action,
      name: session.name,
      harness: row.harness,
      ...(session.cwd ? { cwd: session.cwd } : {}),
      ...(oldName ? { oldName } : {}),
      ...(reason ? { reason } : {}),
      session,
    });
  }

  /** Revives the durable identity for a harness id; names never establish identity. */
  private upsertSession(
    harness: Harness, key: string, name: string | undefined, cwd: string | undefined, seed = key, identityId?: string,
    reason?: string,
  ): SessionRow {
    const identity = identityId ? this.store.identity(identityId)
      : harness === "claude" ? undefined : this.store.identityByHarnessId(harness, key);
    const existing = identity && this.store.session(identity.id);
    if (existing) {
      const row = this.store.transaction(() => {
        this.store.db.run(
          "UPDATE sessions SET key=?, state='live', gone_at=NULL, cwd=COALESCE(?, cwd) WHERE id=?",
          key, cwd ?? null, existing.id,
        );
        const updated = this.store.session(existing.id)!;
        this.store.syncIdentity(updated);
        return updated;
      });
      if (existing.state !== "live") this.emitSession("registered", row, undefined, reason);
      else if (cwd !== undefined && cwd !== existing.cwd) this.emitSession("updated", row);
      return row;
    }
    let base = identity?.name ?? slug(name ?? "");
    if (!base || RESERVED.includes(base) || !NAME_RE.test(base)) {
      base = `${harness}-${seed.toLowerCase().replace(/[^a-z0-9]/g, "").slice(-6)}`;
    }
    let chosen = base;
    for (let n = 2; this.store.sessionByName(chosen); n++) {
      const suffix = `-${n}`;
      chosen = base.slice(0, 40 - suffix.length).replace(/-+$/, "") + suffix;
    }
    const id = identity?.id ?? newId("s_");
    const row = this.store.transaction(() => {
      this.store.db.run(
        `INSERT INTO sessions(id,harness,key,name,cwd,inbound,state,claude_session_ids,created_at)
         VALUES(?,?,?,?,?,?,'live',?,?)`,
        id, harness, key, chosen, cwd ?? identity?.cwd ?? null, identity?.inbound ?? "accept",
        harness === "claude" ? JSON.stringify(this.store.claudeIds(id)) : "[]",
        identity?.createdAt ?? this.now(),
      );
      const revived = this.store.session(id)!;
      this.store.syncIdentity(revived);
      if (identity && chosen !== identity.name) this.store.renameIdentity(id, identity.name, chosen);
      return revived;
    });
    if (identity && chosen !== identity.name) this.emitSession("renamed", row, identity.name);
    this.emitSession("registered", row, undefined, reason);
    return row;
  }

  private opRegister(c: Conn, p: Params): Result {
    const harness = str(p, "harness", true) as Harness;
    if (!HARNESSES.includes(harness)) throw new AsenqError("bad_request", `unknown harness "${harness}"`);
    const row = this.upsertSession(harness, str(p, "key", true), str(p, "name"), str(p, "cwd"));
    const previous = this.delivery.get(row.id);
    if (previous && previous !== c) previous.bound.delete(row.id);
    c.bound.add(row.id);
    this.delivery.set(row.id, c);
    // After the response is written, so the adapter knows the binding before pushes arrive.
    setImmediate(() => void this.flush(row.id));
    return { session: { id: row.id, name: row.name } };
  }

  private markGone(row: SessionRow): void {
    const goneAt = this.now();
    this.store.db.run("UPDATE sessions SET state='gone', gone_at=? WHERE id=?", goneAt, row.id);
    const gone = { ...row, state: "gone" as const, gone_at: goneAt };
    this.store.syncIdentity(gone);
    this.delivery.delete(row.id);
    this.emitSession("gone", gone);
  }

  /** Removes the transport while retaining identity and pending delivery for a later resume. */
  private removeSession(row: SessionRow): void {
    this.store.setIdentityState(row.id, "removed", this.now());
    this.store.db.run("DELETE FROM sessions WHERE id=?", row.id);
    this.delivery.delete(row.id);
    this.lastSeen.delete(row.id);
    for (const c of this.conns) {
      c.bound.delete(row.id);
      if (c.attached === row.id) c.attached = undefined;
    }
    const rs = this.replyServers.get(row.id);
    if (rs) {
      rs.close();
      this.replyServers.delete(row.id);
      rmSync(join(this.opts.replyDir, row.id + ".sock"), { force: true });
    }
    this.emitSession("removed", row);
  }

  private opRename(c: Conn, p: Params): Result {
    const s = this.sender(c, p);
    let target: SessionRow;
    if (s.kind === "agent") target = s.session;
    else target = this.mustSession(str(p, "from", true));
    const wanted = str(p, "name", true);
    const name = slug(wanted);
    if (!name || !NAME_RE.test(name) || RESERVED.includes(name)) {
      throw new AsenqError("invalid_name", `invalid name "${wanted}" (lowercase letters, digits, - and _; not ${RESERVED.join("/")})`);
    }
    if (name === target.name) return { name };
    if (this.store.sessionByName(name)) throw new AsenqError("name_taken", `name "${name}" is taken`);
    this.store.db.run("UPDATE sessions SET name=? WHERE id=?", name, target.id);
    this.store.renameIdentity(target.id, target.name, name);
    this.emitSession("renamed", { ...target, name }, target.name);
    return { name };
  }

  // ---------------------------------------------------------------- claude

  private classifyClaudeLineage(fingerprints: string[], exclude?: string): LineageDecision {
    const candidates = this.store.claudeLineageCandidates(fingerprints, exclude);
    if (candidates.some((identity) => identity.state === "live")) return {};
    if (candidates.length === 1) return { identityId: candidates[0].id };
    if (candidates.length > 1) {
      const reason = `ambiguous Claude lineage candidates: ${candidates.map((identity) => identity.id).join(", ")}`;
      this.log(reason);
      return { reason };
    }
    return {};
  }

  private reconcileClaudeLineage(row: SessionRow, transcriptPath?: string): SessionRow {
    const path = transcriptPath ?? row.claude_transcript_path;
    const changedPath = transcriptPath !== undefined && transcriptPath !== row.claude_transcript_path;
    if (changedPath) this.store.db.run("UPDATE sessions SET claude_transcript_path=? WHERE id=?", path, row.id);
    if (row.claude_lineage_state === 2 && !changedPath) return row;
    const fingerprints = claudeLineage(path, row.claude_source === "resume");
    if (fingerprints.length === 0) {
      if (changedPath && row.claude_lineage_state === 2) {
        this.store.db.run("UPDATE sessions SET claude_lineage_state=1 WHERE id=?", row.id);
      }
      return this.store.session(row.id)!;
    }
    const decision: LineageDecision = row.claude_lineage_state === 0
      ? this.classifyClaudeLineage(fingerprints, row.id) : {};
    if (decision.identityId) {
      const provisional = this.store.identity(row.id)!;
      const delivery = this.delivery.get(row.id);
      if (delivery) {
        this.delivery.delete(row.id);
        this.delivery.set(decision.identityId, delivery);
      }
      for (const conn of this.conns) {
        if (conn.bound.delete(row.id)) conn.bound.add(decision.identityId);
        if (conn.attached === row.id) conn.attached = decision.identityId;
      }
      const transfer = this.store.mergeClaudeIdentity(row.id, decision.identityId);
      const ancestor = this.upsertSession("claude", row.key, undefined, row.cwd ?? undefined, row.key, decision.identityId);
      this.store.db.run(
        `UPDATE sessions SET claude_socket=?,claude_session_ids=?,claude_transcript_path=?,claude_source=?,claude_lineage_state=2 WHERE id=?`,
        row.claude_socket, JSON.stringify(this.store.claudeIds(ancestor.id)), path, row.claude_source, ancestor.id,
      );
      this.store.recordClaudeLineage(ancestor.id, fingerprints);
      this.lastSeen.delete(row.id);
      this.lastSeen.set(ancestor.id, this.now());
      const replyServer = this.replyServers.get(row.id);
      if (replyServer) {
        replyServer.close();
        this.replyServers.delete(row.id);
        rmSync(join(this.opts.replyDir, row.id + ".sock"), { force: true });
        this.ensureReplyServer(ancestor.id);
      }
      if (transfer.droppedReminder !== undefined) {
        this.log(`Claude lineage merge ${row.id} into ${ancestor.id}: dropped provisional reminder ${transfer.droppedReminder}; kept ancestor reminder`);
      }
      this.emit({
        type: "session", action: "removed", name: provisional.name, harness: "claude",
        reason: `merged into ${ancestor.name}`, session: { ...provisional, state: "removed", removedAt: this.now() },
      });
      this.emit({ type: "read", state: this.store.ensureRead({ scope: "session", sessionId: ancestor.id }) });
      setImmediate(() => void this.flush(ancestor.id));
      return this.store.session(ancestor.id)!;
    }
    this.store.recordClaudeLineage(row.id, fingerprints);
    this.store.db.run("UPDATE sessions SET claude_lineage_state=2 WHERE id=?", row.id);
    if (decision.reason) this.emitSession("registered", row, undefined, decision.reason);
    return this.store.session(row.id)!;
  }

  private async opClaudeHook(p: Params): Promise<Result> {
    const event = str(p, "event", true);
    const sessionId = str(p, "sessionId", true);
    if (event === "start") {
      const socket = str(p, "socket") ?? null;
      const key = str(p, "key", true);
      const known = this.store.identityByHarnessId("claude", sessionId, "session")
        ?? this.store.sessionByKey("claude", key);
      const transcriptPath = str(p, "transcriptPath") ?? null;
      const source = str(p, "source") ?? null;
      const fingerprints = claudeLineage(transcriptPath, source === "resume");
      const decision: LineageDecision = known ? { identityId: known.id } : this.classifyClaudeLineage(fingerprints);
      const row = this.upsertSession(
        "claude", key, str(p, "name"), str(p, "cwd"), sessionId, decision.identityId, decision.reason,
      );
      const ids = JSON.parse(row.claude_session_ids) as string[];
      if (!ids.includes(sessionId)) ids.push(sessionId);
      const state = fingerprints.length === 0 ? (known ? 1 : 0) : 2;
      this.store.transaction(() => {
        this.store.db.run(
          `UPDATE sessions SET claude_socket=?,claude_session_ids=?,claude_transcript_path=?,claude_source=?,claude_lineage_state=? WHERE id=?`,
          socket, JSON.stringify(ids), transcriptPath, source, state, row.id,
        );
        this.store.recordClaudeLineage(row.id, fingerprints);
        this.store.syncIdentity({ ...row, claude_socket: socket, claude_session_ids: JSON.stringify(ids) });
      });
      this.lastSeen.set(row.id, this.now());
      setImmediate(() => void this.flush(row.id));
      return { session: { id: row.id, name: row.name } };
    }
    let row = this.store.sessionByClaudeId(sessionId);
    if (event === "end") {
      if (row) this.removeSession(row);
      return {};
    }
    if (event === "poll" || event === "reconcile") {
      if (row) {
        row = this.reconcileClaudeLineage(row, str(p, "transcriptPath"));
        this.lastSeen.set(row.id, this.now());
      }
      if (event === "reconcile") return row ? { session: { id: row.id, name: row.name } } : {};
    }
    if (event === "poll") {
      if (!row) return { texts: [] };
      if (row.claude_socket) return { texts: [] };
      this.lastSeen.set(row.id, this.now());
      const texts: string[] = [];
      let total = 0;
      const role = this.store.identity(row.id)?.role ?? undefined;
      for (const m of this.store.queuedFor(row.id)) {
        let text = renderInbound(toWire(m), role);
        if (texts.length === 0 && text.length > POLL_BUDGET) {
          text = text.slice(0, POLL_BUDGET) + `… (truncated; full text: asenq log --id ${m.id})`;
        } else if (total + text.length > POLL_BUDGET) break;
        texts.push(text);
        total += text.length;
        this.setStatus(m.id, "delivered");
      }
      return { texts };
    }
    throw new AsenqError("bad_request", `unknown claude_hook event "${event}"`);
  }

  /** Reply listener for envelope senders: Claude answers a cross-session message by writing here. */
  private ensureReplyServer(senderId: string): void {
    if (this.replyServers.has(senderId)) return;
    mkdirSync(this.opts.replyDir, { recursive: true, mode: 0o700 });
    const path = join(this.opts.replyDir, senderId + ".sock");
    rmSync(path, { force: true });
    const server = net.createServer((sock) => {
      let buf = "";
      sock.setEncoding("utf8");
      sock.on("error", () => {});
      sock.on("data", (chunk: string) => {
        buf += chunk;
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (line.trim()) void this.onReplyLine(senderId, line);
        }
        if (buf.length > MAX_LINE) sock.destroy();
      });
    });
    server.on("error", (e) => this.log(`reply listener ${path}: ${e.message}`));
    server.listen(path, () => chmodSync(path, 0o600));
    this.replyServers.set(senderId, server);
  }

  private async onReplyLine(targetId: string, line: string): Promise<void> {
    try {
      const frame = JSON.parse(line) as Record<string, unknown>;
      if (frame.type === "control" && frame.action === "peer_message_status") {
        const msgId = this.envelopeIds.get(String(frame.msg_id ?? ""));
        const row = msgId ? this.store.msg(msgId) : undefined;
        const status = frame.status;
        this.log(`peer_message_status ${String(frame.msg_id)} ${String(status)} ${String(frame.reason ?? "")}`);
        if (row && (status === "delivered" || status === "failed" || status === "rejected" ||
          status === "expired" || status === "dropped")) {
          const reason = typeof frame.reason === "string" ? frame.reason : undefined;
          if (row.status !== status || row.reason !== (reason ?? null)) this.setStatus(row.id, status, reason, false);
        }
        return;
      }
      if (frame.type !== "user") return;
      const reply = parseEnvelopeReply(frame);
      const from = reply && this.store.db.get<SessionRow>("SELECT * FROM sessions WHERE claude_socket=?", reply.fromSocket);
      if (!reply || !from) return this.log(`dropped envelope reply to ${targetId}: unknown sender or unparseable frame`);
      const to = targetId === "human" ? "human" : this.store.session(targetId)?.name;
      if (!to) return this.log(`dropped envelope reply: target ${targetId} is gone`);
      await this.send({ kind: "agent", session: from }, { to, text: reply.body });
    } catch (e) {
      this.log(`envelope reply error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ---------------------------------------------------------------- routing

  private senderName(s: Sender): string {
    return s.kind === "agent" ? s.session.name : s.kind;
  }

  async send(s: Sender, p: Params): Promise<SendResult[]> {
    const targetSessionId = str(p, "toSessionId");
    let to = str(p, "to");
    const file = fileParam(p.file);
    const text = str(p, "text") ?? "";
    if (text.length === 0 && !file) throw new AsenqError("bad_request", "text is empty; provide text or a file reference");
    if (text.length > MAX_TEXT) throw new AsenqError("too_large", `text exceeds ${MAX_TEXT} characters`);
    const kind = str(p, "kind") as Kind | undefined;
    if (kind !== undefined && !KINDS.includes(kind)) throw new AsenqError("bad_request", `kind must be one of ${KINDS.join(", ")}`);
    const action = str(p, "action") as ControlAction | undefined;
    if (kind === "control") {
      if (action === undefined || !CONTROL_ACTIONS.includes(action)) {
        throw new AsenqError("bad_request", `control action must be one of ${CONTROL_ACTIONS.join(", ")}`);
      }
    } else if (p.action !== undefined) {
      throw new AsenqError("bad_request", "action is only valid for kind control");
    }
    if (p.done !== undefined && typeof p.done !== "boolean") throw new AsenqError("bad_request", '"done" must be a boolean');
    let stableTarget: SessionRow | undefined;
    if (targetSessionId !== undefined) {
      this.requireHuman(s, "send by stable session identity");
      stableTarget = this.store.session(targetSessionId);
      if (!stableTarget) throw new AsenqError("unknown_target", `session ${targetSessionId} is removed or unknown`);
      if (to !== undefined && to !== stableTarget.name) {
        throw new AsenqError("unknown_target", `session ${targetSessionId} is now named ${stableTarget.name}, not ${to}`);
      }
      to = stableTarget.name;
    }
    if (to === undefined) throw new AsenqError("bad_request", 'missing "to"');
    const now = this.now();
    const base: MsgRow = {
      id: "", from_name: this.senderName(s), from_session: s.kind === "agent" ? s.session.id : null,
      to_name: "", to_session: null, channel: null, text, kind: kind ?? null, action: action ?? null, thread: str(p, "thread") ?? null,
      reply_to: str(p, "replyTo") ?? null, done: p.done === true ? 1 : 0, status: "queued", reason: null, attempts: 0,
      created_at: now, updated_at: now, ord: 0,
      file: file ? JSON.stringify(file) : null,
    };
    if (to === "human") {
      const row = { ...base, id: newId("m_"), to_name: "human", status: "posted" as const };
      this.insert(row);
      return [{ to, msgId: row.id, status: "posted" }];
    }
    let targets: SessionRow[];
    if (stableTarget) {
      targets = [stableTarget];
    } else if (to === "*") {
      const self = s.kind === "agent" ? s.session.id : undefined;
      targets = this.store.live().filter((r) => r.id !== self);
    } else {
      const row = this.store.sessionByName(to);
      if (!row) throw this.unknownTarget(to);
      targets = [row];
    }
    return Promise.all(targets.map((t) => this.routeOne(s, t, { ...base, id: newId("m_"), to_name: t.name, to_session: t.id })));
  }

  private routeOne(s: Sender, target: SessionRow, row: MsgRow): Promise<SendResult> | SendResult {
    const now = row.created_at;
    const finish = (status: MsgStatus, reason?: string): SendResult => {
      this.insert({ ...row, status, reason: reason ?? null });
      return { to: target.name, msgId: row.id, status, ...(reason ? { reason } : {}) };
    };
    if (s.kind === "agent") {
      const bodyKey = row.kind === "control" ? `control\0${row.action}\0${row.text}` : `message\0${row.text}`;
      const dupKey = `${s.session.id}\0${target.id}\0${bodyKey}\0${row.file ?? ""}`;
      const seen = this.dupSeen.get(dupKey);
      if (seen !== undefined && now - seen < DUP_WINDOW_MS) return finish("dropped", "duplicate");
      this.dupSeen.set(dupKey, now);
      const b = this.buckets.get(s.session.id) ?? { tokens: BUCKET_SIZE, at: now };
      b.tokens = Math.min(BUCKET_SIZE, b.tokens + (now - b.at) * BUCKET_REFILL_PER_MS);
      b.at = now;
      this.buckets.set(s.session.id, b);
      if (b.tokens < 1) return finish("rejected", "rate_limited");
      b.tokens -= 1;
      if (this.store.countQueued(target.id) >= QUEUE_LIMIT) return finish("rejected", "queue_full");
    }
    if (target.inbound === "refuse") return finish("rejected", "target refuses messages");
    if (target.inbound === "hold" && s.kind === "agent") return finish("held");
    this.insert({ ...row, status: "queued" });
    if (target.state !== "live") return { to: target.name, msgId: row.id, status: "queued" };
    return this.deliver(row.id).then((status) => {
      const reason = this.store.msg(row.id)?.reason;
      return { to: target.name, msgId: row.id, status, ...(reason && status !== "delivered" ? { reason } : {}) };
    });
  }

  private insert(row: MsgRow): void {
    let scope: ReadScope | undefined;
    if (row.channel && row.from_name !== "human") scope = { scope: "channel", channel: row.channel };
    else if (!row.channel && row.to_name === "human" && row.from_session && this.store.identity(row.from_session)) {
      scope = { scope: "session", sessionId: row.from_session };
    }
    if (scope) this.store.ensureRead(scope);
    const positioned = this.store.transaction(() => {
      this.store.insertMsg(row);
      const event: TailEvent = {
        type: "message",
        msg: toStored(row),
        status: row.status,
        ...(row.reason ? { reason: row.reason } : {}),
      };
      return this.store.appendEvent(event, this.now());
    });
    this.publish(positioned);
    if (scope) this.emit({ type: "read", state: this.store.ensureRead(scope) });
  }

  private setStatus(msgId: string, status: MsgStatus, reason?: string, notify = true): void {
    const positioned = this.store.transaction(() => {
      this.store.db.run("UPDATE messages SET status=?, reason=?, updated_at=? WHERE id=?", status, reason ?? null, this.now(), msgId);
      const row = this.store.msg(msgId);
      if (!row) return undefined;
      this.store.stampDelivery(row);
      const event: TailEvent = {
        type: "message",
        msg: toStored(row),
        status,
        ...(reason ? { reason } : {}),
      };
      return this.store.appendEvent(event, this.now());
    });
    if (!positioned) return;
    this.publish(positioned);
    const row = this.store.msg(msgId)!;
    if (notify && (status === "failed" || status === "expired")) this.notifyFailure(row, reason ?? status);
  }

  /** Tells a live agent sender that its message will never arrive. */
  private notifyFailure(row: MsgRow, reason: string): void {
    if (!row.from_session) return;
    const sender = this.store.session(row.from_session);
    if (!sender || sender.state !== "live") return;
    const notice: MsgRow = {
      id: newId("m_"), from_name: "asenq", from_session: null, to_name: sender.name, to_session: sender.id, channel: null,
      text: `Message ${row.id} to ${row.to_name} was not delivered: ${reason}.`, kind: "status", thread: null,
      reply_to: row.id, done: 0, status: "queued", reason: null, attempts: 0, created_at: this.now(), updated_at: this.now(), ord: 0,
    };
    void Promise.resolve(this.routeOne({ kind: "asenq" }, sender, notice)).catch((e) => this.log(`notice failed: ${String(e)}`));
  }

  private failAttempt(row: MsgRow, reason: string): MsgStatus {
    const attempts = row.attempts + 1;
    this.store.db.run("UPDATE messages SET attempts=?, reason=?, updated_at=? WHERE id=?", attempts, reason, this.now(), row.id);
    if (attempts >= MAX_ATTEMPTS) {
      this.setStatus(row.id, "failed", reason);
      return "failed";
    }
    return "queued";
  }

  /** One delivery attempt for a queued message. Resolves with the message's resulting status. */
  async deliver(msgId: string): Promise<MsgStatus> {
    if (this.delivering.has(msgId)) return "queued";
    this.delivering.add(msgId);
    try {
      return await this.attemptDelivery(msgId);
    } finally {
      this.delivering.delete(msgId);
    }
  }

  private async attemptDelivery(msgId: string): Promise<MsgStatus> {
    const row = this.store.msg(msgId);
    if (!row || row.status !== "queued") return row?.status ?? "failed";
    const target = row.to_session ? this.store.session(row.to_session) : undefined;
    if (!target || target.state !== "live") return "queued";
    const text = renderInbound(toWire(row), this.store.identity(target.id)?.role ?? undefined);

    if (target.harness === "claude") {
      if (!target.claude_socket) return "queued"; // picked up by the hook poll
      let envelope;
      if (this.opts.envelope) {
        const senderId = row.from_session ?? row.from_name;
        if (row.from_name !== "asenq") this.ensureReplyServer(senderId);
        envelope = { replyAddr: replyAddr(this.opts.replyDir, senderId), fromName: row.from_name, uuid: randomUUID() };
        this.envelopeIds.set(envelope.uuid, row.id);
        if (this.envelopeIds.size > 1000) this.envelopeIds.delete(this.envelopeIds.keys().next().value!);
      }
      const r = await writeLine(target.claude_socket, claudeFrame(text, envelope));
      if (r === "ok") {
        if (this.store.msg(row.id)?.status === "queued") this.setStatus(row.id, "delivered");
        return this.store.msg(row.id)?.status ?? "failed";
      }
      if (r === "dead") {
        const cur = this.store.session(target.id);
        if (cur?.state === "live") this.markGone(cur);
        return "queued";
      }
      return this.failAttempt(row, "claude socket error");
    }

    const conn = this.delivery.get(target.id);
    if (!conn) return "queued";
    const { promise, resolve } = Promise.withResolvers<Ack>();
    const settle = (a: Ack): void => {
      const f = this.inflight.get(row.id);
      if (!f) return;
      clearTimeout(f.timer);
      this.inflight.delete(row.id);
      resolve(a);
    };
    const timer = setTimeout(() => settle({ ok: false, reason: "ack timeout" }), this.ackTimeoutMs);
    this.inflight.set(row.id, { conn, timer, settle });
    const push: Push = { push: "deliver", msg: toWire(row), text, session: target.id, key: target.key };
    conn.write(push);
    const ack = await promise;
    if (this.store.msg(row.id)?.status !== "queued") return this.store.msg(row.id)!.status;
    if (ack.ok) {
      this.setStatus(row.id, "delivered");
      return "delivered";
    }
    if (ack.reason === "connection closed") return "queued";
    return this.failAttempt(row, ack.reason ?? "rejected by adapter");
  }

  /** Delivers a session's queued messages oldest first, one at a time. */
  async flush(sessionId: string): Promise<void> {
    if (this.flushing.has(sessionId)) return;
    this.flushing.add(sessionId);
    try {
      for (const m of this.store.queuedFor(sessionId)) {
        if (this.store.session(sessionId)?.state !== "live") break;
        if ((await this.deliver(m.id)) === "queued") break;
      }
    } catch (e) {
      this.log(`flush ${sessionId}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.flushing.delete(sessionId);
    }
  }

  // ---------------------------------------------------------------- timers

  async retry(): Promise<void> {
    for (const s of this.store.live()) {
      if (s.harness === "claude" && !s.claude_socket) continue;
      await this.flush(s.id);
    }
  }

  sweep(): void {
    const now = this.now();
    for (const s of this.store.db.all<SessionRow>("SELECT * FROM sessions WHERE state='gone' AND gone_at<=?", now - this.graceMs)) {
      this.removeSession(s);
    }
    for (const [k, at] of this.dupSeen) if (now - at >= DUP_WINDOW_MS) this.dupSeen.delete(k);
  }

  async probeClaude(): Promise<void> {
    const now = this.now();
    for (const s of this.store.db.all<SessionRow>("SELECT * FROM sessions WHERE harness='claude' AND state='live'")) {
      if (s.claude_socket) {
        if ((await probe(s.claude_socket)) === "dead") {
          const cur = this.store.session(s.id);
          if (cur?.state === "live") this.markGone(cur);
        }
      } else if (now - (this.lastSeen.get(s.id) ?? this.startedAt) > CLAUDE_IDLE_MS) {
        this.removeSession(s);
      }
    }
  }

  prune(): void {
    const cutoff = this.now() - (this.opts.historyDays ?? 7) * 86_400_000;
    const removedMessages = this.store.db.run(
      "DELETE FROM messages WHERE created_at<? AND status NOT IN ('queued','held')",
      cutoff,
    ).changes;
    this.store.pruneEvents(cutoff);
    const reconciliation = this.store.reconcileReads(cutoff);
    for (const state of reconciliation.states) this.emit({ type: "read", state });
    if (removedMessages + reconciliation.removedPositions + reconciliation.removedIdentities > 0) {
      this.emit({ type: "retention" });
    }
  }

  private opChannelSend(s: Sender, p: Params): Result {
    const channel = str(p, "channel", true);
    if (!NAME_RE.test(channel)) throw new AsenqError("invalid_name", `invalid channel name "${channel}"`);
    const text = str(p, "text", true);
    if (text.length === 0) throw new AsenqError("bad_request", "text is empty");
    if (text.length > MAX_TEXT) throw new AsenqError("too_large", `text exceeds ${MAX_TEXT} characters`);
    const now = this.now();
    const row: MsgRow = {
      id: newId("m_"), from_name: this.senderName(s), from_session: s.kind === "agent" ? s.session.id : null,
      to_name: "#" + channel, to_session: null, channel, text, kind: null, thread: null, reply_to: null, done: 0,
      status: "posted", reason: null, attempts: 0, created_at: now, updated_at: now, ord: 0,
    };
    this.insert(row);
    return { msgId: row.id };
  }

  private opLog(p: Params): Result {
    const id = str(p, "msgId");
    const name = str(p, "name");
    const limit = limitParam(p, 50, 1000);
    let rows: MsgRow[];
    if (id) {
      const row = this.store.msg(id);
      if (!row) throw new AsenqError("bad_request", `no message ${id}`);
      rows = [row];
    } else if (name) {
      rows = this.store.db.all<MsgRow>(
        "SELECT * FROM (SELECT * FROM messages WHERE from_name=? OR to_name=? ORDER BY ord DESC LIMIT ?) ORDER BY ord",
        name, name, limit);
    } else {
      rows = this.store.db.all<MsgRow>(
        "SELECT * FROM (SELECT * FROM messages ORDER BY ord DESC LIMIT ?) ORDER BY ord", limit);
    }
    return { messages: rows.map((r) => ({ ...toWire(r), status: r.status, ...(r.reason ? { reason: r.reason } : {}) })) };
  }
}
