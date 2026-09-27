import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import {
  ACK_TIMEOUT_MS, AsenqError, GRACE_MS, INBOUND, KINDS, MAX_ATTEMPTS, MAX_LINE, MAX_TEXT, NAME_RE, PROBE_MS,
  PROTOCOL, RESERVED, RETRY_MS, slug,
  type Harness, type Inbound, type Kind, type MsgStatus, type Push, type Req, type SendResult, type TailEvent,
} from "../shared/protocol.js";
import { renderInbound } from "../shared/render.js";
import type { Db, Param } from "../shared/sqlite.js";
import { version } from "../shared/version.js";
import { claudeFrame, parseEnvelopeReply, probe, replyAddr, writeLine } from "./claude.js";
import { Store, toWire, type MsgRow, type SessionRow } from "./store.js";

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

const newId = (prefix: string): string => prefix + randomBytes(6).toString("hex");

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
    opts.db.run("UPDATE sessions SET state='gone', gone_at=? WHERE harness!='claude' AND state='live'", this.startedAt);
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
        const row = this.store.sessionByClaudeId(str(p, "sessionId", true));
        if (!row) throw new AsenqError("no_session", "this Claude session is not registered yet (SessionStart hook missing? run: asenq doctor)");
        c.attached = row.id;
        return { session: { id: row.id, name: row.name } };
      }
      case "unregister": {
        const s = this.sender(c, p);
        if (s.kind !== "agent") throw new AsenqError("not_registered", "no session bound to this connection");
        c.bound.delete(s.session.id);
        this.removeSession(s.session, "target session closed");
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
        return {};
      }
      case "send":
        return { results: await this.send(this.sender(c, p), p) };
      case "ack": {
        const msgId = str(p, "msgId", true);
        const ack: Ack = { ok: p.ok === true, reason: str(p, "reason") };
        const f = this.inflight.get(msgId);
        if (f) f.settle(ack);
        else if (ack.ok && this.store.msg(msgId)?.status === "queued") this.setStatus(msgId, "delivered");
        return {};
      }
      case "inbox": {
        const s = this.sender(c, p);
        const limit = limitParam(p, 20, 200);
        const rows = s.kind === "agent" && str(p, "name") !== "human"
          ? this.store.db.all<MsgRow>(
            "SELECT * FROM (SELECT *, rowid AS r FROM messages WHERE to_session=? AND status IN ('delivered','queued') ORDER BY created_at DESC, r DESC LIMIT ?) ORDER BY created_at, r",
            s.session.id, limit)
          : this.store.db.all<MsgRow>(
            "SELECT * FROM (SELECT *, rowid AS r FROM messages WHERE to_name='human' AND channel IS NULL ORDER BY created_at DESC, r DESC LIMIT ?) ORDER BY created_at, r",
            limit);
        return { messages: rows.map((r) => ({ ...toWire(r), status: r.status })) };
      }
      case "list": {
        const s = this.sender(c, p);
        const me = s.kind === "agent" ? s.session.id : undefined;
        return {
          sessions: this.store.sessions().map((r) => ({
            name: r.name, harness: r.harness, cwd: r.cwd, state: r.state, inbound: r.inbound, you: r.id === me,
          })),
        };
      }
      case "channel_send":
        return this.opChannelSend(this.sender(c, p), p);
      case "channel_read": {
        const channel = str(p, "channel", true);
        const rows = this.store.db.all<MsgRow>(
          "SELECT * FROM (SELECT *, rowid AS r FROM messages WHERE channel=? ORDER BY created_at DESC, r DESC LIMIT ?) ORDER BY created_at, r",
          channel, limitParam(p, 20, 100));
        return { messages: rows.map(toWire) };
      }
      case "channel_list":
        return {
          channels: this.store.db.all(
            "SELECT channel AS name, count(*) AS count, max(created_at) AS lastAt FROM messages WHERE channel IS NOT NULL GROUP BY channel ORDER BY lastAt DESC"),
        };
      case "held": {
        const name = str(p, "name");
        const rows = name
          ? this.store.db.all<MsgRow>("SELECT * FROM messages WHERE status='held' AND to_name=? ORDER BY created_at", name)
          : this.store.db.all<MsgRow>("SELECT * FROM messages WHERE status='held' ORDER BY created_at");
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

  private emit(event: TailEvent): void {
    const push: Push = { push: "event", event };
    for (const c of this.conns) if (c.tail) c.write(push);
  }

  private emitSession(action: "registered" | "renamed" | "gone" | "removed", r: SessionRow, oldName?: string): void {
    this.emit({ type: "session", action, name: r.name, harness: r.harness, ...(r.cwd ? { cwd: r.cwd } : {}), ...(oldName ? { oldName } : {}) });
  }

  /**
   * Finds or creates the row for (harness, key). New rows take over a gone row with the same
   * name, harness and cwd (a restarted harness); other name collisions get a numeric suffix.
   */
  private upsertSession(harness: Harness, key: string, name: string | undefined, cwd: string | undefined, seed = key): SessionRow {
    const now = this.now();
    const existing = this.store.sessionByKey(harness, key);
    if (existing) {
      this.store.db.run("UPDATE sessions SET state='live', gone_at=NULL, cwd=COALESCE(?, cwd) WHERE id=?", cwd ?? null, existing.id);
      const row = this.store.session(existing.id)!;
      if (existing.state !== "live") this.emitSession("registered", row);
      return row;
    }
    let base = slug(name ?? "");
    if (!base || RESERVED.includes(base) || !NAME_RE.test(base)) {
      base = `${harness}-${seed.toLowerCase().replace(/[^a-z0-9]/g, "").slice(-6)}`;
    }
    const holder = this.store.sessionByName(base);
    if (holder && holder.state === "gone" && holder.harness === harness && (holder.cwd ?? null) === (cwd ?? null)) {
      this.store.db.run("UPDATE sessions SET key=?, state='live', gone_at=NULL WHERE id=?", key, holder.id);
      const row = this.store.session(holder.id)!;
      this.emitSession("registered", row);
      return row;
    }
    let chosen = base;
    for (let n = 2; this.store.sessionByName(chosen); n++) {
      const suffix = `-${n}`;
      chosen = base.slice(0, 40 - suffix.length).replace(/-+$/, "") + suffix;
    }
    const id = newId("s_");
    this.store.db.run(
      "INSERT INTO sessions(id,harness,key,name,cwd,state,created_at) VALUES(?,?,?,?,?,'live',?)",
      id, harness, key, chosen, cwd ?? null, now);
    const row = this.store.session(id)!;
    this.emitSession("registered", row);
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
    this.store.db.run("UPDATE sessions SET state='gone', gone_at=? WHERE id=?", this.now(), row.id);
    this.delivery.delete(row.id);
    this.emitSession("gone", row);
  }

  /** Deletes the session and expires everything still waiting for it. */
  private removeSession(row: SessionRow, reason: string): void {
    const pending = this.store.db.all<MsgRow>(
      "SELECT * FROM messages WHERE to_session=? AND status IN ('queued','held') ORDER BY created_at", row.id);
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
    for (const m of pending) this.setStatus(m.id, "expired", reason);
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
    this.emitSession("renamed", { ...target, name }, target.name);
    return { name };
  }

  // ---------------------------------------------------------------- claude

  private async opClaudeHook(p: Params): Promise<Result> {
    const event = str(p, "event", true);
    const sessionId = str(p, "sessionId", true);
    if (event === "start") {
      const socket = str(p, "socket") ?? null;
      const name = str(p, "name");
      // A dead Claude still holding the requested name should be taken over, not suffixed around.
      const holder = name ? this.store.sessionByName(slug(name)) : undefined;
      if (holder?.harness === "claude" && holder.state === "live" && holder.claude_socket && holder.key !== str(p, "key")) {
        if ((await probe(holder.claude_socket)) === "dead") this.markGone(holder);
      }
      const row = this.upsertSession("claude", str(p, "key", true), name, str(p, "cwd"), sessionId);
      const ids = JSON.parse(row.claude_session_ids) as string[];
      if (!ids.includes(sessionId)) ids.push(sessionId);
      this.store.db.run("UPDATE sessions SET claude_socket=?, claude_session_ids=? WHERE id=?", socket, JSON.stringify(ids), row.id);
      this.lastSeen.set(row.id, this.now());
      setImmediate(() => void this.flush(row.id));
      return { session: { id: row.id, name: row.name } };
    }
    const row = this.store.sessionByClaudeId(sessionId);
    if (event === "end") {
      if (row) this.removeSession(row, "target session ended");
      return {};
    }
    if (event === "poll") {
      if (!row) return { texts: [] };
      this.lastSeen.set(row.id, this.now());
      const texts: string[] = [];
      let total = 0;
      for (const m of this.store.queuedFor(row.id)) {
        let text = renderInbound(toWire(m));
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
        this.log(`peer_message_status ${String(frame.msg_id)} ${String(frame.status)} ${String(frame.reason ?? "")}`);
        if (row) {
          this.emit({
            type: "message", msg: toWire(row), status: String(frame.status) as MsgStatus,
            ...(frame.reason ? { reason: String(frame.reason) } : {}),
          });
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
    const to = str(p, "to", true);
    const text = str(p, "text", true);
    if (text.length === 0) throw new AsenqError("bad_request", "text is empty");
    if (text.length > MAX_TEXT) throw new AsenqError("too_large", `text exceeds ${MAX_TEXT} characters`);
    const kind = str(p, "kind") as Kind | undefined;
    if (kind !== undefined && !KINDS.includes(kind)) throw new AsenqError("bad_request", `kind must be one of ${KINDS.join(", ")}`);
    if (p.done !== undefined && typeof p.done !== "boolean") throw new AsenqError("bad_request", '"done" must be a boolean');
    const now = this.now();
    const base: MsgRow = {
      id: "", from_name: this.senderName(s), from_session: s.kind === "agent" ? s.session.id : null,
      to_name: "", to_session: null, channel: null, text, kind: kind ?? null, thread: str(p, "thread") ?? null,
      reply_to: str(p, "replyTo") ?? null, done: p.done === true ? 1 : 0, status: "queued", reason: null, attempts: 0,
      created_at: now, updated_at: now,
    };
    if (to === "human") {
      const row = { ...base, id: newId("m_"), to_name: "human", status: "posted" as const };
      this.insert(row);
      return [{ to, msgId: row.id, status: "posted" }];
    }
    let targets: SessionRow[];
    if (to === "*") {
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
      const dupKey = `${s.session.id}\0${target.id}\0${row.text}`;
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
    this.store.insertMsg(row);
    this.emit({ type: "message", msg: toWire(row), status: row.status, ...(row.reason ? { reason: row.reason } : {}) });
  }

  private setStatus(msgId: string, status: MsgStatus, reason?: string): void {
    this.store.db.run("UPDATE messages SET status=?, reason=?, updated_at=? WHERE id=?", status, reason ?? null, this.now(), msgId);
    const row = this.store.msg(msgId);
    if (!row) return;
    this.emit({ type: "message", msg: toWire(row), status, ...(reason ? { reason } : {}) });
    if (status === "failed" || status === "expired") this.notifyFailure(row, reason ?? status);
  }

  /** Tells a live agent sender that its message will never arrive. */
  private notifyFailure(row: MsgRow, reason: string): void {
    if (!row.from_session) return;
    const sender = this.store.session(row.from_session);
    if (!sender || sender.state !== "live") return;
    const notice: MsgRow = {
      id: newId("m_"), from_name: "asenq", from_session: null, to_name: sender.name, to_session: sender.id, channel: null,
      text: `Message ${row.id} to ${row.to_name} was not delivered: ${reason}.`, kind: "status", thread: null,
      reply_to: row.id, done: 0, status: "queued", reason: null, attempts: 0, created_at: this.now(), updated_at: this.now(),
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
    const text = renderInbound(toWire(row));

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
        this.setStatus(row.id, "delivered");
        return "delivered";
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
      this.removeSession(s, `session ${s.name} did not come back within ${this.graceMs / 1000}s`);
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
        this.removeSession(s, "target session inactive for 12h");
      }
    }
  }

  prune(): void {
    const cutoff: Param = this.now() - (this.opts.historyDays ?? 7) * 86_400_000;
    this.store.db.run("DELETE FROM messages WHERE created_at<? AND status NOT IN ('queued','held')", cutoff);
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
      status: "posted", reason: null, attempts: 0, created_at: now, updated_at: now,
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
        "SELECT * FROM (SELECT *, rowid AS r FROM messages WHERE from_name=? OR to_name=? ORDER BY created_at DESC, r DESC LIMIT ?) ORDER BY created_at, r",
        name, name, limit);
    } else {
      rows = this.store.db.all<MsgRow>(
        "SELECT * FROM (SELECT *, rowid AS r FROM messages ORDER BY created_at DESC, r DESC LIMIT ?) ORDER BY created_at, r", limit);
    }
    return { messages: rows.map((r) => ({ ...toWire(r), status: r.status, ...(r.reason ? { reason: r.reason } : {}) })) };
  }
}
