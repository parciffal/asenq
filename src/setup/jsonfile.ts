import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

export type Json = Record<string, unknown>;

/** Prints one setup change line with the home directory shortened to `~`. */
export function report(sign: "+" | "-" | "=" | "!", what: string): void {
  process.stdout.write(`${sign} ${what.replaceAll(homedir(), "~")}\n`);
}

function detectIndent(text: string): string {
  const m = /^([ \t]+)\S/m.exec(text);
  return m ? m[1] : "  ";
}

/**
 * Parses `path`, lets `edit` mutate it, and writes it back only when it changed, keeping the
 * file's indent. The first write makes a one-time `<file>.asenq-bak` backup.
 */
export function editJson(path: string, edit: (data: Json) => void): boolean {
  const text = readFileSync(path, "utf8");
  const data = JSON.parse(text) as Json;
  const before = JSON.stringify(data);
  edit(data);
  if (JSON.stringify(data) === before) return false;
  const backup = path + ".asenq-bak";
  if (!existsSync(backup)) copyFileSync(path, backup);
  writeFileSync(path, JSON.stringify(data, null, detectIndent(text)) + "\n");
  return true;
}

export function readJson(path: string): Json | undefined {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as Json;
}

export const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);
