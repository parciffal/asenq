import { closeSync, existsSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { readConfig } from "../shared/config.js";
import { dbPath, lockPath, replyDir, socketPath } from "../shared/paths.js";
import { openDb } from "../shared/sqlite.js";
import { Daemon } from "./daemon.js";

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return !!e && typeof e === "object" && "code" in e && e.code === "EPERM";
  }
}

export function lockedPid(): number | undefined {
  if (!existsSync(lockPath())) return undefined;
  const pid = Number(readFileSync(lockPath(), "utf8").trim());
  return Number.isInteger(pid) && pid > 0 && pidAlive(pid) ? pid : undefined;
}

/** Takes the daemon lock; false when another live daemon holds it. */
function takeLock(): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath(), "wx", 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return true;
    } catch (e) {
      if (!(e && typeof e === "object" && "code" in e && e.code === "EEXIST")) throw e;
      if (lockedPid() !== undefined) return false;
      rmSync(lockPath(), { force: true });
    }
  }
  return false;
}

function envMs(name: string): number | undefined {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : undefined;
}

export async function runDaemon(): Promise<void> {
  if (!takeLock()) {
    process.stderr.write(`asenq daemon already running (pid ${lockedPid()})\n`);
    return;
  }
  const cfg = readConfig();
  const db = await openDb(dbPath());
  const daemon = new Daemon({
    socket: socketPath(),
    db,
    replyDir: replyDir(),
    envelope: cfg?.claude.envelope ?? false,
    historyDays: cfg?.historyDays ?? 7,
    // Test seams: acceptance tests shorten the production timings through the environment.
    ackTimeoutMs: envMs("ASENQ_ACK_TIMEOUT_MS"),
    graceMs: envMs("ASENQ_GRACE_MS"),
    tickMs: envMs("ASENQ_TICK_MS"),
  });
  await daemon.listen();
  process.stderr.write(`${new Date().toISOString()} asenq daemon listening on ${socketPath()} (pid ${process.pid})\n`);
  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await daemon.close();
    db.close();
    rmSync(lockPath(), { force: true });
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop());
  process.on("SIGINT", () => void stop());
}
