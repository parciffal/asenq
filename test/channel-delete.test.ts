import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { ChannelSendResult, ChannelSummary, ListedSession, ReadState, StoredMessage } from "../src/shared/protocol.js";
import { startEnv } from "./helpers.js";
import type { TestEnv } from "./helpers.js";

let env: TestEnv | undefined;
afterEach(async () => {
  await env?.close();
  env = undefined;
});

test("human channel deletion removes posts, memberships and read markers but retains mention DMs", async () => {
  env = await startEnv();
  const human = env.human();
  const alpha = await env.adapter("omp", "delete-alpha", "alpha");
  const beta = await env.adapter("omp", "delete-beta", "beta");
  await human.request("channel_create", { channel: "work" });
  await human.request("channel_create", { channel: "keep" });
  for (const name of ["alpha", "beta"]) await human.request("channel_add", { channel: "work", name });
  await human.request("channel_add", { channel: "keep", name: "alpha" });
  const sent = await human.request("channel_send", { channel: "work", text: "@alpha retain this direct copy" }) as ChannelSendResult;
  assert.equal(sent.results[0].status, "delivered");
  const delivery = await alpha.nextDelivery();
  await beta.client.request("channel_send", { channel: "work", text: "unread channel post" });
  await human.markUnread({ scope: "channel", channel: "work" });
  assert.equal((await human.readState({ scope: "channel", channel: "work" })).unread, 1);
  const watch = await env.watch((event) => event.type === "channel" && event.action === "deleted" && event.channel.name === "work");

  const result = await human.request("channel_delete", { channel: "work" });
  const empty = { name: "work", count: 0, lastAt: 0, lastOrder: 0, memberIds: [] };
  assert.deepEqual(result.channel, empty);
  assert.deepEqual(await watch.event, { type: "channel", action: "deleted", channel: empty });
  assert.deepEqual(((await human.request("channel_list")).channels as ChannelSummary[]).map((channel) => channel.name), ["keep"]);
  const sessions = (await human.request("list")).sessions as ListedSession[];
  assert.deepEqual(sessions.find((session) => session.id === alpha.session.id)!.channels, ["keep"]);
  assert.deepEqual(sessions.find((session) => session.id === beta.session.id)!.channels, []);
  const states = (await human.request("read_state")).states as ReadState[];
  assert.ok(!states.some((state) => state.scope.scope === "channel" && state.scope.channel === "work"));
  assert.ok(states.some((state) => state.scope.scope === "channel" && state.scope.channel === "keep"));
  assert.deepEqual((await human.historyPage({ scope: "channel", channel: "work" })).messages, []);
  const history = (await human.historyPage({ scope: "session", sessionId: alpha.session.id })).messages;
  assert.deepEqual(history.map((message) => [message.id, message.text, message.sourceChannel]),
    [[delivery.msg.id, "@alpha retain this direct copy", "work"]]);
  assert.equal(alpha.deliveries.length, 1, "deletion does not notify members with a direct message");
  assert.equal(beta.deliveries.length, 0);
  await assert.rejects(human.request("channel_members", { channel: "work" }), { code: "unknown_channel" });

  const recreated = await human.request("channel_create", { channel: "work" });
  assert.deepEqual(recreated.channel, empty);
  assert.deepEqual((await human.historyPage({ scope: "channel", channel: "work" })).messages, []);
  assert.equal((await human.readState({ scope: "channel", channel: "work" })).reminder, null);
});

test("workers and orchestrators cannot delete channels", async () => {
  env = await startEnv();
  const human = env.human();
  const worker = await env.adapter("omp", "delete-worker", "worker");
  const orchestrator = await env.adapter("omp", "delete-orchestrator", "orchestrator");
  await human.request("set_role", { name: "worker", role: "worker" });
  await human.request("set_role", { name: "orchestrator", role: "orchestrator" });
  await human.request("channel_create", { channel: "work" });
  for (const name of ["worker", "orchestrator"]) await human.request("channel_add", { channel: "work", name });
  for (const adapter of [worker, orchestrator]) {
    await assert.rejects(adapter.client.request("channel_delete", { channel: "work" }), { code: "bad_request" });
  }
  assert.deepEqual(((await human.request("channel_list")).channels as ChannelSummary[]).map((channel) => channel.name), ["work"]);
});

test("channel deletion rejects unknown and invalid names without changing existing channels", async () => {
  env = await startEnv();
  const human = env.human();
  await human.request("channel_create", { channel: "keep" });
  await assert.rejects(human.request("channel_delete", { channel: "missing" }), { code: "unknown_channel" });
  await assert.rejects(human.request("channel_delete", { channel: "Bad Name" }), { code: "invalid_name" });
  await assert.rejects(human.request("channel_delete"), { code: "bad_request" });
  assert.deepEqual(((await human.request("channel_list")).channels as ChannelSummary[]).map((channel) => channel.name), ["keep"]);
});

test("posting after deletion implicitly recreates the name with only the new post, including after restart", async () => {
  env = await startEnv();
  const human = env.human();
  await human.request("channel_send", { channel: "reusable", text: "old post" });
  await human.request("channel_delete", { channel: "reusable" });
  await env.restart();
  const restarted = env.human();
  assert.deepEqual((await restarted.request("channel_list")).channels, []);
  assert.deepEqual((await restarted.request("read_state")).states, []);
  await restarted.request("channel_send", { channel: "reusable", text: "new post" });
  const channels = (await restarted.request("channel_list")).channels as ChannelSummary[];
  assert.equal(channels.length, 1);
  assert.equal(channels[0].name, "reusable");
  assert.equal(channels[0].count, 1);
  assert.deepEqual(channels[0].memberIds, []);
  assert.deepEqual((await restarted.historyPage({ scope: "channel", channel: "reusable" })).messages.map((message) => message.text), ["new post"]);
});

test("deleting a renamed channel clears rename records instead of leaving dangling redirects", async () => {
  env = await startEnv();
  const human = env.human();
  await human.request("channel_create", { channel: "original" });
  await human.request("channel_rename", { channel: "original", name: "temporary" });
  await human.request("channel_rename", { channel: "temporary", name: "current" });
  await human.request("channel_delete", { channel: "current" });
  for (const channel of ["original", "temporary", "current"]) {
    await assert.rejects(human.request("channel_members", { channel }), { code: "unknown_channel" });
    assert.deepEqual((await human.request("channel_read", { channel })).messages, []);
  }
  await env.restart();
  const restarted = env.human();
  for (const channel of ["original", "temporary", "current"]) {
    await restarted.request("channel_send", { channel, text: "fresh" });
    assert.deepEqual((await restarted.historyPage({ scope: "channel", channel })).messages.map((message) => message.text), ["fresh"]);
  }
});

test("channel deletion preserves held and queued mention copies as actionable direct messages", async () => {
  env = await startEnv();
  const human = env.human();
  const poster = await env.adapter("omp", "delete-poster", "poster");
  const holder = await env.adapter("omp", "delete-holder", "holder");
  await human.request("claude_hook", { event: "start", key: "sid:delete-queued", sessionId: "delete-queued", name: "queued" });
  await human.request("set_inbound", { name: "holder", mode: "hold" });
  await human.request("channel_create", { channel: "work" });
  for (const name of ["holder", "queued"]) await human.request("channel_add", { channel: "work", name });
  const sent = await poster.client.request("channel_send", { channel: "work", text: "@holder @queued preserve pending copies" }) as ChannelSendResult;
  assert.deepEqual(sent.results.map((result) => [result.to, result.status]), [["holder", "held"], ["queued", "queued"]]);
  const heldId = sent.results.find((result) => result.to === "holder")!.msgId!;
  const queuedId = sent.results.find((result) => result.to === "queued")!.msgId!;
  const queued = (await human.sync()).sessions.find((session) => session.name === "queued")!;
  await human.request("channel_delete", { channel: "work" });
  const held = (await human.request("held")).messages as StoredMessage[];
  assert.deepEqual(held.map((message) => [message.id, message.status, message.sourceChannel]), [[heldId, "held", "work"]]);
  const history = await human.historyPage({ scope: "session", sessionId: queued.id });
  assert.deepEqual(history.messages.map((message) => [message.id, message.status, message.sourceChannel]), [[queuedId, "queued", "work"]]);
  assert.equal((await human.request("release", { msgId: heldId })).status, "delivered");
  assert.equal((await holder.nextDelivery()).msg.id, heldId);
  const poll = await human.request("claude_hook", { event: "poll", sessionId: "delete-queued" });
  assert.equal((poll.texts as string[]).length, 1);
  const delivered = (await human.historyPage({ scope: "session", sessionId: queued.id })).messages;
  assert.deepEqual(delivered.map((message) => [message.id, message.status]), [[queuedId, "delivered"]]);
});
