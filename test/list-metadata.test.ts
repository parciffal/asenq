import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { AsenqClient } from "../src/shared/client.js";
import { isSession, startEnv } from "./helpers.js";

type ListedSession = {
  name: string; state: string; you: boolean;
  lastSeen: number | null; busy: boolean | null; harnessSessionId: string | null;
};

async function listed(client: AsenqClient, name: string): Promise<ListedSession> {
  const sessions = (await client.request("list")).sessions as ListedSession[];
  const session = sessions.find((row) => row.name === name);
  assert.ok(session, `missing session ${name}`);
  return session;
}

const originalTranscript = fileURLToPath(new URL("../../test/fixtures/claude-lineage-original.jsonl", import.meta.url));
const resumedTranscript = fileURLToPath(new URL("../../test/fixtures/claude-lineage-resumed.jsonl", import.meta.url));

test("list records exact harness contact, not human queries or incoming direct messages, and retains it after reopen", async () => {
  const env = await startEnv();
  try {
    let human = env.human();
    const adapter = await env.adapter("omp", "actual-omp-id", "alpha", { autoAck: false });
    assert.deepEqual([ (await listed(human, "alpha")).lastSeen, (await listed(human, "alpha")).harnessSessionId ],
      [1_700_000_000_000, "actual-omp-id"]);
    env.clock.advance(10);
    await adapter.client.request("inbox");
    assert.equal((await listed(human, "alpha")).lastSeen, 1_700_000_000_010);
    env.clock.advance(5);
    await assert.rejects(adapter.client.request("sync"), { code: "bad_request" });
    assert.equal((await listed(human, "alpha")).lastSeen, 1_700_000_000_015);
    env.clock.advance(15);
    await human.sync();
    await human.request("log");
    await human.request("inbox");
    const sending = human.request("send", { to: "alpha", text: "not harness activity until acknowledged" });
    const delivery = await adapter.nextDelivery();
    assert.equal((await listed(human, "alpha")).lastSeen, 1_700_000_000_015);
    env.clock.advance(30);
    await adapter.client.request("ack", { msgId: delivery.msg.id, ok: true });
    const sent = (await sending).results as { status: string }[];
    assert.equal(sent[0].status, "delivered");
    assert.equal((await listed(human, "alpha")).lastSeen, 1_700_000_000_060);
    env.clock.advance(40);
    await env.restart();
    human = env.human();
    assert.deepEqual([(await listed(human, "alpha")).lastSeen, (await listed(human, "alpha")).busy],
      [1_700_000_000_060, null]);
  } finally { await env.close(); }
});

test("busy reports distinguish idle from unknown and reset on disconnect, registration and restart", async () => {
  const env = await startEnv();
  try {
    let human = env.human();
    const adapter = await env.adapter("opencode", "actual-opencode-id", "alpha");
    assert.equal((await listed(human, "alpha")).busy, null);
    for (const busy of [true, false, null]) {
      await adapter.client.request("session_status", { busy });
      assert.equal((await listed(human, "alpha")).busy, busy);
    }
    await adapter.client.request("session_status", { busy: true });
    for (const busy of ["idle", 0, {}, undefined]) {
      await assert.rejects(adapter.client.request("session_status", { busy }), { code: "bad_request" });
      assert.equal((await listed(human, "alpha")).busy, true);
    }
    await assert.rejects(human.request("session_status", { busy: false }), { code: "not_registered" });
    await adapter.client.request("register", { harness: "opencode", key: "actual-opencode-id" });
    assert.equal((await listed(human, "alpha")).busy, null);
    await adapter.client.request("session_status", { busy: true });
    const gone = await env.watch(isSession("gone", "alpha"));
    adapter.client.close();
    await gone.event;
    assert.deepEqual([(await listed(human, "alpha")).state, (await listed(human, "alpha")).busy], ["gone", null]);
    const resumed = await env.adapter("opencode", "actual-opencode-id");
    assert.equal(resumed.session.id, adapter.session.id);
    assert.equal((await listed(human, "alpha")).busy, null);
    await resumed.client.request("session_status", { busy: false });
    await env.restart();
    human = env.human();
    assert.equal((await listed(human, "alpha")).busy, null);
  } finally { await env.close(); }
});

test("shared connections update only the selected identity and infer ack contact from the bound recipient", async () => {
  const env = await startEnv();
  try {
    const human = env.human();
    const alpha = await env.adapter("omp", "alpha-id", "alpha", { autoAck: false });
    env.clock.advance(10);
    const beta = (await alpha.client.request("register", { harness: "omp", key: "beta-id", name: "beta" })).session as { id: string };
    env.clock.advance(10);
    await assert.rejects(alpha.client.request("session_status", { busy: false }), { code: "bad_request" });
    await assert.rejects(alpha.client.request("session_status", { as: "unbound", busy: false }), { code: "bad_request" });
    assert.deepEqual([(await listed(human, "alpha")).lastSeen, (await listed(human, "beta")).lastSeen],
      [1_700_000_000_000, 1_700_000_000_010]);
    await alpha.client.request("session_status", { as: beta.id, busy: true });
    assert.deepEqual([(await listed(human, "alpha")).busy, (await listed(human, "beta")).busy], [null, true]);
    await alpha.client.request("list", { as: alpha.session.id });
    assert.equal((await listed(human, "alpha")).lastSeen, 1_700_000_000_020);
    env.clock.advance(10);
    const sending = human.request("send", { to: "beta", text: "shared ack" });
    const delivery = await alpha.nextDelivery();
    await alpha.client.request("ack", { msgId: delivery.msg.id, ok: true });
    assert.equal(((await sending).results as { status: string }[])[0].status, "delivered");
    assert.deepEqual([(await listed(human, "alpha")).lastSeen, (await listed(human, "beta")).lastSeen],
      [1_700_000_000_020, 1_700_000_000_030]);
    env.clock.advance(10);
    await human.request("ack", { msgId: delivery.msg.id, ok: true });
    assert.equal((await listed(human, "beta")).lastSeen, 1_700_000_000_030);
    await alpha.client.request("channel_list"); // This operation never required sender selection.
    assert.deepEqual([(await listed(human, "alpha")).lastSeen, (await listed(human, "beta")).lastSeen],
      [1_700_000_000_020, 1_700_000_000_030]);
    env.clock.advance(10);
    await alpha.client.request("ack", { msgId: delivery.msg.id, ok: true, as: alpha.session.id });
    assert.deepEqual([(await listed(human, "alpha")).lastSeen, (await listed(human, "beta")).lastSeen],
      [1_700_000_000_050, 1_700_000_000_030]);
  } finally { await env.close(); }
});

test("Claude contact tracks current actual session id through A to B to A, attach and reopen", async () => {
  const env = await startEnv();
  try {
    let human = env.human();
    const socket = join(env.home, "not-a-session-id.sock");
    const first = (await human.request("claude_hook", {
      event: "start", key: socket, socket, sessionId: "A", name: "claude",
    })).session as { id: string; name: string };
    assert.deepEqual([(await listed(human, first.name)).harnessSessionId, (await listed(human, first.name)).busy], ["A", null]);
    env.clock.advance(10);
    await human.request("claude_hook", { event: "start", key: socket, socket, sessionId: "B", busy: true });
    assert.deepEqual([(await listed(human, first.name)).harnessSessionId, (await listed(human, first.name)).busy], ["B", true]);
    env.clock.advance(10);
    assert.deepEqual((await human.request("claude_hook", { event: "poll", sessionId: "A", busy: false })).texts, []);
    assert.deepEqual([(await listed(human, first.name)).harnessSessionId, (await listed(human, first.name)).busy,
      (await listed(human, first.name)).lastSeen], ["A", false, 1_700_000_000_020]);
    await assert.rejects(human.request("claude_hook", { event: "poll", sessionId: "A", busy: "idle" }), { code: "bad_request" });
    assert.equal((await listed(human, first.name)).busy, false);
    env.clock.advance(10);
    await env.restart();
    human = env.human();
    assert.deepEqual([(await listed(human, first.name)).harnessSessionId, (await listed(human, first.name)).busy,
      (await listed(human, first.name)).lastSeen], ["A", null, 1_700_000_000_020]);
    env.clock.advance(10);
    const attached = env.human();
    assert.deepEqual((await attached.request("claude_attach", { sessionId: "B" })).session, first);
    assert.deepEqual([(await listed(human, first.name)).harnessSessionId, (await listed(human, first.name)).lastSeen],
      ["B", 1_700_000_000_040]);
    env.clock.advance(10);
    await attached.request("session_status", { busy: null });
    assert.equal((await listed(human, first.name)).lastSeen, 1_700_000_000_050);
    env.clock.advance(10);
    await human.request("claude_hook", { event: "reconcile", sessionId: "A", busy: true });
    assert.deepEqual([(await listed(human, first.name)).harnessSessionId, (await listed(human, first.name)).busy], ["A", true]);
    env.clock.advance(10);
    await human.request("claude_hook", { event: "start", key: "new-process", sessionId: "A" });
    assert.equal((await listed(human, first.name)).busy, null);
  } finally { await env.close(); }
});

test("late Claude lineage reconciliation carries contact and busy to the durable ancestor", async () => {
  const env = await startEnv();
  try {
    let human = env.human();
    const original = (await human.request("claude_hook", {
      event: "start", key: "original", sessionId: "A", name: "ancestor", transcriptPath: originalTranscript,
    })).session as { id: string; name: string };
    await human.request("claude_hook", { event: "end", sessionId: "A" });
    env.clock.advance(10);
    const path = join(env.home, "late.jsonl");
    const provisional = (await human.request("claude_hook", {
      event: "start", key: "provisional", sessionId: "B", name: "provisional", transcriptPath: path, source: "resume", busy: true,
    })).session as { id: string; name: string };
    assert.notEqual(provisional.id, original.id);
    env.clock.advance(10);
    writeFileSync(path, readFileSync(resumedTranscript, "utf8"));
    assert.deepEqual((await human.request("claude_hook", { event: "reconcile", sessionId: "B" })).session, original);
    assert.deepEqual([(await listed(human, original.name)).lastSeen, (await listed(human, original.name)).busy,
      (await listed(human, original.name)).harnessSessionId], [1_700_000_000_020, true, "B"]);
    assert.ok(!(await human.sync()).sessions.some((session) => session.id === provisional.id));
    await env.restart();
    human = env.human();
    assert.deepEqual([(await listed(human, original.name)).lastSeen, (await listed(human, original.name)).busy,
      (await listed(human, original.name)).harnessSessionId], [1_700_000_000_020, null, "B"]);
  } finally { await env.close(); }
});

test("legacy list contact and status stay unknown instead of using creation time or historical Claude ids", async () => {
  const env = await startEnv({}, (db) => {
    db.exec(`CREATE TABLE sessions(
      id TEXT PRIMARY KEY, harness TEXT NOT NULL, key TEXT NOT NULL, name TEXT NOT NULL UNIQUE,
      cwd TEXT, inbound TEXT NOT NULL DEFAULT 'accept', state TEXT NOT NULL,
      gone_at INTEGER, claude_socket TEXT, claude_session_ids TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL, UNIQUE(harness,key));
      INSERT INTO sessions(id,harness,key,name,state,claude_session_ids,created_at)
      VALUES('legacy','claude','old-socket','legacy','live','["A","B"]',1600000000000);`);
  });
  try {
    assert.deepEqual([(await listed(env.human(), "legacy")).lastSeen, (await listed(env.human(), "legacy")).busy,
      (await listed(env.human(), "legacy")).harnessSessionId], [null, null, null]);
    await env.restart();
    assert.deepEqual([(await listed(env.human(), "legacy")).lastSeen, (await listed(env.human(), "legacy")).busy,
      (await listed(env.human(), "legacy")).harnessSessionId], [null, null, null]);
  } finally { await env.close(); }
});
