import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import net from "node:net";
import { basename } from "node:path";
import { readConfig } from "./config.js";
import { logPath, socketPath } from "./paths.js";
import {
  AsenqError, PROTOCOL,
  type ErrCode, type HistoryPage, type HistoryPageRequest, type InboxSummary, type PositionedEvent, type Push,
  type ReadMutationResult, type ReadScope, type ReadState, type RecentEventsResult, type ReplayResult,
  type SendOptions, type SendResult, type SyncResult,
} from "./protocol.js";

export type ClientOpts = {
  onPush?(p: Push): void;
  onReconnect?(): Promise<void>;
  schedule?(fn: () => void, ms: number): unknown;
  autoStart?: boolean;
};

/** A successful daemon response; fields depend on the op. */
export type Reply = Record<string, unknown>;

type Pending = { resolve(v: Reply): void; reject(e: Error): void; timer: NodeJS.Timeout };

/** Ops that may wait for a delivery ack or harness pong on the daemon side. */
const SLOW_OPS: Record<string, true> = { send: true, release: true, ping: true, channel_send: true };

export function ensureDaemon(): void {
  const cfg = readConfig();
  if (!cfg) throw new Error("asenq is not set up (run: asenq setup)");
  const isNode = !/bun/.test(basename(cfg.runtime));
  const fd = openSync(logPath(), "a");
  try {
    const child = spawn(
      cfg.runtime,
      [...(isNode ? ["--disable-warning=ExperimentalWarning"] : []), cfg.cli, "daemon", "run"],
      { detached: true, stdio: ["ignore", fd, fd], env: process.env },
    );
    child.unref();
  } finally {
    closeSync(fd);
  }
}

function dial(path: string): Promise<net.Socket> {
  const { promise, resolve, reject } = Promise.withResolvers<net.Socket>();
  const s = net.createConnection(path);
  s.once("connect", () => { s.removeListener("error", reject); resolve(s); });
  s.once("error", reject);
  return promise;
}

const sleep = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

function errCode(e: unknown): string | undefined {
  return e && typeof e === "object" && "code" in e && typeof e.code === "string" ? e.code : undefined;
}

export class AsenqClient {
  private sock?: net.Socket;
  private buf = "";
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private closed = false;
  private ready?: Promise<void>;
  private inHook = false;
  private backoff = 1000;

  constructor(private opts: ClientOpts = {}) {}

  /** Connects once; concurrent callers share the attempt. */
  connect(): Promise<void> {
    if (!this.ready) {
      const p = this.open();
      this.ready = p;
      p.catch(() => { if (this.ready === p) this.ready = undefined; });
    }
    return this.ready;
  }

  private async open(): Promise<void> {
    const path = socketPath();
    let sock: net.Socket;
    try {
      sock = await dial(path);
    } catch (e) {
      const code = errCode(e);
      if (code !== "ENOENT" && code !== "ECONNREFUSED") throw e;
      if (!this.opts.autoStart) throw new Error("asenq daemon not running (run: asenq daemon start)");
      ensureDaemon();
      const deadline = Date.now() + 3000;
      for (;;) {
        await sleep(100);
        try {
          sock = await dial(path);
          break;
        } catch {
          if (Date.now() > deadline) throw new Error("asenq daemon did not start; see " + logPath());
        }
      }
    }
    this.attach(sock);
    const hello = await this.raw("hello", { protocol: PROTOCOL });
    if (hello.protocol !== PROTOCOL) {
      sock.destroy();
      throw new Error("asenq daemon protocol mismatch; restart it (asenq daemon stop)");
    }
    this.backoff = 1000;
  }

  private attach(sock: net.Socket): void {
    this.sock = sock;
    this.buf = "";
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => {
      this.buf += chunk;
      let i: number;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 1);
        if (line) this.onLine(line);
      }
    });
    sock.on("error", () => {});
    sock.on("close", () => this.onClose(sock));
  }

  private onLine(line: string): void {
    let m: Record<string, unknown>;
    try { m = JSON.parse(line); } catch { return; }
    if (typeof m.push === "string") {
      try { this.opts.onPush?.(m as Push); } catch {}
      return;
    }
    const p = this.pending.get(Number(m.id));
    if (!p) return;
    this.pending.delete(Number(m.id));
    clearTimeout(p.timer);
    if (m.ok === true) return p.resolve(m);
    const err = (m.error ?? {}) as { code?: ErrCode; message?: string };
    p.reject(new AsenqError(err.code ?? "internal", err.message ?? "unknown daemon error"));
  }

  private onClose(sock: net.Socket): void {
    if (this.sock !== sock) return;
    this.sock = undefined;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("asenq daemon connection closed"));
      this.pending.delete(id);
    }
    if (this.closed) return;
    const gate = Promise.withResolvers<void>();
    gate.promise.catch(() => {});
    this.ready = gate.promise;
    const schedule = (): void => {
      const s = this.opts.schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
      s(attempt, this.backoff);
    };
    const attempt = (): void => {
      if (this.closed) return gate.reject(new Error("asenq client closed"));
      this.open().then(async () => {
        this.inHook = true;
        try { await this.opts.onReconnect?.(); } catch {} finally { this.inHook = false; }
        gate.resolve();
      }, () => {
        this.backoff = Math.min(this.backoff * 2, 10_000);
        schedule();
      });
    };
    schedule();
  }

  private raw(op: string, params: Record<string, unknown>): Promise<Reply> {
    const sock = this.sock;
    if (!sock) return Promise.reject(new Error("asenq daemon connection closed"));
    const id = this.nextId++;
    const { promise, resolve, reject } = Promise.withResolvers<Reply>();
    const timer = setTimeout(() => {
      this.pending.delete(id);
      reject(new Error(`asenq daemon timed out on ${op}`));
    }, SLOW_OPS[op] ? 15_000 : 5_000);
    this.pending.set(id, { resolve, reject, timer });
    sock.write(JSON.stringify({ ...params, id, op }) + "\n");
    return promise;
  }

  /** Sends a request, waiting for (re)connection first. Rejects with AsenqError on `ok:false`. */
  async request(op: string, params: Record<string, unknown> = {}): Promise<Reply> {
    if (!this.inHook) await this.connect();
    return this.raw(op, params);
  }

  /** Atomically subscribes this connection and returns the matching human-view snapshot. */
  async sync(): Promise<SyncResult> {
    return await this.request("sync") as SyncResult;
  }

  /** Returns retained events strictly after `position`. */
  async replay(position: number, limit?: number): Promise<ReplayResult> {
    return await this.request("replay", { position, ...(limit === undefined ? {} : { limit }) }) as ReplayResult;
  }

  /** Returns a chronological retained-history page; `before` is an exclusive durable message order. */
  async historyPage(params: HistoryPageRequest): Promise<HistoryPage> {
    return await this.request("history_page", params) as HistoryPage;
  }

  /** Newest incoming human-inbox message per sender, newest first. */
  async inboxSummaries(): Promise<InboxSummary[]> {
    return (await this.request("inbox_summaries")).summaries as InboxSummary[];
  }

  /** Newest retained protocol events (at most 200) in ascending position order. */
  async recentEvents(limit?: number): Promise<PositionedEvent[]> {
    const reply = await this.request("recent_events", limit === undefined ? {} : { limit });
    return (reply as unknown as RecentEventsResult).events;
  }

  async readState(): Promise<ReadState[]>;
  async readState(scope: ReadScope): Promise<ReadState>;
  async readState(scope?: ReadScope): Promise<ReadState | ReadState[]> {
    const reply = await this.request("read_state", scope ?? {});
    return scope ? reply.state as ReadState : reply.states as ReadState[];
  }

  /** Advances ordinary read position only if the caller's view of the marker is current. */
  async markRead(scope: ReadScope, through: number, expectedVersion: number): Promise<ReadMutationResult> {
    return await this.request("mark_read", { ...scope, through, expectedVersion }) as ReadMutationResult;
  }

  /** Creates a one-item reminder; omitting the version deliberately applies to the latest state. */
  async markUnread(scope: ReadScope, expectedVersion?: number): Promise<ReadMutationResult> {
    return await this.request("mark_unread", {
      ...scope,
      ...(expectedVersion === undefined ? {} : { expectedVersion }),
    }) as ReadMutationResult;
  }

  /** Sends as the human to one stable live/gone session identity, immune to name reuse races. */
  async sendToSession(sessionId: string, text: string, options: SendOptions = {}): Promise<SendResult> {
    const reply = await this.request("send", { toSessionId: sessionId, text, ...options });
    return (reply.results as SendResult[])[0];
  }

  close(): void {
    this.closed = true;
    this.sock?.destroy();
  }
}
