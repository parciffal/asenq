import type {
  ChannelSummary, ControlAction, Harness, Inbound, InboxSummary, Kind, MsgStatus, PositionedEvent, ReadScope, ReadState,
  SessionIdentity, SessionState, StoredMessage, TailEvent, WireMsg,
} from "../shared/protocol.js";
import type { Db } from "../shared/sqlite.js";

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions(
  id TEXT PRIMARY KEY, harness TEXT NOT NULL, key TEXT NOT NULL, name TEXT NOT NULL UNIQUE,
  cwd TEXT, inbound TEXT NOT NULL DEFAULT 'accept', state TEXT NOT NULL,
  gone_at INTEGER, claude_socket TEXT, claude_session_ids TEXT NOT NULL DEFAULT '[]',
  claude_transcript_path TEXT, claude_source TEXT, claude_lineage_state INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, UNIQUE(harness, key));
CREATE TABLE IF NOT EXISTS messages(
  id TEXT PRIMARY KEY, from_name TEXT NOT NULL, from_session TEXT, to_name TEXT NOT NULL, to_session TEXT,
  channel TEXT, text TEXT NOT NULL, kind TEXT, action TEXT, thread TEXT, reply_to TEXT,
  done INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, reason TEXT, attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, ord INTEGER, delivery_seq INTEGER);
CREATE INDEX IF NOT EXISTS messages_pending ON messages(to_session, status);
CREATE TABLE IF NOT EXISTS session_identities(
  id TEXT PRIMARY KEY, harness TEXT NOT NULL, name TEXT NOT NULL, previous_names TEXT NOT NULL DEFAULT '[]',
  cwd TEXT, inbound TEXT NOT NULL DEFAULT 'accept', state TEXT NOT NULL,
  created_at INTEGER NOT NULL, removed_at INTEGER, inbox_position INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS session_harness_ids(
  harness TEXT NOT NULL, kind TEXT NOT NULL, harness_id TEXT NOT NULL, identity_id TEXT NOT NULL,
  PRIMARY KEY(harness,kind,harness_id));
CREATE INDEX IF NOT EXISTS session_harness_ids_identity ON session_harness_ids(identity_id);
CREATE TABLE IF NOT EXISTS claude_lineage(
  fingerprint TEXT NOT NULL, identity_id TEXT NOT NULL, PRIMARY KEY(fingerprint,identity_id));
CREATE INDEX IF NOT EXISTS claude_lineage_identity ON claude_lineage(identity_id);
CREATE TABLE IF NOT EXISTS human_read_positions(
  scope TEXT NOT NULL, stream_key TEXT NOT NULL, position INTEGER NOT NULL,
  reminder INTEGER, version INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(scope, stream_key));
CREATE TABLE IF NOT EXISTS protocol_events(
  position INTEGER PRIMARY KEY, event_json TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS protocol_meta(
  key TEXT PRIMARY KEY, value INTEGER NOT NULL);
`;

export type SessionRow = {
  id: string; harness: Harness; key: string; name: string; cwd: string | null;
  inbound: Inbound; state: "live" | "gone"; gone_at: number | null;
  claude_socket: string | null; claude_session_ids: string; created_at: number;
  claude_transcript_path: string | null; claude_source: string | null; claude_lineage_state: number;
};

export type MsgRow = {
  id: string; from_name: string; from_session: string | null; to_name: string; to_session: string | null;
  channel: string | null; text: string; kind: Kind | null; action?: ControlAction | null; thread: string | null; reply_to: string | null;
  done: number; status: MsgStatus; reason: string | null; attempts: number;
  created_at: number; updated_at: number; ord: number; delivery_seq?: number | null;
};

type IdentityRow = {
  id: string; harness: Harness | "unknown"; name: string; previous_names: string; cwd: string | null;
  inbound: Inbound; state: SessionState; created_at: number; removed_at: number | null;
};

type EndpointRow = {
  session_id: string; name: string; created_at: number; updated_at: number; ord: number;
};

type ReadRow = {
  scope: "session" | "channel"; stream_key: string; position: number;
  reminder: number | null; version: number;
};

export function toWire(r: MsgRow): WireMsg {
  const m: WireMsg = { id: r.id, from: r.from_name, to: r.to_name, text: r.text, createdAt: r.created_at };
  if (r.kind) m.kind = r.kind;
  if (r.action) m.action = r.action;
  if (r.thread) m.thread = r.thread;
  if (r.reply_to) m.replyTo = r.reply_to;
  if (r.done) m.done = true;
  return m;
}

export function toStored(r: MsgRow): StoredMessage {
  return {
    ...toWire(r),
    order: r.ord,
    ...(r.from_session ? { fromSessionId: r.from_session } : {}),
    ...(r.channel ? { channel: r.channel } : {}),
    ...(r.to_session ? { toSessionId: r.to_session } : {}),
    status: r.status,
    ...(r.reason ? { reason: r.reason } : {}),
  };
}

function toIdentity(r: IdentityRow): SessionIdentity {
  return {
    id: r.id,
    name: r.name,
    previousNames: JSON.parse(r.previous_names) as string[],
    harness: r.harness,
    ...(r.cwd ? { cwd: r.cwd } : {}),
    state: r.state,
    inbound: r.inbound,
    createdAt: r.created_at,
    ...(r.removed_at === null ? {} : { removedAt: r.removed_at }),
  };
}

export class Store {
  constructor(readonly db: Db) {
    db.exec(SCHEMA);
    this.migrateMessageAction();
    const sessionColumns = this.db.all<{ name: string }>("PRAGMA table_info(sessions)");
    for (const [name, type] of [
      ["claude_transcript_path", "TEXT"], ["claude_source", "TEXT"],
      ["claude_lineage_state", "INTEGER NOT NULL DEFAULT 1"],
    ]) {
      if (!sessionColumns.some((column) => column.name === name)) this.db.exec(`ALTER TABLE sessions ADD COLUMN ${name} ${type}`);
    }
    this.migrateMessageOrder();
    this.backfillIdentities();
    this.backfillHarnessIds();
    this.initializeReadPositions();
    this.initializeInboxPositions();
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private meta(key: string): number | undefined {
    return this.db.get<{ value: number }>("SELECT value FROM protocol_meta WHERE key=?", key)?.value;
  }

  private setMeta(key: string, value: number): void {
    this.db.run(
      "INSERT INTO protocol_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      key, value,
    );
  }

  private migrateMessageAction(): void {
    const columns = this.db.all<{ name: string }>("PRAGMA table_info(messages)");
    if (!columns.some((column) => column.name === "action")) this.db.exec("ALTER TABLE messages ADD COLUMN action TEXT");
  }

  private migrateMessageOrder(): void {
    const columns = this.db.all<{ name: string }>("PRAGMA table_info(messages)");
    if (!columns.some((column) => column.name === "ord")) this.db.exec("ALTER TABLE messages ADD COLUMN ord INTEGER");
    const missing = Number(this.db.get<{ n: number }>("SELECT count(*) AS n FROM messages WHERE ord IS NULL")?.n ?? 0);
    if (missing > 0) {
      const rows = this.db.all<{ rowid: number }>("SELECT rowid FROM messages ORDER BY created_at, rowid");
      this.transaction(() => {
        for (let index = 0; index < rows.length; index++) {
          this.db.run("UPDATE messages SET ord=? WHERE rowid=?", index + 1, rows[index].rowid);
        }
      });
    }
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS messages_order ON messages(ord);
      CREATE INDEX IF NOT EXISTS messages_channel_order ON messages(channel,ord);
      CREATE INDEX IF NOT EXISTS messages_from_session_order ON messages(from_session,ord);
      CREATE INDEX IF NOT EXISTS messages_to_session_order ON messages(to_session,ord);
      CREATE INDEX IF NOT EXISTS messages_to_name_order ON messages(to_name,ord);
    `);
    const maximum = Number(this.db.get<{ n: number }>("SELECT COALESCE(max(ord),0) AS n FROM messages")?.n ?? 0);
    if ((this.meta("message_order") ?? -1) < maximum) this.setMeta("message_order", maximum);
    const eventMaximum = Number(this.db.get<{ n: number }>(
      "SELECT COALESCE(max(position),0) AS n FROM protocol_events",
    )?.n ?? 0);
    if ((this.meta("event_position") ?? -1) < eventMaximum) this.setMeta("event_position", eventMaximum);
    if (this.meta("event_floor") === undefined) this.setMeta("event_floor", 0);
  }

  private backfillIdentities(): void {
    // Historical endpoint reconstruction is a rollout migration, not a scan on every daemon start.
    if (this.meta("identity_backfill") !== undefined) return;
    this.db.run(
      `INSERT OR IGNORE INTO session_identities(id,harness,name,previous_names,cwd,inbound,state,created_at)
       SELECT id,harness,name,'[]',cwd,inbound,state,created_at FROM sessions`,
    );
    const recovered = new Map<string, {
      name: string; previousNames: string[]; createdAt: number; removedAt: number;
    }>();
    const endpoints = this.db.all<EndpointRow>(
      `SELECT session_id,name,created_at,updated_at,ord FROM (
         SELECT from_session AS session_id,from_name AS name,created_at,updated_at,ord
         FROM messages WHERE from_session IS NOT NULL
         UNION ALL
         SELECT to_session AS session_id,to_name AS name,created_at,updated_at,ord
         FROM messages WHERE to_session IS NOT NULL
       ) ORDER BY ord`,
    );
    for (const endpoint of endpoints) {
      const identity = recovered.get(endpoint.session_id);
      if (!identity) {
        recovered.set(endpoint.session_id, {
          name: endpoint.name,
          previousNames: [],
          createdAt: endpoint.created_at,
          removedAt: endpoint.updated_at,
        });
      } else {
        if (endpoint.name !== identity.name) {
          if (!identity.previousNames.includes(identity.name)) identity.previousNames.push(identity.name);
          identity.name = endpoint.name;
        }
        identity.createdAt = Math.min(identity.createdAt, endpoint.created_at);
        identity.removedAt = Math.max(identity.removedAt, endpoint.updated_at);
      }
    }
    for (const [id, identity] of recovered) {
      const existing = this.db.get<IdentityRow>("SELECT * FROM session_identities WHERE id=?", id);
      if (existing) {
        const previousNames = JSON.parse(existing.previous_names) as string[];
        for (const name of [...identity.previousNames, identity.name]) {
          if (name !== existing.name && !previousNames.includes(name)) previousNames.push(name);
        }
        this.db.run(
          "UPDATE session_identities SET previous_names=? WHERE id=?",
          JSON.stringify(previousNames), id,
        );
      } else {
        this.db.run(
          `INSERT INTO session_identities(
            id,harness,name,previous_names,cwd,inbound,state,created_at,removed_at)
           VALUES(?,'unknown',?,?,NULL,'accept','removed',?,?)`,
          id, identity.name, JSON.stringify(identity.previousNames), identity.createdAt, identity.removedAt,
        );
      }
    }
    this.setMeta("identity_backfill", 1);
  }

  private backfillHarnessIds(): void {
    if (this.meta("harness_id_backfill") !== undefined) return;
    this.transaction(() => {
      for (const row of this.db.all<SessionRow>(
        `SELECT sessions.* FROM sessions JOIN session_identities ON session_identities.id=sessions.id
         ORDER BY sessions.created_at,sessions.id`,
      )) this.syncHarnessIds(row);
      this.setMeta("harness_id_backfill", 1);
    });
  }

  private syncHarnessIds(row: SessionRow): void {
    if (row.harness !== "claude") {
      this.db.run(
        "INSERT OR IGNORE INTO session_harness_ids(harness,kind,harness_id,identity_id) VALUES(?,'key',?,?)",
        row.harness, row.key, row.id,
      );
    }
    if (row.harness === "claude") {
      for (const id of JSON.parse(row.claude_session_ids) as string[]) {
        this.db.run(
          "INSERT OR IGNORE INTO session_harness_ids(harness,kind,harness_id,identity_id) VALUES('claude','session',?,?)",
          id, row.id,
        );
      }
    }
  }

  private initializeReadPositions(): void {
    if (this.meta("read_rollout") !== undefined) return;
    this.transaction(() => {
      for (const row of this.db.all<{ id: string }>("SELECT id FROM session_identities")) {
        const newest = Number(this.db.get<{ n: number }>(
          "SELECT COALESCE(max(ord),0) AS n FROM messages WHERE channel IS NULL AND to_name='human' AND from_session=?",
          row.id,
        )?.n ?? 0);
        this.db.run(
          "INSERT OR IGNORE INTO human_read_positions(scope,stream_key,position) VALUES('session',?,?)",
          row.id, newest,
        );
      }
      for (const row of this.db.all<{ channel: string; newest: number }>(
        "SELECT channel,COALESCE(max(ord),0) AS newest FROM messages WHERE channel IS NOT NULL AND from_name!='human' GROUP BY channel",
      )) {
        this.db.run(
          "INSERT OR IGNORE INTO human_read_positions(scope,stream_key,position) VALUES('channel',?,?)",
          row.channel, row.newest,
        );
      }
      this.setMeta("read_rollout", 1);
    });
  }

  private initializeInboxPositions(): void {
    const columns = this.db.all<{ name: string }>("PRAGMA table_info(session_identities)");
    if (!columns.some((column) => column.name === "inbox_position")) {
      this.db.exec("ALTER TABLE session_identities ADD COLUMN inbox_position INTEGER NOT NULL DEFAULT 0");
    }
    const messageColumns = this.db.all<{ name: string }>("PRAGMA table_info(messages)");
    if (!messageColumns.some((column) => column.name === "delivery_seq")) {
      this.db.exec("ALTER TABLE messages ADD COLUMN delivery_seq INTEGER");
    }
    this.transaction(() => {
      const rollout = this.meta("delivery_sequence_rollout") === undefined;
      if (rollout) {
        this.db.run("UPDATE messages SET delivery_seq=ord WHERE channel IS NULL AND status='delivered' AND delivery_seq IS NULL");
      }
      const maximum = Number(this.db.get<{ n: number }>(
        "SELECT COALESCE(max(delivery_seq),0) AS n FROM messages",
      )?.n ?? 0);
      const watermark = Math.max(this.deliveryWatermark(), maximum);
      this.setMeta("delivery_sequence", watermark);
      if (rollout) {
        this.db.run("UPDATE session_identities SET inbox_position=?", watermark);
        this.setMeta("delivery_sequence_rollout", 1);
      }
    });
  }

  deliveryWatermark(): number {
    return this.meta("delivery_sequence") ?? 0;
  }

  private nextDeliverySequence(): number {
    const sequence = this.deliveryWatermark() + 1;
    this.setMeta("delivery_sequence", sequence);
    return sequence;
  }

  stampDelivery(row: MsgRow): void {
    if (row.channel !== null || row.status !== "delivered" || row.delivery_seq != null) return;
    row.delivery_seq = this.nextDeliverySequence();
    this.db.run("UPDATE messages SET delivery_seq=? WHERE id=?", row.delivery_seq, row.id);
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

  identityByHarnessId(harness: Harness, harnessId: string, kind: "key" | "session" = "key"): SessionIdentity | undefined {
    const row = this.db.get<IdentityRow>(
      `SELECT session_identities.* FROM session_identities JOIN session_harness_ids
       ON session_harness_ids.identity_id=session_identities.id
       WHERE session_harness_ids.harness=? AND kind=? AND harness_id=?`,
      harness, kind, harnessId,
    );
    return row && toIdentity(row);
  }

  sessionByClaudeId(sessionId: string): SessionRow | undefined {
    const identity = this.identityByHarnessId("claude", sessionId, "session");
    return identity && this.session(identity.id);
  }

  claudeIds(identityId: string): string[] {
    return this.db.all<{ harness_id: string }>(
      "SELECT harness_id FROM session_harness_ids WHERE identity_id=? AND harness='claude' AND kind='session' ORDER BY rowid",
      identityId,
    ).map((row) => row.harness_id);
  }

  recordClaudeLineage(identityId: string, fingerprints: string[]): void {
    for (const fingerprint of fingerprints) {
      this.db.run("INSERT OR IGNORE INTO claude_lineage(fingerprint,identity_id) VALUES(?,?)", fingerprint, identityId);
    }
  }

  claudeLineageCandidates(fingerprints: string[], exclude?: string): SessionIdentity[] {
    const ids = new Set<string>();
    for (const fingerprint of fingerprints) {
      for (const row of this.db.all<{ identity_id: string }>(
        "SELECT identity_id FROM claude_lineage WHERE fingerprint=?", fingerprint,
      )) if (row.identity_id !== exclude) ids.add(row.identity_id);
    }
    return [...ids].sort().map((id) => this.identity(id)!).filter((identity) => identity?.harness === "claude");
  }

  /** Moves a provisional conversation into its recognized ancestor, without changing ancestor policy. */
  mergeClaudeIdentity(provisionalId: string, ancestorId: string): { droppedReminder?: number } {
    return this.transaction(() => {
      const provisional = this.identity(provisionalId)!;
      const ancestor = this.identity(ancestorId)!;
      const previous = [...ancestor.previousNames];
      for (const name of [...provisional.previousNames, provisional.name]) {
        if (name !== ancestor.name && !previous.includes(name)) previous.push(name);
      }
      this.db.run("UPDATE session_identities SET previous_names=? WHERE id=?", JSON.stringify(previous), ancestorId);
      this.db.run(
        `UPDATE session_identities SET inbox_position=max(inbox_position,
         (SELECT inbox_position FROM session_identities WHERE id=?)) WHERE id=?`,
        provisionalId, ancestorId,
      );
      this.db.run("UPDATE messages SET from_session=? WHERE from_session=?", ancestorId, provisionalId);
      this.db.run("UPDATE messages SET to_session=? WHERE to_session=?", ancestorId, provisionalId);
      this.db.run("UPDATE session_harness_ids SET identity_id=? WHERE identity_id=?", ancestorId, provisionalId);
      this.db.run(
        "INSERT OR IGNORE INTO claude_lineage(fingerprint,identity_id) SELECT fingerprint,? FROM claude_lineage WHERE identity_id=?",
        ancestorId, provisionalId,
      );
      this.db.run("DELETE FROM claude_lineage WHERE identity_id=?", provisionalId);
      const oldRead = this.db.get<ReadRow>(
        "SELECT * FROM human_read_positions WHERE scope='session' AND stream_key=?", provisionalId,
      );
      const ancestorRead = this.db.get<ReadRow>(
        "SELECT * FROM human_read_positions WHERE scope='session' AND stream_key=?", ancestorId,
      );
      if (oldRead) {
        this.db.run(
          `INSERT INTO human_read_positions(scope,stream_key,position,reminder,version) VALUES('session',?,?,?,?)
           ON CONFLICT(scope,stream_key) DO UPDATE SET position=excluded.position,reminder=excluded.reminder,version=excluded.version`,
          ancestorId, Math.max(ancestorRead?.position ?? 0, oldRead.position),
          ancestorRead?.reminder ?? oldRead.reminder, Math.max(ancestorRead?.version ?? 0, oldRead.version) + 1,
        );
      }
      this.db.run("DELETE FROM human_read_positions WHERE scope='session' AND stream_key=?", provisionalId);
      this.db.run("DELETE FROM sessions WHERE id=?", provisionalId);
      this.db.run("DELETE FROM session_identities WHERE id=?", provisionalId);
      return ancestorRead?.reminder != null && oldRead?.reminder != null && ancestorRead.reminder !== oldRead.reminder
        ? { droppedReminder: oldRead.reminder } : {};
    });
  }

  sessions(): SessionRow[] {
    return this.db.all<SessionRow>("SELECT * FROM sessions ORDER BY created_at");
  }

  live(): SessionRow[] {
    return this.db.all<SessionRow>("SELECT * FROM sessions WHERE state='live' ORDER BY created_at");
  }

  identity(id: string): SessionIdentity | undefined {
    const row = this.db.get<IdentityRow>("SELECT * FROM session_identities WHERE id=?", id);
    return row && toIdentity(row);
  }

  identities(): SessionIdentity[] {
    return this.db.all<IdentityRow>("SELECT * FROM session_identities ORDER BY created_at,id").map(toIdentity);
  }

  syncIdentity(row: SessionRow): SessionIdentity {
    this.db.run(
      `INSERT INTO session_identities(id,harness,name,previous_names,cwd,inbound,state,created_at,removed_at,inbox_position)
       VALUES(?,?,?,'[]',?,?,?, ?,NULL,?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name,cwd=excluded.cwd,inbound=excluded.inbound,state=excluded.state,removed_at=NULL`,
      row.id, row.harness, row.name, row.cwd, row.inbound, row.state, row.created_at, this.deliveryWatermark(),
    );
    this.syncHarnessIds(row);
    this.ensureRead({ scope: "session", sessionId: row.id });
    return this.identity(row.id)!;
  }

  renameIdentity(id: string, oldName: string, name: string): SessionIdentity {
    const row = this.db.get<IdentityRow>("SELECT * FROM session_identities WHERE id=?", id)!;
    const previous = JSON.parse(row.previous_names) as string[];
    if (!previous.includes(oldName)) previous.push(oldName);
    this.db.run("UPDATE session_identities SET name=?,previous_names=? WHERE id=?", name, JSON.stringify(previous), id);
    return this.identity(id)!;
  }

  setIdentityState(id: string, state: SessionState, removedAt?: number): SessionIdentity {
    this.db.run(
      "UPDATE session_identities SET state=?,removed_at=? WHERE id=?",
      state, removedAt ?? null, id,
    );
    return this.identity(id)!;
  }

  setIdentityInbound(id: string, inbound: Inbound): SessionIdentity {
    this.db.run("UPDATE session_identities SET inbound=? WHERE id=?", inbound, id);
    return this.identity(id)!;
  }

  msg(id: string): MsgRow | undefined {
    return this.db.get<MsgRow>("SELECT * FROM messages WHERE id=?", id);
  }

  queuedFor(sessionId: string): MsgRow[] {
    return this.db.all<MsgRow>(
      "SELECT * FROM messages WHERE to_session=? AND status='queued' ORDER BY ord", sessionId,
    );
  }

  countQueued(sessionId: string): number {
    return Number(this.db.get<{ n: number }>(
      "SELECT count(*) AS n FROM messages WHERE to_session=? AND status='queued'", sessionId,
    )?.n ?? 0);
  }

  insertMsg(row: MsgRow): MsgRow {
    const order = (this.meta("message_order") ?? 0) + 1;
    this.setMeta("message_order", order);
    row.ord = order;
    row.delivery_seq = row.channel === null && row.status === "delivered" ? this.nextDeliverySequence() : null;
    this.db.run(
      `INSERT INTO messages(id,from_name,from_session,to_name,to_session,channel,text,kind,action,thread,reply_to,done,status,reason,attempts,created_at,updated_at,ord,delivery_seq)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      row.id, row.from_name, row.from_session, row.to_name, row.to_session, row.channel, row.text, row.kind, row.action ?? null, row.thread, row.reply_to,
      row.done, row.status, row.reason, row.attempts, row.created_at, row.updated_at, row.ord, row.delivery_seq,
    );
    return row;
  }

  appendEvent(event: TailEvent, createdAt: number): PositionedEvent {
    const position = (this.meta("event_position") ?? 0) + 1;
    this.setMeta("event_position", position);
    this.db.run(
      "INSERT INTO protocol_events(position,event_json,created_at) VALUES(?,?,?)",
      position, JSON.stringify(event), createdAt,
    );
    return { position, event };
  }

  eventWatermark(): number {
    return this.meta("event_position") ?? 0;
  }

  eventFloor(): number {
    return this.meta("event_floor") ?? 0;
  }

  eventsAfter(position: number, limit: number): PositionedEvent[] {
    return this.db.all<{ position: number; event_json: string }>(
      "SELECT position,event_json FROM protocol_events WHERE position>? ORDER BY position LIMIT ?",
      position, limit,
    ).map((row) => ({ position: row.position, event: JSON.parse(row.event_json) as TailEvent }));
  }

  pruneEvents(cutoff: number): void {
    const removedThrough = this.db.get<{ position: number | null }>(
      "SELECT max(position) AS position FROM protocol_events WHERE created_at<?", cutoff,
    )?.position;
    if (removedThrough === null || removedThrough === undefined) return;
    this.transaction(() => {
      this.db.run("DELETE FROM protocol_events WHERE position<=?", removedThrough);
      this.setMeta("event_floor", Math.max(this.eventFloor(), removedThrough));
    });
  }

  channelSummaries(): ChannelSummary[] {
    return this.db.all<{ name: string; count: number; lastAt: number; lastOrder: number }>(
      `SELECT channel AS name,count(*) AS count,max(created_at) AS lastAt,max(ord) AS lastOrder
       FROM messages WHERE channel IS NOT NULL GROUP BY channel ORDER BY lastOrder DESC`,
    );
  }

  /** Latest retained direct-message order touching each stable identity, as sender or recipient. */
  sessionLastOrders(): Record<string, number> {
    const orders: Record<string, number> = {};
    for (const row of this.db.all<{ id: string; ord: number }>(
      `SELECT id,max(ord) AS ord FROM (
         SELECT from_session AS id,ord FROM messages WHERE channel IS NULL AND from_session IS NOT NULL
         UNION ALL
         SELECT to_session AS id,ord FROM messages WHERE channel IS NULL AND to_session IS NOT NULL
       ) GROUP BY id`,
    )) orders[row.id] = Number(row.ord);
    return orders;
  }

  /** Newest incoming human-inbox message per sender identity (legacy senders group by name), newest first. */
  inboxSummaries(): InboxSummary[] {
    return this.db.all<MsgRow>(
      `SELECT m.* FROM messages m JOIN (
         SELECT max(ord) AS ord FROM messages
         WHERE channel IS NULL AND to_name='human' AND from_name!='human'
         GROUP BY COALESCE('s:' || from_session, 'n:' || from_name)
       ) latest ON latest.ord=m.ord ORDER BY m.ord DESC`,
    ).map((row) => {
      const identity = row.from_session ? this.identity(row.from_session) : undefined;
      return {
        ...(identity ? { sessionId: identity.id } : {}),
        name: identity?.name ?? row.from_name,
        latest: toStored(row),
      };
    });
  }

  /** The newest `limit` retained protocol events in ascending position order. */
  recentEvents(limit: number): PositionedEvent[] {
    return this.db.all<{ position: number; event_json: string }>(
      "SELECT * FROM (SELECT position,event_json FROM protocol_events ORDER BY position DESC LIMIT ?) ORDER BY position",
      limit,
    ).map((row) => ({ position: row.position, event: JSON.parse(row.event_json) as TailEvent }));
  }

  ensureRead(scope: ReadScope): ReadState {
    const [kind, key] = scope.scope === "session"
      ? ["session" as const, scope.sessionId]
      : ["channel" as const, scope.channel];
    let row = this.db.get<ReadRow>("SELECT * FROM human_read_positions WHERE scope=? AND stream_key=?", kind, key);
    if (!row) {
      const position = this.latestEligible(scope);
      this.db.run(
        "INSERT INTO human_read_positions(scope,stream_key,position) VALUES(?,?,?)",
        kind, key, position,
      );
      row = { scope: kind, stream_key: key, position, reminder: null, version: 0 };
    }
    return this.readStateFromRow(row);
  }

  readStates(): ReadState[] {
    return this.db.all<ReadRow>(
      "SELECT * FROM human_read_positions ORDER BY scope,stream_key",
    ).map((row) => this.readStateFromRow(row));
  }

  latestEligible(scope: ReadScope): number {
    const row = scope.scope === "session"
      ? this.db.get<{ n: number }>(
        "SELECT COALESCE(max(ord),0) AS n FROM messages WHERE channel IS NULL AND to_name='human' AND from_session=?",
        scope.sessionId,
      )
      : this.db.get<{ n: number }>(
        "SELECT COALESCE(max(ord),0) AS n FROM messages WHERE channel=? AND from_name!='human'",
        scope.channel,
      );
    return Number(row?.n ?? 0);
  }

  isEligible(scope: ReadScope, order: number): boolean {
    const row = scope.scope === "session"
      ? this.db.get<{ one: number }>(
        "SELECT 1 AS one FROM messages WHERE ord=? AND channel IS NULL AND to_name='human' AND from_session=?",
        order, scope.sessionId,
      )
      : this.db.get<{ one: number }>(
        "SELECT 1 AS one FROM messages WHERE ord=? AND channel=? AND from_name!='human'",
        order, scope.channel,
      );
    return row !== undefined;
  }

  updateRead(scope: ReadScope, position: number, reminder: number | null, version: number): void {
    const key = scope.scope === "session" ? scope.sessionId : scope.channel;
    this.db.run(
      "UPDATE human_read_positions SET position=?,reminder=?,version=? WHERE scope=? AND stream_key=?",
      position, reminder, version, scope.scope, key,
    );
  }

  private readStateFromRow(row: ReadRow): ReadState {
    const scope: ReadScope = row.scope === "session"
      ? { scope: "session", sessionId: row.stream_key }
      : { scope: "channel", channel: row.stream_key };
    const count = scope.scope === "session"
      ? this.db.get<{ n: number }>(
        `SELECT count(*) AS n FROM messages
         WHERE channel IS NULL AND to_name='human' AND from_session=? AND (ord>? OR ord=?)`,
        scope.sessionId, row.position, row.reminder ?? -1,
      )
      : this.db.get<{ n: number }>(
        "SELECT count(*) AS n FROM messages WHERE channel=? AND from_name!='human' AND (ord>? OR ord=?)",
        scope.channel, row.position, row.reminder ?? -1,
      );
    return {
      scope,
      position: row.position,
      reminder: row.reminder,
      version: row.version,
      unread: Number(count?.n ?? 0),
    };
  }

  reconcileReads(cutoff: number): { states: ReadState[]; removedPositions: number; removedIdentities: number } {
    const changed: ReadScope[] = [];
    for (const row of this.db.all<ReadRow>("SELECT * FROM human_read_positions WHERE reminder IS NOT NULL")) {
      const scope: ReadScope = row.scope === "session"
        ? { scope: "session", sessionId: row.stream_key }
        : { scope: "channel", channel: row.stream_key };
      if (!this.isEligible(scope, row.reminder!)) {
        this.db.run(
          "UPDATE human_read_positions SET reminder=NULL,version=version+1 WHERE scope=? AND stream_key=?",
          row.scope, row.stream_key,
        );
        changed.push(scope);
      }
    }
    let removedPositions = this.db.run(
      `DELETE FROM human_read_positions WHERE scope='channel'
       AND NOT EXISTS(SELECT 1 FROM messages WHERE channel=human_read_positions.stream_key)`,
    ).changes;
    removedPositions += this.db.run(
      `DELETE FROM human_read_positions WHERE scope='session'
       AND EXISTS(SELECT 1 FROM session_identities WHERE id=human_read_positions.stream_key AND state='removed' AND removed_at<?)
       AND NOT EXISTS(SELECT 1 FROM messages WHERE from_session=human_read_positions.stream_key OR to_session=human_read_positions.stream_key)`,
      cutoff,
    ).changes;
    const removedIdentities = this.db.run(
      `DELETE FROM session_identities WHERE state='removed' AND removed_at<?
       AND NOT EXISTS(SELECT 1 FROM messages WHERE from_session=session_identities.id OR to_session=session_identities.id)`,
      cutoff,
    ).changes;
    this.db.run(
      "DELETE FROM session_harness_ids WHERE NOT EXISTS(SELECT 1 FROM session_identities WHERE id=session_harness_ids.identity_id)",
    );
    this.db.run(
      "DELETE FROM claude_lineage WHERE NOT EXISTS(SELECT 1 FROM session_identities WHERE id=claude_lineage.identity_id)",
    );
    const states: ReadState[] = [];
    for (const scope of changed) {
      const key = scope.scope === "session" ? scope.sessionId : scope.channel;
      const row = this.db.get<ReadRow>(
        "SELECT * FROM human_read_positions WHERE scope=? AND stream_key=?",
        scope.scope, key,
      );
      if (row) states.push(this.readStateFromRow(row));
    }
    return { states, removedPositions, removedIdentities };
  }
}
