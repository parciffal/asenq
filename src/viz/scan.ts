import { execFile } from "node:child_process";
import { basename } from "node:path";
import type { VizHarness } from "./types.js";

export type ProcInfo = { pid: number; harness: VizHarness; command: string; elapsedSec: number; cpu: number };

/** Interpreters that launch a harness script: the harness is then the first script argument, not argv0. */
const RUNTIMES: Record<string, true> = { node: true, nodejs: true, bun: true, bunx: true, deno: true };
/** Runtimes whose `run` subcommand precedes the script. */
const RUN_SUBCOMMAND: Record<string, true> = { bun: true, deno: true };
const HARNESSES: Record<string, VizHarness> = { claude: "claude", omp: "omp", opencode: "opencode", codex: "codex" };
/** First non-flag argument of short-lived or background helper invocations that are not an interactive agent. */
const HELPER_SUBCOMMANDS: Record<string, true> = {
  "bg-spare": true, mcp: true, "mcp-server": true, "app-server": true, serve: true,
  login: true, logout: true, doctor: true, update: true,
};
const NO_TTY: Record<string, true> = { "?": true, "??": true, "-": true };
const SCRIPT_EXTENSION = /\.(?:[cm]?js|ts|exe)$/;

/**
 * Decides from argv alone (never substrings of the whole line) whether a command line is an interactive
 * agent of a known harness. Wrapper/helper processes — `npm exec …`, MCP servers, `claude bg-spare`,
 * omp `__omp_worker_*` threads, editors and greps that merely mention a harness — yield null.
 * Arguments are split on whitespace, so executable paths containing spaces are not recognised.
 */
export function classify(command: string): VizHarness | null {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return null;
  const exec = tokens[0];
  let args = tokens.slice(1);
  const runtime = basename(exec);
  let name = runtime.replace(SCRIPT_EXTENSION, "");
  let versioned = exec.includes("/claude/versions/");
  if (!versioned && RUNTIMES[runtime]) {
    const first = args.findIndex((t) => !t.startsWith("-"));
    if (RUN_SUBCOMMAND[runtime] && first >= 0 && args[first] === "run") args = args.filter((_, i) => i !== first);
    const script = args.findIndex((t) => !t.startsWith("-"));
    if (script < 0) return null;
    const target = args[script];
    args = args.slice(script + 1);
    name = basename(target).replace(SCRIPT_EXTENSION, "");
    versioned = target.includes("/claude/versions/");
  }
  const harness = versioned ? "claude" : Object.hasOwn(HARNESSES, name) ? HARNESSES[name] : undefined;
  if (!harness) return null;
  if (tokens.some((t) => t === "--bg-spare" || t.startsWith("__omp_worker"))) return null;
  const sub = args.find((t) => !t.startsWith("-"));
  if (sub !== undefined && HELPER_SUBCOMMANDS[sub]) return null;
  return harness;
}

/** `[[dd-]hh:]mm:ss` to seconds; null when malformed. */
function parseEtime(value: string): number | null {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(value);
  if (!m) return null;
  const [, d = "0", h = "0", mm, ss] = m;
  return ((Number(d) * 24 + Number(h)) * 60 + Number(mm)) * 60 + Number(ss);
}

/** Parses `ps -axo pid=,tty=,etime=,pcpu=,command=`; keeps only TTY-attached processes `classify` accepts. */
export function parsePs(output: string): ProcInfo[] {
  const procs: ProcInfo[] = [];
  for (const line of output.split("\n")) {
    const m = /^\s*(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S.*?)\s*$/.exec(line);
    if (!m) continue;
    const [, pid, tty, etime, pcpu, command] = m;
    if (NO_TTY[tty]) continue;
    const harness = classify(command);
    const elapsedSec = parseEtime(etime);
    const cpu = Number(pcpu);
    if (!harness || elapsedSec === null || !Number.isFinite(cpu)) continue;
    procs.push({ pid: Number(pid), harness, command, elapsedSec, cpu });
  }
  return procs;
}

function runPs(): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  execFile("ps", ["-axo", "pid=,tty=,etime=,pcpu=,command="], { timeout: 3000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
    if (error) reject(error);
    else resolve(stdout);
  });
  return promise;
}

/** Lists running agent processes; any failure (or Windows, which has no compatible `ps`) yields []. */
export async function scanProcesses(run: () => Promise<string> = runPs): Promise<ProcInfo[]> {
  if (process.platform === "win32") return [];
  try {
    return parsePs(await run());
  } catch {
    return [];
  }
}
