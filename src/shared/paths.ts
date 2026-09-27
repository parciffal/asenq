import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function asenqHome(): string {
  const dir = process.env.ASENQ_HOME ?? join(homedir(), ".asenq");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export const socketPath = () => join(asenqHome(), "asenq.sock");
export const dbPath = () => join(asenqHome(), "asenq.db");
export const lockPath = () => join(asenqHome(), "daemon.lock");
export const logPath = () => join(asenqHome(), "daemon.log");
export const configPath = () => join(asenqHome(), "config.json");
export const replyDir = () => join(asenqHome(), "r");
