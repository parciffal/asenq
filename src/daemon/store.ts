import type { Harness, Inbound, Kind, MsgStatus, WireMsg } from "../shared/protocol.js";
import type { Db } from "../shared/sqlite.js";

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions(
  id TEXT PRIMARY KEY, harness TEXT NOT NULL, key TEXT NOT NULL, name TEXT NOT NULL UNIQUE,
  cwd TEXT, inbound TEXT NOT NULL DEFAULT 'accept', state TEXT NOT NULL,
  gone_at INTEGER, claude_socket TEXT, claude_session_ids TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL, UNIQUE(harness, key));
CREATE TABLE IF NOT EXISTS messages(
  id TEXT PRIMARY KEY, from_name TEXT NOT NULL, from_session TEXT, to_name TEXT NOT NULL, to_session TEXT,
  channel TEXT, text TEXT NOT NULL, kind TEXT, thread TEXT, reply_to TEXT,
  done INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, reason TEXT, attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS messages_pending ON messages(to_session, status);
CREATE INDEX IF NOT EXISTS messages_channel ON messages(channel, created_at);
`;

export type SessionRow = {
  id: string; harness: Harness; key: string; name: string; cwd: string | null;
  inbound: Inbound; state: "live" | "gone"; gone_at: number | null;
  claude_socket: string | null; claude_session_ids: string; created_at: number;
};

export type MsgRow = {
  id: string; from_name: string; from_session: string | null; to_name: string; to_session: string | null;
  channel: string | null; text: string; kind: Kind | null; thread: string | null; reply_to: string | null;
  done: number; status: MsgStatus; reason: string | null; attempts: number;
  created_at: number; updated_at: number;
};

export function toWire(r: MsgRow): WireMsg {
  const m: WireMsg = { id: r.id, from: r.from_name, to: r.to_name, text: r.text, createdAt: r.created_at };
  if (r.kind) m.kind = r.kind;
  if (r.thread) m.thread = r.thread;
  if (r.reply_to) m.replyTo = r.reply_to;
  if (r.done) m.done = true;
  return m;
}

export class Store {
  constructor(readonly db: Db) {
    db.exec(SCHEMA);
  }

  session(id: string): SessionRow | undefined {
    return this.db.get<SessionRow>("SELECT * FROM sessions WHERE id=?", id);
  }
  sessionByName(name: string): SessionRow | undefined {
    return this.db.get<SessionRow>("SELECT * FROM sessions WHERE name=?", name);
  }
  sessionByKey(harness: Harness, key: string): SessionRow | undefined {
    return this.db.get<SessionRow>("SELECT * FROM sessions WHERE harness=? AND key=?", harness, key);
  }
  sessionByClaudeId(sessionId: string): SessionRow | undefined {
    return this.db
      .all<SessionRow>("SELECT * FROM sessions WHERE harness='claude'")
      .find((r) => (JSON.parse(r.claude_session_ids) as string[]).includes(sessionId));
  }
  sessions(): SessionRow[] {
    return this.db.all<SessionRow>("SELECT * FROM sessions ORDER BY created_at");
  }
  live(): SessionRow[] {
    return this.db.all<SessionRow>("SELECT * FROM sessions WHERE state='live' ORDER BY created_at");
  }

  msg(id: string): MsgRow | undefined {
    return this.db.get<MsgRow>("SELECT * FROM messages WHERE id=?", id);
  }
  queuedFor(sessionId: string): MsgRow[] {
    return this.db.all<MsgRow>(
      "SELECT * FROM messages WHERE to_session=? AND status='queued' ORDER BY created_at, rowid", sessionId);
  }
  countQueued(sessionId: string): number {
    return Number(this.db.get<{ n: number }>(
      "SELECT count(*) AS n FROM messages WHERE to_session=? AND status='queued'", sessionId)?.n ?? 0);
  }
  insertMsg(r: MsgRow): void {
    this.db.run(
      `INSERT INTO messages(id,from_name,from_session,to_name,to_session,channel,text,kind,thread,reply_to,done,status,reason,attempts,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      r.id, r.from_name, r.from_session, r.to_name, r.to_session, r.channel, r.text, r.kind, r.thread, r.reply_to,
      r.done, r.status, r.reason, r.attempts, r.created_at, r.updated_at);
  }
}
