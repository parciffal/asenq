import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { lockedPid } from "../daemon/main.js";
import { readConfig, writeConfig } from "../shared/config.js";
import { configPath, dbPath } from "../shared/paths.js";
import { DEFAULT_STALE_HOURS } from "../shared/sessions.js";
import { editJson, isObj, readJson, report, type Json } from "./jsonfile.js";

export const CLAUDE_EVENTS = ["SessionStart", "SessionEnd", "PostToolUse", "UserPromptSubmit", "Stop"] as const;
export const ASENQ_HOOK_RE = /asenq.* hook claude$/;
const LEGACY_HOOK = "messenger-poll.js";

export type Install = { runtime: string; cli: string; opencodeAdapter: string; ompAdapter: string };

export function install(): Install {
  const cli = realpathSync(fileURLToPath(new URL("../cli.js", import.meta.url)));
  return {
    runtime: process.execPath,
    cli,
    opencodeAdapter: fileURLToPath(new URL("../adapters/opencode.js", import.meta.url)),
    ompAdapter: fileURLToPath(new URL("../adapters/omp.js", import.meta.url)),
  };
}

export const claudeDir = (): string => join(homedir(), ".claude");
export const opencodeDir = (): string => join(homedir(), ".config", "opencode");
export const ompAgentDir = (): string => process.env.PI_CODING_AGENT_DIR || join(homedir(), ".omp", "agent");
export const hookCommand = (i: Install): string => `"${i.runtime}" "${i.cli}" hook claude`;
export const opencodeShim = (i: Install): string => `export { server } from "${pathToFileURL(i.opencodeAdapter).href}";\n`;
export const ompShim = (i: Install): string => `export { default } from "${pathToFileURL(i.ompAdapter).href}";\n`;

type Handler = { command?: unknown };
type Group = { matcher?: string; hooks?: Handler[] };

/** Removes handlers matching `drop` from every hook group; empty groups and events disappear. */
function stripHandlers(settings: Json, drop: (h: Handler) => boolean): string[] {
  const removed: string[] = [];
  const hooks = settings.hooks;
  if (!isObj(hooks)) return removed;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    const kept: Group[] = [];
    for (const g of groups as Group[]) {
      if (!Array.isArray(g?.hooks)) {
        kept.push(g);
        continue;
      }
      const handlers = g.hooks.filter((h) => !drop(h));
      if (handlers.length !== g.hooks.length) removed.push(event);
      if (handlers.length) kept.push({ ...g, hooks: handlers });
    }
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
  }
  if (Object.keys(hooks).length === 0) delete settings.hooks;
  return removed;
}

/** asenq's handler: this install's exact command, or any install path that contains "asenq". */
const asenqHandler = (command: string) => (h: Handler): boolean =>
  typeof h?.command === "string" && (h.command === command || ASENQ_HOOK_RE.test(h.command));

function desiredGroup(event: string, command: string): Group {
  return { ...(event === "PostToolUse" ? { matcher: "*" } : {}), hooks: [{ type: "command", command, timeout: 10 } as Handler] };
}

/** True when `event` holds exactly one asenq group equal to the desired one. */
export function claudeHookInstalled(settings: Json, event: string, command: string): boolean {
  const groups = isObj(settings.hooks) ? settings.hooks[event] : undefined;
  if (!Array.isArray(groups)) return false;
  const ours = (groups as Group[]).filter((g) => Array.isArray(g?.hooks) && g.hooks.some(asenqHandler(command)));
  return ours.length === 1 && JSON.stringify(ours[0]) === JSON.stringify(desiredGroup(event, command));
}

function claude(args: string[]): { ok: boolean; missing: boolean; out: string } {
  const r = spawnSync("claude", args, { encoding: "utf8" });
  const missing = !!r.error && "code" in r.error && r.error.code === "ENOENT";
  return { ok: r.status === 0, missing, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

function claudeUserMcp(name: string): Json | undefined {
  const servers = readJson(join(homedir(), ".claude.json"))?.mcpServers;
  const s = isObj(servers) ? servers[name] : undefined;
  return isObj(s) ? s : undefined;
}

function writeShim(path: string, content: string): void {
  if (existsSync(path) && readFileSync(path, "utf8") === content) return report("=", `${path} (unchanged)`);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  report("+", path);
}

function removeFile(path: string): boolean {
  if (!existsSync(path)) return false;
  rmSync(path);
  report("-", path);
  return true;
}

function setupClaude(i: Install): void {
  const settingsPath = join(claudeDir(), "settings.json");
  if (!existsSync(settingsPath)) writeFileSync(settingsPath, "{}\n");
  const command = hookCommand(i);
  for (const event of CLAUDE_EVENTS) {
    let changed = false;
    editJson(settingsPath, (s) => {
      if (claudeHookInstalled(s, event, command)) return;
      const hooks = (isObj(s.hooks) ? s.hooks : (s.hooks = {})) as Json;
      const groups = (Array.isArray(hooks[event]) ? hooks[event] : []) as Group[];
      const kept = groups
        .map((g) => (Array.isArray(g?.hooks) ? { ...g, hooks: g.hooks.filter((h) => !asenqHandler(command)(h)) } : g))
        .filter((g) => !Array.isArray(g?.hooks) || g.hooks.length > 0);
      hooks[event] = [...kept, desiredGroup(event, command)];
      changed = true;
    });
    report(changed ? "+" : "=", `${settingsPath} hooks.${event}: asenq hook claude${changed ? "" : " (unchanged)"}`);
  }

  const current = claudeUserMcp("asenq");
  if (current && current.command === i.runtime && JSON.stringify(current.args) === JSON.stringify([i.cli, "mcp"])) {
    report("=", "claude mcp asenq (unchanged)");
    return;
  }
  const addArgs = ["mcp", "add", "--scope", "user", "--transport", "stdio", "asenq", "--", i.runtime, i.cli, "mcp"];
  claude(["mcp", "remove", "-s", "user", "asenq"]);
  const r = claude(addArgs);
  if (r.missing) report("!", `claude CLI not found; add MCP server manually: claude ${addArgs.join(" ")}`);
  else if (!r.ok) report("!", `claude ${addArgs.join(" ")} failed: ${r.out}`);
  else report("+", `claude mcp asenq: ${i.runtime} ${i.cli} mcp`);
}

/** Removes the Redis-based mcp-messenger wiring. Returns true when anything was removed. */
function removeLegacy(): boolean {
  let removed = false;
  const settingsPath = join(claudeDir(), "settings.json");
  if (existsSync(settingsPath)) {
    let events: string[] = [];
    let enabled = false;
    editJson(settingsPath, (s) => {
      events = stripHandlers(s, (h) => typeof h?.command === "string" && h.command.includes(LEGACY_HOOK));
      const list = s.enabledMcpjsonServers;
      if (Array.isArray(list) && list.includes("messenger")) {
        enabled = true;
        const rest = list.filter((x) => x !== "messenger");
        if (rest.length) s.enabledMcpjsonServers = rest;
        else delete s.enabledMcpjsonServers;
      }
    });
    for (const e of new Set(events)) report("-", `${settingsPath} hooks.${e}: ${LEGACY_HOOK}`);
    if (enabled) report("-", `${settingsPath} enabledMcpjsonServers: messenger`);
    removed ||= events.length > 0 || enabled;
  }
  if (claudeUserMcp("messenger")) {
    const r = claude(["mcp", "remove", "-s", "user", "messenger"]);
    if (r.ok) report("-", "claude mcp messenger");
    else report("!", `claude mcp remove -s user messenger failed: ${r.out}`);
    removed = true;
  }
  const mcpJson = join(claudeDir(), "mcp.json");
  if (existsSync(mcpJson)) {
    const changed = editJson(mcpJson, (d) => {
      if (isObj(d.mcpServers)) delete d.mcpServers.messenger;
    });
    if (changed) report("-", `${mcpJson} mcpServers.messenger`);
    removed ||= changed;
  }
  const dotMcp = join(claudeDir(), ".mcp.json");
  const dot = readJson(dotMcp);
  if (dot && isObj(dot.mcpServers) && "messenger" in dot.mcpServers) {
    const rest = Object.keys(dot.mcpServers).filter((k) => k !== "messenger");
    if (rest.length === 0) removeFile(dotMcp);
    else {
      editJson(dotMcp, (d) => void delete (d.mcpServers as Json).messenger);
      report("-", `${dotMcp} mcpServers.messenger`);
    }
    removed = true;
  }
  removed = removeFile(join(claudeDir(), "hooks", LEGACY_HOOK)) || removed;
  removed = removeFile(join(opencodeDir(), "plugins", "messenger.js")) || removed;
  const ocJson = join(opencodeDir(), "opencode.json");
  if (existsSync(ocJson)) {
    const changed = editJson(ocJson, (d) => {
      if (isObj(d.mcp)) delete d.mcp.messenger;
    });
    if (changed) report("-", `${ocJson} mcp.messenger`);
    removed ||= changed;
  }
  return removed;
}

async function stopDaemon(): Promise<void> {
  const pid = lockedPid();
  if (!pid) return;
  process.kill(pid, "SIGTERM");
  for (let n = 0; n < 30 && lockedPid(); n++) await new Promise((r) => setTimeout(r, 100));
  report("-", `daemon pid ${pid}`);
}

async function remove(): Promise<number> {
  const settingsPath = join(claudeDir(), "settings.json");
  if (existsSync(settingsPath)) {
    let events: string[] = [];
    editJson(settingsPath, (s) => void (events = stripHandlers(s, asenqHandler(hookCommand(install())))));
    for (const e of new Set(events)) report("-", `${settingsPath} hooks.${e}: asenq hook claude`);
  }
  if (claudeUserMcp("asenq")) {
    const r = claude(["mcp", "remove", "-s", "user", "asenq"]);
    if (r.ok) report("-", "claude mcp asenq");
    else report("!", `claude mcp remove -s user asenq failed: ${r.out}`);
  }
  removeFile(join(opencodeDir(), "plugins", "asenq.js"));
  removeFile(join(ompAgentDir(), "extensions", "asenq.js"));
  await stopDaemon();
  removeFile(configPath());
  process.stdout.write(`note: kept message history at ${dbPath()}\n`);
  return 0;
}

export async function setup(argv: string[]): Promise<number> {
  if (argv.includes("--remove")) return remove();
  const i = install();

  const prev = readConfig();
  const cfg = { runtime: i.runtime, cli: i.cli, historyDays: prev?.historyDays ?? 7, staleHours: prev?.staleHours ?? DEFAULT_STALE_HOURS, claude: { envelope: prev?.claude.envelope ?? false } };
  if (prev && JSON.stringify(prev) === JSON.stringify(cfg)) report("=", `${configPath()} (unchanged)`);
  else {
    writeConfig(cfg);
    report("+", `${configPath()}: runtime ${i.runtime}`);
  }

  if (existsSync(claudeDir())) setupClaude(i);
  else process.stdout.write("skip claude: not installed\n");
  if (existsSync(opencodeDir())) writeShim(join(opencodeDir(), "plugins", "asenq.js"), opencodeShim(i));
  else process.stdout.write("skip opencode: not installed\n");
  if (existsSync(ompAgentDir())) writeShim(join(ompAgentDir(), "extensions", "asenq.js"), ompShim(i));
  else process.stdout.write("skip omp: not installed\n");

  if (removeLegacy()) {
    process.stdout.write(
      "note: left ~/.local/share/mcp-messenger, ~/.local/state/mcp-messenger and Redis keys mcp:messenger:* untouched; delete them manually if unused\n");
  }
  return 0;
}
