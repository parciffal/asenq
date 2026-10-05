import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { claudeHookInstalled, CLAUDE_EVENTS, claudeDir, hookCommand, ompAgentDir, opencodeDir, type Install } from "./setup/setup.js";
import { isObj, readJson } from "./setup/jsonfile.js";
import { AsenqClient } from "./shared/client.js";
import { readConfig } from "./shared/config.js";
import { PROTOCOL } from "./shared/protocol.js";

type Level = "ok" | "warn" | "fail";

/** Last Claude version whose private envelope format asenq was checked against. */
const ENVELOPE_TESTED = "2.1.283";
const MIN_CLAUDE_SOCKET = "2.1.224";

function cmpVersion(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

function versionOf(bin: string): string | undefined {
  const r = spawnSync(bin, ["--version"], { encoding: "utf8" });
  if (r.status !== 0) return undefined;
  return /\d+\.\d+\.\d+/.exec(r.stdout)?.[0] ?? (r.stdout.trim() || "unknown");
}

/** Resolves the file a shim re-exports from, if the shim exists. */
function shimTarget(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const m = /from "(file:[^"]+)"/.exec(readFileSync(path, "utf8"));
  return m ? fileURLToPath(m[1]) : "";
}

export async function doctor(): Promise<number> {
  let failed = false;
  const line = (level: Level, msg: string): void => {
    if (level === "fail") failed = true;
    process.stdout.write(`${level.padEnd(4)} ${msg}\n`);
  };

  const [major, minor] = process.versions.node.split(".").map(Number);
  if (process.versions.bun) line("ok", `runtime bun ${process.versions.bun}`);
  else if (major > 22 || (major === 22 && minor >= 13)) line("ok", `runtime node ${process.versions.node}`);
  else line("fail", `runtime node ${process.versions.node}; asenq requires Node >= 22.13 or Bun`);

  const cfg = readConfig();
  if (!cfg) line("fail", "config.json missing; run: asenq setup");
  else if (!existsSync(cfg.cli)) line("fail", `config.json cli ${cfg.cli} does not exist; run: asenq setup`);
  else line("ok", `config: runtime ${cfg.runtime}, cli ${cfg.cli}`);

  let sessions: { name: string; harness: string; state: string }[] | undefined;
  if (cfg) {
    const client = new AsenqClient({ autoStart: true });
    try {
      const hello = await client.request("hello", { protocol: PROTOCOL });
      line("ok", `daemon running (asenq ${String(hello.version)})`);
      sessions = (await client.request("list")).sessions as typeof sessions;
    } catch (e) {
      line("fail", `daemon: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      client.close();
    }
  }

  const install: Install | undefined = cfg ? { runtime: cfg.runtime, cli: cfg.cli, opencodeAdapter: "", ompAdapter: "" } : undefined;

  if (existsSync(claudeDir())) {
    const v = versionOf("claude");
    if (!v) line("warn", "claude --version failed; Claude Code not on PATH");
    else if (cmpVersion(v, MIN_CLAUDE_SOCKET) < 0) line("warn", `claude ${v}: idle Claude sessions won't wake; hooks fallback only`);
    else line("ok", `claude ${v}`);

    const settings = readJson(join(claudeDir(), "settings.json")) ?? {};
    const missing = install ? CLAUDE_EVENTS.filter((e) => !claudeHookInstalled(settings, e, hookCommand(install))) : [...CLAUDE_EVENTS];
    if (missing.length) line("fail", `~/.claude/settings.json is missing asenq hooks for ${missing.join(", ")}; run: asenq setup`);
    else line("ok", "claude hooks installed on all five events");

    const mcp = spawnSync("claude", ["mcp", "get", "asenq"], { encoding: "utf8" });
    if (mcp.status === 0) line("ok", "claude mcp asenq registered");
    else line("fail", "claude mcp asenq not registered; run: asenq setup");

    const perms = isObj(settings.permissions) ? settings.permissions : {};
    const bypassNote = 'Claude sessions in bypass mode hold asenq messages for approval; set "crossSessionInbound": "accept" in ~/.claude/settings.json or per session via --settings';
    if (perms.defaultMode === "bypassPermissions" && settings.crossSessionInbound !== "accept") line("warn", bypassNote);

    if (cfg?.claude.envelope) {
      if (v && cmpVersion(v, ENVELOPE_TESTED) > 0) {
        line("warn", `claude.envelope is untested on ${v}; set it to false if sender names or replies break`);
      } else line("ok", "claude.envelope enabled");
    }
  } else line("ok", "claude: not installed, skipped");

  if (existsSync(opencodeDir())) {
    const v = versionOf("opencode");
    const target = shimTarget(join(opencodeDir(), "plugins", "asenq.js"));
    if (!v) line("warn", "opencode --version failed");
    if (target === undefined) line("fail", "~/.config/opencode/plugins/asenq.js missing; run: asenq setup");
    else if (!target || !existsSync(target)) line("fail", `opencode shim points to missing ${target || "(unparseable)"}; run: asenq setup`);
    else if (existsSync(join(opencodeDir(), "plugins", "messenger.js"))) line("fail", "legacy ~/.config/opencode/plugins/messenger.js still present; run: asenq setup");
    else line("ok", `opencode ${v ?? "?"} plugin installed`);
  } else line("ok", "opencode: not installed, skipped");

  if (existsSync(ompAgentDir())) {
    const v = versionOf("omp");
    const target = shimTarget(join(ompAgentDir(), "extensions", "asenq.js"));
    if (!v) line("warn", "omp --version failed");
    if (target === undefined) line("fail", `${join(ompAgentDir(), "extensions", "asenq.js")} missing; run: asenq setup`);
    else if (!target || !existsSync(target)) line("fail", `omp shim points to missing ${target || "(unparseable)"}; run: asenq setup`);
    else line("ok", `omp ${v ?? "?"} extension installed`);
  } else line("ok", "omp: not installed, skipped");

  if (sessions) {
    const live = sessions.filter((s) => s.state === "live" || s.state === "stale");
    line("ok", `${live.length} live session(s)${live.length ? ": " + live.map((s) => `${s.name} (${s.harness})${s.state === "stale" ? " [stale]" : ""}`).join(", ") : ""}`);
  }
  return failed ? 1 : 0;
}
