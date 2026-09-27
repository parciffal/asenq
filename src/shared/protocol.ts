export const PROTOCOL = 1;
export const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
export const RESERVED = ["human", "asenq", "all", "daemon"];
export const MAX_TEXT = 32_000;
export const MAX_LINE = 1024 * 1024;
export const GRACE_MS = 120_000;
export const ACK_TIMEOUT_MS = 10_000;
export const RETRY_MS = 30_000;
export const MAX_ATTEMPTS = 5;
export const PROBE_MS = 30_000;

export type Harness = "claude" | "opencode" | "omp";
export type Inbound = "accept" | "hold" | "refuse";
export type Kind = "chat" | "task" | "result" | "status";
export const KINDS: Kind[] = ["chat", "task", "result", "status"];
export const INBOUND: Inbound[] = ["accept", "hold", "refuse"];

export type ErrCode =
  | "bad_request" | "unknown_target" | "name_taken" | "invalid_name"
  | "too_large" | "not_registered" | "no_session" | "rate_limited" | "internal";

export type Req = { id: number; op: string; [k: string]: unknown };
export type Res =
  | { id: number; ok: true; [k: string]: unknown }
  | { id: number; ok: false; error: { code: ErrCode; message: string } };

export type WireMsg = {
  id: string; from: string; to: string;
  kind?: Kind; thread?: string; replyTo?: string; done?: boolean;
  text: string; createdAt: number;
};

export type MsgStatus =
  | "queued" | "delivered" | "held" | "rejected" | "failed"
  | "expired" | "posted" | "dropped";

export type TailEvent =
  | { type: "session"; action: "registered" | "renamed" | "gone" | "removed";
      name: string; harness: Harness; cwd?: string; oldName?: string }
  | { type: "message"; msg: WireMsg; status: MsgStatus; reason?: string };

/** `session`/`key` identify the target binding on connections that host several sessions. */
export type Push =
  | { push: "deliver"; msg: WireMsg; text: string; session: string; key: string }
  | { push: "event"; event: TailEvent };

export type SendResult = { to: string; msgId?: string; status: MsgStatus | "unknown_target"; reason?: string };

export class AsenqError extends Error {
  constructor(readonly code: ErrCode, message: string) { super(message); }
}

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
}
