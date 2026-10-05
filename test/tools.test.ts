import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { AsenqClient } from "../src/shared/client.js";
import type { SendResult } from "../src/shared/protocol.js";
import { callTool } from "../src/shared/tools.js";
import { startEnv, type TestEnv } from "./helpers.js";

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
