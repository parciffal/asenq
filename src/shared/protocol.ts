export const PROTOCOL = 12;
export const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
export const RESERVED = ["human", "asenq", "all", "daemon"];
export const MAX_TEXT = 32_000;
export const MAX_LINE = 1024 * 1024;
export const GRACE_MS = 120_000;
export const QUEUE_TTL_MS = 86_400_000;
export const ACK_TIMEOUT_MS = 10_000;
export const RETRY_MS = 30_000;
export const MAX_ATTEMPTS = 5;
export const PROBE_MS = 30_000;

export type Harness = "claude" | "opencode" | "omp";
export type Inbound = "accept" | "hold" | "refuse";
export type Role = "orchestrator" | "worker";
export type Kind = "chat" | "task" | "result" | "status" | "control";
export const KINDS: Kind[] = ["chat", "task", "result", "status", "control"];
export type ControlAction = "pause" | "resume" | "cancel";
export const CONTROL_ACTIONS: readonly ControlAction[] = ["pause", "resume", "cancel"];
export const INBOUND: Inbound[] = ["accept", "hold", "refuse"];

export type ErrCode =
  | "bad_request" | "unknown_target" | "name_taken" | "invalid_name"
  | "unknown_channel" | "not_live" | "ambiguous_target"
  | "too_large" | "not_registered" | "not_permitted" | "no_session" | "rate_limited" | "internal";

export type Req = { id: number; op: string; [k: string]: unknown };
export type Res =
  | { id: number; ok: true; [k: string]: unknown }
  | { id: number; ok: false; error: { code: ErrCode; message: string } };

export type FileReference = { path: string; summary: string; sha256: string; size: number };

export type WireMsg = {
  id: string; from: string; to: string;
  kind?: Kind; action?: ControlAction; thread?: string; replyTo?: string; done?: boolean;
  /** The reply target is no longer retained or is not readable by this caller. */
  replyToMissing?: boolean;
  text: string; file?: FileReference; createdAt: number;
};

export type MsgStatus =
  | "queued" | "delivered" | "replied" | "held" | "rejected" | "failed"
  | "expired" | "posted" | "dropped";

/** Retained history and held replies include durable order and delivery state.
 * Scope held actions by session ids; historical from/to names can outlive a rename. */
export type StoredMessage = WireMsg & {
  order: number;
  fromSessionId?: string;
  channel?: string;
  toSessionId?: string;
  status: MsgStatus;
  reason?: string;
};

export type SessionState = "live" | "gone" | "removed";
export type PingStatus = "responding" | "not_responding" | "unknown";

/** Stable historical identity; names can be reused, but ids cannot. */
export type SessionIdentity = {
  id: string;
  name: string;
  previousNames: string[];
  harness: Harness | "unknown";
  cwd?: string;
  state: SessionState;
  inbound: Inbound;
  role?: Role | null;
  createdAt: number;
  removedAt?: number;
  closedAt?: number;
};

export type ChannelSummary = {
  name: string;
  count: number;
  lastAt: number;
  lastOrder: number;
  memberIds?: string[];
};

export type HistoryScope =
  | { scope: "session"; sessionId: string }
  | { scope: "inbox" }
  | { scope: "channel"; channel: string };

export type HistoryPageRequest = HistoryScope & { before?: number; limit?: number };
export type ReadScope = Exclude<HistoryScope, { scope: "inbox" }>;

/** `position` is monotone; `reminder` is one independently persisted unread item. */
export type ReadState = {
  scope: ReadScope;
  position: number;
  reminder: number | null;
  version: number;
  unread: number;
};

export type TailEvent =
  | { type: "session"; action: "registered" | "renamed" | "gone" | "removed" | "updated";
      name: string; harness: Harness; cwd?: string; oldName?: string; reason?: string; session: SessionIdentity }
  | { type: "channel"; action: "created" | "updated"; channel: ChannelSummary }
  | { type: "message"; msg: StoredMessage; status: MsgStatus; reason?: string; failedCount?: number }
  | { type: "read"; state: ReadState }
  | { type: "ping"; sessionId: string; ping: PingStatus }
  | { type: "retention" };

export type PositionedEvent = { position: number; event: TailEvent };

export type SyncResult = {
  watermark: number;
  eventFloor: number;
  sessions: SessionIdentity[];
  channels: ChannelSummary[];
  readStates: ReadState[];
  failedCount: number;
  /** Latest retained non-channel message order per stable session identity; absent means zero. */
  sessionLastOrders: Record<string, number>;
  /** Durable direct activity: outgoing creation or first incoming delivery, excluding channel posts. */
  sessionLastActivity: Record<string, number>;
  sessionPings: Record<string, PingStatus>;
};

/** Latest incoming human-inbox message from one sender; `sessionId` is absent for legacy name-only senders. */
export type InboxSummary = {
  sessionId?: string;
  name: string;
  latest: StoredMessage;
};

export type RecentEventsResult = { events: PositionedEvent[]; watermark: number; eventFloor: number };

export type HistoryPage = { messages: StoredMessage[]; hasMore: boolean };

export type ReplayResult = {
  events: PositionedEvent[];
  gap: boolean;
  hasMore: boolean;
  eventFloor: number;
  watermark: number;
};

export type ReadMutationResult = { applied: boolean; state: ReadState };

/** `session`/`key` identify the target binding on connections that host several sessions. */
export type Push =
  | { push: "deliver"; msg: WireMsg; text: string; session: string; key: string }
  | { push: "ping"; pingId: string }
  | { push: "event"; position: number; event: TailEvent };

export type SendResult = { to: string; msgId?: string; status: MsgStatus | "unknown_target"; reason?: string };

export type SendOptions = {
  kind?: Kind;
  action?: ControlAction;
  thread?: string;
  replyTo?: string;
  done?: boolean;
};

export class AsenqError extends Error {
  constructor(readonly code: ErrCode, message: string) { super(message); }
}

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
}
