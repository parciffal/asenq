import assert from "node:assert/strict";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import type { AsenqClient } from "../src/shared/client.js";
import type { SendResult } from "../src/shared/protocol.js";
import { z } from "zod";
import { zodShape } from "../src/shared/schema.js";
import { callTool, TOOLS } from "../src/shared/tools.js";
import { isSession, startEnv, type TestEnv } from "./helpers.js";

let env: TestEnv | undefined;
afterEach(async () => {
  await env?.close();
  env = undefined;
});

async function send(c: AsenqClient, to: string, text: string, extra: Record<string, unknown> = {}): Promise<string> {
  const r = await c.request("send", { to, text, ...extra });
  const [result] = r.results as SendResult[];
  assert.ok(result.msgId);
  return result.msgId;
}

function messageIds(output: string): string[] {
  return [...output.matchAll(/· (m_[0-9a-f]{12})/g)].map((match) => match[1]);
}

test("list identifies human-assigned roles without transferring them across reused names", async () => {
  env = await startEnv();
  const human = env.human();
  const orchestrator = await env.adapter("omp", "orch-key", "coordinator");
  const worker = await env.adapter("opencode", "worker-key", "builder");
  await human.request("set_role", { name: "coordinator", role: "orchestrator" });
  await human.request("set_role", { name: "builder", role: "worker" });
  const listed = await callTool(orchestrator.client, "asenq_list", {});
  assert.match(listed.split("\n").find((line) => line.startsWith("coordinator "))!, /role=orchestrator.*\[you\]/);
  assert.match(listed.split("\n").find((line) => line.startsWith("builder "))!, /role=worker/);
  await worker.client.request("rename", { name: "renamed" });
  const renamed = await callTool(orchestrator.client, "asenq_list", {});
  assert.match(renamed.split("\n").find((line) => line.startsWith("renamed "))!, /role=worker/);
  await human.request("set_role", { name: "renamed", role: null });
  const unset = await callTool(orchestrator.client, "asenq_list", {});
  assert.doesNotMatch(unset.split("\n").find((line) => line.startsWith("renamed "))!, /role=/);
  await human.request("set_role", { name: "renamed", role: "worker" });
  await worker.client.request("unregister");
  await env.adapter("opencode", "replacement-key", "renamed");
  const reused = await callTool(orchestrator.client, "asenq_list", {});
  assert.doesNotMatch(reused.split("\n").find((line) => line.startsWith("renamed "))!, /role=/);
});

test("orchestrator tools edit only their channels and shared members' roles", async () => {
  env = await startEnv();
  const human = env.human();
  const alpha = await env.adapter("omp", "alpha", "alpha");
  const beta = await env.adapter("omp", "beta", "beta");
  const worker = await env.adapter("omp", "worker", "worker");
  const outside = await env.adapter("omp", "outside", "outside");
  await human.request("set_role", { name: "alpha", role: "orchestrator" });
  await human.request("set_role", { name: "beta", role: "orchestrator" });
  for (const name of ["red", "blue"]) await human.request("channel_create", { channel: name });
  await human.request("channel_add", { channel: "red", name: "alpha" });
  await human.request("channel_add", { channel: "blue", name: "beta" });

  await callTool(alpha.client, "asenq_channel_add", { channel: "red", name: "worker" });
  await callTool(beta.client, "asenq_channel_add", { channel: "blue", name: "worker" });
  await callTool(alpha.client, "asenq_set_role", { name: "worker", role: "worker" });
  for (const channel of ["red", "blue"]) {
    const members = await callTool(outside.client, "asenq_channel_members", { channel });
    const line = members.split("\n").find((row) => row.startsWith("worker "))!;
    assert.ok(line.includes("role=worker"));
    assert.ok(line.includes("state=live"));
    assert.ok(line.includes(`id=${worker.session.id}`));
  }
  assert.match(await callTool(alpha.client, "asenq_set_role", { name: "outside", role: "worker" }), /^asenq error \(not_permitted\): /);
  assert.match(await callTool(alpha.client, "asenq_channel_add", { channel: "blue", name: "outside" }), /^asenq error \(not_permitted\): /);
  assert.match(await callTool(alpha.client, "asenq_channel_remove", { channel: "blue", name: "worker" }), /^asenq error \(not_permitted\): /);
  assert.match(await callTool(worker.client, "asenq_set_role", { name: "alpha", role: "worker" }), /^asenq error \(not_permitted\): /);
  assert.match(await callTool(worker.client, "asenq_channel_add", { channel: "red", name: "outside" }), /^asenq error \(not_permitted\): /);
  assert.match(await callTool(worker.client, "asenq_channel_remove", { channel: "red", name: "alpha" }), /^asenq error \(not_permitted\): /);
  const identities = (await human.sync()).sessions;
  assert.equal(identities.find((s) => s.id === outside.session.id)?.role, null);
  assert.equal(identities.find((s) => s.id === alpha.session.id)?.role, "orchestrator");
  const blue = await callTool(alpha.client, "asenq_channel_members", { channel: "blue" });
  assert.ok(blue.includes(`id=${beta.session.id}`));
  assert.ok(blue.includes(`id=${worker.session.id}`));
  assert.ok(!blue.includes(`id=${outside.session.id}`));

  await callTool(beta.client, "asenq_set_role", { name: "worker", role: "unset" });
  assert.equal((await human.sync()).sessions.find((s) => s.id === worker.session.id)?.role, null);
  assert.match(await callTool(worker.client, "asenq_channel_remove", { channel: "red", name: "alpha" }), /^asenq error \(not_permitted\): /);
  await callTool(alpha.client, "asenq_channel_remove", { channel: "red", name: "worker" });
  const red = await callTool(beta.client, "asenq_channel_members", { channel: "red" });
  assert.ok(red.includes(`id=${alpha.session.id}`));
  assert.ok(!red.includes(`id=${worker.session.id}`));
  const retained = await callTool(alpha.client, "asenq_channel_members", { channel: "blue" });
  assert.ok(retained.includes(`id=${worker.session.id}`));
  assert.match(retained.split("\n").find((row) => row.startsWith("worker "))!, /role=unset/);
});

test("orchestrator tools create with membership and self-join existing channels while worker and unset sessions cannot", async () => {
  env = await startEnv();
  const human = env.human();
  const shared = await env.adapter("opencode", "orchestrator", "orchestrator");
  const worker = (await shared.client.request("register", { harness: "opencode", key: "worker", name: "worker" }))
    .session as { id: string; name: string };
  const unset = (await shared.client.request("register", { harness: "opencode", key: "unset", name: "unset" }))
    .session as { id: string; name: string };
  await human.request("set_role", { name: "orchestrator", role: "orchestrator" });
  await human.request("set_role", { name: "worker", role: "worker" });
  assert.match(await callTool(shared.client, "asenq_channel_create", { channel: "unselected" }), /^asenq error \(bad_request\): /);
  await callTool(shared.client, "asenq_channel_create", { channel: "new" }, shared.session.id);
  const initial = await callTool(shared.client, "asenq_channel_members", { channel: "new" }, shared.session.id);
  assert.ok(initial.includes(`id=${shared.session.id}`));
  assert.ok(!initial.includes(`id=${worker.id}`));
  assert.ok(!initial.includes(`id=${unset.id}`));
  assert.match(initial.split("\n").find((row) => row.startsWith("orchestrator "))!, /role=orchestrator/);
  await callTool(shared.client, "asenq_channel_add", { channel: "new", name: "worker" }, shared.session.id);
  assert.ok((await callTool(shared.client, "asenq_channel_members", { channel: "new" }, worker.id)).includes(`id=${worker.id}`));

  await human.request("channel_create", { channel: "existing" });
  await callTool(shared.client, "asenq_channel_create", { channel: "existing" }, shared.session.id);
  assert.match(await callTool(shared.client, "asenq_channel_members", { channel: "existing" }, shared.session.id), /no members/);
  assert.match(await callTool(shared.client, "asenq_channel_add", { channel: "existing", name: "worker" }, shared.session.id), /^asenq error \(not_permitted\): /);
  await callTool(shared.client, "asenq_channel_add", { channel: "existing", name: "orchestrator" }, shared.session.id);
  await callTool(shared.client, "asenq_channel_add", { channel: "existing", name: "worker" }, shared.session.id);
  const joined = await callTool(shared.client, "asenq_channel_members", { channel: "existing" }, shared.session.id);
  assert.ok(joined.includes(`id=${shared.session.id}`));
  assert.ok(joined.includes(`id=${worker.id}`));
  await callTool(shared.client, "asenq_channel_remove", { channel: "existing", name: "worker" }, shared.session.id);

  for (const session of [worker, unset]) {
    assert.match(await callTool(shared.client, "asenq_channel_create", { channel: `denied-${session.name}` }, session.id), /^asenq error \(not_permitted\): /);
    assert.match(await callTool(shared.client, "asenq_channel_create", { channel: "existing" }, session.id), /^asenq error \(not_permitted\): /);
    assert.match(await callTool(shared.client, "asenq_channel_add", { channel: "existing", name: session.name }, session.id), /^asenq error \(not_permitted\): /);
  }
  const existing = await callTool(shared.client, "asenq_channel_members", { channel: "existing" }, shared.session.id);
  assert.ok(existing.includes(`id=${shared.session.id}`));
  assert.ok(!existing.includes(`id=${worker.id}`));
  assert.ok(!existing.includes(`id=${unset.id}`));
  const channels = (await human.sync()).channels;
  assert.deepEqual(channels.map((channel) => channel.name).sort(), ["existing", "new"]);
});

test("channel tools distinguish empty rosters and channels without posts", async () => {
  env = await startEnv();
  const reader = await env.adapter("omp", "reader", "reader");
  await env.human().request("channel_create", { channel: "empty" });
  const members = await callTool(reader.client, "asenq_channel_members", { channel: "empty" });
  assert.match(members, /no members/);
  assert.ok(!members.includes("role="));
  const channels = await callTool(reader.client, "asenq_channel_list", {});
  const empty = channels.split("\n").find((row) => row.startsWith("#empty "))!;
  assert.ok(empty.includes("0 messages"));
  assert.ok(empty.includes("no posts"));
  assert.ok(!empty.includes("1970"));
  await callTool(reader.client, "asenq_channel_send", { channel: "posted", text: "Read on demand" });
  assert.match(await callTool(reader.client, "asenq_channel_members", { channel: "posted" }), /no members/);
  const posted = (await callTool(reader.client, "asenq_channel_list", {})).split("\n").find((row) => row.startsWith("#posted "))!;
  assert.ok(posted.includes("1 messages"));
  assert.ok(posted.includes(new Date(env.clock.now()).toISOString()));
  assert.match(await callTool(reader.client, "asenq_channel_members", { channel: "missing" }), /^asenq error \(unknown_channel\): /);
});

test("member output follows durable identity names, full roles and raw lifecycle states", async () => {
  env = await startEnv({ graceMs: 100 });
  const human = env.human();
  const orchestrator = await env.adapter("omp", "orchestrator", "orchestrator");
  const member = await env.adapter("omp", "member", "member");
  await human.request("set_role", { name: "orchestrator", role: "orchestrator" });
  await human.request("set_role", { name: "member", role: "worker" });
  await human.request("channel_create", { channel: "roster" });
  for (const name of ["orchestrator", "member"]) await human.request("channel_add", { channel: "roster", name });
  const renamed = "member-with-a-long-name-that-must-stay";
  await member.client.request("rename", { name: renamed });
  const live = await callTool(orchestrator.client, "asenq_channel_members", { channel: "roster" });
  assert.match(live.split("\n").find((row) => row.startsWith("orchestrator "))!, /role=orchestrator/);
  const assertMember = (output: string, state: string): void => {
    const row = output.split("\n").find((line) => line.includes(`id=${member.session.id}`))!;
    assert.ok(row.startsWith(`${renamed} `));
    assert.ok(row.includes("role=worker"));
    assert.ok(row.includes(`state=${state}`));
  };
  assertMember(live, "live");
  assert.ok(!live.split("\n").some((row) => row.startsWith("member ")));
  const gone = await env.watch(isSession("gone", renamed));
  member.client.close();
  await gone.event;
  assertMember(await callTool(orchestrator.client, "asenq_channel_members", { channel: "roster" }), "gone");
  assert.match(await callTool(orchestrator.client, "asenq_channel_add", { channel: "roster", name: renamed }), /^asenq error \(not_live\): /);
  env.clock.advance(101);
  env.daemon.sweep();
  assertMember(await callTool(orchestrator.client, "asenq_channel_members", { channel: "roster" }), "removed");
  await callTool(orchestrator.client, "asenq_channel_remove", { channel: "roster", name: "member" });
  const removed = await callTool(orchestrator.client, "asenq_channel_members", { channel: "roster" });
  assert.ok(!removed.includes(`id=${member.session.id}`));
  assert.ok(removed.includes(`id=${orchestrator.session.id}`));
});

test("multi-bound tool edits authorize the selected session, never another orchestrator", async () => {
  env = await startEnv();
  const human = env.human();
  const shared = await env.adapter("opencode", "alpha", "alpha");
  const beta = (await shared.client.request("register", { harness: "opencode", key: "beta", name: "beta" }))
    .session as { id: string; name: string };
  const worker = await env.adapter("omp", "worker", "worker");
  await human.request("set_role", { name: "alpha", role: "orchestrator" });
  await human.request("set_role", { name: "beta", role: "orchestrator" });
  for (const channel of ["red", "blue"]) await human.request("channel_create", { channel });
  await human.request("channel_add", { channel: "red", name: "alpha" });
  await human.request("channel_add", { channel: "blue", name: "beta" });
  await callTool(shared.client, "asenq_channel_add", { channel: "red", name: "worker" }, shared.session.id);
  await callTool(shared.client, "asenq_set_role", { name: "worker", role: "worker" }, shared.session.id);
  assert.match(await callTool(shared.client, "asenq_set_role", { name: "worker", role: "orchestrator" }, beta.id), /^asenq error \(not_permitted\): /);
  assert.match(await callTool(shared.client, "asenq_channel_remove", { channel: "red", name: "worker" }, beta.id), /^asenq error \(not_permitted\): /);
  assert.match(await callTool(shared.client, "asenq_channel_add", { channel: "red", name: "alpha" }, beta.id), /^asenq error \(not_permitted\): /);
  for (const [tool, args] of [
    ["asenq_channel_add", { channel: "red", name: "beta" }],
    ["asenq_channel_remove", { channel: "red", name: "worker" }],
    ["asenq_set_role", { name: "worker", role: "orchestrator" }],
  ] as const) {
    assert.match(await callTool(shared.client, tool, args), /^asenq error \(bad_request\): /);
  }
  const red = await callTool(shared.client, "asenq_channel_members", { channel: "red" }, beta.id);
  assert.ok(red.includes(`id=${worker.session.id}`));
  assert.ok(!red.includes(`id=${beta.id}`));
  assert.match(red.split("\n").find((row) => row.startsWith("worker "))!, /role=worker/);
  await callTool(shared.client, "asenq_channel_add", { channel: "blue", name: "worker" }, beta.id);
  await callTool(shared.client, "asenq_set_role", { name: "worker", role: "unset" }, beta.id);
  await callTool(shared.client, "asenq_channel_remove", { channel: "red", name: "worker" }, shared.session.id);
  const after = await callTool(shared.client, "asenq_channel_members", { channel: "red" }, shared.session.id);
  assert.ok(!after.includes(`id=${worker.session.id}`));
  assert.ok(after.includes(`id=${shared.session.id}`));
  const blue = await callTool(shared.client, "asenq_channel_members", { channel: "blue" }, shared.session.id);
  assert.ok(blue.includes(`id=${worker.session.id}`));
  assert.match(blue.split("\n").find((row) => row.startsWith("worker "))!, /role=unset/);
  assert.equal((await human.sync()).sessions.find((s) => s.id === worker.session.id)?.role, null);
});

test("ambiguous member removal exposes identities for human remediation without changing the roster", async () => {
  env = await startEnv();
  const human = env.human();
  const orchestrator = await env.adapter("omp", "orchestrator", "orchestrator");
  await human.request("set_role", { name: "orchestrator", role: "orchestrator" });
  await human.request("channel_create", { channel: "roster" });
  await human.request("channel_add", { channel: "roster", name: "orchestrator" });
  const first = await env.adapter("omp", "first", "duplicate");
  await callTool(orchestrator.client, "asenq_channel_add", { channel: "roster", name: "duplicate" });
  await first.client.request("unregister");
  const second = await env.adapter("omp", "second", "duplicate");
  await callTool(orchestrator.client, "asenq_channel_add", { channel: "roster", name: "duplicate" });
  await second.client.request("unregister");
  const refused = await callTool(orchestrator.client, "asenq_channel_remove", { channel: "roster", name: "duplicate" });
  assert.match(refused, /^asenq error \(ambiguous_target\): /);
  for (const id of [first.session.id, second.session.id]) assert.ok(refused.includes(id));
  assert.ok(refused.includes("duplicate"));
  assert.ok(refused.includes("removed"));
  const members = await callTool(orchestrator.client, "asenq_channel_members", { channel: "roster" });
  for (const id of [first.session.id, second.session.id]) {
    const row = members.split("\n").find((line) => line.includes(`id=${id}`))!;
    assert.ok(row.startsWith("duplicate "));
    assert.ok(row.includes("role=unset"));
    assert.ok(row.includes("state=removed"));
  }
  await human.request("channel_remove", { channel: "roster", sessionId: first.session.id });
  await callTool(orchestrator.client, "asenq_channel_remove", { channel: "roster", name: "duplicate" });
  const after = await callTool(orchestrator.client, "asenq_channel_members", { channel: "roster" });
  assert.ok(!after.includes(`id=${first.session.id}`));
  assert.ok(!after.includes(`id=${second.session.id}`));
  assert.ok(after.includes(`id=${orchestrator.session.id}`));
});

test("inbox clips an oversized body within the total cap and identifies full-text recovery", async () => {
  env = await startEnv();
  const receiver = await env.adapter("omp", "receiver", "receiver");
  const text = "body-start:" + "x".repeat(20_000) + ":body-end";
  const r = await env.human().request("send", { to: "receiver", text, thread: "large" });
  const [{ msgId }] = r.results as SendResult[];
  const output = await callTool(receiver.client, "asenq_inbox", { unread_only: false });

  assert.ok(output.length <= 16_000, `inbox returned ${output.length} characters`);
  assert.ok(output.includes(`human → receiver · ${msgId}`));
  assert.ok(output.includes("body-start:"));
  assert.ok(!output.includes(":body-end"));
  assert.match(output, /truncated/);
  assert.match(output, /more available/);
  assert.match(output, /asenq_thread_read/);
  assert.match(output, /large/);
  assert.ok(!output.includes("before="), "a clipped message must not be paged past");
  assert.ok(output.includes(`asenq_inbox id=${msgId}`));
  assert.ok((await callTool(receiver.client, "asenq_thread_read", { thread: "large" })).endsWith(text));
});

test("explicit inbox id recovers a full oversized message for its participants only", async () => {
  env = await startEnv();
  const sender = await env.adapter("omp", "sender", "sender");
  const receiver = await env.adapter("omp", "receiver", "receiver");
  const stranger = await env.adapter("omp", "stranger", "stranger");
  const text = "full-body-start:" + "x".repeat(20_000) + ":full-body-end";
  const r = await sender.client.request("send", { to: "receiver", text });
  const [{ msgId }] = r.results as SendResult[];

  const clipped = await callTool(receiver.client, "asenq_inbox", {});
  assert.ok(clipped.length <= 16_000);
  assert.match(clipped, /truncated/);
  const recovered = await callTool(receiver.client, "asenq_inbox", {
    id: msgId, thread: "unmatched", from: "stranger", since: "2999-01-01T00:00:00Z", unread_only: true,
  });
  assert.ok(recovered.length > 16_000);
  assert.ok(recovered.endsWith(text));
  assert.ok(!recovered.includes("[truncated"));
  assert.ok((await callTool(sender.client, "asenq_inbox", { id: msgId })).endsWith(text));
  const foreign = await callTool(stranger.client, "asenq_inbox", { id: msgId });
  assert.ok(!foreign.includes("full-body-start:"));
  assert.deepEqual(messageIds(foreign), []);
});

test("inbox history pages newest first with a usable older-page marker", async () => {
  env = await startEnv();
  const receiver = await env.adapter("omp", "receiver", "receiver");
  const human = env.human();
  const ids: string[] = [];
  for (let i = 0; i < 23; i++) ids.push(await send(human, "receiver", `message-${i}`));

  const first = await callTool(receiver.client, "asenq_inbox", { unread_only: false });
  assert.deepEqual(messageIds(first), ids.slice(3).reverse());
  assert.match(first, /more available/);
  assert.ok(first.includes(`before=${ids[3]}`));
  const older = await callTool(receiver.client, "asenq_inbox", { unread_only: false, before: ids[3], limit: 2 });
  assert.deepEqual(messageIds(older), [ids[2], ids[1]]);
  assert.ok(older.includes(`before=${ids[1]}`));
  const last = await callTool(receiver.client, "asenq_inbox", { unread_only: false, before: ids[1] });
  assert.deepEqual(messageIds(last), [ids[0]]);
  assert.ok(!last.includes("more available"));
});

test("default inbox drains delivered large messages oldest first without skipping budgeted rows", async () => {
  env = await startEnv();
  const receiver = await env.adapter("omp", "receiver", "receiver");
  const human = env.human();
  const texts = [0, 1, 2].map((i) => `body-${i}:` + "x".repeat(8_000) + `:end-${i}`);
  const ids: string[] = [];
  for (const text of texts) ids.push(await send(human, "receiver", text));

  for (let i = 0; i < texts.length; i++) {
    const output = await callTool(receiver.client, "asenq_inbox", {});
    assert.ok(output.length <= 16_000);
    assert.deepEqual(messageIds(output), [ids[i]]);
    assert.ok(output.includes(texts[i]), "budgeted rows must be displayed whole before advancing");
    assert.equal(output.includes("more available"), i < texts.length - 1);
  }
  assert.equal(await callTool(receiver.client, "asenq_inbox", {}), "no messages");
  assert.deepEqual(messageIds(await callTool(receiver.client, "asenq_inbox", { unread_only: false, limit: 1 })), [ids[2]]);
  assert.equal(await callTool(receiver.client, "asenq_inbox", {}), "no messages");
  const newest = await send(human, "receiver", "new after draining");
  assert.deepEqual(messageIds(await callTool(receiver.client, "asenq_inbox", {})), [newest]);
});

test("inbox combines sender, thread and exclusive cursors without advancing unread position", async () => {
  env = await startEnv();
  const receiver = await env.adapter("omp", "receiver", "receiver");
  const sender = await env.adapter("omp", "sender", "sender");
  const human = env.human();
  const first = await send(human, "receiver", "first", { thread: "chosen" });
  const middle = await send(human, "receiver", "middle", { thread: "chosen" });
  await send(human, "receiver", "wrong thread", { thread: "other" });
  await send(sender.client, "receiver", "wrong sender", { thread: "chosen" });
  const last = await send(human, "receiver", "last", { thread: "chosen" });

  const filtered = await callTool(receiver.client, "asenq_inbox", {
    since: first, before: last, thread: "chosen", from: "human", limit: 1,
  });
  assert.deepEqual(messageIds(filtered), [middle]);
  assert.ok(!filtered.includes("more available"));
  assert.deepEqual(messageIds(await callTool(receiver.client, "asenq_inbox", { limit: 1 })), [first]);
});

test("thread read selects the caller and returns both directions in durable order", async () => {
  env = await startEnv();
  const shared = await env.adapter("opencode", "alpha", "alpha");
  const other = await env.adapter("omp", "other", "other");
  const human = env.human();
  const first = await send(shared.client, "human", "alpha sent", { thread: "shared" });
  const second = await send(human, "alpha", "alpha received", { thread: "shared" });
  const third = await send(other.client, "alpha", "other sent", { thread: "shared" });
  const unrelated = await send(human, "alpha", "unrelated", { thread: "other" });
  const beta = (await shared.client.request("register", { harness: "opencode", key: "beta", name: "beta", cwd: "/work" }))
    .session as { id: string; name: string };
  const betaOnly = await send(shared.client, "human", "beta sent", { as: beta.id, thread: "shared" });

  const alphaThread = await callTool(shared.client, "asenq_thread_read", { thread: "shared" }, shared.session.id);
  assert.deepEqual(messageIds(alphaThread), [first, second, third]);
  assert.ok(alphaThread.includes("alpha → human"));
  assert.ok(alphaThread.includes("human → alpha"));
  assert.deepEqual(messageIds(await callTool(shared.client, "asenq_thread_read", { thread: "shared", since: first }, shared.session.id)), [second, third]);
  assert.deepEqual(messageIds(await callTool(shared.client, "asenq_thread_read", { thread: "shared" }, beta.id)), [betaOnly]);
  assert.deepEqual(messageIds(await callTool(shared.client, "asenq_inbox", { unread_only: false }, shared.session.id)), [unrelated, third, second]);
});

test("inbox preserves a whole body that fits the cap and clips oversized thread metadata safely", async () => {
  env = await startEnv();
  const receiver = await env.adapter("omp", "receiver", "receiver");
  const human = env.human();
  const text = "x".repeat(15_700);
  const fullId = await send(human, "receiver", text);
  const full = await callTool(receiver.client, "asenq_inbox", { unread_only: false, limit: 1 });
  assert.deepEqual(messageIds(full), [fullId]);
  assert.ok(full.endsWith(text));
  assert.ok(!full.includes("truncated"));
  assert.ok(full.length <= 16_000);

  const hugeId = await send(human, "receiver", "visible body", { thread: "t".repeat(20_000) });
  const clipped = await callTool(receiver.client, "asenq_inbox", { unread_only: false, limit: 1 });
  assert.ok(clipped.length <= 16_000);
  assert.deepEqual(messageIds(clipped), [hugeId]);
  assert.ok(clipped.includes("visible body"));
  assert.match(clipped, /truncated/);
  assert.match(clipped, /more available/);
  assert.ok(clipped.includes(`asenq_inbox id=${hugeId}`));
});

test("inbox clipping keeps Unicode bodies well formed at either character boundary", async () => {
  env = await startEnv();
  const receiver = await env.adapter("omp", "receiver", "receiver");
  const human = env.human();
  for (const prefix of ["", "x"]) {
    const id = await send(human, "receiver", prefix + "😀".repeat(10_000));
    const output = await callTool(receiver.client, "asenq_inbox", { unread_only: false, limit: 1 });
    assert.ok(output.length <= 16_000);
    assert.deepEqual(messageIds(output), [id]);
    assert.match(output, /truncated/);
    assert.ok(output.includes(`asenq_inbox id=${id}`));
    assert.doesNotMatch(output, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  }
});

test("inbox keeps a near-cap message whole when a compact more marker fits", async () => {
  env = await startEnv();
  const receiver = await env.adapter("omp", "receiver", "receiver");
  const human = env.human();
  await send(human, "receiver", "older row");
  const text = "near-cap-start:" + "x".repeat(15_850) + ":near-cap-end";
  const id = await send(human, "receiver", text);
  const output = await callTool(receiver.client, "asenq_inbox", { unread_only: false });

  assert.ok(output.length <= 16_000);
  assert.deepEqual(messageIds(output), [id]);
  assert.ok(output.includes(text), "a compact marker must not cause an otherwise-fitting body to be clipped");
  assert.match(output, /more available/);
  assert.ok(!output.includes("truncated"));
});

test("control tools deliver urgent actions and retain them in inbox and thread recovery", async () => {
  env = await startEnv();
  const sender = await env.adapter("omp", "sender", "sender");
  const receiver = await env.adapter("omp", "receiver", "receiver");

  for (const action of ["pause", "resume", "cancel"]) {
    const result = await callTool(sender.client, "asenq_send", {
      to: "receiver", text: "Please change course", kind: "control", action, thread: "control-loop",
    });
    assert.match(result, /^receiver m_[0-9a-f]{12} delivered$/);
    const delivery = await receiver.nextDelivery();
    assert.match(delivery.text.split("\n")[0], /\[URGENT\]/);
    assert.ok(delivery.text.split("\n")[0].includes(`action=${action}`));
    const recovered = await callTool(receiver.client, "asenq_inbox", { id: delivery.msg.id });
    assert.ok(recovered.includes(`kind=control · action=${action}`));
    assert.ok(recovered.endsWith("Please change course"));
  }

  for (const output of [
    await callTool(receiver.client, "asenq_inbox", { unread_only: false }),
    await callTool(sender.client, "asenq_thread_read", { thread: "control-loop" }),
  ]) {
    assert.equal(messageIds(output).length, 3, "distinct actions with identical text all survive");
    for (const action of ["pause", "resume", "cancel"]) assert.ok(output.includes(`kind=control · action=${action}`));
  }
});

test("control tool validation errors stay visible and admit no messages", async () => {
  env = await startEnv();
  const sender = await env.adapter("omp", "sender", "sender");
  const receiver = await env.adapter("omp", "receiver", "receiver");
  for (const extra of [
    { kind: "control" },
    { kind: "control", action: "stop" },
    { kind: "chat", action: "pause" },
    { action: "resume" },
    { kind: "control", action: "cancel", text: "" },
  ]) {
    const result = await callTool(sender.client, "asenq_send", {
      to: "receiver", text: "Do not admit invalid controls", ...extra,
    });
    assert.match(result, /^asenq error \(bad_request\): /);
  }
  assert.equal(await callTool(receiver.client, "asenq_inbox", { unread_only: false }), "no messages");
  assert.equal(receiver.deliveries.length, 0, "invalid requests never reach delivery");
});

test("clipped control metadata retains its action and full recovery preserves the thread", async () => {
  env = await startEnv();
  const receiver = await env.adapter("omp", "receiver", "receiver");
  const thread = "t".repeat(20_000);
  const msgId = await send(env.human(), "receiver", "Keep this control body", { kind: "control", action: "cancel", thread });
  const clipped = await callTool(receiver.client, "asenq_inbox", { unread_only: false });
  assert.ok(clipped.length <= 16_000);
  assert.ok(clipped.includes(` · ${msgId} · kind=control · action=cancel`), "clipping optional metadata keeps the control intent");
  assert.ok(clipped.includes("Keep this control body"));
  assert.match(clipped, /truncated/);
  for (const recovered of [
    await callTool(receiver.client, "asenq_inbox", { id: msgId }),
    await callTool(receiver.client, "asenq_thread_read", { thread }),
  ]) {
    assert.ok(recovered.includes(`kind=control · action=cancel · thread=${thread}`));
    assert.ok(recovered.endsWith("Keep this control body"));
  }
});

test("file-only tools accept nested input and expose references in inbox and thread reads", async () => {
  env = await startEnv();
  const shared = await env.adapter("opencode", "alpha", "alpha");
  const receiver = await env.adapter("omp", "receiver", "receiver");
  const beta = (await shared.client.request("register", { harness: "opencode", key: "beta", name: "beta", cwd: "/work" }))
    .session as { id: string };
  const path = join(env.home, "report.txt");
  writeFileSync(path, "hello");
  const schema = z.object(zodShape(z, TOOLS.find((tool) => tool.name === "asenq_send")!.params));
  const args = schema.parse({ to: "receiver", file: { path, summary: "Review evidence" }, thread: "file-review" });
  assert.equal(schema.safeParse({ to: "receiver", file: { path } }).success, false);
  assert.equal(schema.safeParse({ to: "receiver", file: { path: 123, summary: "Review evidence" } }).success, false);

  const result = await callTool(shared.client, "asenq_send", args, beta.id);
  assert.match(result, /^receiver m_[0-9a-f]{12} delivered$/);
  const delivery = await receiver.nextDelivery();
  assert.equal(delivery.msg.from, "beta");
  assert.equal(delivery.msg.text, "");
  assert.deepEqual(delivery.msg.file, {
    path, summary: "Review evidence",
    sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824", size: 5,
  });
  for (const output of [
    await callTool(receiver.client, "asenq_inbox", {}),
    await callTool(receiver.client, "asenq_inbox", { id: delivery.msg.id }),
    await callTool(shared.client, "asenq_thread_read", { thread: "file-review" }, beta.id),
  ]) {
    assert.ok(output.includes("Review evidence"));
    assert.ok(output.includes(path));
    assert.ok(output.includes("2cf24dba5fb0"));
    assert.match(output, /\b5 bytes\b/);
    assert.ok(output.includes(`read the file; verify with asenq_file_check id=${delivery.msg.id}`));
    assert.ok(!output.includes("hello"), "reads expose the reference, not the file contents");
  }
  assert.equal(await callTool(shared.client, "asenq_thread_read", { thread: "file-review" }, shared.session.id), "no messages");
});

test("text-plus-file tools keep caller isolation for sender and human file checks", async () => {
  env = await startEnv();
  const shared = await env.adapter("opencode", "alpha", "alpha");
  const beta = (await shared.client.request("register", { harness: "opencode", key: "beta", name: "beta", cwd: "/work" }))
    .session as { id: string };
  const path = join(env.home, "report.txt");
  writeFileSync(path, "hello");
  const result = await callTool(shared.client, "asenq_send", {
    to: "human", text: "Please review before continuing", file: { path, summary: "Review evidence" }, thread: "review",
  }, beta.id);
  const id = result.match(/\bm_[0-9a-f]{12}\b/)?.[0];
  assert.ok(id, result);
  const human = env.human();
  const output = await callTool(human, "asenq_inbox", { id });
  assert.ok(output.includes("Please review before continuing"));
  assert.ok(output.includes("Review evidence"));
  assert.ok(output.includes(path));
  assert.equal(await callTool(shared.client, "asenq_file_check", { id }, beta.id), "match");
  assert.equal(await callTool(human, "asenq_file_check", { id }), "match");
  assert.match(await callTool(shared.client, "asenq_file_check", { id }, shared.session.id), /^asenq error \([^)]+\): /);
  assert.match(await callTool(human, "asenq_file_check", { id: "m_000000000000" }), /^asenq error \([^)]+\): /);
  assert.match(await callTool(human, "asenq_file_check", {}), /^asenq error \(bad_request\): /);
  const plainId = await send(human, "alpha", "No reference");
  assert.match(await callTool(shared.client, "asenq_file_check", { id: plainId }, shared.session.id), /^asenq error \([^)]+\): /);
});

test("file checks report snapshot changes and missing files through real tool calls", async () => {
  env = await startEnv();
  const receiver = await env.adapter("omp", "receiver", "receiver");
  const path = join(env.home, "report.txt");
  writeFileSync(path, "hello");
  const result = await callTool(env.human(), "asenq_send", { to: "receiver", file: { path, summary: "Review evidence" } });
  assert.match(result, /^receiver m_[0-9a-f]{12} delivered$/);
  const { msg } = await receiver.nextDelivery();
  assert.equal(await callTool(receiver.client, "asenq_file_check", { id: msg.id }), "match");
  writeFileSync(path, "HELLO");
  assert.equal(await callTool(receiver.client, "asenq_file_check", { id: msg.id }), "changed");
  unlinkSync(path);
  assert.equal(await callTool(receiver.client, "asenq_file_check", { id: msg.id }), "missing");
  const recovered = await callTool(receiver.client, "asenq_inbox", { id: msg.id });
  assert.ok(recovered.includes("2cf24dba5fb0"), "the send-time snapshot remains after the source is gone");
});

test("file tool validation errors propagate without admitting messages", async () => {
  env = await startEnv();
  const receiver = await env.adapter("omp", "receiver", "receiver");
  const path = join(env.home, "report.txt");
  writeFileSync(path, "hello");
  const directory = join(env.home, "directory");
  mkdirSync(directory);
  for (const args of [
    {},
    { file: { path: "report.txt", summary: "Relative path" } },
    { file: { path: join(env.home, "missing.txt"), summary: "Missing file" } },
    { file: { path: directory, summary: "Not a regular file" } },
    { file: { path } },
    { file: { path, summary: "x".repeat(501) } },
  ]) {
    assert.match(await callTool(env.human(), "asenq_send", { to: "receiver", ...args }), /^asenq error \([^)]+\): /);
  }
  assert.equal(await callTool(receiver.client, "asenq_inbox", { unread_only: false }), "no messages");
});

test("capped inbox preserves file metadata when oversized thread metadata is omitted", async () => {
  env = await startEnv();
  const receiver = await env.adapter("omp", "receiver", "receiver");
  const path = join(env.home, "report.txt");
  writeFileSync(path, "hello");
  const result = await callTool(env.human(), "asenq_send", {
    to: "receiver", file: { path, summary: "Review evidence" }, thread: "t".repeat(20_000),
  });
  assert.match(result, /^receiver m_[0-9a-f]{12} delivered$/);
  const { msg } = await receiver.nextDelivery();
  const output = await callTool(receiver.client, "asenq_inbox", { unread_only: false });
  assert.ok(output.length <= 16_000);
  assert.deepEqual(messageIds(output), [msg.id]);
  assert.ok(output.includes("Review evidence"));
  assert.ok(output.includes(path));
  assert.ok(output.includes("2cf24dba5fb0"));
  assert.ok(output.includes(`asenq_inbox id=${msg.id}`));
});

test("purge preserves sender notices and marks missing reply targets in inbox and thread output", async () => {
  env = await startEnv();
  const sender = await env.adapter("omp", "notice-sender", "notice-sender");
  const target = await env.adapter("omp", "notice-target", "notice-target");
  const human = env.human();
  await human.request("set_inbound", { name: target.session.name, mode: "hold" });
  const original = await send(sender.client, target.session.name, "Waiting for the archived worker");
  await human.request("close", { identity: target.session.id });
  const notice = await sender.nextDelivery();
  assert.equal(notice.msg.replyTo, original);
  await send(sender.client, "human", "Retained follow-up", { thread: "purged-follow-up", replyTo: original });
  assert.ok(!(await callTool(sender.client, "asenq_thread_read", { thread: "purged-follow-up" })).includes("(purged message)"));

  await human.request("purge", { identity: target.session.id });
  const inbox = await callTool(sender.client, "asenq_inbox", { unread_only: false });
  assert.ok(inbox.includes(notice.msg.id), "the live sender keeps its delivery notice");
  assert.ok(inbox.includes("(purged message)"), "inbox displays the missing notice target");
  const thread = await callTool(sender.client, "asenq_thread_read", { thread: "purged-follow-up" });
  assert.ok(thread.includes("Retained follow-up"));
  assert.ok(thread.includes("(purged message)"), "thread recovery displays the missing target");
});

test("reply availability cannot reveal a message outside the caller's direct scope", async () => {
  env = await startEnv();
  const reader = await env.adapter("omp", "reply-reader", "reply-reader");
  const privateSender = await env.adapter("omp", "private-sender", "private-sender");
  const privateReceiver = await env.adapter("omp", "private-receiver", "private-receiver");
  const privateId = await send(privateSender.client, privateReceiver.session.name, "Private body");
  for (const replyTo of [privateId, "m_000000000000"]) {
    await send(reader.client, "human", `Reference ${replyTo}`, { thread: "unavailable-replies", replyTo });
  }
  const result = await reader.client.request("thread_read", { thread: "unavailable-replies" });
  const messages = result.messages as { replyTo: string; replyToMissing?: boolean }[];
  assert.deepEqual(messages.map((message) => message.replyTo), [privateId, "m_000000000000"]);
  assert.ok(messages.every((message) => message.replyToMissing === true));
  const output = await callTool(reader.client, "asenq_thread_read", { thread: "unavailable-replies" });
  assert.equal(output.match(/\(purged message\)/g)?.length, 2);
  assert.ok(!output.includes("Private body"));
});
