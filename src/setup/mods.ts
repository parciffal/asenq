import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { editJson, isObj, report, type Json } from "./jsonfile.js";

/** The shipped mods directory: `<package root>/mods`. */
export const modsSourceDir = (): string => fileURLToPath(new URL("../../../mods", import.meta.url));

const SKIP_PATTERNS = [/\.test\./, /\.claude-plugin\/types\//];

function shouldCopy(relativePath: string): boolean {
  return !SKIP_PATTERNS.some((p) => p.test(relativePath));
}

/** Collects the files to copy from source, returning relative paths. */
function collectFiles(src: string, relBase = ""): { rel: string; abs: string }[] {
  const out: { rel: string; abs: string }[] = [];
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
function isModCurrent(dest: string, files: { rel: string; abs: string }[], cliConfig: string): boolean {
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

/**
 * Installs the asenq mod to `~/.claude/mods/asenq`, writes the CLI config file,
 * and adds the path to CLAUDE_CODE_PLUGIN_DIRS in settings.json.
 */
export function installMod(claudeBase: string, runtime: string, cli: string): void {
  const source = join(modsSourceDir(), "asenq");
  if (!existsSync(source)) return;
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
    report("+", `${modDir} (mod installed)`);
  }

  // Add to PLUGIN_DIRS
  addPluginDir(join(claudeBase, "settings.json"), modDir);
}

/** Removes the mod folder and its PLUGIN_DIRS entry. */
export function removeMod(claudeBase: string): void {
  const modDir = join(claudeBase, "mods", "asenq");
  if (existsSync(modDir)) {
    rmSync(modDir, { recursive: true });
    report("-", modDir);
  }
  removePluginDir(join(claudeBase, "settings.json"), modDir);
}

/**
 * Adds `modDir` to `env.CLAUDE_CODE_PLUGIN_DIRS` in settings.json.
 * Uses `:` as the path-list separator (POSIX standard).
 */
function addPluginDir(settingsPath: string, modDir: string): void {
  if (!existsSync(settingsPath)) return;
  let changed = false;
  editJson(settingsPath, (s) => {
    const env = (isObj(s.env) ? s.env : (s.env = {})) as Json;
    const current = typeof env.CLAUDE_CODE_PLUGIN_DIRS === "string" ? env.CLAUDE_CODE_PLUGIN_DIRS : "";
    const dirs = current ? current.split(":").filter(Boolean) : [];
    if (dirs.includes(modDir)) return;
    dirs.push(modDir);
    env.CLAUDE_CODE_PLUGIN_DIRS = dirs.join(":");
    changed = true;
  });
  if (changed) report("+", `${settingsPath} env.CLAUDE_CODE_PLUGIN_DIRS: ${modDir}`);
  else report("=", `${settingsPath} env.CLAUDE_CODE_PLUGIN_DIRS (unchanged)`);
}

/** Removes `modDir` from `env.CLAUDE_CODE_PLUGIN_DIRS`, cleaning up if empty. */
function removePluginDir(settingsPath: string, modDir: string): void {
  if (!existsSync(settingsPath)) return;
  let changed = false;
  editJson(settingsPath, (s) => {
    if (!isObj(s.env)) return;
    const env = s.env as Json;
    const current = typeof env.CLAUDE_CODE_PLUGIN_DIRS === "string" ? env.CLAUDE_CODE_PLUGIN_DIRS : "";
    if (!current) return;
    const dirs = current.split(":").filter((d) => d && d !== modDir);
    if (dirs.length === current.split(":").filter(Boolean).length) return;
    if (dirs.length === 0) {
      delete env.CLAUDE_CODE_PLUGIN_DIRS;
      if (Object.keys(env).length === 0) delete s.env;
    } else {
      env.CLAUDE_CODE_PLUGIN_DIRS = dirs.join(":");
    }
    changed = true;
  });
  if (changed) report("-", `${settingsPath} env.CLAUDE_CODE_PLUGIN_DIRS: ${modDir}`);
}

/** Checks whether the mod is installed and registered in PLUGIN_DIRS. */
export function checkMod(claudeBase: string): { installed: boolean; registered: boolean } {
  const modDir = join(claudeBase, "mods", "asenq");
  const installed = existsSync(join(modDir, ".claude-plugin", "plugin.json"));
  const settingsPath = join(claudeBase, "settings.json");
  let registered = false;
  if (existsSync(settingsPath)) {
    const text = readFileSync(settingsPath, "utf8");
    const data = JSON.parse(text) as Json;
    if (isObj(data.env)) {
      const dirs = typeof data.env.CLAUDE_CODE_PLUGIN_DIRS === "string" ? data.env.CLAUDE_CODE_PLUGIN_DIRS.split(":") : [];
      registered = dirs.includes(modDir);
    }
  }
  return { installed, registered };
}
