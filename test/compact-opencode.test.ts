// Compact-before-delivery behavior for the OpenCode plugin (#39).
// Drives the real plugin against a real in-process daemon; the OpenCode SDK is a boundary recorder,
// so no external model or HTTP call is made.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { server } from "../src/adapters/opencode.js";
import type { Hooks, OpencodeClient, OpencodeMessage } from "../src/adapters/opencode-types.js";
import type { AsenqClient } from "../src/shared/client.js";
import type { SendResult, TailEvent, WireMsg } from "../src/shared/protocol.js";
import { startEnv, type TestEnv } from "./helpers.js";

let env: TestEnv | undefined;
const started: Hooks[] = [];
afterEach(async () => {
  for (const h of started) await h.dispose?.();
  started.length = 0;
  await env?.close();
  env = undefined;
});

type Model = { providerID: string; modelID: string };
type SummarizeCall = { path: { id: string }; body: Model };
type SummarizeOutcome = { data?: boolean; error?: unknown };

type Sdk = {
  client: OpencodeClient;
  /** Ordered names of SDK calls made by the plugin: "messages", "summarize", "prompt". */
  calls: string[];
  summarizeCalls: SummarizeCall[];
  prompts: { id: string; text: string }[];
  setMessages(next: OpencodeMessage[]): void;
  setSummarize(next: ((call: SummarizeCall) => Promise<SummarizeOutcome>) | undefined): void;
  /** Resolves once the named call has happened at least `n` times; the deterministic alternative to polling. */
  callHappened(name: string, n?: number): Promise<void>;
  logHappened(substring: string): Promise<void>;
};

/** Records every SDK boundary crossing the plugin makes; `withMethods: false` models an SDK without compaction. */
function fakeSdk(withMethods = true): Sdk {
  let messages: OpencodeMessage[] = [];
  let summarize: ((call: SummarizeCall) => Promise<SummarizeOutcome>) | undefined;
  const calls: string[] = [];
  const summarizeCalls: SummarizeCall[] = [];
  const prompts: { id: string; text: string }[] = [];
  const logs: string[] = [];
  const waiters: { name: string; n: number; resolve: () => void }[] = [];
  const logWaiters: { substring: string; resolve: () => void }[] = [];

  const record = (name: string): void => {
    calls.push(name);
    const count = calls.filter((c) => c === name).length;
    for (const w of [...waiters]) {
      if (w.name === name && count >= w.n) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve();
      }
    }
  };

  const recordLog = (message: string): void => {
    logs.push(message);
    for (const w of [...logWaiters]) {
      if (message.includes(w.substring)) {
        logWaiters.splice(logWaiters.indexOf(w), 1);
        w.resolve();
      }
    }
  };

  const session: Record<string, unknown> = {
    async get() {
      return { data: { id: "oc" } };
    },
    async promptAsync(o: { path: { id: string }; body: { parts: { text: string }[] } }) {
      prompts.push({ id: o.path.id, text: o.body.parts[0]?.text ?? "" });
      record("prompt");
      return { data: {} };
    },
  };
  if (withMethods) {
    session.messages = async () => {
      record("messages");
      return { data: messages };
    };
    session.summarize = async (call: SummarizeCall) => {
      summarizeCalls.push(call);
      record("summarize");
      return (summarize ?? (async () => ({ data: true })))(call);
    };
  }

  return {
    client: {
      session,
      app: {
        async log(o: { body: { message: string } }) {
          recordLog(o.body.message);
          return {};
        },
      },
    } as unknown as OpencodeClient,
    calls,
    summarizeCalls,
    prompts,
    setMessages(next) {
      messages = next;
    },
    setSummarize(next) {
      summarize = next;
    },
    callHappened(name, n = 1) {
      if (calls.filter((c) => c === name).length >= n) return Promise.resolve();
      const { promise, resolve } = Promise.withResolvers<void>();
      waiters.push({ name, n, resolve });
      return promise;
    },
    logHappened(substring) {
      if (logs.some((message) => message.includes(substring))) return Promise.resolve();
      const { promise, resolve } = Promise.withResolvers<void>();
      logWaiters.push({ substring, resolve });
      return promise;
    },
  };
}

async function startPlugin(sdk: Sdk): Promise<Hooks> {
  const h = await server({ client: sdk.client, directory: "/work", worktree: "/work" });
  started.push(h);
  return h;
}

/** Fires the real registration event and waits for the daemon to confirm it. */
async function register(env: TestEnv, h: Hooks, ocId: string): Promise<string> {
  const registered = await env.watch((e) => e.type === "session" && e.action === "registered" && e.harness === "opencode");
  await h.event?.({ event: { type: "session.created", properties: { info: { id: ocId } } } });
  const event = await registered.event;
  if (event.type !== "session") throw new Error("expected a session event");
  return event.name;
}

async function send(c: AsenqClient, to: string, text: string, reset?: "compact"): Promise<SendResult> {
  const r = await c.request("send", { to, text, ...(reset ? { reset } : {}) });
  // The send reply carries one result per target; the wire defines each as a SendResult.
  const results = r.results as SendResult[];
  const result = results[0];
  assert.ok(result, "send must return a result");
  return result;
}

function resetResultOf(msg: WireMsg): string | undefined {
  return "resetResult" in msg && typeof msg.resetResult === "string" ? msg.resetResult : undefined;
}

const deliveredFor = (text: string) => (e: TailEvent): boolean =>
  e.type === "message" && e.msg.text === text && e.status === "delivered";

const queuedFor = (text: string) => (e: TailEvent): boolean =>
  e.type === "message" && e.msg.text === text && e.status === "queued";

const failedFor = (text: string) => (e: TailEvent): boolean =>
  e.type === "message" && e.msg.text === text && e.status === "failed";

const finishedFor = (text: string, reset: string) => (e: TailEvent): boolean =>
  e.type === "message" && e.msg.text === text && resetResultOf(e.msg) === reset;

test("acks receipt immediately, compacts, then injects the flagged message in order", async () => {
  env = await startEnv();
  const sdk = fakeSdk();
  sdk.setMessages([{ info: { role: "user", model: { providerID: "anthropic", modelID: "claude-sonnet-4" } } }]);
  const held = Promise.withResolvers<void>();
  sdk.setSummarize(() => held.promise.then(() => ({ data: true })));

  const h = await startPlugin(sdk);
  const name = await register(env, h, "oc-1");

  const delivered = await env.watch(deliveredFor("new task"));
  const finished = await env.watch(finishedFor("new task", "compacted"));
  const result = await send(env.human(), name, "new task", "compact");
  assert.equal(result.reset, "pending", "a capable live receipt reports pending, not a finished outcome");

  // Receipt lands before compaction finishes: the daemon marks the message delivered while summarize is held.
  await delivered.event;
  await sdk.callHappened("summarize");
  assert.equal(sdk.prompts.length, 0, "the message must not be injected before compaction");

  held.resolve();
  await sdk.callHappened("prompt");
  assert.deepEqual(sdk.calls, ["messages", "summarize", "prompt"], "fetch model, compact, then inject");
  assert.deepEqual(sdk.summarizeCalls[0]?.body, { providerID: "anthropic", modelID: "claude-sonnet-4" });
  assert.match(sdk.prompts[0].text, /(?:^|\n)new task(?:\n|$)/);
  await finished.event;
});

test("a same-session push queues behind an in-flight compaction instead of overtaking it", async () => {
  env = await startEnv();
  const sdk = fakeSdk();
  sdk.setMessages([{ info: { role: "user", model: { providerID: "p", modelID: "m" } } }]);
  const held = Promise.withResolvers<void>();
  sdk.setSummarize(() => held.promise.then(() => ({ data: true })));

  const h = await startPlugin(sdk);
  const name = await register(env, h, "oc-1");
  const human = env.human();

  const receipted = await env.watch(deliveredFor("compact task"));
  const finished = await env.watch(finishedFor("compact task", "compacted"));
  const normalQueued = await env.watch(queuedFor("after task"));

  const compacted = await send(human, name, "compact task", "compact");
  assert.equal(compacted.reset, "pending");
  // The receipt ack freed the daemon, which pushes the next message while summarize is still held.
  await receipted.event;
  await sdk.callHappened("summarize");

  const normal = send(human, name, "after task");
  void normal.catch(() => {});
  await normalQueued.event;
  assert.deepEqual(sdk.calls, ["messages", "summarize"], "no queued delivery may start before compaction ends");
  assert.equal(sdk.prompts.length, 0);

  held.resolve();
  await sdk.callHappened("prompt", 2);
  assert.equal(sdk.prompts.length, 2, "each message is injected exactly once");
  assert.match(sdk.prompts[0].text, /(?:^|\n)compact task(?:\n|$)/);
  assert.match(sdk.prompts[1].text, /(?:^|\n)after task(?:\n|$)/);
  await finished.event;
  assert.equal((await normal).reset, undefined, "an ordinary push carries no reset outcome");
});

test("uses the latest chronological model from either message shape", async () => {
  env = await startEnv();
  const sdk = fakeSdk();
  const h = await startPlugin(sdk);
  const name = await register(env, h, "oc-1");
  const human = env.human();

  // Newest message is a user message carrying the nested model.
  sdk.setMessages([
    { info: { role: "assistant", providerID: "openai", modelID: "gpt-old" } },
    { info: { role: "user", model: { providerID: "anthropic", modelID: "user-new" } } },
  ]);
  const firstDone = await env.watch(finishedFor("one", "compacted"));
  await send(human, name, "one", "compact");
  await sdk.callHappened("summarize");
  assert.deepEqual(sdk.summarizeCalls[0]?.body, { providerID: "anthropic", modelID: "user-new" });
  await firstDone.event;

  // Newest message is an assistant message carrying the top-level pair.
  sdk.setMessages([
    { info: { role: "user", model: { providerID: "anthropic", modelID: "user-old" } } },
    { info: { role: "assistant", providerID: "openai", modelID: "assistant-new" } },
  ]);
  const secondDone = await env.watch(finishedFor("two", "compacted"));
  await send(human, name, "two", "compact");
  await sdk.callHappened("summarize", 2);
  assert.deepEqual(sdk.summarizeCalls[1]?.body, { providerID: "openai", modelID: "assistant-new" });
  await secondDone.event;
});

test("summarize error or false still injects the message and reports failed", async () => {
  env = await startEnv();
  const sdk = fakeSdk();
  sdk.setMessages([{ info: { role: "user", model: { providerID: "p", modelID: "m" } } }]);
  const outcomes: SummarizeOutcome[] = [{ error: { message: "boom" } }, { data: false }];
  sdk.setSummarize(async () => outcomes.shift() ?? { data: true });

  const h = await startPlugin(sdk);
  const name = await register(env, h, "oc-1");
  const human = env.human();

  const firstFailed = await env.watch(finishedFor("first", "failed"));
  const secondFailed = await env.watch(finishedFor("second", "failed"));
  for (const text of ["first", "second"]) {
    const result = await send(human, name, text, "compact");
    assert.equal(result.reset, "pending");
  }
  await firstFailed.event;
  await secondFailed.event;
  await sdk.callHappened("prompt", 2);
  assert.equal(sdk.prompts.length, 2, "compaction failure must not suppress either message");
  assert.match(sdk.prompts[0].text, /(?:^|\n)first(?:\n|$)/);
  assert.match(sdk.prompts[1].text, /(?:^|\n)second(?:\n|$)/);
});

test("another OpenCode binding delivers while a different binding compacts", async () => {
  env = await startEnv();
  const sdk = fakeSdk();
  sdk.setMessages([{ info: { role: "user", model: { providerID: "p", modelID: "m" } } }]);
  const held = Promise.withResolvers<void>();
  sdk.setSummarize((call) => (call.path.id === "oc-1" ? held.promise.then(() => ({ data: true })) : Promise.resolve({ data: true })));

  const h = await startPlugin(sdk);
  const firstName = await register(env, h, "oc-1");
  const secondName = await register(env, h, "oc-2");
  const human = env.human();

  const compacted = await send(human, firstName, "task one", "compact");
  assert.equal(compacted.reset, "pending");
  await sdk.callHappened("summarize");
  const second = await send(human, secondName, "task two");
  await sdk.callHappened("prompt");
  assert.equal(sdk.prompts[0]?.id, "oc-2", "the free binding must deliver while the other compacts");
  assert.ok(!sdk.prompts.some((p) => p.id === "oc-1"), "the compacting binding must not be injected early");

  const finished = await env.watch(finishedFor("task one", "compacted"));
  held.resolve();
  await sdk.callHappened("prompt", 2);
  assert.equal(sdk.prompts[1]?.id, "oc-1");
  await finished.event;
  assert.equal(second.reset, undefined, "an ordinary push carries no reset outcome");
});

test("does not declare compact without summarize/messages and still delivers", async () => {
  env = await startEnv();
  const sdk = fakeSdk(false);
  const h = await startPlugin(sdk);
  const name = await register(env, h, "oc-1");
  const human = env.human();

  const finished = await env.watch(finishedFor("still delivered", "unsupported"));
  const result = await send(human, name, "still delivered", "compact");
  assert.equal(result.reset, "unsupported", "a target without the cap reports unsupported");
  await sdk.callHappened("prompt");
  assert.match(sdk.prompts[0].text, /(?:^|\n)still delivered(?:\n|$)/);
  assert.deepEqual(sdk.calls, ["prompt"], "without the SDK API no compaction work is attempted");
  await finished.event;
});

test("does not inject into a session deleted while its compaction is pending", async () => {
  env = await startEnv();
  const sdk = fakeSdk();
  sdk.setMessages([{ info: { role: "user", model: { providerID: "p", modelID: "m" } } }]);
  const held = Promise.withResolvers<void>();
  sdk.setSummarize(() => held.promise.then(() => ({ data: true })));

  const h = await startPlugin(sdk);
  const name = await register(env, h, "oc-1");

  const delivered = await env.watch(deliveredFor("stale task"));
  const result = await send(env.human(), name, "stale task", "compact");
  assert.equal(result.reset, "pending");
  await delivered.event;
  await sdk.callHappened("summarize");

  // The OpenCode session disappears while summarize is still held; the message must not be injected into it.
  await h.event?.({ event: { type: "session.deleted", properties: { info: { id: "oc-1" } } } });
  held.resolve();
  // Wait for the resumed handler, not the daemon's earlier disconnect failure event.
  await sdk.logHappened("reset_result");
  assert.equal(sdk.prompts.length, 0, "a deleted session must not receive the message");
});

test("disposing the plugin during summarization cannot launch a stale task", async () => {
  env = await startEnv();
  const sdk = fakeSdk();
  sdk.setMessages([{ info: { role: "user", model: { providerID: "p", modelID: "m" } } }]);
  const held = Promise.withResolvers<void>();
  sdk.setSummarize(() => held.promise.then(() => ({ data: true })));
  const h = await startPlugin(sdk);
  const name = await register(env, h, "disposed-session");
  const result = await send(env.human(), name, "must not start after disposal", "compact");
  assert.equal(result.reset, "pending");
  await sdk.callHappened("summarize");
  await h.dispose?.();
  held.resolve();
  await sdk.logHappened("reset_result"); // Completion failed on the closed client, after any attempted injection.
  assert.deepEqual(sdk.prompts, [], "disposal invalidates the harness binding before an awaited operation resumes");
});
