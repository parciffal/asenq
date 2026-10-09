import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { ChannelSummary, ListedSession, SessionIdentity } from "../src/shared/protocol.js";
import { startEnv, type TestEnv } from "./helpers.js";

let env: TestEnv | undefined;
afterEach(async () => {
  await env?.close();
  env = undefined;
});

test("list op returns fields needed for --json ls output", async () => {
  env = await startEnv();
  const human = env.human();
  const w = await env.adapter("omp", "k1", "worker");
  await human.request("set_role", { name: "worker", role: "worker" });
  await human.request("channel_create", { channel: "work" });
  await human.request("channel_add", { channel: "work", name: "worker" });

  const r = await human.request("list");
  const sessions = r.sessions as ListedSession[];
  assert.ok(sessions.length >= 1);

  const workerSession = sessions.find((s) => s.name === "worker")!;
  assert.ok(workerSession);
  // All required fields for JSON output
  assert.equal(typeof workerSession.id, "string");
  assert.equal(workerSession.name, "worker");
  assert.equal(workerSession.role, "worker");
  assert.equal(workerSession.state, "live");
  assert.equal(workerSession.harness, "omp");
  assert.equal(typeof workerSession.harnessSessionId, "string");
  assert.ok(Array.isArray(workerSession.channels));
  assert.ok(workerSession.channels.includes("work"));
  assert.ok("cwd" in workerSession);

  // Validate the JSON shape matches what the CLI would emit
  const jsonItem = {
    id: workerSession.id,
    name: workerSession.name,
    role: workerSession.role,
    state: workerSession.state,
    harness: workerSession.harness,
    harnessSessionId: workerSession.harnessSessionId,
    cwd: workerSession.cwd,
    channels: workerSession.channels,
  };
  assert.equal(typeof jsonItem.id, "string");
  assert.equal(typeof jsonItem.name, "string");
  assert.ok(jsonItem.role === null || typeof jsonItem.role === "string");
  assert.ok(["live", "gone", "stale"].includes(jsonItem.state));
  assert.ok(["claude", "omp", "opencode"].includes(jsonItem.harness));
  assert.ok(Array.isArray(jsonItem.channels));
});

test("channel_list and channel_members return fields needed for --json output", async () => {
  env = await startEnv();
  const human = env.human();
  const w = await env.adapter("omp", "k1", "worker");
  await human.request("set_role", { name: "worker", role: "orchestrator" });
  await human.request("channel_create", { channel: "proj" });
  await human.request("channel_add", { channel: "proj", name: "worker" });
  await human.request("channel_send", { channel: "proj", text: "hi" });

  // channels --json shape
  const chList = (await human.request("channel_list")).channels as ChannelSummary[];
  const ch = chList.find((c) => c.name === "proj")!;
  assert.ok(ch);
  assert.equal(typeof ch.name, "string");
  assert.equal(typeof ch.count, "number");
  assert.ok(Array.isArray(ch.memberIds));

  // For --json, we need to resolve memberIds to identity info
  const { sessions: identities } = await human.sync();
  const idMap = new Map(identities.map((s) => [s.id, s]));
  const jsonChannel = {
    name: ch.name,
    members: (ch.memberIds ?? []).map((id) => {
      const s = idMap.get(id);
      return { name: s?.name ?? id, role: s?.role ?? null, state: s?.state ?? "unknown", id };
    }),
    count: ch.count,
  };
  assert.equal(jsonChannel.name, "proj");
  assert.ok(jsonChannel.members.length >= 1);
  const member = jsonChannel.members.find((m) => m.name === "worker")!;
  assert.ok(member);
  assert.equal(member.role, "orchestrator");
  assert.equal(member.state, "live");
  assert.equal(typeof member.id, "string");
  assert.equal(typeof jsonChannel.count, "number");

  // channel members --json shape
  const memResult = (await human.request("channel_members", { channel: "proj" })).members as SessionIdentity[];
  assert.ok(memResult.length >= 1);
  const jsonMembers = memResult.map((m) => ({ name: m.name, role: m.role ?? null, state: m.state, id: m.id }));
  const wMember = jsonMembers.find((m) => m.name === "worker")!;
  assert.ok(wMember);
  assert.equal(wMember.role, "orchestrator");
  assert.equal(wMember.state, "live");
  assert.equal(typeof wMember.id, "string");
});

test("ls --json respects filters", async () => {
  env = await startEnv();
  const human = env.human();
  await env.adapter("omp", "k1", "w1", { cwd: "/project/a" });
  await env.adapter("opencode", "k2", "w2", { cwd: "/project/b" });
  await human.request("channel_create", { channel: "ch1" });
  await human.request("channel_add", { channel: "ch1", name: "w1" });

  // Filter by harness
  const byHarness = await human.request("list", { harness: "omp" });
  const hSessions = byHarness.sessions as ListedSession[];
  assert.ok(hSessions.every((s) => s.harness === "omp"));
  assert.ok(hSessions.some((s) => s.name === "w1"));
  assert.ok(!hSessions.some((s) => s.name === "w2"));

  // Filter by channel
  const byChannel = await human.request("list", { channel: "ch1" });
  const chSessions = byChannel.sessions as ListedSession[];
  assert.ok(chSessions.some((s) => s.name === "w1"));
  assert.ok(!chSessions.some((s) => s.name === "w2"));

  // Filter by cwd
  const byCwd = await human.request("list", { cwd: "/project/a" });
  const cwdSessions = byCwd.sessions as ListedSession[];
  assert.ok(cwdSessions.some((s) => s.name === "w1"));
  assert.ok(!cwdSessions.some((s) => s.name === "w2"));
});
