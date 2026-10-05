import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { configPath } from "./paths.js";

export type Config = {
  runtime: string;
  cli: string;
  historyDays: number;
  claude: { envelope: boolean };
};

export function readConfig(): Config | undefined {
  const p = configPath();
  if (!existsSync(p)) return undefined;
  const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<Config>;
  return {
    runtime: raw.runtime ?? "",
    cli: raw.cli ?? "",
    historyDays: raw.historyDays ?? 7,
    claude: { envelope: raw.claude?.envelope ?? false },
  };
}

export function writeConfig(c: Config): void {
  writeFileSync(configPath(), JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
}
