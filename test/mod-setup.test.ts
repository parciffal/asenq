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
  assert.ok(!existsSync(join(modDir, "hooks", "asenq.test.tsx")), "test file excluded");

  const dirs = pluginDirs(settings(home));
  assert.ok(dirs.includes(modDir), `PLUGIN_DIRS contains ${modDir}`);
});

test("setup is idempotent for the mod and does not duplicate PLUGIN_DIRS", () => {
  const pkg = makePkg();
  const home = makeHome();

  run(pkg, home, "setup");
  const second = run(pkg, home, "setup");
  assert.equal(second.status, 0);

  const modDir = join(home, ".claude", "mods", "asenq");
  const dirs = pluginDirs(settings(home));
  assert.equal(dirs.filter((d) => d === modDir).length, 1, "mod path appears exactly once");
});

test("setup preserves existing PLUGIN_DIRS entries", () => {
  const pkg = makePkg();
  const home = makeHome();

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
  assert.ok(!pluginDirs(settings(home)).includes(modDir), "mod dir removed from PLUGIN_DIRS");
});

test("setup --remove leaves other PLUGIN_DIRS entries intact", () => {
  const pkg = makePkg();
  const home = makeHome();

  writeFileSync(
    join(home, ".claude", "settings.json"),
    JSON.stringify({ env: { CLAUDE_CODE_PLUGIN_DIRS: "/my/plugin" } }, null, 2) + "\n",
  );

  run(pkg, home, "setup");
  const r = run(pkg, home, "setup", "--remove");
  assert.equal(r.status, 0);

  const dirs = pluginDirs(settings(home));
  assert.ok(dirs.includes("/my/plugin"), "user's plugin dir preserved");
  assert.ok(!dirs.includes(join(home, ".claude", "mods", "asenq")), "mod dir removed");
});

test("setup --remove deletes env key when PLUGIN_DIRS ends up empty and asenq created it", () => {
  const pkg = makePkg();
  const home = makeHome();

  // No pre-existing PLUGIN_DIRS: asenq creates it
  run(pkg, home, "setup");
  const r = run(pkg, home, "setup", "--remove");
  assert.equal(r.status, 0);

  const s = settings(home);
  const env = s.env as Record<string, unknown> | undefined;
  assert.ok(!env || !("CLAUDE_CODE_PLUGIN_DIRS" in env), "CLAUDE_CODE_PLUGIN_DIRS key removed when empty");
});

// --- F-08: three setup mutations that survived ---

test("asenq-cli.json argv is exactly [runtime, cli] in order and value", () => {
  const pkg = makePkg();
  const home = makeHome();
  run(pkg, home, "setup");

  const modDir = join(home, ".claude", "mods", "asenq");
  const cliConfig = JSON.parse(readFileSync(join(modDir, "asenq-cli.json"), "utf8"));
  assert.deepEqual(Object.keys(cliConfig), ["argv"], "only has argv key");
  assert.equal(cliConfig.argv.length, 2, "exactly two elements");
  assert.equal(cliConfig.argv[0], process.execPath, "first element is the runtime");
  // The second element must be a real cli.js path
  assert.ok(typeof cliConfig.argv[1] === "string" && cliConfig.argv[1].endsWith("cli.js"), "second element is cli.js path");
  assert.ok(existsSync(cliConfig.argv[1]), "cli.js path exists");
});

test("setup refreshes a stale installed mod (isModCurrent detects changes)", () => {
  const pkg = makePkg();
  const home = makeHome();
  run(pkg, home, "setup");

  const modDir = join(home, ".claude", "mods", "asenq");
  const registerPath = join(modDir, "hooks", "register.tsx");
  const original = readFileSync(registerPath, "utf8");
  // Make the installed copy stale
  writeFileSync(registerPath, original + "\n// stale\n");

  const second = run(pkg, home, "setup");
  assert.equal(second.status, 0);
  // Should have been refreshed: the stale comment should be gone
  assert.equal(readFileSync(registerPath, "utf8"), original, "mod was refreshed to current");
  assert.ok(second.out.includes("mod installed"), "reports mod installed on refresh");
});

test("setup --remove keeps other env keys beside PLUGIN_DIRS", () => {
  const pkg = makePkg();
  const home = makeHome();

  writeFileSync(
    join(home, ".claude", "settings.json"),
    JSON.stringify({ env: { FOO: "1" } }, null, 2) + "\n",
  );

  run(pkg, home, "setup");
  run(pkg, home, "setup", "--remove");

  const s = settings(home);
  const env = s.env as Record<string, unknown> | undefined;
  assert.ok(env !== undefined, "env key preserved");
  assert.equal(env!.FOO, "1", "FOO key preserved");
});

// --- F-09: PLUGIN_DIRS tracking ---

test("fresh install then stale refresh then --remove cleans up fully", () => {
  const pkg = makePkg();
  const home = makeHome();

  // Fresh install: asenq creates the key
  run(pkg, home, "setup");
  const modDir = join(home, ".claude", "mods", "asenq");
  assert.ok(pluginDirs(settings(home)).includes(modDir), "key created");
  // Marker exists outside the mod folder
  assert.ok(existsSync(join(home, ".claude", "mods", ".asenq-plugin-dirs-created")), "marker exists");

  // Stale refresh: rmSync the mod folder and re-install
  const registerPath = join(modDir, "hooks", "register.tsx");
  writeFileSync(registerPath, "// stale\n");
  run(pkg, home, "setup");
  // Marker should survive the refresh (it's outside the mod folder)
  assert.ok(existsSync(join(home, ".claude", "mods", ".asenq-plugin-dirs-created")), "marker survives refresh");

  // Remove: cleans up fully (key deleted since asenq created it)
  run(pkg, home, "setup", "--remove");
  const s = settings(home);
  const env = s.env as Record<string, unknown> | undefined;
  assert.ok(!env || !("CLAUDE_CODE_PLUGIN_DIRS" in env), "key deleted");
  assert.ok(!existsSync(join(home, ".claude", "mods", ".asenq-plugin-dirs-created")), "marker deleted");
});

test("user-owned PLUGIN_DIRS key survives remove as empty string", () => {
  const pkg = makePkg();
  const home = makeHome();

  // User pre-registers only the mod's exact path
  const modDir = join(home, ".claude", "mods", "asenq");
  writeFileSync(
    join(home, ".claude", "settings.json"),
    JSON.stringify({ env: { CLAUDE_CODE_PLUGIN_DIRS: modDir } }, null, 2) + "\n",
  );

  run(pkg, home, "setup");
  // The path already exists, so setup does not add a duplicate
  assert.equal(pluginDirs(settings(home)).filter((d) => d === modDir).length, 1);

  run(pkg, home, "setup", "--remove");
  const s = settings(home);
  const env = s.env as Record<string, unknown>;
  // User owned the key: it survives as "" or remains present
  assert.ok("CLAUDE_CODE_PLUGIN_DIRS" in env || (typeof env.CLAUDE_CODE_PLUGIN_DIRS === "string"), "key preserved for user");
});

test("user-owned key with other entries keeps those entries on remove", () => {
  const pkg = makePkg();
  const home = makeHome();

  writeFileSync(
    join(home, ".claude", "settings.json"),
    JSON.stringify({ env: { CLAUDE_CODE_PLUGIN_DIRS: "/user/plugin" } }, null, 2) + "\n",
  );

  run(pkg, home, "setup");
  run(pkg, home, "setup", "--remove");

  const s = settings(home);
  const env = s.env as Record<string, unknown>;
  assert.ok(typeof env.CLAUDE_CODE_PLUGIN_DIRS === "string", "key preserved");
  assert.ok((env.CLAUDE_CODE_PLUGIN_DIRS as string).includes("/user/plugin"), "user entry preserved");
});

test("setup does not overwrite a non-string PLUGIN_DIRS value", () => {
  const pkg = makePkg();
  const home = makeHome();

  writeFileSync(
    join(home, ".claude", "settings.json"),
    JSON.stringify({ env: { CLAUDE_CODE_PLUGIN_DIRS: 42 } }, null, 2) + "\n",
  );

  const r = run(pkg, home, "setup");
  assert.equal(r.status, 0);
  assert.ok(r.out.includes("not a string") || r.out.includes("skipping"), "warns about non-string value");

  const s = settings(home);
  const env = s.env as Record<string, unknown>;
  assert.equal(env.CLAUDE_CODE_PLUGIN_DIRS, 42, "value unchanged");
});

test("setup does not duplicate a tilde-form entry", () => {
  const pkg = makePkg();
  const home = makeHome();

  const modDir = join(home, ".claude", "mods", "asenq");
  const tildeForm = modDir.replace(home, "~");
  writeFileSync(
    join(home, ".claude", "settings.json"),
    JSON.stringify({ env: { CLAUDE_CODE_PLUGIN_DIRS: tildeForm } }, null, 2) + "\n",
  );

  run(pkg, home, "setup");
  const dirs = pluginDirs(settings(home));
  assert.equal(dirs.length, 1, "no duplicate entry for tilde form");
});

test("setup does not leave behind env:{} that asenq created", () => {
  const pkg = makePkg();
  const home = makeHome();

  // No pre-existing env key
  writeFileSync(join(home, ".claude", "settings.json"), "{}\n");

  run(pkg, home, "setup");
  run(pkg, home, "setup", "--remove");

  const s = settings(home);
  assert.ok(!("env" in s) || s.env === undefined, "env removed since asenq created it");
});

// --- F-10: doctor ---

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
  rmSync(join(home, ".claude", "mods", "asenq"), { recursive: true });

  const d = doctor(pkg, home);
  assert.equal(d.status, 1);
  assert.ok(d.out.includes("not installed"), "mod missing");
});

test("doctor reports mod not in PLUGIN_DIRS when entry is missing", () => {
  const pkg = makePkg();
  const home = makeHome();
  run(pkg, home, "setup");
  const s = settings(home);
  (s as any).env = {};
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify(s, null, 2) + "\n");

  const d = doctor(pkg, home);
  assert.equal(d.status, 1);
  assert.ok(d.out.includes("not in CLAUDE_CODE_PLUGIN_DIRS"), "mod not registered");
});

test("doctor reports stale mod when installed copy differs from shipped", () => {
  const pkg = makePkg();
  const home = makeHome();
  run(pkg, home, "setup");

  // Make the installed copy stale
  const registerPath = join(home, ".claude", "mods", "asenq", "hooks", "register.tsx");
  writeFileSync(registerPath, "// stale\n");

  const d = doctor(pkg, home);
  assert.equal(d.status, 1);
  assert.ok(d.out.includes("outdated"), "mod outdated");
});

test("doctor reports invalid asenq-cli.json when paths are missing", () => {
  const pkg = makePkg();
  const home = makeHome();
  run(pkg, home, "setup");

  // Overwrite with invalid paths
  writeFileSync(
    join(home, ".claude", "mods", "asenq", "asenq-cli.json"),
    JSON.stringify({ argv: ["/nonexistent/node", "/nonexistent/cli.js"] }, null, 2) + "\n",
  );

  const d = doctor(pkg, home);
  assert.equal(d.status, 1);
  assert.ok(d.out.includes("asenq-cli.json") || d.out.includes("paths do not exist"), "cli paths invalid");
});

test("setup fails when shipped mod source is missing", () => {
  const pkg = makePkg();
  rmSync(join(pkg, "mods", "asenq", ".claude-plugin", "plugin.json"));
  const home = makeHome();

  const r = run(pkg, home, "setup");
  assert.equal(r.status, 1);
  assert.ok(r.out.includes("shipped mod missing") || r.out.includes("reinstall"), "reports missing mod");
});
