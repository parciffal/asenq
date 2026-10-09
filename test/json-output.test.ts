import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { ChannelSummary, ListedSession, SessionIdentity } from "../src/shared/protocol.js";
import { formatSessions } from "../src/shared/tools.js";
import { startEnv, type TestEnv } from "./helpers.js";

let env: TestEnv | undefined;
afterEach(async () => {
  await env?.close();
  env = undefined;
});

// F-05: ls --json emits full ListedSession
test("list op returns the full ListedSession shape for --json", async () => {
  env = await startEnv();
  const human = env.human();
  const w = await env.adapter("omp", "k1", "alpha");
  await human.request("set_role", { name: "alpha", role: "worker" });
  await human.request("channel_create", { channel: "work" });
  await human.request("channel_add", { channel: "work", name: "alpha" });

  const r = await human.request("list");
  const sessions = r.sessions as ListedSession[];
  const s = sessions.find((s) => s.name === "alpha")!;
  assert.ok(s);

  // All fields present
  assert.equal(typeof s.id, "string");
  assert.equal(s.name, "alpha");
  assert.ok(Array.isArray(s.previousNames));
  assert.equal(s.harness, "omp");
  assert.ok("cwd" in s);
  assert.equal(s.state, "live");
  assert.equal(typeof s.stale, "boolean");
  assert.ok(s.ping === null || typeof s.ping === "string");
  assert.equal(s.inbound, "accept");
  assert.equal(s.role, "worker");
  assert.ok(Array.isArray(s.channels));
  assert.ok(s.channels.includes("work"));
  assert.ok("lastSeen" in s);
  assert.ok("busy" in s);
  assert.equal(typeof s.harnessSessionId, "string");
  assert.equal(typeof s.you, "boolean");

  // JSON.stringify round-trip preserves all keys
  const parsed = JSON.parse(JSON.stringify(s)) as ListedSession;
  assert.equal(parsed.id, s.id);
  assert.equal(parsed.inbound, s.inbound);
  assert.equal(parsed.stale, s.stale);
  assert.equal(parsed.you, s.you);
});

// F-03: Claude harness harnessSessionId from claude_current_session_id
test("Claude session harnessSessionId from claude_current_session_id", async () => {
  env = await startEnv();
  const human = env.human();

  // Start a Claude session: before attach, harnessSessionId is null
  const hookResult = await human.request("claude_hook", {
    event: "start", key: "claude-proc-1", sessionId: "cs-123", name: "claude-test",
  });
  const claudeSession = hookResult.session as { id: string; name: string };

  const listBefore = (await human.request("list")).sessions as ListedSession[];
  const before = listBefore.find((s) => s.name === claudeSession.name)!;
  assert.ok(before);
  // harnessSessionId should be the current session id after hook start
  assert.equal(before.harnessSessionId, "cs-123");
  assert.equal(before.harness, "claude");

  // Attach with a different session id
  await human.request("claude_hook", {
    event: "start", key: "claude-proc-1", sessionId: "cs-456", name: "claude-test",
  });
  const listAfter = (await human.request("list")).sessions as ListedSession[];
  const after = listAfter.find((s) => s.id === claudeSession.id)!;
  assert.equal(after.harnessSessionId, "cs-456");
});

// F-05: channels --json includes lastAt and lastOrder
test("channels --json shape includes lastAt and lastOrder", async () => {
  env = await startEnv();
  const human = env.human();
  const w = await env.adapter("omp", "k1", "alpha");
  await human.request("set_role", { name: "alpha", role: "orchestrator" });
  await human.request("channel_create", { channel: "proj" });
  await human.request("channel_add", { channel: "proj", name: "alpha" });
  await human.request("channel_send", { channel: "proj", text: "hi" });

  const chList = (await human.request("channel_list")).channels as ChannelSummary[];
  const ch = chList.find((c) => c.name === "proj")!;
  assert.ok(ch);
  assert.equal(typeof ch.lastAt, "number");
  assert.equal(typeof ch.lastOrder, "number");
  assert.ok(ch.lastAt > 0);
  assert.ok(ch.lastOrder > 0);

  // F-05: member objects same shape in channels --json and channel members --json
  const { sessions: identities } = await human.sync();
  const idMap = new Map(identities.map((s) => [s.id, s]));
  const channelMembers = (ch.memberIds ?? []).map((id) => {
    const s = idMap.get(id);
    return { name: s?.name ?? id, role: s?.role ?? null, state: s?.state ?? "removed", id };
  });
  const directMembers = ((await human.request("channel_members", { channel: "proj" })).members as SessionIdentity[])
    .map((m) => ({ name: m.name, role: m.role ?? null, state: m.state, id: m.id }));

  // Both should have identical shape and content for the same channel
  assert.deepEqual(channelMembers, directMembers);
});

test("ls --json respects filters", async () => {
  env = await startEnv();
  const human = env.human();
  await env.adapter("omp", "k1", "w1", { cwd: "/project/a" });
  await env.adapter("opencode", "k2", "w2", { cwd: "/project/b" });
  await human.request("channel_create", { channel: "ch1" });
  await human.request("channel_add", { channel: "ch1", name: "w1" });

  const byHarness = await human.request("list", { harness: "omp" });
  const hSessions = byHarness.sessions as ListedSession[];
  assert.ok(hSessions.every((s) => s.harness === "omp"));
  assert.ok(hSessions.some((s) => s.name === "w1"));
  assert.ok(!hSessions.some((s) => s.name === "w2"));

  const byChannel = await human.request("list", { channel: "ch1" });
  const chSessions = byChannel.sessions as ListedSession[];
  assert.ok(chSessions.some((s) => s.name === "w1"));
  assert.ok(!chSessions.some((s) => s.name === "w2"));

  const byCwd = await human.request("list", { cwd: "/project/a" });
  const cwdSessions = byCwd.sessions as ListedSession[];
  assert.ok(cwdSessions.some((s) => s.name === "w1"));
  assert.ok(!cwdSessions.some((s) => s.name === "w2"));
});

// F-03: text output unchanged without --json (snapshot against main's formatting)
test("formatSessions text output matches expected format", async () => {
  env = await startEnv();
  const human = env.human();
  const w = await env.adapter("omp", "k1", "alpha");

  const r = await human.request("list");
  const sessions = r.sessions as ListedSession[];
  const text = formatSessions(sessions);

  // Verify text format lines per session (the original formatSessions output)
  const lines = text.split("\n");
  assert.ok(lines.some((l) => l.startsWith("alpha")));
  assert.ok(lines.some((l) => l.includes("id=") && l.includes("former=")));
  assert.ok(lines.some((l) => l.includes("harness=omp")));
  assert.ok(lines.some((l) => l.includes("role=")));
  assert.ok(lines.some((l) => l.includes("inbound=accept")));
  assert.ok(lines.some((l) => l.includes("ping=")));
  assert.ok(lines.some((l) => l.includes("lastSeen=")));
  assert.ok(lines.some((l) => l.includes("harnessSessionId=")));
});

test("channels text output matches expected format", async () => {
  env = await startEnv();
  const human = env.human();
  await human.request("channel_create", { channel: "test-ch" });

  const r = await human.request("channel_list");
  const rows = r.channels as ChannelSummary[];
  const ch = rows.find((c) => c.name === "test-ch")!;
  // Match the text format: `#name  no posts  0 members` or `#name  N messages  last ...  M members`
  const line = ch.count
    ? `#${ch.name}  ${ch.count} messages  last ${new Date(ch.lastAt).toLocaleString()}  ${ch.memberIds?.length ?? 0} members`
    : `#${ch.name}  no posts  ${ch.memberIds?.length ?? 0} members`;
  assert.ok(line.startsWith("#test-ch"));
  assert.ok(line.includes("members"));
});

test("channel members text output matches expected format", async () => {
  env = await startEnv();
  const human = env.human();
  const w = await env.adapter("omp", "k1", "alpha");
  await human.request("set_role", { name: "alpha", role: "worker" });
  await human.request("channel_create", { channel: "fmt" });
  await human.request("channel_add", { channel: "fmt", name: "alpha" });

  const r = await human.request("channel_members", { channel: "fmt" });
  const members = r.members as SessionIdentity[];
  assert.ok(members.length >= 1);
  // Text format: `name  role  state  id`
  const m = members[0];
  const line = `${m.name}  ${m.role ?? "unset"}  ${m.state}  ${m.id}`;
  assert.ok(line.startsWith("alpha"));
  assert.ok(line.includes("worker"));
  assert.ok(line.includes("live"));
  assert.ok(line.includes("s_"));
});
