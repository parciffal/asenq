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
const SKILLS = ["setup-asenq", "asenq-worker", "asenq-orchestrator", "asenq-recover"] as const;
type Harness = "claude" | "opencode" | "omp";
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

/**
 * Copies the built package (dist/src, skills, node_modules link) into a temp root. Skills install
 * from the package root, so the copy lets a test play a newer package without touching the repo.
 */
function makePkg(): string {
  const root = mkdtempSync(join(tmp, "asenq-pkg-"));
  cpSync(join(repo, "dist", "src"), join(root, "dist", "src"), { recursive: true });
  cpSync(join(repo, "skills"), join(root, "skills"), { recursive: true });
  cpSync(join(repo, "package.json"), join(root, "package.json"));
  symlinkSync(join(repo, "node_modules"), join(root, "node_modules"), "dir");
  garbage.push(root);
  return root;
}

function makeHome(dirs: Partial<Record<Harness, boolean>> = { claude: true, opencode: true, omp: true }): string {
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

/** Doctor autostarts a daemon in ASENQ_HOME; always stop it, even when a doctor assertion fails. */
function doctor(pkg: string, home: string): Result {
  try {
    return run(pkg, home, "doctor");
  } finally {
    stopDaemon(pkg, home);
  }
}

function skillsRoot(home: string, harness: Harness): string {
  if (harness === "claude") return join(home, ".claude", "skills");
  if (harness === "opencode") return join(home, ".config", "opencode", "skills");
  return join(home, ".omp", "agent", "skills");
}
const skillFile = (root: string, name: string): string => join(root, name, "SKILL.md");
const shipped = (pkg: string, name: string): string => readFileSync(join(pkg, "skills", name, "SKILL.md"), "utf8");

test("setup installs each shipped skill into every detected harness and is idempotent", () => {
  const pkg = makePkg();
  const home = makeHome();

  const first = run(pkg, home, "setup");
  assert.equal(first.status, 0);
  for (const harness of ["claude", "opencode", "omp"] as const) {
    for (const name of SKILLS) {
      assert.equal(readFileSync(skillFile(skillsRoot(home, harness), name), "utf8"), shipped(pkg, name), `${harness}/${name}`);
      assert.ok(first.out.includes(`skills/${name}/SKILL.md`), `output lists ${harness}/${name}`);
    }
  }

  const second = run(pkg, home, "setup");
  assert.equal(second.status, 0);
  assert.deepEqual(second.lines.filter((l) => !l.startsWith("= ")), []);
  for (const harness of ["claude", "opencode", "omp"] as const) {
    for (const name of SKILLS) {
      assert.equal(readFileSync(skillFile(skillsRoot(home, harness), name), "utf8"), shipped(pkg, name), `${harness}/${name} after rerun`);
    }
  }
});

test("setup backs up a user-edited installed skill before overwriting it", () => {
  const pkg = makePkg();
  const home = makeHome({ claude: true });
  run(pkg, home, "setup");

  const dest = skillFile(skillsRoot(home, "claude"), "asenq-worker");
  const edited = "my local notes\n";
  writeFileSync(dest, edited);

  const r = run(pkg, home, "setup");
  assert.equal(r.status, 0);
  assert.equal(readFileSync(dest + ".asenq-bak", "utf8"), edited);
  assert.equal(readFileSync(dest, "utf8"), shipped(pkg, "asenq-worker"));
});

test("each edited update refreshes the single .asenq-bak with the latest edit", () => {
  const pkg = makePkg();
  const home = makeHome({ claude: true });
  run(pkg, home, "setup");

  const dest = skillFile(skillsRoot(home, "claude"), "setup-asenq");
  writeFileSync(dest, "edit one\n");
  run(pkg, home, "setup");
  assert.equal(readFileSync(dest + ".asenq-bak", "utf8"), "edit one\n");

  writeFileSync(dest, "edit two\n");
  run(pkg, home, "setup");
  assert.equal(readFileSync(dest + ".asenq-bak", "utf8"), "edit two\n");
  assert.equal(readFileSync(dest, "utf8"), shipped(pkg, "setup-asenq"));
});

test("a package update overwrites an unedited skill without a backup", () => {
  const pkg = makePkg();
  const home = makeHome();
  run(pkg, home, "setup");

  const dest = skillFile(skillsRoot(home, "claude"), "asenq-recover");
  const v2 = shipped(pkg, "asenq-recover") + "\nships newer advice\n";
  writeFileSync(join(pkg, "skills", "asenq-recover", "SKILL.md"), v2);

  const r = run(pkg, home, "setup");
  assert.equal(r.status, 0);
  assert.equal(readFileSync(dest, "utf8"), v2);
  assert.ok(!existsSync(dest + ".asenq-bak"), "unedited update must not create a backup");

  const again = run(pkg, home, "setup");
  assert.deepEqual(again.lines.filter((l) => !l.startsWith("= ")), []);
});

test("setup backs up an untracked colliding SKILL.md before taking ownership", () => {
  const pkg = makePkg();
  const home = makeHome({ claude: true });
  const dest = skillFile(skillsRoot(home, "claude"), "setup-asenq");
  mkdirSync(join(skillsRoot(home, "claude"), "setup-asenq"), { recursive: true });
  writeFileSync(dest, "hand written\n");

  const r = run(pkg, home, "setup");
  assert.equal(r.status, 0);
  assert.equal(readFileSync(dest + ".asenq-bak", "utf8"), "hand written\n");
  assert.equal(readFileSync(dest, "utf8"), shipped(pkg, "setup-asenq"));
});

test("setup --remove deletes only asenq-installed skills and keeps unrelated files and backups", () => {
  const pkg = makePkg();
  const home = makeHome({ claude: true });
  run(pkg, home, "setup");

  const root = skillsRoot(home, "claude");
  mkdirSync(join(root, "my-skill"), { recursive: true });
  writeFileSync(join(root, "my-skill", "SKILL.md"), "mine\n");
  writeFileSync(join(root, "asenq-worker", "notes.md"), "notes\n");
  writeFileSync(skillFile(root, "asenq-worker"), "edited by me\n");

  const r = run(pkg, home, "setup", "--remove");
  assert.equal(r.status, 0);
  for (const name of SKILLS) assert.ok(!existsSync(skillFile(root, name)), `${name} removed`);
  assert.equal(readFileSync(join(root, "my-skill", "SKILL.md"), "utf8"), "mine\n");
  assert.equal(readFileSync(join(root, "asenq-worker", "notes.md"), "utf8"), "notes\n");
  assert.equal(readFileSync(skillFile(root, "asenq-worker") + ".asenq-bak", "utf8"), "edited by me\n");
  assert.ok(!existsSync(join(root, "setup-asenq")), "empty dir asenq created is cleaned up");
  assert.ok(existsSync(join(root, "asenq-worker")), "dir with unrelated content is preserved");
});

test("setup --remove leaves a same-named skill it never installed", () => {
  const pkg = makePkg();
  const home = makeHome({ claude: true });
  const dest = skillFile(skillsRoot(home, "claude"), "asenq-worker");
  mkdirSync(join(skillsRoot(home, "claude"), "asenq-worker"), { recursive: true });
  writeFileSync(dest, "not ours\n");

  const r = run(pkg, home, "setup", "--remove");
  assert.equal(r.status, 0);
  assert.equal(readFileSync(dest, "utf8"), "not ours\n");
  assert.ok(!existsSync(dest + ".asenq-bak"));
});

test("skills install under PI_CODING_AGENT_DIR for omp", () => {
  const pkg = makePkg();
  const home = makeHome({ claude: true, opencode: false, omp: false });
  const custom = mkdtempSync(join(tmp, "asenq-agent-"));
  garbage.push(custom);

  const r = spawnCli(pkg, childEnv(home, { PI_CODING_AGENT_DIR: custom }), "setup");
  assert.equal(r.status, 0);
  for (const name of SKILLS) {
    assert.equal(readFileSync(join(custom, "skills", name, "SKILL.md"), "utf8"), shipped(pkg, name), name);
  }
  assert.ok(existsSync(join(custom, "extensions", "asenq.js")));
  assert.ok(!existsSync(join(home, ".omp")), "default omp dir untouched when PI_CODING_AGENT_DIR is set");
});

test("setup installs skills only into detected harnesses and skips the rest", () => {
  const pkg = makePkg();
  const home = makeHome({ claude: true, opencode: false, omp: false });

  const r = run(pkg, home, "setup");
  assert.equal(r.status, 0);
  assert.ok(r.out.includes("skip opencode: not installed"));
  assert.ok(r.out.includes("skip omp: not installed"));
  for (const name of SKILLS) {
    assert.equal(readFileSync(skillFile(skillsRoot(home, "claude"), name), "utf8"), shipped(pkg, name), name);
  }
  assert.ok(!existsSync(join(home, ".config")));
  assert.ok(!existsSync(join(home, ".omp")));
});

test("doctor reports installed skills as current per harness", () => {
  const pkg = makePkg();
  const home = makeHome({ claude: true, opencode: true });
  run(pkg, home, "setup");

  const d = doctor(pkg, home);
  assert.equal(d.status, 0);
  assert.ok(d.out.includes("claude skills: current"));
  assert.ok(d.out.includes("opencode skills: current"));
  assert.ok(d.out.includes("omp skills: skipped"));
});

test("doctor reports a missing installed skill", () => {
  const pkg = makePkg();
  const home = makeHome({ claude: true });
  run(pkg, home, "setup");
  rmSync(skillFile(skillsRoot(home, "claude"), "asenq-worker"));

  const d = doctor(pkg, home);
  assert.equal(d.status, 1);
  assert.ok(d.out.includes("claude skills: missing asenq-worker"));
});

test("doctor reports an outdated skill after the package ships newer content", () => {
  const pkg = makePkg();
  const home = makeHome({ claude: true });
  run(pkg, home, "setup");
  writeFileSync(join(pkg, "skills", "asenq-orchestrator", "SKILL.md"), shipped(pkg, "asenq-orchestrator") + "\nv2\n");

  const d = doctor(pkg, home);
  assert.equal(d.status, 1);
  assert.ok(d.out.includes("claude skills: outdated asenq-orchestrator"));
});

test("doctor reports a detected harness whose skills were never installed as missing", () => {
  const pkg = makePkg();
  const home = makeHome({ claude: true });
  run(pkg, home, "setup");
  rmSync(skillsRoot(home, "claude"), { recursive: true, force: true });

  const d = doctor(pkg, home);
  assert.equal(d.status, 1);
  assert.ok(d.out.includes("claude skills: missing"));
  assert.ok(d.out.includes("run: asenq setup"));
});

test("doctor reports a user-edited skill", () => {
  const pkg = makePkg();
  const home = makeHome({ claude: true });
  run(pkg, home, "setup");
  writeFileSync(skillFile(skillsRoot(home, "claude"), "asenq-recover"), "tweaked\n");

  const d = doctor(pkg, home);
  assert.equal(d.status, 0);
  assert.ok(d.out.includes("claude skills: edited asenq-recover"));
});

test("doctor warns about an unowned same-named skill and leaves it alone", () => {
  const pkg = makePkg();
  const home = makeHome({ claude: true });
  run(pkg, home, "setup");
  const root = skillsRoot(home, "claude");
  rmSync(join(root, ".asenq-skills.json"));

  const d = doctor(pkg, home);
  assert.equal(d.status, 0);
  assert.ok(d.out.includes("claude skills: unowned"));
  assert.equal(readFileSync(skillFile(root, "asenq-worker"), "utf8"), shipped(pkg, "asenq-worker"));
  assert.ok(!existsSync(join(root, ".asenq-skills.json")), "doctor does not adopt the files");
});

test("setup fails closed without touching anything when one shipped skill file is missing", () => {
  const pkg = makePkg();
  rmSync(join(pkg, "skills", "asenq-worker", "SKILL.md"));
  const home = makeHome();

  const r = run(pkg, home, "setup");
  assert.equal(r.status, 1);
  assert.ok(/reinstall/i.test(r.out), "actionable reinstall reason");
  assert.ok(r.out.includes("asenq-worker"), "names the missing skill file");
  assert.ok(!existsSync(join(home, ".asenq", "config.json")), "no config written");
  assert.ok(!existsSync(join(home, ".claude", "settings.json")), "no hooks written");
  assert.ok(!existsSync(join(home, ".config", "opencode", "plugins", "asenq.js")), "no opencode shim written");
  assert.ok(!existsSync(join(home, ".omp", "agent", "extensions", "asenq.js")), "no omp shim written");
  assert.ok(!existsSync(join(home, ".claude", "skills")), "no skills copied");
});

test("setup fails closed when the whole shipped skills directory is missing", () => {
  const pkg = makePkg();
  rmSync(join(pkg, "skills"), { recursive: true, force: true });
  const home = makeHome();

  const r = run(pkg, home, "setup");
  assert.equal(r.status, 1);
  assert.ok(/reinstall/i.test(r.out), "actionable reinstall reason");
  assert.ok(!existsSync(join(home, ".asenq", "config.json")), "no config written");
  assert.ok(!existsSync(join(home, ".claude", "settings.json")), "no hooks written");
  assert.ok(!existsSync(join(home, ".claude", "skills")), "no skills copied");
});

test("doctor fails per harness when one shipped skill file is missing", () => {
  const pkg = makePkg();
  const home = makeHome({ claude: true, opencode: true });
  run(pkg, home, "setup");

  const broken = makePkg();
  rmSync(join(broken, "skills", "asenq-worker", "SKILL.md"));

  const d = doctor(broken, home);
  assert.equal(d.status, 1);
  assert.ok(d.out.includes("claude skills: shipped skills missing asenq-worker"));
  assert.ok(d.out.includes("opencode skills: shipped skills missing asenq-worker"));
  assert.ok(/reinstall/i.test(d.out));
});

test("doctor fails when the whole shipped skills directory is missing", () => {
  const pkg = makePkg();
  const home = makeHome({ claude: true });
  run(pkg, home, "setup");

  const broken = makePkg();
  rmSync(join(broken, "skills"), { recursive: true, force: true });

  const d = doctor(broken, home);
  assert.equal(d.status, 1);
  assert.ok(d.out.includes("claude skills: shipped skills missing setup-asenq, asenq-worker, asenq-orchestrator, asenq-recover"));
  assert.ok(/reinstall/i.test(d.out));
});

test("setup --remove ignores foreign and traversing manifest keys", () => {
  const pkg = makePkg();
  const home = makeHome({ claude: true });
  run(pkg, home, "setup");

  const root = skillsRoot(home, "claude");
  const foreign = join(root, "my-skill", "SKILL.md");
  const escape = join(home, ".claude", "escape", "SKILL.md");
  mkdirSync(join(root, "my-skill"), { recursive: true });
  mkdirSync(join(home, ".claude", "escape"), { recursive: true });
  writeFileSync(foreign, "foreign\n");
  writeFileSync(escape, "traversal\n");
  const manifest = JSON.parse(readFileSync(join(root, ".asenq-skills.json"), "utf8")) as Record<string, string>;
  manifest["my-skill"] = "0".repeat(64);
  manifest["../escape"] = "0".repeat(64);
  writeFileSync(join(root, ".asenq-skills.json"), JSON.stringify(manifest, null, 2) + "\n");

  const r = run(pkg, home, "setup", "--remove");
  assert.equal(r.status, 0);
  for (const name of SKILLS) assert.ok(!existsSync(skillFile(root, name)), `${name} removed`);
  assert.equal(readFileSync(foreign, "utf8"), "foreign\n");
  assert.equal(readFileSync(escape, "utf8"), "traversal\n");
  assert.ok(!existsSync(join(root, "my-skill", "SKILL.md.asenq-bak")));
});

test("a setup rerun prunes foreign manifest keys and still preserves their files", () => {
  const pkg = makePkg();
  const home = makeHome({ claude: true });
  run(pkg, home, "setup");

  const root = skillsRoot(home, "claude");
  const foreign = join(root, "my-skill", "SKILL.md");
  const escape = join(home, ".claude", "escape", "SKILL.md");
  mkdirSync(join(root, "my-skill"), { recursive: true });
  mkdirSync(join(home, ".claude", "escape"), { recursive: true });
  writeFileSync(foreign, "foreign\n");
  writeFileSync(escape, "traversal\n");
  const manifest = JSON.parse(readFileSync(join(root, ".asenq-skills.json"), "utf8")) as Record<string, string>;
  manifest["my-skill"] = "0".repeat(64);
  manifest["../escape"] = "0".repeat(64);
  writeFileSync(join(root, ".asenq-skills.json"), JSON.stringify(manifest, null, 2) + "\n");

  const r = run(pkg, home, "setup");
  assert.equal(r.status, 0);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(root, ".asenq-skills.json"), "utf8")) as Record<string, string>).sort(), [...SKILLS].sort());
  assert.equal(readFileSync(foreign, "utf8"), "foreign\n");
  assert.equal(readFileSync(escape, "utf8"), "traversal\n");

  const removed = run(pkg, home, "setup", "--remove");
  assert.equal(removed.status, 0);
  assert.equal(readFileSync(foreign, "utf8"), "foreign\n");
  assert.equal(readFileSync(escape, "utf8"), "traversal\n");
});
