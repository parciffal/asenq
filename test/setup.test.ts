import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const fixture = fileURLToPath(new URL("../../test/fixtures/home", import.meta.url));
const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const home = mkdtempSync(join(tmpdir(), "asenq-setup-"));
after(() => rmSync(home, { recursive: true, force: true }));

/** Stub `claude` that logs argv and applies `mcp add/remove` to ~/.claude.json like the real CLI. */
const STUB = `#!/usr/bin/env node
const fs = require("fs");
const home = process.env.HOME;
const a = process.argv.slice(2);
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

function run(...args: string[]): { status: number | null; lines: string[] } {
  const r = spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, ASENQ_HOME: join(home, ".asenq"), PI_CODING_AGENT_DIR: undefined, PATH: `${join(home, "bin")}:${process.env.PATH}` },
  });
  assert.equal(r.stderr, "");
  return { status: r.status, lines: r.stdout.trim().split("\n") };
}

type Settings = { enabledMcpjsonServers?: string[]; hooks?: Record<string, { matcher?: string; hooks: { command: string }[] }[]> };
const settings = (): Settings => JSON.parse(readFileSync(join(home, ".claude/settings.json"), "utf8"));
const commands = (s: Settings): string[] => Object.values(s.hooks ?? {}).flat().flatMap((g) => g.hooks.map((h) => h.command));
const asenqEvents = (s: Settings): string[] =>
  Object.entries(s.hooks ?? {}).filter(([, gs]) => gs.some((g) => g.hooks.some((h) => / hook claude$/.test(h.command)))).map(([e]) => e).sort();

test("setup wires every harness, removes the legacy messenger, and is idempotent; --remove undoes it", () => {
  cpSync(fixture, home, { recursive: true });
  mkdirSync(join(home, "bin"));
  writeFileSync(join(home, "bin", "claude"), STUB);
  chmodSync(join(home, "bin", "claude"), 0o755);

  const first = run("setup");
  assert.equal(first.status, 0);
  assert.ok(first.lines.some((l) => l.startsWith("note: left ~/.local/share/mcp-messenger")));

  const s = settings();
  assert.ok(!commands(s).some((c) => c.includes("messenger-poll.js")));
  assert.equal(s.enabledMcpjsonServers, undefined);
  assert.deepEqual(asenqEvents(s), ["PostToolUse", "SessionEnd", "SessionStart", "Stop", "UserPromptSubmit"]);
  assert.equal(s.hooks!.PostToolUse.at(-1)!.matcher, "*");
  assert.ok(commands(s).some((c) => c.includes("gsd-check-update.js")));
  assert.ok(commands(s).some((c) => c.includes("gsd-session-state.sh")));
  assert.ok(existsSync(join(home, ".claude/settings.json.asenq-bak")));

  assert.ok(!existsSync(join(home, ".claude/.mcp.json")));
  assert.ok(!existsSync(join(home, ".claude/hooks/messenger-poll.js")));
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(home, ".claude/mcp.json"), "utf8")).mcpServers), ["playwright"]);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(home, ".config/opencode/opencode.json"), "utf8")).mcp), ["cwa"]);
  assert.ok(!existsSync(join(home, ".config/opencode/plugins/messenger.js")));

  const ocShim = readFileSync(join(home, ".config/opencode/plugins/asenq.js"), "utf8");
  assert.match(ocShim, /^export \{ server \} from "file:\/\/.+\/adapters\/opencode\.js";\n$/);
  const ompShim = readFileSync(join(home, ".omp/agent/extensions/asenq.js"), "utf8");
  assert.match(ompShim, /^export \{ default \} from "file:\/\/.+\/adapters\/omp\.js";\n$/);

  const argv = readFileSync(join(home, "claude-argv.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]);
  assert.ok(argv.some((a) => a.join(" ") === `mcp add --scope user --transport stdio asenq -- ${process.execPath} ${cli} mcp`));
  assert.ok(argv.some((a) => a.join(" ") === "mcp remove -s user messenger"));
  const claudeJson = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));
  assert.deepEqual(Object.keys(claudeJson.mcpServers), ["asenq"]);

  const second = run("setup");
  assert.equal(second.status, 0);
  assert.deepEqual(second.lines.filter((l) => !l.startsWith("= ")), []);

  const removed = run("setup", "--remove");
  assert.equal(removed.status, 0);
  assert.deepEqual(asenqEvents(settings()), []);
  assert.ok(commands(settings()).some((c) => c.includes("gsd-check-update.js")));
  assert.ok(!existsSync(join(home, ".config/opencode/plugins/asenq.js")));
  assert.ok(!existsSync(join(home, ".omp/agent/extensions/asenq.js")));
  assert.ok(!existsSync(join(home, ".asenq/config.json")));
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")).mcpServers), []);
  assert.ok(!commands(settings()).some((c) => c.includes("messenger-poll.js")));
});
