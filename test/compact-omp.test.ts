// Behavior tests for the production omp extension: a flagged direct push compacts the target's
// context before injecting the task, serialized against ordinary pushes for the same binding.
import assert from "node:assert/strict";
import { test } from "node:test";
import asenq from "../src/adapters/omp.js";
import type { ExtensionAPI, ExtensionContext } from "../src/adapters/omp-types.js";
import type { AsenqClient } from "../src/shared/client.js";
import { ACK_TIMEOUT_MS, type SendResult } from "../src/shared/protocol.js";
import { logOf, startEnv, type TestEnv } from "./helpers.js";

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<void> | void;

type Host = {
  pi: ExtensionAPI;
  handlers: Map<string, Handler>;
  sent: string[];
};

const shutdowns: (() => void)[] = [];
function stopHosts(): void {
  for (const shutdown of shutdowns.splice(0)) shutdown();
}
/** Records the SDK surface the extension touches; compaction and injection are the mock boundary. */
function makePi(): Host {
  const handlers = new Map<string, Handler>();
  const sent: string[] = [];
  const node = (): Record<string, unknown> => {
    const shape: Record<string, unknown> = {};
    for (const method of ["describe", "optional", "int", "min", "max"]) shape[method] = () => shape;
    return shape;
  };
  const pi = {
    on(event: string, handler: Handler) { handlers.set(event, handler); },
    registerTool() {},
    sendUserMessage(text: string) { sent.push(text); },
    getActiveTools: () => [] as string[],
    setActiveTools: async () => {},
    zod: { z: { string: node, number: node, boolean: node, enum: node, object: node } },
    logger: { warn: () => {}, debug: () => {} },
  } as unknown as ExtensionAPI;
  return { pi, handlers, sent };
}

function makeCtx(sessionId: string, compact: (options?: { suppressContinuation?: boolean }) => Promise<void>): ExtensionContext {
  return {
    agent: { kind: "main", id: sessionId, name: "main", depth: 0 },
    cwd: "/work/compact-omp",
    hasUI: false,
    sessionManager: { getSessionId: () => sessionId },
    ui: { setStatus: () => {} },
    setTimeout: (callback: () => void, ms?: number) => setTimeout(callback, ms),
    clearTimer: (timer: unknown) => clearTimeout(timer as NodeJS.Timeout),
    compact,
  };
}

/** Boots the real extension with ASENQ_NAME set only for the initial registration. */
async function boot(ctx: ExtensionContext, name: string): Promise<Host> {
  const host = makePi();
  asenq(host.pi);
  const previous = process.env.ASENQ_NAME;
  process.env.ASENQ_NAME = name;
  try {
    await host.handlers.get("session_start")!({ type: "session_start" }, ctx);
    shutdowns.push(() => { void host.handlers.get("session_shutdown")!({ type: "session_shutdown" }, ctx); });
  } finally {
    if (previous === undefined) delete process.env.ASENQ_NAME;
    else process.env.ASENQ_NAME = previous;
  }
  return host;
}

/** One event-loop turn without a wall-clock delay. */
function tick(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
}

const flushTurns = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await tick();
};

/** Polls retained history until the daemon has stored the finished reset outcome. */
async function waitForReset(human: AsenqClient, msgId: string, expected: string): Promise<void> {
  for (let i = 0; i < 1000; i++) {
    const msg = await logOf(human, msgId);
    if (msg.resetResult === expected) return;
    await tick();
  }
  assert.fail(`message ${msgId} never reported resetResult=${expected}`);
}

test("flagged push acknowledges receipt, compacts once, and injects the task ahead of a queued normal push", async () => {
  const env: TestEnv = await startEnv();
  try {
    const compacts: unknown[] = [];
    const gate = Promise.withResolvers<void>();
    const ctx = makeCtx("omp-session-ordered", (options) => { compacts.push(options); return gate.promise; });
    const { sent } = await boot(ctx, "compact-ordered");

    const human = env.human();
    // reset:"pending" in the live send result proves the daemon certified this connection's compact cap.
    const reply = await human.request("send", { to: "compact-ordered", text: "task one", reset: "compact" });
    const [first] = reply.results as SendResult[];
    assert.equal(first.status, "delivered");
    assert.equal(first.reset, "pending");
    assert.deepEqual(compacts, [{ suppressContinuation: true }]);
    assert.deepEqual(sent, [], "the task is not injected before compaction finishes");

    const inserted = await env.watch((e) => e.type === "message" && e.msg.text === "next task");
    const delivered = await env.watch((e) => e.type === "message" && e.msg.text === "next task" && e.status === "delivered");
    const queued = human.request("send", { to: "compact-ordered", text: "next task" });
    await inserted.event;
    await flushTurns();
    assert.deepEqual(sent, [], "a normal push must not overtake the pending compaction");

    gate.resolve();
    const [second] = (await queued).results as SendResult[];
    assert.equal(second.status, "queued", "later sends wait in the daemon rather than timing out inside compaction");
    await delivered.event;
    assert.equal(sent.length, 2, "each task is injected exactly once");
    assert.match(sent[0], /(?:^|\n)task one(?:\n|$)/);
    assert.match(sent[1], /(?:^|\n)next task(?:\n|$)/);
    await waitForReset(human, first.msgId!, "compacted");
  } finally {
    stopHosts();
    await env.close();
  }
});

test("a failed compaction still injects the task and reports failed", async () => {
  const env = await startEnv();
  try {
    let calls = 0;
    const ctx = makeCtx("omp-session-failed", async () => { calls += 1; throw new Error("compaction blew up"); });
    const { sent } = await boot(ctx, "compact-failed");

    const human = env.human();
    const reply = await human.request("send", { to: "compact-failed", text: "task after failure", reset: "compact" });
    const [first] = reply.results as SendResult[];
    assert.equal(first.status, "delivered");
    assert.equal(first.reset, "pending");
    await waitForReset(human, first.msgId!, "failed");
    assert.equal(calls, 1);
    assert.equal(sent.length, 1);
    assert.match(sent[0], /(?:^|\n)task after failure(?:\n|$)/, "compaction failure must not suppress the task");
    assert.equal((await logOf(human, first.msgId!)).status, "delivered");
  } finally {
    stopHosts();
    await env.close();
  }
});

test("a compaction slower than the delivery acknowledgment window still delivers exactly once", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const env = await startEnv();
  try {
    const gate = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const ctx = makeCtx("omp-session-slow", () => { started.resolve(); return gate.promise; });
    const { sent } = await boot(ctx, "compact-slow");

    const human = env.human();
    const reply = await human.request("send", { to: "compact-slow", text: "slow task", reset: "compact" });
    const [first] = reply.results as SendResult[];
    assert.equal(first.status, "delivered");
    assert.equal(first.reset, "pending");
    await started.promise;

    // The receipt ack already settled the delivery, so a compaction outliving the ack window is harmless.
    t.mock.timers.tick(ACK_TIMEOUT_MS * 3);
    assert.equal((await logOf(human, first.msgId!)).status, "delivered");
    assert.deepEqual(sent, []);

    gate.resolve();
    await waitForReset(human, first.msgId!, "compacted");
    assert.equal(sent.length, 1, "a slow compaction injects exactly once");
    assert.match(sent[0], /(?:^|\n)slow task(?:\n|$)/);
    assert.equal((await logOf(human, first.msgId!)).status, "delivered");
  } finally {
    stopHosts();
    t.mock.timers.reset();
    await env.close();
  }
});

test("a session switch during compaction never compacts or injects into the replacement session", async () => {
  const env = await startEnv();
  try {
    const compactsA: unknown[] = [];
    const gate = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const ctxA = makeCtx("omp-session-before", (options) => { compactsA.push(options); started.resolve(); return gate.promise; });
    const { handlers, sent } = await boot(ctxA, "compact-switch");

    const human = env.human();
    const reply = await human.request("send", { to: "compact-switch", text: "task across switch", reset: "compact" });
    const [first] = reply.results as SendResult[];
    assert.equal(first.status, "delivered");
    await started.promise;
    assert.deepEqual(compactsA, [{ suppressContinuation: true }]);

    const compactsB: unknown[] = [];
    const ctxB = makeCtx("omp-session-after", (options) => { compactsB.push(options); return Promise.resolve(); });
    await handlers.get("session_switch")!({ type: "session_switch", reason: "new" }, ctxB);

    gate.resolve();
    await flushTurns();
    assert.deepEqual(compactsB, [], "the replacement session must not be compacted");
    assert.deepEqual(sent, [], "the queued task must not be injected into the replacement session");
  } finally {
    stopHosts();
    await env.close();
  }
});

test("an unflagged push delivers immediately without compacting", async () => {
  const env = await startEnv();
  try {
    const compacts: unknown[] = [];
    const ctx = makeCtx("omp-session-plain", (options) => { compacts.push(options); return Promise.resolve(); });
    const { sent } = await boot(ctx, "compact-plain");

    const human = env.human();
    const reply = await human.request("send", { to: "compact-plain", text: "plain message" });
    const [first] = reply.results as SendResult[];
    assert.equal(first.status, "delivered");
    assert.equal(first.reset, undefined);
    assert.equal(sent.length, 1);
    assert.match(sent[0], /(?:^|\n)plain message(?:\n|$)/);
    assert.deepEqual(compacts, []);
  } finally {
    stopHosts();
    await env.close();
  }
});
