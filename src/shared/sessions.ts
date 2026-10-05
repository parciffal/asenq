import type { SessionIdentity } from "./protocol.js";

export const DEFAULT_STALE_HOURS = 6;

export function isStaleSession(
  session: Pick<SessionIdentity, "state" | "createdAt">,
  lastDirectAt: number | undefined,
  now: number,
  staleHours: number = DEFAULT_STALE_HOURS,
): boolean {
  if (session.state === "removed") return false;
  if (session.state === "gone") return true;
  return now - (lastDirectAt ?? session.createdAt) >= staleHours * 3600_000;
}
