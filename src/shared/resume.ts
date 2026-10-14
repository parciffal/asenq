import type { Harness } from "./protocol.js";

/** Commands are for a POSIX shell; a harness id must remain one argument. */
export function resumeCommand(harness: Harness, sessionId: string | null): string | undefined {
  if (!sessionId) return undefined;
  const id = /^[a-zA-Z0-9_./:-]+$/.test(sessionId)
    ? sessionId
    : "'" + sessionId.replace(/'/g, "'\\''") + "'";
  if (sessionId.startsWith("-")) {
    return `${harness} ${harness === "opencode" ? "--session" : "--resume"}=${id}`;
  }
  return `${harness} ${harness === "opencode" ? "-s" : "-r"} ${id}`;
}
