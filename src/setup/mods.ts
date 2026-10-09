import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { editJson, isObj, report, type Json } from "./jsonfile.js";

/** The shipped mods directory: `<package root>/mods`. */
export const modsSourceDir = (): string => fileURLToPath(new URL("../../../mods", import.meta.url));

/** Marker file inside the mod folder recording that asenq created PLUGIN_DIRS. */
const CREATED_MARKER = ".asenq-plugin-dirs-created";

const SKIP_PATTERNS = [/\.test\./, /\.claude-plugin\/types\//];

function shouldCopy(relativePath: string): boolean {
  return !SKIP_PATTERNS.some((p) => p.test(relativePath));
}

/** Collects the files to copy from source, returning relative paths. */
function collectFiles(src: string, relBase = ""): { rel: string; abs: string }[] {
  const out: { rel: string; abs: string }[] = [];
  if (!existsSync(src)) return out;
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const abs = join(src, entry.name);
    const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...collectFiles(abs, rel));
    } else if (shouldCopy(rel)) {
      out.push({ rel, abs });
    }
  }
  return out;
}

/** True when every file in `files` exists in `dest` with the same content. */
export function isModCurrent(dest: string, files: { rel: string; abs: string }[], cliConfig: string): boolean {
  for (const f of files) {
    const destPath = join(dest, f.rel);
    if (!existsSync(destPath)) return false;
    if (!readFileSync(destPath).equals(readFileSync(f.abs))) return false;
  }
  const cliPath = join(dest, "asenq-cli.json");
  if (!existsSync(cliPath)) return false;
  if (readFileSync(cliPath, "utf8") !== cliConfig) return false;
  return true;
}

/** Expands `~` at the start of a path to the home directory. */
function expandTilde(p: string): string {
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  if (p === "~") return homedir();
  return p;
}

/**
 * Installs the asenq mod to `~/.claude/mods/asenq`, writes the CLI config file,
 * and adds the path to CLAUDE_CODE_PLUGIN_DIRS in settings.json.
 * Returns 1 on failure (shipped mod missing), 0 on success.
 */
export function installMod(claudeBase: string, runtime: string, cli: string): number {
  const source = join(modsSourceDir(), "asenq");
  if (!existsSync(source) || !existsSync(join(source, ".claude-plugin", "plugin.json"))) {
    report("!", `shipped mod missing from ${source}; reinstall asenq`);
    return 1;
  }
  const modDir = join(claudeBase, "mods", "asenq");
  const cliConfig = JSON.stringify({ argv: [runtime, cli] }, null, 2) + "\n";
  const files = collectFiles(source);

  if (existsSync(modDir) && isModCurrent(modDir, files, cliConfig)) {
    report("=", `${modDir} (mod unchanged)`);
  } else {
    if (existsSync(modDir)) rmSync(modDir, { recursive: true });
    for (const f of files) {
      const destPath = join(modDir, f.rel);
      mkdirSync(join(destPath, ".."), { recursive: true });
      copyFileSync(f.abs, destPath);
    }
    writeFileSync(join(modDir, "asenq-cli.json"), cliConfig);
    report("+", `${modDir} (mod installed; applies to Claude sessions started after setup)`);
  }

  // Add to PLUGIN_DIRS
  addPluginDir(join(claudeBase, "settings.json"), modDir);
  return 0;
}

/** Removes the mod folder and its PLUGIN_DIRS entry. */
export function removeMod(claudeBase: string): void {
  const modDir = join(claudeBase, "mods", "asenq");
  const markerPath = join(modDir, CREATED_MARKER);
  const asenqCreated = existsSync(markerPath);

  if (existsSync(modDir)) {
    rmSync(modDir, { recursive: true });
    report("-", modDir);
  }
  removePluginDir(join(claudeBase, "settings.json"), modDir, asenqCreated);
}

/**
 * Adds `modDir` to `env.CLAUDE_CODE_PLUGIN_DIRS` in settings.json.
 * Uses `:` as the path-list separator (POSIX standard).
 * If PLUGIN_DIRS was absent and asenq creates it, writes a marker file.
 */
function addPluginDir(settingsPath: string, modDir: string): void {
  if (!existsSync(settingsPath)) return;
  let changed = false;
  let wasCreated = false;
  editJson(settingsPath, (s) => {
    const env = (isObj(s.env) ? s.env : (s.env = {})) as Json;
    const raw = env.CLAUDE_CODE_PLUGIN_DIRS;
    // If the existing value is not a string and not undefined, don't overwrite (F-09)
    if (raw !== undefined && typeof raw !== "string") {
      return; // skip; will warn below
    }
    const current = typeof raw === "string" ? raw : "";
    wasCreated = raw === undefined;
    const dirs = current ? current.split(":").filter(Boolean) : [];
    // Normalise tilde entries for dedup (F-09)
    if (dirs.some((d) => expandTilde(d) === modDir)) return;
    dirs.push(modDir);
    env.CLAUDE_CODE_PLUGIN_DIRS = dirs.join(":");
    changed = true;
  });
  if (!changed) {
    // Check if it was skipped because of a non-string value
    const data = JSON.parse(readFileSync(settingsPath, "utf8")) as Json;
    if (isObj(data.env) && data.env.CLAUDE_CODE_PLUGIN_DIRS !== undefined && typeof data.env.CLAUDE_CODE_PLUGIN_DIRS !== "string") {
      report("!", `${settingsPath} env.CLAUDE_CODE_PLUGIN_DIRS is not a string; skipping`);
      return;
    }
    report("=", `${settingsPath} env.CLAUDE_CODE_PLUGIN_DIRS (unchanged)`);
    return;
  }
  report("+", `${settingsPath} env.CLAUDE_CODE_PLUGIN_DIRS: ${modDir}`);
  // Record that asenq created the key (F-09)
  if (wasCreated) {
    const markerPath = join(modDir, CREATED_MARKER);
    if (existsSync(join(modDir))) writeFileSync(markerPath, "");
  }
}

/** Removes `modDir` from `env.CLAUDE_CODE_PLUGIN_DIRS`, cleaning up if empty and asenq created it. */
function removePluginDir(settingsPath: string, modDir: string, asenqCreated: boolean): void {
  if (!existsSync(settingsPath)) return;
  let changed = false;
  editJson(settingsPath, (s) => {
    if (!isObj(s.env)) return;
    const env = s.env as Json;
    const current = typeof env.CLAUDE_CODE_PLUGIN_DIRS === "string" ? env.CLAUDE_CODE_PLUGIN_DIRS : "";
    if (!current) return;
    const dirs = current.split(":").filter((d) => d && expandTilde(d) !== modDir);
    if (dirs.length === current.split(":").filter(Boolean).length) return;
    if (dirs.length === 0 && asenqCreated) {
      // Asenq created the key and it's now empty: delete it
      delete env.CLAUDE_CODE_PLUGIN_DIRS;
      if (Object.keys(env).length === 0) delete s.env;
    } else if (dirs.length === 0) {
      // User owned the key, just clear the value
      delete env.CLAUDE_CODE_PLUGIN_DIRS;
    } else {
      env.CLAUDE_CODE_PLUGIN_DIRS = dirs.join(":");
    }
    changed = true;
  });
  if (changed) report("-", `${settingsPath} env.CLAUDE_CODE_PLUGIN_DIRS: ${modDir}`);
}

export type ModCheckResult = {
  installed: boolean
  registered: boolean
  current: boolean
  cliValid: boolean
}

/** Checks whether the mod is installed, registered, current and has valid CLI paths. */
export function checkMod(claudeBase: string, shippedSource?: string): ModCheckResult {
  const modDir = join(claudeBase, "mods", "asenq");
  const installed = existsSync(join(modDir, ".claude-plugin", "plugin.json"));
  const settingsPath = join(claudeBase, "settings.json");
  let registered = false;
  if (existsSync(settingsPath)) {
    const text = readFileSync(settingsPath, "utf8");
    const data = JSON.parse(text) as Json;
    if (isObj(data.env)) {
      const dirs = typeof data.env.CLAUDE_CODE_PLUGIN_DIRS === "string" ? data.env.CLAUDE_CODE_PLUGIN_DIRS.split(":") : [];
      registered = dirs.some((d) => expandTilde(d) === modDir);
    }
  }

  // Check if mod is current against shipped source (F-10)
  let current = true;
  if (installed && shippedSource) {
    const source = join(shippedSource, "asenq");
    if (existsSync(source)) {
      const files = collectFiles(source);
      for (const f of files) {
        const destPath = join(modDir, f.rel);
        if (!existsSync(destPath) || !readFileSync(destPath).equals(readFileSync(f.abs))) {
          current = false;
          break;
        }
      }
    }
  }

  // Check asenq-cli.json exists and its paths exist (F-10)
  let cliValid = false;
  const cliPath = join(modDir, "asenq-cli.json");
  if (existsSync(cliPath)) {
    try {
      const config = JSON.parse(readFileSync(cliPath, "utf8")) as { argv?: unknown[] };
      if (Array.isArray(config.argv) && config.argv.length >= 2) {
        const [runtime, cli] = config.argv as string[];
        cliValid = typeof runtime === "string" && typeof cli === "string" && existsSync(runtime) && existsSync(cli);
      }
    } catch { /* invalid json */ }
  }

  return { installed, registered, current, cliValid };
}
