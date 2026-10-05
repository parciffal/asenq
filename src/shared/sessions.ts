import type { PingStatus, SessionIdentity } from "./protocol.js";

export function isStaleSession(
  session: Pick<SessionIdentity, "state">,
  ping: PingStatus | null | undefined,
): boolean {
  if (session.state === "removed") return false;
  if (session.state === "gone") return true;
  return ping === "not_responding";
}
