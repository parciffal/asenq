import type {
  ChannelSummary, ControlAction, Harness, Inbound, InboxSummary, Kind, MsgStatus, PositionedEvent, ReadScope, ReadState,
  PingStatus, Role, SessionIdentity, SessionState, StoredMessage, TailEvent, WireMsg,
} from "../shared/protocol.js";
import type { Db } from "../shared/sqlite.js";

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions(
  id TEXT PRIMARY KEY, harness TEXT NOT NULL, key TEXT NOT NULL, name TEXT NOT NULL UNIQUE,
  cwd TEXT, inbound TEXT NOT NULL DEFAULT 'accept', state TEXT NOT NULL,
  gone_at INTEGER, claude_socket TEXT, claude_session_ids TEXT NOT NULL DEFAULT '[]',
  claude_transcript_path TEXT, claude_source TEXT, claude_lineage_state INTEGER NOT NULL DEFAULT 1,
  busy INTEGER, claude_current_session_id TEXT,
  created_at INTEGER NOT NULL, UNIQUE(harness, key));
CREATE TABLE IF NOT EXISTS messages(
  id TEXT PRIMARY KEY, from_name TEXT NOT NULL, from_session TEXT, to_name TEXT NOT NULL, to_session TEXT,
  channel TEXT, source_channel TEXT, text TEXT NOT NULL, file TEXT, kind TEXT, action TEXT, thread TEXT, reply_to TEXT,
  done INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, reason TEXT, attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, ord INTEGER, delivery_seq INTEGER);
CREATE INDEX IF NOT EXISTS messages_pending ON messages(to_session, status);
CREATE TABLE IF NOT EXISTS session_identities(
  id TEXT PRIMARY KEY, harness TEXT NOT NULL, name TEXT NOT NULL, previous_names TEXT NOT NULL DEFAULT '[]',
  cwd TEXT, inbound TEXT NOT NULL DEFAULT 'accept', state TEXT NOT NULL, role TEXT,
  created_at INTEGER NOT NULL, removed_at INTEGER, closed_at INTEGER, last_direct_at INTEGER,
  inbox_position INTEGER NOT NULL DEFAULT 0, last_seen_at INTEGER);
CREATE TABLE IF NOT EXISTS session_harness_ids(
  harness TEXT NOT NULL, kind TEXT NOT NULL, harness_id TEXT NOT NULL, identity_id TEXT NOT NULL,
  PRIMARY KEY(harness,kind,harness_id));
CREATE INDEX IF NOT EXISTS session_harness_ids_identity ON session_harness_ids(identity_id);
CREATE TABLE IF NOT EXISTS claude_lineage(
  fingerprint TEXT NOT NULL, identity_id TEXT NOT NULL, PRIMARY KEY(fingerprint,identity_id));
CREATE INDEX IF NOT EXISTS claude_lineage_identity ON claude_lineage(identity_id);
CREATE TABLE IF NOT EXISTS channels(name TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS channel_members(
  channel TEXT NOT NULL, session_id TEXT NOT NULL, PRIMARY KEY(channel,session_id));
CREATE INDEX IF NOT EXISTS channel_members_identity ON channel_members(session_id,channel);
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
  busy: number | null; claude_current_session_id: string | null;
};

export type MsgRow = {
  id: string; from_name: string; from_session: string | null; to_name: string; to_session: string | null;
  channel: string | null; text: string; kind: Kind | null; action?: ControlAction | null; thread: string | null; reply_to: string | null;
  done: number; status: MsgStatus; reason: string | null; attempts: number;
  created_at: number; updated_at: number; ord: number; delivery_seq?: number | null;
  file?: string | null; source_channel?: string | null;
};

type IdentityRow = {
  id: string; harness: Harness | "unknown"; name: string; previous_names: string; cwd: string | null;
  inbound: Inbound; state: SessionState; role: Role | null; created_at: number; removed_at: number | null;
  closed_at: number | null; last_direct_at: number | null;
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
  if (r.file) m.file = JSON.parse(r.file) as WireMsg["file"];
  if (r.source_channel) m.sourceChannel = r.source_channel;
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
    role: r.role,
    createdAt: r.created_at,
    ...(r.removed_at === null ? {} : { removedAt: r.removed_at }),
    ...(r.closed_at === null ? {} : { closedAt: r.closed_at }),
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
      ["busy", "INTEGER"], ["claude_current_session_id", "TEXT"],
    ]) {
      if (!sessionColumns.some((column) => column.name === name)) this.db.exec(`ALTER TABLE sessions ADD COLUMN ${name} ${type}`);
    }
    this.migrateMessageFile();
    this.migrateMessageSourceChannel();
    this.migrateMessageOrder();
    this.backfillIdentities();
    this.backfillHarnessIds();
    this.initializeReadPositions();
    this.initializeInboxPositions();
    this.migrateIdentityRole();
    this.migrateIdentityContact();
    this.migrateChannels();
    this.initializeDirectActivity();
    const identityColumns = this.db.all<{ name: string }>("PRAGMA table_info(session_identities)");
    if (!identityColumns.some((column) => column.name === "ping")) {
      this.db.exec("ALTER TABLE session_identities ADD COLUMN ping TEXT");
    }
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

  private initializeDirectActivity(): void {
    const columns = this.db.all<{ name: string }>("PRAGMA table_info(session_identities)");
    for (const name of ["closed_at", "last_direct_at"]) {
      if (!columns.some((column) => column.name === name)) {
        this.db.exec(`ALTER TABLE session_identities ADD COLUMN ${name} INTEGER`);
      }
    }
    if (this.meta("direct_activity_rollout") !== undefined) return;
    this.transaction(() => {
      this.db.run(
        `UPDATE session_identities SET last_direct_at=(
           SELECT max(at) FROM (
             SELECT from_session AS id,created_at AS at FROM messages WHERE channel IS NULL
             UNION ALL
             SELECT to_session AS id,updated_at AS at FROM messages WHERE channel IS NULL AND status='delivered'
           ) WHERE id=session_identities.id
         )`,
      );
      this.setMeta("direct_activity_rollout", 1);
    });
  }

  private recordDirectActivity(id: string | null, at: number): void {
    if (id === null) return;
    this.db.run(
      "UPDATE session_identities SET last_direct_at=max(COALESCE(last_direct_at,?),?) WHERE id=?",
      at, at, id,
    );
  }

  sessionLastActivity(): Record<string, number> {
    const activity: Record<string, number> = {};
    for (const row of this.db.all<{ id: string; last_direct_at: number }>(
      "SELECT id,last_direct_at FROM session_identities WHERE last_direct_at IS NOT NULL",
    )) activity[row.id] = row.last_direct_at;
    return activity;
  }

  sessionPings(): Record<string, PingStatus> {
    const pings: Record<string, PingStatus> = {};
    for (const row of this.db.all<{ id: string; ping: PingStatus }>(
      "SELECT id,ping FROM session_identities WHERE state='live' AND ping IS NOT NULL",
    )) pings[row.id] = row.ping;
    return pings;
  }

  setSessionPing(id: string, ping: PingStatus): void {
    this.db.run("UPDATE session_identities SET ping=? WHERE id=? AND state='live'", ping, id);
  }

  private migrateMessageAction(): void {
    const columns = this.db.all<{ name: string }>("PRAGMA table_info(messages)");
    if (!columns.some((column) => column.name === "action")) this.db.exec("ALTER TABLE messages ADD COLUMN action TEXT");
  }

  private migrateMessageFile(): void {
    const columns = this.db.all<{ name: string }>("PRAGMA table_info(messages)");
    if (!columns.some((column) => column.name === "file")) this.db.exec("ALTER TABLE messages ADD COLUMN file TEXT");
  }

  private migrateMessageSourceChannel(): void {
    const columns = this.db.all<{ name: string }>("PRAGMA table_info(messages)");
    if (!columns.some((column) => column.name === "source_channel")) this.db.exec("ALTER TABLE messages ADD COLUMN source_channel TEXT");
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
      CREATE INDEX IF NOT EXISTS messages_reply_to ON messages(reply_to);
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
        this.db.run("UPDATE messages SET delivery_seq=ord WHERE channel IS NULL AND status IN ('delivered','replied') AND delivery_seq IS NULL");
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

  private migrateIdentityRole(): void {
    const columns = this.db.all<{ name: string }>("PRAGMA table_info(session_identities)");
    if (!columns.some((column) => column.name === "role")) this.db.exec("ALTER TABLE session_identities ADD COLUMN role TEXT");
  }

  private migrateIdentityContact(): void {
    const columns = this.db.all<{ name: string }>("PRAGMA table_info(session_identities)");
    if (!columns.some((column) => column.name === "last_seen_at")) {
      this.db.exec("ALTER TABLE session_identities ADD COLUMN last_seen_at INTEGER");
    }
  }

  private migrateChannels(): void {
    if (this.meta("channel_roster_rollout") !== undefined) return;
    this.transaction(() => {
      this.db.run("INSERT OR IGNORE INTO channels(name) SELECT DISTINCT channel FROM messages WHERE channel IS NOT NULL");
      this.db.run("INSERT OR IGNORE INTO channels(name) SELECT stream_key FROM human_read_positions WHERE scope='channel'");
      this.setMeta("channel_roster_rollout", 1);
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
    if (row.channel !== null || (row.status !== "delivered" && row.status !== "replied") || row.delivery_seq != null) return;
    row.delivery_seq = this.nextDeliverySequence();
    this.db.run("UPDATE messages SET delivery_seq=? WHERE id=?", row.delivery_seq, row.id);
    this.recordDirectActivity(row.to_session, row.updated_at);
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
       WHERE session_harness_ids.harness=? AND kind=? AND harness_id=? AND closed_at IS NULL`,
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
        `SELECT identity_id FROM claude_lineage JOIN session_identities ON session_identities.id=identity_id
         WHERE fingerprint=? AND closed_at IS NULL`, fingerprint,
      )) if (row.identity_id !== exclude) ids.add(row.identity_id);
    }
    return [...ids].sort().map((id) => this.identity(id)!).filter((identity) => identity?.harness === "claude");
  }

  /** Moves a provisional conversation into its recognized ancestor, without changing ancestor policy. */
  mergeClaudeIdentity(provisionalId: string, ancestorId: string): { channels: ChannelSummary[]; droppedReminder?: number } {
    return this.transaction(() => {
      const provisional = this.identity(provisionalId)!;
      const ancestor = this.identity(ancestorId)!;
      const channels = this.db.all<{ channel: string }>("SELECT channel FROM channel_members WHERE session_id=?", provisionalId);
      this.db.run("UPDATE session_identities SET role=COALESCE(role,?) WHERE id=?", provisional.role ?? null, ancestorId);
      this.db.run(
        `UPDATE session_identities SET last_seen_at=CASE
         WHEN last_seen_at IS NULL THEN (SELECT last_seen_at FROM session_identities WHERE id=?)
         ELSE max(last_seen_at,COALESCE((SELECT last_seen_at FROM session_identities WHERE id=?),last_seen_at))
         END WHERE id=?`,
        provisionalId, provisionalId, ancestorId,
      );
      this.db.run(
        "INSERT OR IGNORE INTO channel_members(channel,session_id) SELECT channel,? FROM channel_members WHERE session_id=?",
        ancestorId, provisionalId,
      );
      this.db.run("DELETE FROM channel_members WHERE session_id=?", provisionalId);
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
      this.db.run(
        `UPDATE session_identities SET last_direct_at=(
         SELECT max(last_direct_at) FROM session_identities WHERE id IN (?,?)) WHERE id=?`,
        provisionalId, ancestorId, ancestorId,
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
      return {
        channels: channels.map((row) => this.channelSummary(row.channel)),
        ...(ancestorRead?.reminder != null && oldRead?.reminder != null && ancestorRead.reminder !== oldRead.reminder
          ? { droppedReminder: oldRead.reminder } : {}),
      };
    });
  }

  sessions(): SessionRow[] {
    return this.db.all<SessionRow>("SELECT * FROM sessions ORDER BY created_at");
  }

  sessionListRows(): (SessionRow & { last_seen_at: number | null; previous_names: string; role: Role | null })[] {
    return this.db.all(
      `SELECT sessions.*,session_identities.last_seen_at,session_identities.previous_names,session_identities.role
       FROM sessions JOIN session_identities ON session_identities.id=sessions.id ORDER BY sessions.created_at`,
    );
  }

  sessionChannels(): Record<string, string[]> {
    const channels: Record<string, string[]> = {};
    for (const row of this.db.all<{ session_id: string; channel: string }>(
      "SELECT session_id,channel FROM channel_members ORDER BY channel",
    )) (channels[row.session_id] ??= []).push(row.channel);
    return channels;
  }

  recordContact(id: string, at: number, claudeSessionId?: string): void {
    this.db.run("UPDATE session_identities SET last_seen_at=? WHERE id=?", at, id);
    if (claudeSessionId !== undefined) {
      this.db.run("UPDATE sessions SET claude_current_session_id=? WHERE id=?", claudeSessionId, id);
    }
  }

  setSessionBusy(id: string, busy: boolean | null): void {
    this.db.run("UPDATE sessions SET busy=? WHERE id=?", busy === null ? null : Number(busy), id);
  }

  live(): SessionRow[] {
    return this.db.all<SessionRow>("SELECT * FROM sessions WHERE state='live' ORDER BY created_at");
  }

  broadcastTargets(senderId: string): SessionRow[] {
    return this.db.all<SessionRow>(
      `SELECT s.* FROM sessions s WHERE s.state='live' AND s.id<>?
       AND (NOT EXISTS (SELECT 1 FROM channel_members WHERE session_id=?)
         OR EXISTS (SELECT 1 FROM channel_members a JOIN channel_members b ON b.channel=a.channel
                    WHERE a.session_id=? AND b.session_id=s.id))
       ORDER BY s.created_at`, senderId, senderId, senderId,
    );
  }

  identity(id: string): SessionIdentity | undefined {
    const row = this.db.get<IdentityRow>("SELECT * FROM session_identities WHERE id=?", id);
    return row && toIdentity(row);
  }

  identityByName(name: string): SessionIdentity | { candidates: SessionIdentity[] } | undefined {
    const candidates = this.db.all<IdentityRow>(
      `WITH matches AS (
         SELECT *, (CASE WHEN state='removed' THEN 2 ELSE 0 END
           + CASE WHEN name=? THEN 0 ELSE 1 END) AS rank
         FROM session_identities
         WHERE closed_at IS NULL
           AND (name=? OR EXISTS (SELECT 1 FROM json_each(previous_names) WHERE value=?))
       )
       SELECT * FROM matches WHERE rank=(SELECT min(rank) FROM matches)
       ORDER BY COALESCE(removed_at,created_at),id`,
      name, name, name,
    ).map(toIdentity);
    if (candidates.length === 0) return undefined;
    return candidates.length === 1 ? candidates[0] : { candidates };
  }

  identities(): SessionIdentity[] {
    return this.db.all<IdentityRow>("SELECT * FROM session_identities ORDER BY created_at,id").map(toIdentity);
  }

  syncIdentity(row: SessionRow): SessionIdentity {
    if (this.identity(row.id)?.closedAt !== undefined) throw new Error(`cannot revive closed session ${row.id}`);
    this.db.run(
      `INSERT INTO session_identities(id,harness,name,previous_names,cwd,inbound,state,created_at,removed_at,inbox_position)
       VALUES(?,?,?,'[]',?,?,?, ?,NULL,?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name,cwd=excluded.cwd,inbound=excluded.inbound,state=excluded.state,removed_at=NULL`,
      row.id, row.harness, row.name, row.cwd, row.inbound, row.state, row.created_at, this.deliveryWatermark(),
    );
    this.syncHarnessIds(row);
    if (row.state !== "live") this.db.run("UPDATE session_identities SET ping=NULL WHERE id=?", row.id);
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
    if (state !== "live") this.db.run("UPDATE session_identities SET ping=NULL WHERE id=?", id);
    return this.identity(id)!;
  }

  setIdentityInbound(id: string, inbound: Inbound): SessionIdentity {
    this.db.run("UPDATE session_identities SET inbound=? WHERE id=?", inbound, id);
    return this.identity(id)!;
  }

  setIdentityRole(id: string, role: Role | null): SessionIdentity {
    this.db.run("UPDATE session_identities SET role=? WHERE id=?", role, id);
    return this.identity(id)!;
  }

  /** Terminal closure and identity-association deletion commit together. */
  closeIdentity(id: string, at: number): SessionIdentity {
    return this.transaction(() => {
      this.db.run(
        "UPDATE session_identities SET state='removed',removed_at=COALESCE(removed_at,?),closed_at=? WHERE id=? AND closed_at IS NULL",
        at, at, id,
      );
      this.db.run("DELETE FROM sessions WHERE id=?", id);
      this.db.run("DELETE FROM session_harness_ids WHERE identity_id=?", id);
      this.db.run("DELETE FROM claude_lineage WHERE identity_id=?", id);
      this.db.run("DELETE FROM channel_members WHERE session_id=?", id);
      this.db.run("UPDATE session_identities SET ping=NULL WHERE id=?", id);
      return this.identity(id)!;
    });
  }

  purgeIdentities(ids: string[]): void {
    this.transaction(() => {
      for (const id of ids) {
        const messages = new Set(this.db.all<{ id: string }>(
          "SELECT id FROM messages WHERE channel IS NULL AND (from_session=? OR to_session=?)", id, id,
        ).map((row) => row.id));
        for (const row of this.db.all<{ position: number; event_json: string }>(
          "SELECT position,event_json FROM protocol_events",
        )) {
          const event = JSON.parse(row.event_json) as TailEvent;
          const belongs = event.type === "session" ? event.session.id === id
            : event.type === "read" ? event.state.scope.scope === "session" && event.state.scope.sessionId === id
            : event.type === "ping" ? event.sessionId === id
            : event.type === "message" ? event.msg.channel === undefined && (
              messages.has(event.msg.id) || event.msg.fromSessionId === id || event.msg.toSessionId === id
            ) : false;
          if (belongs) this.db.run("DELETE FROM protocol_events WHERE position=?", row.position);
        }
        this.db.run("DELETE FROM messages WHERE channel IS NULL AND (from_session=? OR to_session=?)", id, id);
        this.db.run("DELETE FROM human_read_positions WHERE scope='session' AND stream_key=?", id);
        this.db.run("DELETE FROM session_harness_ids WHERE identity_id=?", id);
        this.db.run("DELETE FROM claude_lineage WHERE identity_id=?", id);
        this.db.run("DELETE FROM channel_members WHERE session_id=?", id);
        this.db.run("DELETE FROM session_identities WHERE id=?", id);
      }
    });
  }

  msg(id: string): MsgRow | undefined {
    return this.db.get<MsgRow>("SELECT * FROM messages WHERE id=?", id);
  }

  withReplyState<T extends WireMsg>(message: T, sessionId?: string): T {
    if (!message.replyTo) return message;
    const target = sessionId === undefined
      ? this.db.get<{ one: number }>("SELECT 1 AS one FROM messages WHERE id=? AND channel IS NULL", message.replyTo)
      : this.db.get<{ one: number }>(
        `SELECT 1 AS one FROM messages WHERE id=? AND channel IS NULL
         AND (from_session=? OR (to_session=? AND status IN ('delivered','replied','queued')))`,
        message.replyTo, sessionId, sessionId,
      );
    const { replyToMissing: _previous, ...retained } = message;
    return { ...retained, ...(target ? {} : { replyToMissing: true }) } as T;
  }

  private projectEvent(row: { position: number; event_json: string }): PositionedEvent {
    const event = JSON.parse(row.event_json) as TailEvent;
    return {
      position: row.position,
      event: event.type === "message" ? { ...event, msg: this.withReplyState(event.msg) } : event,
    };
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

  failedCount(): number {
    return Number(this.db.get<{ n: number }>(
      "SELECT count(*) AS n FROM messages WHERE channel IS NULL AND status IN ('failed','expired')",
    )?.n ?? 0);
  }

  /** Delivery confirmation is reciprocal by durable endpoints, not historical names. */
  hasDeliveredReply(original: MsgRow): boolean {
    if (original.channel !== null || (original.status !== "delivered"
      && !(original.status === "posted" && original.to_session === null && original.to_name === "human"))) return false;
    if ((!original.from_session && original.from_name !== "human")
      || (!original.to_session && original.to_name !== "human")) return false;
    return this.db.get<{ one: number }>(
      `SELECT 1 AS one FROM messages WHERE channel IS NULL AND reply_to=? AND ord>?
       AND (status IN ('delivered','replied') OR (status='posted' AND to_session IS NULL AND to_name='human'))
       AND ((from_session IS NOT NULL AND from_session=?) OR (from_session IS NULL AND from_name='human' AND ? IS NULL))
       AND ((to_session IS NOT NULL AND to_session=?) OR (to_session IS NULL AND to_name='human' AND ? IS NULL))
       LIMIT 1`,
      original.id, original.ord, original.to_session, original.to_session, original.from_session, original.from_session,
    ) !== undefined;
  }

  insertMsg(row: MsgRow): MsgRow {
    const order = (this.meta("message_order") ?? 0) + 1;
    this.setMeta("message_order", order);
    row.ord = order;
    row.delivery_seq = row.channel === null && (row.status === "delivered" || row.status === "replied")
      ? this.nextDeliverySequence() : null;
    this.db.run(
      `INSERT INTO messages(id,from_name,from_session,to_name,to_session,channel,source_channel,text,file,kind,action,thread,reply_to,done,status,reason,attempts,created_at,updated_at,ord,delivery_seq)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      row.id, row.from_name, row.from_session, row.to_name, row.to_session, row.channel, row.source_channel ?? null, row.text, row.file ?? null, row.kind, row.action ?? null, row.thread, row.reply_to,
      row.done, row.status, row.reason, row.attempts, row.created_at, row.updated_at, row.ord, row.delivery_seq,
    );
    if (row.channel === null) {
      this.recordDirectActivity(row.from_session, row.created_at);
      if (row.status === "delivered") this.recordDirectActivity(row.to_session, row.updated_at);
    }
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
    ).map((row) => this.projectEvent(row));
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

  hasChannel(name: string): boolean {
    return this.db.get("SELECT 1 FROM channels WHERE name=?", name) !== undefined;
  }

  createChannel(name: string): boolean {
    const created = this.db.run("INSERT OR IGNORE INTO channels(name) VALUES(?)", name).changes > 0;
    this.ensureRead({ scope: "channel", channel: name });
    return created;
  }

  channelMembers(name: string): SessionIdentity[] {
    return this.db.all<IdentityRow>(
      `SELECT i.* FROM session_identities i JOIN channel_members m ON m.session_id=i.id
       WHERE m.channel=? ORDER BY i.created_at,i.id`, name,
    ).map(toIdentity);
  }

  private channelMemberIds(name: string): string[] {
    const rows = this.db.all<{ id: string }>(
      `SELECT i.id FROM session_identities i JOIN channel_members m ON m.session_id=i.id
       WHERE m.channel=? ORDER BY i.created_at,i.id`, name,
    );
    return rows.map((row) => row.id);
  }

  isChannelMember(name: string, sessionId: string): boolean {
    return this.db.get("SELECT 1 FROM channel_members WHERE channel=? AND session_id=?", name, sessionId) !== undefined;
  }

  shareChannel(first: string, second: string): boolean {
    return this.db.get(
      `SELECT 1 FROM channel_members a JOIN channel_members b ON b.channel=a.channel
       WHERE a.session_id=? AND b.session_id=? LIMIT 1`, first, second,
    ) !== undefined;
  }

  addChannelMember(name: string, sessionId: string): boolean {
    return this.db.run("INSERT OR IGNORE INTO channel_members(channel,session_id) VALUES(?,?)", name, sessionId).changes > 0;
  }

  removeChannelMember(name: string, sessionId: string): boolean {
    return this.db.run("DELETE FROM channel_members WHERE channel=? AND session_id=?", name, sessionId).changes > 0;
  }

  channelSummary(name: string): ChannelSummary {
    const summary = this.db.get<{ count: number; lastAt: number; lastOrder: number }>(
      `SELECT count(*) AS count,COALESCE(max(created_at),0) AS lastAt,COALESCE(max(ord),0) AS lastOrder
       FROM messages WHERE channel=?`, name,
    )!;
    return { name, ...summary, memberIds: this.channelMemberIds(name) };
  }

  channelSummaries(): ChannelSummary[] {
    return this.db.all<{ name: string; count: number; lastAt: number; lastOrder: number }>(
      `SELECT c.name,count(m.id) AS count,COALESCE(max(m.created_at),0) AS lastAt,COALESCE(max(m.ord),0) AS lastOrder
       FROM channels c LEFT JOIN messages m ON m.channel=c.name GROUP BY c.name ORDER BY lastOrder DESC,c.name`,
    ).map((summary) => ({ ...summary, memberIds: this.channelMemberIds(summary.name) }));
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
        latest: this.withReplyState(toStored(row)),
      };
    });
  }

  /** The newest `limit` retained protocol events in ascending position order. */
  recentEvents(limit: number): PositionedEvent[] {
    return this.db.all<{ position: number; event_json: string }>(
      "SELECT * FROM (SELECT position,event_json FROM protocol_events ORDER BY position DESC LIMIT ?) ORDER BY position",
      limit,
    ).map((row) => this.projectEvent(row));
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

  reconcileReads(cutoff: number): { states: ReadState[]; channels: ChannelSummary[]; removedPositions: number; removedIdentities: number } {
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
    const removedPositions = this.db.run(
      `DELETE FROM human_read_positions WHERE scope='session'
       AND EXISTS(SELECT 1 FROM session_identities WHERE id=human_read_positions.stream_key AND state='removed' AND removed_at<?)
       AND NOT EXISTS(SELECT 1 FROM messages WHERE from_session=human_read_positions.stream_key OR to_session=human_read_positions.stream_key)`,
      cutoff,
    ).changes;
    const removed = this.transaction(() => {
      const channels = this.db.all<{ channel: string }>(
        `SELECT DISTINCT m.channel FROM channel_members m JOIN session_identities i ON i.id=m.session_id
         WHERE i.state='removed' AND i.removed_at<?
         AND NOT EXISTS(SELECT 1 FROM messages WHERE from_session=i.id OR to_session=i.id)`,
        cutoff,
      );
      this.db.run(
        `DELETE FROM channel_members WHERE session_id IN (
         SELECT id FROM session_identities WHERE state='removed' AND removed_at<?
         AND NOT EXISTS(SELECT 1 FROM messages WHERE from_session=session_identities.id OR to_session=session_identities.id))`,
        cutoff,
      );
      const identities = this.db.run(
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
      return { channels: channels.map((row) => this.channelSummary(row.channel)), identities };
    });
    const states: ReadState[] = [];
    for (const scope of changed) {
      const key = scope.scope === "session" ? scope.sessionId : scope.channel;
      const row = this.db.get<ReadRow>(
        "SELECT * FROM human_read_positions WHERE scope=? AND stream_key=?",
        scope.scope, key,
      );
      if (row) states.push(this.readStateFromRow(row));
    }
    return { states, channels: removed.channels, removedPositions, removedIdentities: removed.identities };
  }
}
