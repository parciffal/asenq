import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { AsenqClient } from "../src/shared/client.js";
import type { SendResult } from "../src/shared/protocol.js";
import { isSession, isStatus, logOf, startEnv } from "./helpers.js";
import type { Delivery, TestEnv } from "./helpers.js";

let env: TestEnv | undefined;
afterEach(async () => { await env?.close(); env = undefined; });

test("compact reset requires the human or current orchestrator role and exactly one named target", async () => {
  env = await startEnv();
  const human = env.human();
  const shared = await env.adapter("opencode", "orchestrator", "orchestrator");
  const worker = (await shared.client.request("register", { harness: "opencode", key: "worker", name: "worker" })).session as { id: string };
  const target = await env.adapter("omp", "target", "target");
  await human.request("set_role", { name: "orchestrator", role: "orchestrator" });
  await human.request("set_role", { name: "worker", role: "worker" });
  await assert.rejects(shared.client.request("send", { as: worker.id, to: "target", text: "unauthorized", reset: "compact" }), { code: "not_permitted" });
  for (const to of ["*", "human"]) {
    await assert.rejects(human.request("send", { to, text: "not a target session", reset: "compact" }), { code: "bad_request" });
  }
  await human.request("channel_create", { channel: "roster" });
  await assert.rejects(human.request("channel_send", { channel: "roster", text: "not a direct message", reset: "compact" }), { code: "bad_request" });
  await assert.rejects(human.request("send", { to: "target", text: "unknown reset", reset: "clear" }), { code: "bad_request" });
  const r = await shared.client.request("send", { as: shared.session.id, to: "target", text: "authorized", reset: "compact" });
  assert.deepEqual((r.results as SendResult[]).map(({ status }) => status), ["delivered"]);
  assert.deepEqual(target.deliveries.map(({ msg }) => msg.text), ["authorized"]);
  await human.request("set_role", { name: "orchestrator", role: null });
  await assert.rejects(shared.client.request("send", { as: shared.session.id, to: "target", text: "revoked", reset: "compact" }), { code: "not_permitted" });
});

test("compact reset without a capability delivers normally and records unsupported", async () => {
  env = await startEnv();
  const target = await env.adapter("omp", "legacy", "legacy");
  const human = env.human();
  const r = await human.request("send", { to: "legacy", text: "fallback task", reset: "compact" });
  const [sent] = r.results as SendResult[];
  assert.deepEqual([sent.status, sent.reset], ["delivered", "unsupported"]);
  const push = await target.nextDelivery();
  assert.equal(push.reset, undefined, "unsupported adapter must never receive a compact instruction");
  const retained = await logOf(human, sent.msgId!);
  assert.deepEqual([retained.text, retained.reset, retained.resetResult], ["fallback task", "compact", "unsupported"]);
});

test("capable delivery acknowledges pending immediately and authenticates final reset outcomes", async () => {
  env = await startEnv({ ackTimeoutMs: 30 });
  const human = env.human();
  const target = await env.adapter("omp", "capable", "capable", { autoAck: false });
  await target.client.request("register", { harness: "omp", key: "capable", caps: ["compact"] });
  const sending = human.request("send", { to: "capable", text: "new task", reset: "compact" });
  void sending.catch(() => {});
  const push = await target.nextDelivery();
  assert.equal(push.reset, "compact");
  await assert.rejects(human.request("ack", { msgId: push.msg.id, ok: true, reset: "pending" }), { code: "not_permitted" });
  await target.client.request("ack", { as: target.session.id, msgId: push.msg.id, ok: true, reset: "pending" });
  const [sent] = (await sending).results as SendResult[];
  assert.deepEqual([sent.status, sent.reset], ["delivered", "pending"]);
  assert.equal((await logOf(human, sent.msgId!)).resetResult, undefined);
  await assert.rejects(human.request("reset_result", { msgId: push.msg.id, reset: "compacted", ok: true }), { code: "not_permitted" });
  const finished = await env.watch((e) => e.type === "message" && e.msg.id === push.msg.id && e.msg.resetResult === "failed");
  await target.client.request("reset_result", { as: target.session.id, msgId: push.msg.id, reset: "failed", ok: true });
  await finished.event;
  assert.deepEqual([(await logOf(human, sent.msgId!)).status, (await logOf(human, sent.msgId!)).resetResult], ["delivered", "failed"]);
  await target.client.request("reset_result", { as: target.session.id, msgId: push.msg.id, reset: "compacted", ok: true });
  assert.equal((await logOf(human, sent.msgId!)).resetResult, "failed", "duplicate completions cannot rewrite the outcome");
});

for (const status of ["held", "queued"] as const) {
  test(`${status} compact message survives daemon restart and resolves capability only at delivery`, async () => {
    env = await startEnv();
    let human = env.human();
    const sender = await env.adapter("omp", "coordinator", "coordinator");
    await human.request("set_role", { name: "coordinator", role: "orchestrator" });
    const original = await env.adapter("omp", "deferred-target", "target");
    if (status === "held") await human.request("set_inbound", { name: "target", mode: "hold" });
    else {
      const gone = await env.watch(isSession("gone", "target"));
      original.client.close();
      await gone.event;
    }
    const [sent] = (await sender.client.request("send", { to: "target", text: "deferred task", reset: "compact" })).results as SendResult[];
    assert.deepEqual([sent.status, sent.reset], [status, undefined]);
    assert.equal(original.deliveries.length, 0);
    assert.deepEqual([(await logOf(human, sent.msgId!)).reset, (await logOf(human, sent.msgId!)).resetResult], ["compact", undefined]);
    await env.restart();
    human = env.human();
    const received = Promise.withResolvers<Delivery>();
    const client = new AsenqClient({ onPush: (p) => { if (p.push === "deliver") received.resolve(p); } });
    try {
      const binding = (await client.request("register", { harness: "omp", key: "deferred-target", caps: ["compact"] })).session as { id: string };
      assert.equal(binding.id, original.session.id);
      const release = status === "held" ? human.request("release", { msgId: sent.msgId }) : undefined;
      const push = await received.promise;
      assert.deepEqual([push.msg.id, push.reset], [sent.msgId, "compact"]);
      const accepted = await env.watch(isStatus(sent.msgId, "delivered"));
      await client.request("ack", { as: binding.id, msgId: sent.msgId, ok: true, reset: "pending" });
      await accepted.event;
      if (release) assert.equal((await release).status, "delivered");
      const completed = await env.watch((e) => e.type === "message" && e.msg.id === sent.msgId && e.msg.resetResult === "compacted");
      await client.request("reset_result", { as: binding.id, msgId: sent.msgId, reset: "compacted", ok: true });
      await completed.event;
      assert.deepEqual([(await logOf(human, sent.msgId!)).status, (await logOf(human, sent.msgId!)).resetResult], ["delivered", "compacted"]);
    } finally { client.close(); }
  });
}

test("Claude hook delivery falls back without attempting compaction", async () => {
  env = await startEnv();
  const human = env.human();
  await human.request("claude_hook", { event: "start", sessionId: "claude-context", key: "claude-context", name: "claude-target", cwd: "/work" });
  const [sent] = (await human.request("send", { to: "claude-target", text: "hook task", reset: "compact" })).results as SendResult[];
  assert.deepEqual([sent.status, sent.reset], ["queued", undefined]);
  const polled = await human.request("claude_hook", { event: "poll", sessionId: "claude-context" });
  assert.match((polled.texts as string[])[0], /hook task/);
  assert.deepEqual([(await logOf(human, sent.msgId!)).status, (await logOf(human, sent.msgId!)).resetResult], ["delivered", "unsupported"]);
});

test("capability removal on the same connection applies to the next compact delivery", async () => {
  env = await startEnv();
  const human = env.human();
  const target = await env.adapter("omp", "changing", "changing");
  await target.client.request("register", { harness: "omp", key: "changing", caps: ["compact"] });
  await target.client.request("register", { harness: "omp", key: "changing", caps: ["ping"] });
  const [sent] = (await human.request("send", { to: "changing", text: "no longer capable", reset: "compact" })).results as SendResult[];
  assert.deepEqual([sent.status, sent.reset, (await target.nextDelivery()).reset], ["delivered", "unsupported", undefined]);
});

test("accepted compact delivery reports injection failure without retrying compaction", async () => {
  env = await startEnv();
  const human = env.human();
  const target = await env.adapter("omp", "inject-error", "target", { autoAck: false });
  await target.client.request("register", { harness: "omp", key: "inject-error", caps: ["compact"] });
  const sending = human.request("send", { to: "target", text: "task that cannot be injected", reset: "compact" });
  void sending.catch(() => {});
  const push = await target.nextDelivery();
  await target.client.request("ack", { as: target.session.id, msgId: push.msg.id, ok: true, reset: "pending" });
  await sending;
  await target.client.request("reset_result", { as: target.session.id, msgId: push.msg.id, reset: "compacted", ok: false, reason: "harness stopped" });
  await env.daemon.retry();
  const retained = await logOf(human, push.msg.id);
  assert.deepEqual([retained.status, retained.resetResult, retained.reason], ["failed", "compacted", "harness stopped"]);
  assert.equal(target.deliveries.length, 1);
});

test("disconnect after compact receipt finishes the outcome and revival does not repeat compaction", async () => {
  env = await startEnv();
  const human = env.human();
  const target = await env.adapter("omp", "interrupted", "target", { autoAck: false });
  await target.client.request("register", { harness: "omp", key: "interrupted", caps: ["compact"] });
  const sending = human.request("send", { to: "target", text: "interrupted task", reset: "compact" });
  void sending.catch(() => {});
  const push = await target.nextDelivery();
  await target.client.request("ack", { as: target.session.id, msgId: push.msg.id, ok: true, reset: "pending" });
  await sending;
  const [deferred] = (await human.request("send", { to: "target", text: "deferred after interrupted reset" })).results as SendResult[];
  assert.equal(deferred.status, "queued");
  const gone = await env.watch(isSession("gone", "target"));
  target.client.close();
  await gone.event;
  const retained = await logOf(human, push.msg.id);
  assert.deepEqual([retained.status, retained.resetResult], ["failed", "failed"]);
  assert.equal((await logOf(human, deferred.msgId!)).status, "queued");
  const finished = await env.watch(isStatus(deferred.msgId, "delivered"));
  const revived = await env.adapter("omp", "interrupted", "target");
  await finished.event;
  assert.deepEqual(revived.deliveries.map(({ msg }) => msg.id), [deferred.msgId], "revival delivers only the deferred task, not the accepted compact task");
});

test("a pending reset defers normal delivery attempts until compaction finishes", async () => {
  env = await startEnv({ ackTimeoutMs: 30 });
  const human = env.human();
  const target = await env.adapter("omp", "blocking", "target", { autoAck: false });
  await target.client.request("register", { harness: "omp", key: "blocking", caps: ["compact"] });
  const sending = human.request("send", { to: "target", text: "compact task", reset: "compact" });
  void sending.catch(() => {});
  const first = await target.nextDelivery();
  await target.client.request("ack", { as: target.session.id, msgId: first.msg.id, ok: true, reset: "pending" });
  await sending;
  const [normal] = (await human.request("send", { to: "target", text: "later normal task" })).results as SendResult[];
  assert.equal(normal.status, "queued");
  env.clock.advance(60_000);
  await env.daemon.retry();
  assert.equal(target.deliveries.length, 1, "normal messages are not pushed into a long compaction and retried");
  const received = target.nextDelivery();
  await target.client.request("reset_result", { as: target.session.id, msgId: first.msg.id, reset: "compacted", ok: true });
  const next = await received;
  assert.equal(next.msg.id, normal.msgId);
  const finished = await env.watch(isStatus(normal.msgId, "delivered"));
  await target.client.request("ack", { msgId: next.msg.id, ok: true });
  await finished.event;
  assert.equal(target.deliveries.length, 2, "the deferred message is delivered exactly once after compaction");
});

for (const timeout of [50, 10 * 60_000]) {
  test(`pending reset expires at ${timeout} ms and flushes the deferred queue`, async () => {
    env = await startEnv(timeout === 50 ? { resetTimeoutMs: timeout } : {});
    const human = env.human();
    const target = await env.adapter("omp", "timeout", "target", { autoAck: false });
    await target.client.request("register", { harness: "omp", key: "timeout", caps: ["compact"] });
    const sending = human.request("send", { to: "target", text: "hanging reset", reset: "compact" });
    void sending.catch(() => {});
    const first = await target.nextDelivery();
    await target.client.request("ack", { as: target.session.id, msgId: first.msg.id, ok: true, reset: "pending" });
    await sending;
    const [normal] = (await human.request("send", { to: "target", text: "task after timeout" })).results as SendResult[];
    assert.equal(normal.status, "queued");
    env.clock.advance(timeout - 1);
    env.daemon.sweep();
    assert.equal((await logOf(human, first.msg.id)).resetResult, undefined);
    assert.equal(target.deliveries.length, 1);
    await target.client.request("ack", { as: target.session.id, msgId: first.msg.id, ok: true, reset: "pending" });
    env.clock.advance(1);
    const next = target.nextDelivery();
    env.daemon.sweep();
    assert.equal((await next).msg.id, normal.msgId, "expiry releases the next delivery attempt");
    const delivered = await env.watch(isStatus(normal.msgId, "delivered"));
    await target.client.request("ack", { msgId: normal.msgId, ok: true });
    await delivered.event;
    const retained = await logOf(human, first.msg.id);
    assert.deepEqual([retained.status, retained.resetResult, retained.reason], ["failed", "failed", "compact delivery timed out"]);
    await target.client.request("reset_result", { as: target.session.id, msgId: first.msg.id, reset: "compacted", ok: true });
    assert.equal((await logOf(human, first.msg.id)).resetResult, "failed", "a late completion cannot undo timeout");
  });
}

test("queue expiry before compact receipt does not leave the target gated forever", async () => {
  env = await startEnv({ ackTimeoutMs: 30, queueTtlMs: 10 });
  const human = env.human();
  const target = await env.adapter("omp", "expiry", "target", { autoAck: false });
  await target.client.request("register", { harness: "omp", key: "expiry", caps: ["compact"] });
  const sending = human.request("send", { to: "target", text: "expires before receipt", reset: "compact" });
  void sending.catch(() => {});
  await target.nextDelivery();
  env.clock.advance(10);
  env.daemon.sweep();
  assert.equal(((await sending).results as SendResult[])[0].status, "expired");
  const [normal] = (await human.request("send", { to: "target", text: "normal after expired reset" })).results as SendResult[];
  assert.deepEqual(target.deliveries.map(({ msg }) => msg.text), ["expires before receipt", "normal after expired reset"]);
  await target.client.request("ack", { msgId: normal.msgId, ok: true });
  assert.equal((await logOf(human, normal.msgId!)).status, "delivered");
});

test("expired compact receipt is rejected before the adapter may compact or inject", async () => {
  env = await startEnv({ ackTimeoutMs: 100, queueTtlMs: 10 });
  const human = env.human();
  const target = await env.adapter("omp", "late-receipt", "target", { autoAck: false });
  await target.client.request("register", { harness: "omp", key: "late-receipt", caps: ["compact"] });
  const sending = human.request("send", { to: "target", text: "must not compact after expiry", reset: "compact" });
  void sending.catch(() => {});
  const push = await target.nextDelivery();
  env.clock.advance(10);
  env.daemon.sweep();
  await assert.rejects(target.client.request("ack", { as: target.session.id, msgId: push.msg.id, ok: true, reset: "pending" }), { code: "bad_request" });
  assert.equal(((await sending).results as SendResult[])[0].status, "expired");
  assert.equal((await logOf(human, push.msg.id)).resetResult, undefined, "no compaction outcome is claimed");
});
