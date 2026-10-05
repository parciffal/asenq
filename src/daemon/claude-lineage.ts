import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

const HEAD_LINES = 8;
const HEAD_BYTES = 256 * 1024;

/** Only transcript-head message identifiers establish Claude resume lineage. */
export function claudeLineage(path: string | null | undefined, requireCompleteHead = false): string[] {
  if (!path) return [];
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    if (!fstatSync(fd).isFile()) return [];
    const buffer = Buffer.allocUnsafe(HEAD_BYTES);
    let used = 0;
    let lines = 0;
    let end = 0;
    while (used < HEAD_BYTES && lines < HEAD_LINES) {
      const count = readSync(fd, buffer, used, Math.min(4096, HEAD_BYTES - used), null);
      if (count === 0) {
        end = used;
        break;
      }
      const next = used + count;
      for (let i = used; i < next; i++) {
        if (buffer[i] === 10 && ++lines === HEAD_LINES) {
          end = i + 1;
          break;
        }
      }
      used = next;
    }
    // Resume files may still be growing; do not select an ancestor from a partial head.
    if (end === 0 || (requireCompleteHead && lines < HEAD_LINES)) return [];
    const fingerprints = new Set<string>();
    for (const line of buffer.subarray(0, end).toString("utf8").split("\n").slice(0, HEAD_LINES)) {
      if (!line.trim()) continue;
      const row: unknown = JSON.parse(line);
      if (!row || typeof row !== "object" || Array.isArray(row)) return [];
      const entry = row as Record<string, unknown>;
      if (entry.type === "atis-latch") continue;
      if (typeof entry.uuid === "string" && entry.uuid) fingerprints.add(entry.uuid);
      if (entry.type === "file-history-snapshot") {
        const messageId = entry.messageId;
        if (typeof messageId === "string" && messageId) fingerprints.add(messageId);
      }
    }
    return [...fingerprints];
  } catch {
    return [];
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
