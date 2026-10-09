import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import type { ListedSession } from "../src/shared/protocol.js";
import { startEnv, type TestEnv } from "./helpers.js";

// From dist/test/ -> dist/src/cli.js
const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");

let env: TestEnv | undefined;
afterEach(async () => {
  await env?.close();
  env = undefined;
});

function run(args: string[], home: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", CLI, ...args],
      { env: { ...process.env, ASENQ_HOME: home, HOME: home } },
      (error, stdout, stderr) => {
        resolve({ stdout, stderr, code: error?.code === undefined ? 0 : (error as unknown as { status: number }).status ?? 1 });
      },
    );
  });
}

test("ls --json outputs full ListedSession array via the real CLI", async () => {
  env = await startEnv();
  const human = env.human();
  const w = await env.adapter("omp", "k1", "alpha");
  await human.request("set_role", { name: "alpha", role: "worker" });
  await human.request("channel_create", { channel: "work" });
  await human.request("channel_add", { channel: "work", name: "alpha" });

  const { stdout } = await run(["ls", "--json"], env.home);
  const sessions = JSON.parse(stdout) as ListedSession[];
  assert.ok(sessions.length >= 1);
  const s = sessions.find((s) => s.name === "alpha")!;
  assert.ok(s);

  // Full ListedSession keys present
  assert.equal(typeof s.id, "string");
  assert.equal(s.name, "alpha");
  assert.ok(Array.isArray(s.previousNames));
  assert.equal(s.harness, "omp");
  assert.ok("cwd" in s);
  assert.equal(s.state, "live");
  assert.equal(typeof s.stale, "boolean");
  assert.equal(s.inbound, "accept");
  assert.equal(s.role, "worker");
  assert.ok(Array.isArray(s.channels));
  assert.ok(s.channels.includes("work"));
  assert.ok("lastSeen" in s);
  assert.ok("busy" in s);
  assert.ok("harnessSessionId" in s);
  assert.equal(typeof s.you, "boolean");
});

test("ls text output via the real CLI matches expected format", async () => {
  env = await startEnv();
  await env.adapter("omp", "k1", "alpha");

  const { stdout } = await run(["ls"], env.home);
  const lines = stdout.split("\n");
  assert.ok(lines.some((l) => l.startsWith("alpha")), "session name header");
  assert.ok(lines.some((l) => l.includes("id=") && l.includes("former=")), "id and former line");
  assert.ok(lines.some((l) => l.includes("harness=omp")), "harness line");
  assert.ok(lines.some((l) => l.includes("role=")), "role line");
  assert.ok(lines.some((l) => l.includes("inbound=accept")), "inbound line");
  assert.ok(lines.some((l) => l.includes("ping=")), "ping line");
  assert.ok(lines.some((l) => l.includes("lastSeen=")), "lastSeen line");
  assert.ok(lines.some((l) => l.includes("harnessSessionId=")), "harnessSessionId line");
});

test("channels --json outputs array with lastAt and lastOrder via the real CLI", async () => {
  env = await startEnv();
  const human = env.human();
  const w = await env.adapter("omp", "k1", "alpha");
  await human.request("set_role", { name: "alpha", role: "orchestrator" });
  await human.request("channel_create", { channel: "proj" });
  await human.request("channel_add", { channel: "proj", name: "alpha" });
  await human.request("channel_send", { channel: "proj", text: "hi" });

  const { stdout } = await run(["channels", "--json"], env.home);
  const channels = JSON.parse(stdout) as { name: string; members: { name: string; role: string | null; state: string; id: string }[]; count: number; lastAt: number; lastOrder: number }[];
  const ch = channels.find((c) => c.name === "proj")!;
  assert.ok(ch);
  assert.equal(typeof ch.count, "number");
  assert.equal(typeof ch.lastAt, "number");
  assert.ok(ch.lastAt > 0);
  assert.equal(typeof ch.lastOrder, "number");
  assert.ok(ch.lastOrder > 0);
  assert.ok(ch.members.length >= 1);
  const m = ch.members.find((m) => m.name === "alpha")!;
  assert.ok(m);
  assert.equal(m.role, "orchestrator");
  assert.equal(m.state, "live");
  assert.equal(typeof m.id, "string");
});

test("channels text output via the real CLI matches expected format", async () => {
  env = await startEnv();
  const human = env.human();
  await human.request("channel_create", { channel: "test-ch" });

  const { stdout } = await run(["channels"], env.home);
  assert.ok(stdout.includes("#test-ch"), "channel name with # prefix");
  assert.ok(stdout.includes("members"), "members count");
});

test("channel members --json outputs member array via the real CLI", async () => {
  env = await startEnv();
  const human = env.human();
  const w = await env.adapter("omp", "k1", "alpha");
  await human.request("set_role", { name: "alpha", role: "worker" });
  await human.request("channel_create", { channel: "fmt" });
  await human.request("channel_add", { channel: "fmt", name: "alpha" });

  const { stdout } = await run(["channel", "members", "fmt", "--json"], env.home);
  const members = JSON.parse(stdout) as { name: string; role: string | null; state: string; id: string }[];
  assert.ok(members.length >= 1);
  const m = members.find((m) => m.name === "alpha")!;
  assert.ok(m);
  assert.equal(m.role, "worker");
  assert.equal(m.state, "live");
  assert.equal(typeof m.id, "string");
});

test("channel members --json <ch> works with flag before channel name", async () => {
  env = await startEnv();
  const human = env.human();
  await env.adapter("omp", "k1", "alpha");
  await human.request("channel_create", { channel: "ordered" });
  await human.request("channel_add", { channel: "ordered", name: "alpha" });

  const { stdout } = await run(["channel", "members", "--json", "ordered"], env.home);
  const members = JSON.parse(stdout) as { name: string; role: string | null; state: string; id: string }[];
  assert.ok(members.some((m) => m.name === "alpha"));
});

test("channel members text output via the real CLI matches expected format", async () => {
  env = await startEnv();
  const human = env.human();
  await env.adapter("omp", "k1", "alpha");
  await human.request("set_role", { name: "alpha", role: "worker" });
  await human.request("channel_create", { channel: "fmt" });
  await human.request("channel_add", { channel: "fmt", name: "alpha" });

  const { stdout } = await run(["channel", "members", "fmt"], env.home);
  assert.ok(stdout.includes("alpha"), "member name");
  assert.ok(stdout.includes("worker"), "member role");
  assert.ok(stdout.includes("live"), "member state");
  assert.ok(stdout.includes("s_"), "member id prefix");
});

test("member objects have the same shape in channels --json and channel members --json", async () => {
  env = await startEnv();
  const human = env.human();
  await env.adapter("omp", "k1", "alpha");
  await human.request("set_role", { name: "alpha", role: "orchestrator" });
  await human.request("channel_create", { channel: "shape" });
  await human.request("channel_add", { channel: "shape", name: "alpha" });

  const { stdout: chOut } = await run(["channels", "--json"], env.home);
  const channels = JSON.parse(chOut) as { name: string; members: { name: string; role: string | null; state: string; id: string }[] }[];
  const chMember = channels.find((c) => c.name === "shape")!.members.find((m) => m.name === "alpha")!;

  const { stdout: memOut } = await run(["channel", "members", "shape", "--json"], env.home);
  const directMembers = JSON.parse(memOut) as { name: string; role: string | null; state: string; id: string }[];
  const directMember = directMembers.find((m) => m.name === "alpha")!;

  assert.deepEqual(chMember, directMember);
});

test("Claude session harnessSessionId from claude_current_session_id", async () => {
  env = await startEnv();
  const human = env.human();

  await human.request("claude_hook", {
    event: "start", key: "claude-proc-1", sessionId: "cs-123", name: "claude-test",
  });

  const { stdout: before } = await run(["ls", "--json"], env.home);
  const sessionsBefore = JSON.parse(before) as ListedSession[];
  const claudeBefore = sessionsBefore.find((s) => s.harness === "claude")!;
  assert.ok(claudeBefore);
  assert.equal(claudeBefore.harnessSessionId, "cs-123");

  await human.request("claude_hook", {
    event: "start", key: "claude-proc-1", sessionId: "cs-456", name: "claude-test",
  });

  const { stdout: after } = await run(["ls", "--json"], env.home);
  const sessionsAfter = JSON.parse(after) as ListedSession[];
  const claudeAfter = sessionsAfter.find((s) => s.id === claudeBefore.id)!;
  assert.equal(claudeAfter.harnessSessionId, "cs-456");
});

test("ls --json respects filters via the real CLI", async () => {
  env = await startEnv();
  const human = env.human();
  await env.adapter("omp", "k1", "w1", { cwd: "/project/a" });
  await env.adapter("opencode", "k2", "w2", { cwd: "/project/b" });
  await human.request("channel_create", { channel: "ch1" });
  await human.request("channel_add", { channel: "ch1", name: "w1" });

  const { stdout: hOut } = await run(["ls", "--json", "--harness", "omp"], env.home);
  const hSessions = JSON.parse(hOut) as ListedSession[];
  assert.ok(hSessions.every((s) => s.harness === "omp"));
  assert.ok(hSessions.some((s) => s.name === "w1"));

  const { stdout: chOut } = await run(["ls", "--json", "--channel", "ch1"], env.home);
  const chSessions = JSON.parse(chOut) as ListedSession[];
  assert.ok(chSessions.some((s) => s.name === "w1"));
  assert.ok(!chSessions.some((s) => s.name === "w2"));
});
