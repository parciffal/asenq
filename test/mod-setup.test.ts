import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync,
  symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const tmp = realpathSync(tmpdir());
type Result = { status: number | null; out: string; lines: string[] };

const garbage: string[] = [];
after(() => { for (const p of garbage) rmSync(p, { recursive: true, force: true }); });

/** Stub `claude` that answers --version and applies `mcp add/remove/get` to ~/.claude.json. */
const CLAUDE_STUB = `#!/usr/bin/env node
const fs = require("fs");
const home = process.env.HOME;
const a = process.argv.slice(2);
if (a[0] === "--version") { console.log("2.1.283"); process.exit(0); }
fs.appendFileSync(home + "/claude-argv.log", JSON.stringify(a) + "\\n");
const f = home + "/.claude.json";
const d = JSON.parse(fs.readFileSync(f, "utf8"));
d.mcpServers ??= {};
if (a[0] === "mcp" && a[1] === "add") {
  const i = a.indexOf("--");
  d.mcpServers[a[i - 1]] = { type: "stdio", command: a[i + 1], args: a.slice(i + 2), env: {} };
} else if (a[0] === "mcp" && a[1] === "remove") {
  const name = a[a.length - 1];
  if (!d.mcpServers[name]) { process.stderr.write("No MCP server named " + name); process.exit(1); }
  delete d.mcpServers[name];
} else if (a[0] === "mcp" && a[1] === "get") {
  process.exit(d.mcpServers[a[2]] ? 0 : 1);
}
fs.writeFileSync(f, JSON.stringify(d, null, 2));
`;

function makePkg(): string {
  const root = mkdtempSync(join(tmp, "asenq-pkg-"));
  cpSync(join(repo, "dist", "src"), join(root, "dist", "src"), { recursive: true });
  cpSync(join(repo, "skills"), join(root, "skills"), { recursive: true });
  cpSync(join(repo, "mods"), join(root, "mods"), { recursive: true });
  cpSync(join(repo, "package.json"), join(root, "package.json"));
  symlinkSync(join(repo, "node_modules"), join(root, "node_modules"), "dir");
  garbage.push(root);
  return root;
}

function makeHome(dirs: Partial<Record<"claude" | "opencode" | "omp", boolean>> = { claude: true }): string {
  const home = mkdtempSync(join(tmp, "asenq-home-"));
  mkdirSync(join(home, "bin"));
  writeFileSync(join(home, ".claude.json"), '{"mcpServers":{}}');
  writeFileSync(join(home, "bin", "claude"), CLAUDE_STUB);
  chmodSync(join(home, "bin", "claude"), 0o755);
  if (dirs.claude) mkdirSync(join(home, ".claude"), { recursive: true });
  if (dirs.opencode) mkdirSync(join(home, ".config", "opencode"), { recursive: true });
  if (dirs.omp) mkdirSync(join(home, ".omp", "agent"), { recursive: true });
  garbage.push(home);
  return home;
}

function childEnv(home: string, extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    ASENQ_HOME: join(home, ".asenq"),
    PI_CODING_AGENT_DIR: undefined,
    PATH: `${join(home, "bin")}:${process.env.PATH ?? ""}`,
    ...extra,
  };
}

function spawnCli(pkg: string, env: NodeJS.ProcessEnv, ...args: string[]): Result {
  const r = spawnSync(process.execPath, [join(pkg, "dist", "src", "cli.js"), ...args], { encoding: "utf8", env });
  assert.equal(r.stderr, "", `stderr from asenq ${args.join(" ")}`);
  const out = r.stdout ?? "";
  return { status: r.status, out, lines: out.trim().split("\n") };
}

const run = (pkg: string, home: string, ...args: string[]): Result => spawnCli(pkg, childEnv(home), ...args);
const stopDaemon = (pkg: string, home: string): void => {
  spawnSync(process.execPath, [join(pkg, "dist", "src", "cli.js"), "daemon", "stop"], { encoding: "utf8", env: childEnv(home) });
};

function doctor(pkg: string, home: string): Result {
  try { return run(pkg, home, "doctor"); }
  finally { stopDaemon(pkg, home); }
}

type Settings = Record<string, unknown>;
const settings = (home: string): Settings => JSON.parse(readFileSync(join(home, ".claude/settings.json"), "utf8"));
const pluginDirs = (s: Settings): string[] => {
  const env = s.env as Record<string, unknown> | undefined;
  const dirs = typeof env?.CLAUDE_CODE_PLUGIN_DIRS === "string" ? env.CLAUDE_CODE_PLUGIN_DIRS : "";
  return dirs ? dirs.split(":").filter(Boolean) : [];
};

test("setup installs the mod folder and adds it to PLUGIN_DIRS", () => {
  const pkg = makePkg();
  const home = makeHome();

  const r = run(pkg, home, "setup");
  assert.equal(r.status, 0);

  const modDir = join(home, ".claude", "mods", "asenq");
  assert.ok(existsSync(join(modDir, ".claude-plugin", "plugin.json")), "plugin.json exists");
  assert.ok(existsSync(join(modDir, "hooks", "register.tsx")), "register.tsx exists");
  assert.ok(existsSync(join(modDir, "hooks", "format.ts")), "format.ts exists");
  assert.ok(existsSync(join(modDir, "types", "index.d.ts")), "types/index.d.ts exists");
  assert.ok(existsSync(join(modDir, "asenq-cli.json")), "asenq-cli.json exists");

  // Test files should be excluded
  assert.ok(!existsSync(join(modDir, "hooks", "asenq.test.tsx")), "test file excluded");

  // PLUGIN_DIRS should contain the mod path
  const dirs = pluginDirs(settings(home));
  assert.ok(dirs.includes(modDir), `PLUGIN_DIRS contains ${modDir}`);

  // asenq-cli.json should have the right argv
  const cli = JSON.parse(readFileSync(join(modDir, "asenq-cli.json"), "utf8"));
  assert.ok(Array.isArray(cli.argv));
  assert.equal(cli.argv.length, 2);
});

test("setup is idempotent for the mod and does not duplicate PLUGIN_DIRS", () => {
  const pkg = makePkg();
  const home = makeHome();

  run(pkg, home, "setup");
  const second = run(pkg, home, "setup");
  assert.equal(second.status, 0);

  const modDir = join(home, ".claude", "mods", "asenq");
  const dirs = pluginDirs(settings(home));
  const count = dirs.filter((d) => d === modDir).length;
  assert.equal(count, 1, "mod path appears exactly once in PLUGIN_DIRS");
});

test("setup preserves existing PLUGIN_DIRS entries", () => {
  const pkg = makePkg();
  const home = makeHome();

  // Pre-populate with a user's own plugin dir
  writeFileSync(
    join(home, ".claude", "settings.json"),
    JSON.stringify({ env: { CLAUDE_CODE_PLUGIN_DIRS: "/my/plugin:/other/plugin" } }, null, 2) + "\n",
  );

  const r = run(pkg, home, "setup");
  assert.equal(r.status, 0);

  const dirs = pluginDirs(settings(home));
  assert.ok(dirs.includes("/my/plugin"), "preserves /my/plugin");
  assert.ok(dirs.includes("/other/plugin"), "preserves /other/plugin");
  assert.ok(dirs.includes(join(home, ".claude", "mods", "asenq")), "adds mod dir");
});

test("setup --remove strips mod entry from PLUGIN_DIRS and deletes folder", () => {
  const pkg = makePkg();
  const home = makeHome();

  run(pkg, home, "setup");
  const modDir = join(home, ".claude", "mods", "asenq");
  assert.ok(existsSync(modDir));

  const r = run(pkg, home, "setup", "--remove");
  assert.equal(r.status, 0);
  assert.ok(!existsSync(modDir), "mod dir removed");

  const dirs = pluginDirs(settings(home));
  assert.ok(!dirs.includes(modDir), "mod dir removed from PLUGIN_DIRS");
});

test("setup --remove leaves other PLUGIN_DIRS entries intact", () => {
  const pkg = makePkg();
  const home = makeHome();

  // Pre-populate with a user's own plugin dir
  writeFileSync(
    join(home, ".claude", "settings.json"),
    JSON.stringify({ env: { CLAUDE_CODE_PLUGIN_DIRS: "/my/plugin" } }, null, 2) + "\n",
  );

  run(pkg, home, "setup");
  const r = run(pkg, home, "setup", "--remove");
  assert.equal(r.status, 0);

  const s = settings(home);
  const dirs = pluginDirs(s);
  assert.ok(dirs.includes("/my/plugin"), "user's plugin dir preserved");
  assert.ok(!dirs.includes(join(home, ".claude", "mods", "asenq")), "mod dir removed");
});

test("setup --remove deletes env key when PLUGIN_DIRS ends up empty and asenq created it", () => {
  const pkg = makePkg();
  const home = makeHome();

  run(pkg, home, "setup");
  const r = run(pkg, home, "setup", "--remove");
  assert.equal(r.status, 0);

  const s = settings(home);
  const env = s.env as Record<string, unknown> | undefined;
  // env.CLAUDE_CODE_PLUGIN_DIRS should be gone
  assert.ok(!env || !("CLAUDE_CODE_PLUGIN_DIRS" in env), "CLAUDE_CODE_PLUGIN_DIRS key removed when empty");
});

test("doctor reports mod as installed and registered", () => {
  const pkg = makePkg();
  const home = makeHome();
  run(pkg, home, "setup");

  const d = doctor(pkg, home);
  assert.equal(d.status, 0);
  assert.ok(d.out.includes("claude mod: installed and registered"), "mod is ok");
});

test("doctor reports mod not installed when folder is missing", () => {
  const pkg = makePkg();
  const home = makeHome();
  run(pkg, home, "setup");

  // Remove the mod
  rmSync(join(home, ".claude", "mods", "asenq"), { recursive: true });

  const d = doctor(pkg, home);
  assert.equal(d.status, 1);
  assert.ok(d.out.includes("claude mod:") && d.out.includes("not installed"), "mod missing");
});

test("doctor reports mod not in PLUGIN_DIRS when entry is missing", () => {
  const pkg = makePkg();
  const home = makeHome();
  run(pkg, home, "setup");

  // Remove the PLUGIN_DIRS entry only
  const s = settings(home);
  (s as any).env = {};
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify(s, null, 2) + "\n");

  const d = doctor(pkg, home);
  assert.equal(d.status, 1);
  assert.ok(d.out.includes("claude mod:") && d.out.includes("not in CLAUDE_CODE_PLUGIN_DIRS"), "mod not registered");
});
