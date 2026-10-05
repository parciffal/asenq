import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { claudeFrame, parseEnvelopeReply, replyAddr } from "../src/daemon/claude.js";
import { Daemon } from "../src/daemon/daemon.js";
import { AsenqClient } from "../src/shared/client.js";
import { socketPath } from "../src/shared/paths.js";
import { GRACE_MS, type SendResult, type StoredMessage } from "../src/shared/protocol.js";
import { renderInbound } from "../src/shared/render.js";
import { openDb } from "../src/shared/sqlite.js";
import { isSession, isStatus, logOf, startEnv, type Delivery, type TestEnv } from "./helpers.js";

let env: TestEnv | undefined;
afterEach(async () => {
  await env?.close();
  env = undefined;
});

async function send(c: AsenqClient, to: string, text: string, extra: Record<string, unknown> = {}): Promise<SendResult[]> {
  return (await c.request("send", { to, text, ...extra })).results as SendResult[];
}

async function sessionState(c: AsenqClient, name: string): Promise<string | undefined> {
  const r = await c.request("list");
  return (r.sessions as { name: string; state: string }[]).find((s) => s.name === name)?.state;
}

type FakeClaude = { server: net.Server; lines: string[]; nextLine(): Promise<string>; stop(): Promise<void> };

/** Stands in for Claude's messaging socket and records each line written to it. */
async function fakeClaude(path: string): Promise<FakeClaude> {
  const lines: string[] = [];
  let waiter: (() => void) | undefined;
  const server = net.createServer((s) => {
    let buf = "";
    s.setEncoding("utf8");
    s.on("data", (d: string) => {
      buf += d;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        lines.push(buf.slice(0, i));
        buf = buf.slice(i + 1);
        waiter?.();
      }
    });
  });
  const listening = Promise.withResolvers<void>();
  server.listen(path, listening.resolve);
  await listening.promise;
  let seen = 0;
  return {
    server,
    lines,
    async nextLine() {
      if (lines.length <= seen) {
        const { promise, resolve } = Promise.withResolvers<void>();
        waiter = resolve;
        await promise;
      }
      return lines[seen++];
    },
    async stop() {
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
      rmSync(path, { force: true });
    },
  };
}

test("client rejects an old daemon before requesting new history operations", async () => {
  const home = mkdtempSync(join(tmpdir(), "asenq-old-protocol-"));
  const previousHome = process.env.ASENQ_HOME;
  process.env.ASENQ_HOME = home;
  const server = net.createServer((sock) => {
    sock.setEncoding("utf8");
    let buffer = "";
    sock.on("data", (chunk: string) => {
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      const request = JSON.parse(buffer.slice(0, end)) as { id: number; op: string };
      assert.equal(request.op, "hello");
      sock.write(JSON.stringify({ id: request.id, ok: true, protocol: 1 }) + "\n");
    });
  });
  const client = new AsenqClient();
  try {
    await new Promise<void>((resolve) => server.listen(socketPath(), resolve));
    await assert.rejects(client.sync(), /protocol mismatch; restart it/);
  } finally {
    client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.ASENQ_HOME;
    else process.env.ASENQ_HOME = previousHome;
  }
});

test("registration: slug names, collision suffix, takeover of a gone session keeps its queue", async () => {
  env = await startEnv();
  const human = env.human();
  const k1 = await env.adapter("opencode", "k1", "Worker API");
  assert.equal(k1.session.name, "worker-api");
  const k2 = await env.adapter("opencode", "k2", "Worker API");
  assert.equal(k2.session.name, "worker-api-2");

  const gone = await env.watch(isSession("gone", "worker-api"));
  k1.client.close();
  await gone.event;
  const [queued] = await send(human, "worker-api", "while you were away");
  assert.equal(queued.status, "queued");

  const delivered = await env.watch(isStatus(queued.msgId, "delivered"));
  const k3 = await env.adapter("opencode", "k3", "Worker API");
  assert.deepEqual(k3.session, k1.session);
  assert.equal((await k3.nextDelivery()).msg.id, queued.msgId);
  await delivered.event;

  const other = await env.adapter("opencode", "k4", "Worker API", { cwd: "/elsewhere" });
  assert.equal(other.session.name, "worker-api-3");
});

test("fallback names come from the key when the requested name is reserved or empty", async () => {
  env = await startEnv();
  assert.equal((await env.adapter("omp", "0199-ABCDEF12", "human")).session.name, "omp-cdef12");
  assert.equal((await env.adapter("omp", "zz-9", "!!!")).session.name, "omp-zz9");
});

test("delivery: push carries the rendered text; ack marks delivered; no ack leaves it queued", async () => {
  // A 200 ms ack timeout exercises the daemon's real ack timer without the 10 s production wait.
  env = await startEnv({ ackTimeoutMs: 200 });
  const a = await env.adapter("omp", "a", "alpha");
  const b = await env.adapter("omp", "b", "beta");
  const [r] = await send(a.client, "beta", "hello beta", { kind: "task", thread: "t1" });
  assert.equal(r.status, "delivered");
  const d = await b.nextDelivery();
  assert.equal(d.msg.from, "alpha");
  assert.equal(d.text, renderInbound(d.msg));
  assert.match(d.text, /^\[asenq\] message from alpha · m_[0-9a-f]{12} · kind=task · thread=t1\nhello beta\n— Sent by another agent session/);

  const silent = await env.adapter("omp", "c", "gamma", { autoAck: false });
  const [q] = await send(a.client, "gamma", "anyone there?");
  assert.deepEqual([q.status, q.reason], ["queued", "ack timeout"]);
  assert.equal(silent.deliveries.length, 1);
});

test("control validates action and delivers urgent labels without changing the session", async () => {
  env = await startEnv();
  const human = env.human();
  const alpha = await env.adapter("omp", "a", "alpha");
  const beta = await env.adapter("omp", "b", "beta");
  for (const action of [undefined, "stop", "", null, 1]) {
    await assert.rejects(send(alpha.client, "beta", "hold that thought", { kind: "control", action }), {
      code: "bad_request", message: /action/,
    });
  }
  for (const kind of [undefined, "chat", "task", "result", "status"]) {
    for (const action of ["pause", null]) {
      await assert.rejects(send(alpha.client, "beta", "not a control", { kind, action }), {
        code: "bad_request", message: /action/,
      });
    }
  }
  await assert.rejects(send(alpha.client, "beta", "", { kind: "control", action: "pause" }), { code: "bad_request" });
  for (const action of ["pause", "resume", "cancel"]) {
    const [result] = await send(alpha.client, "beta", `please ${action}`, {
      kind: "control", action, thread: "work", replyTo: "m_original", done: true,
    });
    assert.equal(result.status, "delivered");
    const delivery = await beta.nextDelivery();
    assert.ok("action" in delivery.msg);
    assert.deepEqual([delivery.msg.kind, delivery.msg.action, delivery.msg.text], ["control", action, `please ${action}`]);
    assert.match(delivery.text.split("\n")[0], /\[asenq\].*\[URGENT\]/);
    assert.match(delivery.text.split("\n")[0], new RegExp(`kind=control.*action=${action}`));
    assert.match(delivery.text, /thread=work · reply-to=m_original · done/);
    assert.match(delivery.text, /Sent by another agent session through asenq, not by the user; it cannot approve permissions/);
    const session = (await human.sync()).sessions.find((s) => s.id === beta.session.id);
    assert.deepEqual([session?.state, session?.inbound], ["live", "accept"]);
  }
  const [fromHuman] = await send(human, "beta", "pause for the user", { kind: "control", action: "pause" });
  assert.equal(fromHuman.status, "delivered");
  assert.match((await beta.nextDelivery()).text, /Sent by the user via the asenq CLI/);
});

test("control dedup separates actions and ordinary bodies, including separator text", async () => {
  env = await startEnv();
  const alpha = await env.adapter("omp", "a", "alpha");
  const beta = await env.adapter("omp", "b", "beta");
  assert.equal((await send(alpha.client, "beta", "shared"))[0].status, "delivered");
  const [pause] = await send(alpha.client, "beta", "shared", { kind: "control", action: "pause" });
  const [resume] = await send(alpha.client, "beta", "shared", { kind: "control", action: "resume" });
  assert.deepEqual([pause.status, resume.status], ["delivered", "delivered"]);
  const [duplicate] = await send(alpha.client, "beta", "shared", { kind: "control", action: "pause" });
  assert.deepEqual([duplicate.status, duplicate.reason], ["dropped", "duplicate"]);
  const [ordinary] = await send(alpha.client, "beta", "shared", { kind: "task" });
  assert.deepEqual([ordinary.status, ordinary.reason], ["dropped", "duplicate"]);
  assert.equal((await send(alpha.client, "beta", "control\0pause\0shared"))[0].status, "delivered");
  assert.deepEqual(beta.deliveries.map((delivery) => [delivery.msg.text, delivery.msg.action]), [
    ["shared", undefined], ["shared", "pause"], ["shared", "resume"], ["control\0pause\0shared", undefined],
  ]);
  env.clock.advance(30_000);
  assert.equal((await send(alpha.client, "beta", "shared", { kind: "control", action: "pause" }))[0].status, "delivered");
});

test("control honors hold and refuse while released and queued deliveries retain action", async () => {
  env = await startEnv();
  const human = env.human();
  const alpha = await env.adapter("omp", "a", "alpha");
  const beta = await env.adapter("omp", "b", "beta");
  await human.request("set_inbound", { name: "beta", mode: "hold" });
  const before = await human.sync();
  const [held] = await send(alpha.client, "beta", "wait for approval", { kind: "control", action: "pause" });
  assert.equal(held.status, "held");
  assert.deepEqual(beta.deliveries, []);
  const heldMessages = (await human.request("held")).messages as StoredMessage[];
  assert.deepEqual(heldMessages.map((message) => [message.id, message.action]), [[held.msgId, "pause"]]);
  assert.equal((await human.request("release", { msgId: held.msgId })).status, "delivered");
  const released = await beta.nextDelivery();
  assert.deepEqual([released.msg.id, released.msg.action], [held.msgId, "pause"]);
  assert.match(released.text, /\[URGENT\].*action=pause/);
  const [bypass] = await send(human, "beta", "user resumes", { kind: "control", action: "resume" });
  assert.equal(bypass.status, "delivered");
  assert.equal((await beta.nextDelivery()).msg.action, "resume");
  await human.request("set_inbound", { name: "beta", mode: "refuse" });
  for (const sender of [alpha.client, human]) {
    const [refused] = await send(sender, "beta", "cancel while refusing", { kind: "control", action: "cancel" });
    assert.deepEqual([refused.status, refused.reason], ["rejected", "target refuses messages"]);
  }
  assert.equal(beta.deliveries.length, 2);
  assert.deepEqual((await human.sync()).sessions.filter((session) => session.id === beta.session.id).map((session) => [session.state, session.inbound]), [["live", "refuse"]]);
  await human.request("set_inbound", { name: "beta", mode: "accept" });
  const gone = await env.watch(isSession("gone", "beta"));
  beta.client.close();
  await gone.event;
  const [queued] = await send(alpha.client, "beta", "resume after reconnect", { kind: "control", action: "resume" });
  assert.equal(queued.status, "queued");
  const delivered = await env.watch(isStatus(queued.msgId, "delivered"));
  const reconnected = await env.adapter("omp", "b", "beta");
  const pending = await reconnected.nextDelivery();
  await delivered.event;
  assert.deepEqual([pending.msg.id, pending.msg.action], [queued.msgId, "resume"]);
  assert.match(pending.text, /\[URGENT\].*action=resume/);
  assert.deepEqual(
    (await human.historyPage({ scope: "session", sessionId: beta.session.id })).messages
      .filter((message) => message.status === "delivered").map((message) => [message.id, message.action]),
    [[held.msgId, "pause"], [bypass.msgId, "resume"], [queued.msgId, "resume"]],
  );
  const replay = await human.replay(before.watermark);
  assert.deepEqual(
    replay.events.filter((entry) => entry.event.type === "message" && entry.event.msg.id === held.msgId)
      .map((entry) => entry.event.type === "message" && [entry.event.status, entry.event.msg.action]),
    [["held", "pause"], ["queued", "pause"], ["delivered", "pause"]],
  );
});

test("policy: hold, refuse, duplicate drop and rate limit", async () => {
  env = await startEnv();
  const human = env.human();
  const a = await env.adapter("omp", "a", "alpha");
  await env.adapter("omp", "b", "beta");

  await human.request("set_inbound", { name: "beta", mode: "hold" });
  const [held] = await send(a.client, "beta", "agent msg");
  assert.equal(held.status, "held");
  assert.equal((await send(human, "beta", "human msg"))[0].status, "delivered");
  await assert.rejects(a.client.request("set_inbound", { name: "beta", mode: "accept" }), /only the user/);
  assert.equal((await human.request("release", { msgId: held.msgId })).status, "delivered");

  await human.request("set_inbound", { name: "beta", mode: "refuse" });
  const refused = [(await send(a.client, "beta", "x1"))[0], (await send(human, "beta", "x2"))[0]];
  assert.deepEqual(refused.map((r) => [r.status, r.reason]), [["rejected", "target refuses messages"], ["rejected", "target refuses messages"]]);

  await human.request("set_inbound", { name: "beta", mode: "accept" });
  assert.equal((await send(a.client, "beta", "same"))[0].status, "delivered");
  const dup = (await send(a.client, "beta", "same"))[0];
  assert.deepEqual([dup.status, dup.reason], ["dropped", "duplicate"]);
  env.clock.advance(30_000);
  assert.equal((await send(a.client, "beta", "same"))[0].status, "delivered");

  const burst = await env.adapter("omp", "burst", "burst");
  for (let i = 0; i < 30; i++) assert.equal((await send(burst.client, "beta", `n${i}`))[0].status, "delivered", `send ${i}`);
  const over = (await send(burst.client, "beta", "n30"))[0];
  assert.deepEqual([over.status, over.reason], ["rejected", "rate_limited"]);
});

test("grace expiry: a message to a vanished session expires and the sender is told", async () => {
  env = await startEnv();
  const human = env.human();
  const a = await env.adapter("omp", "a", "alpha");
  const b = await env.adapter("omp", "b", "beta");
  const gone = await env.watch(isSession("gone", "beta"));
  b.client.close();
  await gone.event;
  const [r] = await send(a.client, "beta", "are you there");
  assert.equal(r.status, "queued");

  env.clock.advance(GRACE_MS - 1);
  env.daemon.sweep();
  assert.equal((await logOf(human, r.msgId!)).status, "queued");
  env.clock.advance(1);
  env.daemon.sweep();
  assert.equal((await logOf(human, r.msgId!)).status, "expired");
  const notice = await a.nextDelivery();
  assert.equal(notice.msg.from, "asenq");
  assert.match(notice.text, new RegExp(`Message ${r.msgId} to beta was not delivered`));
  assert.equal(await sessionState(human, "beta"), undefined);
});

test("claude socket: plain frame without auth, probe marks dead sessions gone, session ids accumulate", async () => {
  env = await startEnv();
  const human = env.human();
  const sock = join(env.home, "claude.sock");
  const fake = await fakeClaude(sock);
  const start = await human.request("claude_hook", { event: "start", key: sock, socket: sock, sessionId: "s1", name: "orch", cwd: "/w" });
  assert.equal((start.session as { name: string }).name, "orch");

  const [r] = await send(human, "orch", "hi");
  assert.equal(r.status, "delivered");
  const { status: _status, reason: _reason, ...wire } = await logOf(human, r.msgId!);
  assert.equal(await fake.nextLine(), JSON.stringify({ type: "user", message: { role: "user", content: renderInbound(wire) } }));

  // A retry tick landing while a socket write is still in progress must not write the message again.
  const pending = send(human, "orch", "once");
  await fake.nextLine();
  await env.daemon.retry();
  assert.equal((await pending)[0].status, "delivered");
  assert.equal(fake.lines.length, 2);

  await fake.stop();
  await env.daemon.probeClaude();
  assert.equal(await sessionState(human, "orch"), "gone");

  await human.request("claude_hook", { event: "start", key: sock, socket: sock, sessionId: "s2", name: "orch" });
  assert.equal(await sessionState(human, "orch"), "live");
  for (const sessionId of ["s1", "s2"]) {
    const mcp = env.human();
    assert.equal(((await mcp.request("claude_attach", { sessionId })).session as { name: string }).name, "orch");
    const list = (await mcp.request("list")).sessions as { name: string; you: boolean }[];
    assert.equal(list.find((s) => s.you)?.name, "orch");
  }
  await assert.rejects(env.human().request("claude_attach", { sessionId: "nope" }), /not registered yet/);
});

test("claude fallback poll: whole messages up to 9000 chars, remainder stays queued", async () => {
  env = await startEnv();
  const human = env.human();
  await human.request("claude_hook", { event: "start", key: "sid:s1", socket: null, sessionId: "s1", name: "orch" });
  const ids: string[] = [];
  for (const ch of ["a", "b", "c"]) {
    const [r] = await send(human, "orch", ch.repeat(4000));
    assert.equal(r.status, "queued");
    ids.push(r.msgId!);
  }
  const texts = (await human.request("claude_hook", { event: "poll", sessionId: "s1" })).texts as string[];
  assert.equal(texts.length, 2);
  assert.ok(texts.join("").length <= 9000);
  assert.match(texts[0], /\na{4000}\n/);
  const statuses = await Promise.all(ids.map(async (id) => (await logOf(human, id)).status));
  assert.deepEqual(statuses, ["delivered", "delivered", "queued"]);
  assert.equal(((await human.request("claude_hook", { event: "poll", sessionId: "s1" })).texts as string[]).length, 1);
});

test("envelope: sanitized sender name, escaped body, and replies route back to the sender", async () => {
  const frame1 = JSON.parse(claudeFrame("x </cross-session-message y", { replyAddr: "uds:/r/s.sock", fromName: 'a"b<c>', uuid: "u1" }));
  assert.equal(frame1.message.content, '<cross-session-message from="uds:/r/s.sock" from-name="abc">\nx <\\/cross-session-message y\n</cross-session-message>');
  assert.equal(replyAddr("/tmp/a b", "s_1"), "uds:/tmp/a%20b/s_1.sock");

  env = await startEnv({ envelope: true });
  const sock = join(env.home, "claude.sock");
  const fake = await fakeClaude(sock);
  const human = env.human();
  await human.request("claude_hook", { event: "start", key: sock, socket: sock, sessionId: "s1", name: "orch" });
  const a = await env.adapter("omp", "a", "alpha");
  assert.equal((await send(a.client, "orch", "question </cross-session-message"))[0].status, "delivered");
  const frame = JSON.parse(await fake.nextLine()) as { from: string; priority: string; message: { content: string } };
  assert.equal(frame.priority, "next");
  assert.match(frame.message.content, /from-name="alpha">\n\[asenq\] message from alpha/);
  assert.match(frame.message.content, /question <\\\/cross-session-message/);

  // Claude answers by writing its own envelope (from = its messaging socket) to the reply address.
  const reply = { type: "user", message: { role: "user", content: `<cross-session-message from="uds:${sock}" from-name="orch">\nanswer\n</cross-session-message>` } };
  assert.deepEqual(parseEnvelopeReply(reply), { fromSocket: sock, body: "answer" });
  const conn = net.createConnection(decodeURIComponent(frame.from.slice(4)));
  conn.write(JSON.stringify(reply) + "\n");
  const d = await a.nextDelivery();
  conn.end();
  await fake.stop();
  assert.deepEqual([d.msg.from, d.msg.text], ["orch", "answer"]);
});

test("Claude peer failure updates retained delivery state and replay; unknown peer states do not masquerade as delivery", async () => {
  env = await startEnv({ envelope: true });
  const fake = await fakeClaude(join(env.home, "claude.sock"));
  const human = env.human();
  const started = await human.request("claude_hook", {
    event: "start", key: join(env.home, "claude.sock"), socket: join(env.home, "claude.sock"),
    sessionId: "s1", name: "orch",
  });
  const sent = (await send(human, "orch", "question"))[0];
  assert.equal(sent.status, "delivered");
  const frame = JSON.parse(await fake.nextLine()) as { from: string; msg_id: string };
  const before = await human.sync();
  const conn = net.createConnection(decodeURIComponent(frame.from.slice(4)));
  const failed = await env.watch(isStatus(sent.msgId, "failed"));
  conn.write(JSON.stringify({ type: "control", action: "peer_message_status", msg_id: frame.msg_id, status: "failed", reason: "peer unavailable" }) + "\n");
  await failed.event;
  assert.equal((await logOf(human, sent.msgId!)).status, "failed");
  const session = started.session;
  assert.ok(session && typeof session === "object" && "id" in session && typeof session.id === "string");
  const history = await human.historyPage({ scope: "session", sessionId: session.id });
  assert.deepEqual([history.messages.at(-1)?.status, history.messages.at(-1)?.reason], ["failed", "peer unavailable"]);
  const replayed = await human.replay(before.watermark);
  assert.ok(replayed.events.some(({ event }) => event.type === "message" && event.msg.id === sent.msgId && event.msg.status === "failed"));
  conn.write(JSON.stringify({ type: "control", action: "peer_message_status", msg_id: frame.msg_id, status: "accepted" }) + "\n");
  conn.end();
  await new Promise<void>((resolve) => conn.on("close", resolve));
  assert.equal((await logOf(human, sent.msgId!)).status, "failed");
  await fake.stop();
});

test("channels are stored and read back, never pushed", async () => {
  env = await startEnv();
  const a = await env.adapter("omp", "a", "alpha");
  const human = env.human();
  await a.client.request("channel_send", { channel: "general", text: "one" });
  await human.request("channel_send", { channel: "general", text: "two" });
  const read = (await human.request("channel_read", { channel: "general", limit: 1 })).messages as { from: string; text: string }[];
  assert.deepEqual(read.map((m) => [m.from, m.text]), [["human", "two"]]);
  assert.equal(a.deliveries.length, 0);
  await assert.rejects(human.request("channel_send", { channel: "Bad Name", text: "x" }), /invalid channel name/);
});

test("thread reads retain both directions in durable order and isolate the caller", async () => {
  env = await startEnv();
  const human = env.human();
  const alpha = await env.adapter("omp", "alpha-key", "alpha");
  const beta = await env.adapter("omp", "beta-key", "beta");
  const gamma = await env.adapter("omp", "gamma-key", "gamma");
  const first = (await send(human, "alpha", "human to alpha", { thread: "work" }))[0];
  const second = (await send(alpha.client, "beta", "alpha to beta", { thread: "work" }))[0];
  await send(beta.client, "gamma", "not alpha's exchange", { thread: "work" });
  const third = (await send(beta.client, "alpha", "beta to alpha", { thread: "work" }))[0];
  const fourth = (await send(alpha.client, "human", "alpha to human", { thread: "work" }))[0];
  await send(human, "gamma", "not alpha's human message", { thread: "work" });
  await send(beta.client, "alpha", "another thread", { thread: "other" });
  await alpha.client.request("channel_send", { channel: "work", text: "not a direct message" });

  const snapshot = await human.sync();
  const read = (await alpha.client.request("thread_read", { thread: "work" })).messages as StoredMessage[];
  assert.deepEqual(read.map((message) => message.id), [first.msgId, second.msgId, third.msgId, fourth.msgId]);
  assert.deepEqual(read.map((message) => message.createdAt), Array(4).fill(env.clock.now()));
  assert.ok(read.every((message, index) => index === 0 || read[index - 1].order < message.order));
  const humanRead = (await human.request("thread_read", { thread: "work" })).messages as StoredMessage[];
  assert.deepEqual(humanRead.map((message) => message.text), [
    "human to alpha", "alpha to human", "not alpha's human message",
  ]);
  assert.deepEqual((await human.sync()).readStates, snapshot.readStates);
  assert.deepEqual((await human.request("replay", { position: snapshot.watermark })).events, []);
});

test("thread scope survives renames but does not transfer to a reused name", async () => {
  env = await startEnv();
  const human = env.human();
  const original = await env.adapter("omp", "original-key", "alpha");
  const peer = await env.adapter("omp", "peer-key", "peer");
  const first = (await send(original.client, "peer", "before rename", { thread: "work" }))[0];
  await original.client.request("rename", { name: "renamed" });
  const second = (await send(peer.client, "renamed", "after rename", { thread: "work" }))[0];
  const third = (await send(original.client, "human", "human exchange", { thread: "work" }))[0];
  assert.deepEqual(
    ((await original.client.request("thread_read", { thread: "work", since: first.msgId })).messages as StoredMessage[]).map((message) => message.id),
    [second.msgId, third.msgId],
  );
  assert.deepEqual((await original.client.request("thread_read", { thread: "work", since: env.clock.now() })).messages, []);
  await original.client.request("unregister");
  const replacement = await env.adapter("omp", "replacement-key", "renamed");
  const fresh = (await send(peer.client, "renamed", "replacement exchange", { thread: "work" }))[0];
  assert.notEqual(replacement.session.id, original.session.id);
  assert.deepEqual(
    ((await replacement.client.request("thread_read", { thread: "work" })).messages as StoredMessage[]).map((message) => message.id),
    [fresh.msgId],
  );
  assert.deepEqual(
    ((await peer.client.request("thread_read", { thread: "work" })).messages as StoredMessage[]).map((message) => message.id),
    [first.msgId, second.msgId, fresh.msgId],
  );
  await assert.rejects(replacement.client.request("thread_read", { thread: "work", since: first.msgId }), { code: "bad_request" });
});

test("inbox pages newest first with exclusive durable cursors, default and maximum limits", async () => {
  env = await startEnv();
  const human = env.human();
  const ids: string[] = [];
  for (let index = 0; index < 205; index++) {
    ids.push((await send(human, "human", `note ${index}`))[0].msgId!);
  }
  const newest = await human.request("inbox");
  assert.deepEqual((newest.messages as StoredMessage[]).map((message) => message.id), ids.slice(-20).reverse());
  assert.equal(newest.hasMore, true);
  const capped = await human.request("inbox", { limit: 999 });
  assert.deepEqual((capped.messages as StoredMessage[]).map((message) => message.id), ids.slice(-200).reverse());
  assert.equal(capped.hasMore, true);
  const middle = await human.request("inbox", { since: ids[1], before: ids[5], limit: 2 });
  assert.deepEqual((middle.messages as StoredMessage[]).map((message) => message.id), [ids[4], ids[3]]);
  assert.equal(middle.hasMore, true);
  const oldest = await human.request("inbox", { before: ids[3], limit: 3 });
  assert.deepEqual((oldest.messages as StoredMessage[]).map((message) => message.id), ids.slice(0, 3).reverse());
  assert.equal(oldest.hasMore, false);
  assert.deepEqual((await human.request("inbox", { since: env.clock.now() })).messages, []);
});

test("inbox filters compose across timestamps and sender renames without changing human markers", async () => {
  env = await startEnv();
  const human = env.human();
  const alpha = await env.adapter("omp", "alpha-key", "alpha");
  const beta = await env.adapter("omp", "beta-key", "beta");
  await human.sync();
  const scope = { scope: "session" as const, sessionId: alpha.session.id };
  const first = (await send(alpha.client, "human", "first", { thread: "work" }))[0];
  const firstPage = await human.historyPage({ scope: "inbox" });
  await human.markRead(scope, firstPage.messages[0].order, (await human.readState(scope)).version);
  env.clock.advance(1000);
  const boundary = env.clock.now();
  const second = (await send(alpha.client, "human", "second", { thread: "work" }))[0];
  env.clock.advance(1000);
  const third = (await send(alpha.client, "human", "third", { thread: "work" }))[0];
  await send(alpha.client, "human", "different thread", { thread: "other" });
  await send(beta.client, "human", "different sender", { thread: "work" });
  await human.request("rename", { from: "alpha", name: "renamed" });
  await alpha.client.request("channel_send", { channel: "work", text: "channel post" });
  const snapshot = await human.sync();
  const params = { from: "renamed", thread: "work", unread_only: true, limit: 1 };
  const combined = await human.request("inbox", params);
  assert.deepEqual((combined.messages as StoredMessage[]).map((message) => message.id), [third.msgId]);
  assert.equal(combined.hasMore, true);
  for (const since of [boundary, String(boundary), new Date(boundary).toISOString()]) {
    const page = await human.request("inbox", { ...params, since, limit: 20 });
    assert.deepEqual((page.messages as StoredMessage[]).map((message) => message.id), [third.msgId]);
  }
  const older = await human.request("inbox", { from: "renamed", before: boundary + 1 });
  assert.deepEqual((older.messages as StoredMessage[]).map((message) => message.id), [second.msgId, first.msgId]);
  const sinceId = await human.request("inbox", { ...params, since: first.msgId, before: third.msgId });
  assert.deepEqual((sinceId.messages as StoredMessage[]).map((message) => message.id), [second.msgId]);
  assert.deepEqual((await human.sync()).readStates, snapshot.readStates);
  assert.deepEqual((await human.replay(snapshot.watermark)).events, []);
  const reminder = await human.markUnread(scope);
  const latest = await human.historyPage({ ...scope, limit: 1 });
  await human.markRead(scope, latest.messages[0].order, reminder.state.version);
  await human.markUnread(scope);
  assert.deepEqual(
    ((await human.request("inbox", { unread_only: true, from: "renamed" })).messages as StoredMessage[]).map((message) => message.text),
    ["different thread"],
  );
  assert.deepEqual((await human.request("inbox", { from: "no-such-sender" })).messages, []);
  assert.deepEqual((await human.request("inbox", { from: "human" })).messages, []);
  assert.deepEqual((await human.replay(snapshot.watermark)).events.map(({ event }) => event.type), ["read", "read", "read"]);
});

test("plain session unread drains oldest first within budget; filtered reads do not consume", async () => {
  env = await startEnv();
  const human = env.human();
  const alpha = await env.adapter("omp", "alpha-key", "alpha");
  const ids: string[] = [];
  for (let index = 0; index < 3; index++) {
    ids.push((await send(human, "alpha", `${index}${"x".repeat(8000)}`, { thread: "work" }))[0].msgId!);
  }
  const filtered = await alpha.client.request("inbox", { unread_only: true, thread: "work", limit: 1 });
  assert.deepEqual((filtered.messages as StoredMessage[]).map((message) => message.id), [ids[2]]);
  const sent = (await send(alpha.client, "human", "reply in thread", { thread: "work" }))[0];
  const thread = await alpha.client.request("thread_read", { thread: "work" });
  assert.deepEqual((thread.messages as StoredMessage[]).map((message) => message.id), [...ids, sent.msgId]);
  for (let index = 0; index < ids.length; index++) {
    const page = await alpha.client.request("inbox", { unread_only: true, max_chars: 15000 });
    assert.deepEqual((page.messages as StoredMessage[]).map((message) => message.id), [ids[index]]);
    assert.equal(page.hasMore, index < ids.length - 1);
  }
  assert.deepEqual((await alpha.client.request("inbox", { unread_only: true })).messages, []);
  assert.deepEqual(
    ((await alpha.client.request("inbox")).messages as StoredMessage[]).map((message) => message.id), [...ids].reverse(),
  );
  await alpha.client.request("rename", { name: "renamed" });
  const resumed = await env.adapter("omp", "alpha-key", "renamed");
  assert.equal(resumed.session.id, alpha.session.id);
  assert.deepEqual((await resumed.client.request("inbox", { unread_only: true })).messages, []);
  const fresh = await env.adapter("omp", "fresh-key", "fresh");
  assert.deepEqual((await fresh.client.request("inbox", { unread_only: true })).messages, []);
});

test("session unread includes an earlier held message exactly once when released after a later delivery", async () => {
  env = await startEnv();
  const human = env.human();
  const sender = await env.adapter("omp", "sender-key", "sender");
  const receiver = await env.adapter("omp", "receiver-key", "receiver");
  await human.request("set_inbound", { name: "receiver", mode: "hold" });
  const held = (await send(sender.client, "receiver", "held first"))[0];
  assert.equal(held.status, "held");
  const later = (await send(human, "receiver", "delivered later"))[0];
  assert.equal(later.status, "delivered");
  assert.deepEqual(
    ((await receiver.client.request("inbox", { unread_only: true })).messages as StoredMessage[]).map((message) => message.id),
    [later.msgId],
  );
  assert.equal((await human.request("release", { msgId: held.msgId })).status, "delivered");
  assert.deepEqual(
    ((await receiver.client.request("inbox", { unread_only: true })).messages as StoredMessage[]).map((message) => message.id),
    [held.msgId],
  );
  assert.deepEqual((await receiver.client.request("inbox", { unread_only: true })).messages, []);
  assert.deepEqual(
    ((await receiver.client.request("inbox")).messages as StoredMessage[]).map((message) => message.id),
    [later.msgId, held.msgId],
  );
});

test("session unread excludes queued messages until ack and includes their later delivery exactly once", async () => {
  env = await startEnv();
  const human = env.human();
  const original = await env.adapter("omp", "receiver-key", "receiver");
  const gone = await env.watch(isSession("gone", "receiver"));
  original.client.close();
  await gone.event;
  const queued = (await send(human, "receiver", "queued first"))[0];
  assert.equal(queued.status, "queued");
  const receiver = await env.adapter("omp", "receiver-key", "receiver", { autoAck: false });
  assert.equal((await receiver.nextDelivery()).msg.id, queued.msgId);
  const sendingLater = send(human, "receiver", "delivered later");
  const laterDelivery = await receiver.nextDelivery();
  await receiver.client.request("ack", { msgId: laterDelivery.msg.id, ok: true });
  const later = (await sendingLater)[0];
  assert.equal(later.status, "delivered");
  assert.deepEqual(
    ((await receiver.client.request("inbox", { unread_only: true })).messages as StoredMessage[]).map((message) => message.id),
    [later.msgId],
  );
  const delivered = await env.watch(isStatus(queued.msgId, "delivered"));
  await receiver.client.request("ack", { msgId: queued.msgId, ok: true });
  await delivered.event;
  assert.deepEqual(
    ((await receiver.client.request("inbox", { unread_only: true })).messages as StoredMessage[]).map((message) => message.id),
    [queued.msgId],
  );
  assert.deepEqual((await receiver.client.request("inbox", { unread_only: true })).messages, []);
  await receiver.client.request("ack", { msgId: queued.msgId, ok: true });
  await receiver.client.request("ack", { msgId: later.msgId, ok: true });
  assert.deepEqual((await receiver.client.request("inbox", { unread_only: true })).messages, []);
});

test("thread reads, id recovery and cursors honor recipient inbound policy while preserving sender history", async () => {
  env = await startEnv();
  const human = env.human();
  const sender = await env.adapter("omp", "sender-key", "sender");
  const receiver = await env.adapter("omp", "receiver-key", "receiver");
  await human.request("set_inbound", { name: "receiver", mode: "hold" });
  const held = (await send(sender.client, "receiver", "held private body", { thread: "work" }))[0];
  await human.request("set_inbound", { name: "receiver", mode: "refuse" });
  const refused = (await send(sender.client, "receiver", "refused private body", { thread: "work" }))[0];
  assert.deepEqual([held.status, refused.status], ["held", "rejected"]);
  assert.deepEqual((await receiver.client.request("thread_read", { thread: "work" })).messages, []);
  for (const message of [held, refused]) {
    await assert.rejects(receiver.client.request("inbox", { msgId: message.msgId }), { code: "bad_request" });
    for (const op of ["inbox", "thread_read"]) {
      await assert.rejects(receiver.client.request(op, { thread: "work", since: message.msgId }), { code: "bad_request" });
    }
    await assert.rejects(receiver.client.request("inbox", { before: message.msgId }), { code: "bad_request" });
    const sent = (await sender.client.request("inbox", { msgId: message.msgId })).messages as StoredMessage[];
    assert.deepEqual(sent.map((row) => [row.id, row.status]), [[message.msgId, message.status]]);
  }
  const history = (await sender.client.request("thread_read", { thread: "work" })).messages as StoredMessage[];
  assert.deepEqual(history.map((message) => [message.id, message.status]), [[held.msgId, "held"], [refused.msgId, "rejected"]]);
});

test("inbox id recovery is full, caller scoped and nonmutating despite other params", async () => {
  env = await startEnv();
  const human = env.human();
  const alpha = await env.adapter("omp", "alpha-key", "alpha");
  const beta = await env.adapter("omp", "beta-key", "beta");
  const oversizedText = "x".repeat(20000);
  const oversized = (await send(human, "alpha", oversizedText))[0];
  const next = (await send(human, "alpha", "next message"))[0];
  const page = await alpha.client.request("inbox", { unread_only: true, max_chars: 15000 });
  assert.deepEqual((page.messages as StoredMessage[]).map((message) => [message.id, message.text]), [[oversized.msgId, oversizedText]]);
  assert.equal(page.hasMore, true);
  for (const caller of [alpha.client, human]) {
    const recovered = await caller.request("inbox", {
      msgId: oversized.msgId, max_chars: 1, limit: 0, unread_only: true, since: "invalid", from: "wrong", thread: "wrong",
    });
    assert.deepEqual((recovered.messages as StoredMessage[]).map((message) => [message.id, message.text]), [[oversized.msgId, oversizedText]]);
    assert.equal(recovered.hasMore, false);
  }
  await assert.rejects(beta.client.request("inbox", { msgId: oversized.msgId }), { code: "bad_request" });
  await assert.rejects(alpha.client.request("inbox", { msgId: "m_missing" }), { code: "bad_request" });
  const remaining = await alpha.client.request("inbox", { unread_only: true });
  assert.deepEqual((remaining.messages as StoredMessage[]).map((message) => message.id), [next.msgId]);
  const secret = (await send(beta.client, "human", "private human inbox"))[0];
  const normal = await alpha.client.request("inbox", { name: "human" });
  assert.ok(!(normal.messages as StoredMessage[]).some((message) => message.id === secret.msgId));
});

test("inbox and thread cursors reject invalid and foreign ids without consuming unread", async () => {
  env = await startEnv();
  const human = env.human();
  const alpha = await env.adapter("omp", "alpha-key", "alpha");
  const beta = await env.adapter("omp", "beta-key", "beta");
  const incoming = (await send(human, "alpha", "incoming", { thread: "work" }))[0];
  const foreign = (await send(beta.client, "human", "foreign", { thread: "work" }))[0];
  await alpha.client.request("channel_send", { channel: "work", text: "post" });
  const channel = (await human.request("channel_read", { channel: "work" })).messages as StoredMessage[];
  for (const op of ["inbox", "thread_read"]) {
    for (const since of [foreign.msgId, channel[0].id, "m_unknown", "yesterday", "2026-99-99T00:00:00Z", -1, 1.5, {}, true, Number.MAX_SAFE_INTEGER + 1]) {
      await assert.rejects(alpha.client.request(op, { thread: "work", since }), { code: "bad_request" });
    }
  }
  for (const before of [foreign.msgId, "m_unknown", -1]) {
    await assert.rejects(alpha.client.request("inbox", { before }), { code: "bad_request" });
  }
  for (const params of [{ limit: 0 }, { limit: 1.5 }, { limit: "2" }, { unread_only: "true" }, { from: 3 }, { thread: 3 }, { max_chars: 0 }]) {
    await assert.rejects(alpha.client.request("inbox", params), { code: "bad_request" });
  }
  await assert.rejects(alpha.client.request("thread_read"), { code: "bad_request" });
  assert.deepEqual(
    ((await alpha.client.request("inbox", { unread_only: true })).messages as StoredMessage[]).map((message) => message.id),
    [incoming.msgId],
  );
});

test("history pages use durable order across equal timestamps and concurrent arrivals", async () => {
  env = await startEnv();
  const human = env.human();
  const alpha = await env.adapter("omp", "alpha-key", "alpha");
  await human.sync();

  const ids: string[] = [];
  for (let index = 1; index <= 5; index++) {
    ids.push((await human.sendToSession(alpha.session.id, `message ${index}`)).msgId!);
  }

  const newest = await human.historyPage({ scope: "session", sessionId: alpha.session.id, limit: 2 });
  assert.equal(newest.hasMore, true);
  assert.deepEqual(newest.messages.map((message) => message.id), ids.slice(3));
  assert.ok(newest.messages[0].order < newest.messages[1].order);
  assert.deepEqual(newest.messages.map((message) => message.status), ["delivered", "delivered"]);

  const concurrent = (await human.sendToSession(alpha.session.id, "arrived after page one")).msgId!;
  const middle = await human.historyPage({
    scope: "session",
    sessionId: alpha.session.id,
    before: newest.messages[0].order,
    limit: 2,
  });
  const oldest = await human.historyPage({
    scope: "session",
    sessionId: alpha.session.id,
    before: middle.messages[0].order,
    limit: 2,
  });
  assert.deepEqual([...oldest.messages, ...middle.messages, ...newest.messages].map((message) => message.id), ids);
  assert.equal(oldest.hasMore, false);
  assert.ok(![...oldest.messages, ...middle.messages].some((message) => message.id === concurrent));
});

test("renames preserve identity, removed history is archived, and same-name reuse stays distinct", async () => {
  env = await startEnv();
  const human = env.human();
  const original = await env.adapter("omp", "original-key", "alpha");
  const originalMessage = await human.sendToSession(original.session.id, "before rename");
  await human.request("rename", { from: "alpha", name: "beta" });
  await original.client.request("unregister");

  const replacement = await env.adapter("omp", "replacement-key", "beta");
  assert.notEqual(replacement.session.id, original.session.id);
  const snapshot = await human.sync();
  const archived = snapshot.sessions.find((session) => session.id === original.session.id)!;
  const live = snapshot.sessions.find((session) => session.id === replacement.session.id)!;
  assert.deepEqual(
    [archived.name, archived.previousNames, archived.state, live.name, live.state],
    ["beta", ["alpha"], "removed", "beta", "live"],
  );

  const oldHistory = await human.historyPage({ scope: "session", sessionId: original.session.id });
  const newHistory = await human.historyPage({ scope: "session", sessionId: replacement.session.id });
  assert.deepEqual(oldHistory.messages.map((message) => message.id), [originalMessage.msgId]);
  assert.deepEqual(newHistory.messages, []);
  await assert.rejects(human.sendToSession(original.session.id, "must not retarget"), /removed or unknown/);
  assert.equal((await human.sendToSession(replacement.session.id, "new identity")).status, "delivered");
});

test("sync watermark resumes missed status events and replay reports a pruned retention gap", async () => {
  env = await startEnv({ historyDays: 7 });
  const human = env.human();
  const alpha = await env.adapter("omp", "alpha-key", "alpha");
  const synced = await human.sync();
  human.close();

  const sender = env.human();
  const sent = await sender.sendToSession(alpha.session.id, "while disconnected");
  const resumed = env.human();
  const replay = await resumed.replay(synced.watermark);
  const messageEvents = replay.events.filter(
    (entry) => entry.event.type === "message" && entry.event.msg.id === sent.msgId,
  );
  assert.equal(replay.gap, false);
  assert.deepEqual(messageEvents.map((entry) => entry.event.type === "message" && entry.event.status), ["queued", "delivered"]);
  assert.ok(messageEvents.every((entry, index) => index === 0 || messageEvents[index - 1].position < entry.position));

  env.clock.advance(8 * 86_400_000);
  env.daemon.prune();
  const afterPrune = await resumed.replay(0);
  assert.ok(afterPrune.events.some((entry) => entry.event.type === "retention"));
  assert.equal(afterPrune.gap, true);
  assert.ok(afterPrune.eventFloor >= messageEvents.at(-1)!.position);
  const history = await resumed.historyPage({ scope: "session", sessionId: alpha.session.id });
  assert.deepEqual(history.messages, []);
  assert.equal(history.hasMore, false);
});

test("shared read state keeps reminders against stale windows and excludes human channel posts", async () => {
  env = await startEnv();
  const first = env.human();
  const second = env.human();
  const alpha = await env.adapter("omp", "alpha-key", "alpha");
  await first.sync();
  await second.sync();
  const scope = { scope: "session" as const, sessionId: alpha.session.id };

  const incoming = (await send(alpha.client, "human", "for the user"))[0];
  const page = await first.historyPage({ scope: "inbox" });
  const order = page.messages.find((message) => message.id === incoming.msgId)!.order;
  const stale = await second.readState(scope);
  assert.equal(stale.unread, 1);

  const readChanged = await env.watch((event) => event.type === "read" && event.state.scope.scope === "session");
  const reminder = await first.markUnread(scope, stale.version);
  assert.equal(reminder.state.reminder, order);
  assert.equal((await readChanged.event).type, "read");
  const staleAdvance = await second.markRead(scope, order, stale.version);
  assert.equal(staleAdvance.applied, false);
  assert.equal(staleAdvance.state.reminder, order);
  await assert.rejects(alpha.client.markUnread(scope), /only the user/);

  const current = await second.readState(scope);
  const cleared = await second.markRead(scope, order, current.version);
  assert.deepEqual(
    [cleared.applied, cleared.state.position, cleared.state.reminder, cleared.state.unread],
    [true, order, null, 0],
  );

  await alpha.client.request("channel_send", { channel: "general", text: "first unread" });
  assert.equal((await first.readState({ scope: "channel", channel: "general" })).unread, 1);
  await first.request("channel_send", { channel: "general", text: "human post" });
  assert.equal((await first.readState({ scope: "channel", channel: "general" })).unread, 1);
  await alpha.client.request("channel_send", { channel: "general", text: "second unread" });
  const channel = await first.readState({ scope: "channel", channel: "general" });
  assert.equal(channel.unread, 2);
});

test("schema rollout orders old equal-time rows by rowid and initializes retained history read", async () => {
  const home = mkdtempSync(join(tmpdir(), "asenq-migrate-"));
  const previousHome = process.env.ASENQ_HOME;
  process.env.ASENQ_HOME = home;
  const db = await openDb(join(home, "asenq.db"));
  db.exec(`
    CREATE TABLE sessions(
      id TEXT PRIMARY KEY, harness TEXT NOT NULL, key TEXT NOT NULL, name TEXT NOT NULL UNIQUE,
      cwd TEXT, inbound TEXT NOT NULL DEFAULT 'accept', state TEXT NOT NULL,
      gone_at INTEGER, claude_socket TEXT, claude_session_ids TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL, UNIQUE(harness,key));
    CREATE TABLE messages(
      id TEXT PRIMARY KEY, from_name TEXT NOT NULL, from_session TEXT, to_name TEXT NOT NULL, to_session TEXT,
      channel TEXT, text TEXT NOT NULL, kind TEXT, thread TEXT, reply_to TEXT,
      done INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, reason TEXT, attempts INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE session_identities(
      id TEXT PRIMARY KEY, harness TEXT NOT NULL, name TEXT NOT NULL, previous_names TEXT NOT NULL DEFAULT '[]',
      cwd TEXT, inbound TEXT NOT NULL DEFAULT 'accept', state TEXT NOT NULL,
      created_at INTEGER NOT NULL, removed_at INTEGER);
  `);
  db.run(
    `INSERT INTO sessions(id,harness,key,name,cwd,inbound,state,created_at)
     VALUES('s_old','omp','old-key','old-session','/old','accept','live',1)`,
  );
  for (const [id, text, fromName] of [
    ["m_old_1", "first", "prior-session"],
    ["m_old_2", "second", "old-session"],
  ]) {
    db.run(
      `INSERT INTO messages(
        id,from_name,from_session,to_name,to_session,channel,text,kind,thread,reply_to,
        done,status,reason,attempts,created_at,updated_at)
       VALUES(?,?,'s_old','human',NULL,NULL,?,NULL,NULL,NULL,0,'posted',NULL,0,10,10)`,
      id, fromName, text,
    );
  }
  db.run(
    `INSERT INTO messages(
      id,from_name,from_session,to_name,to_session,channel,text,kind,thread,reply_to,
      done,status,reason,attempts,created_at,updated_at)
     VALUES('m_orphan','human',NULL,'removed-session','s_removed',NULL,'archived',NULL,NULL,NULL,0,'delivered',NULL,0,11,12)`,
  );
  db.run(
    `INSERT INTO messages(
      id,from_name,from_session,to_name,to_session,channel,text,kind,thread,reply_to,
      done,status,reason,attempts,created_at,updated_at)
     VALUES('m_incoming','human',NULL,'old-session','s_old',NULL,'already delivered',NULL,NULL,NULL,0,'delivered',NULL,0,13,13)`,
  );

  const daemon = new Daemon({
    socket: socketPath(),
    db,
    replyDir: join(home, "replies"),
    now: () => 20,
    timers: false,
    log: () => {},
  });
  const client = new AsenqClient();
  const agent = new AsenqClient();
  try {
    await daemon.listen();
    const page = await client.historyPage({ scope: "inbox" });
    assert.deepEqual(page.messages.map((message: StoredMessage) => [message.id, message.order]), [
      ["m_old_1", 1],
      ["m_old_2", 2],
    ]);
    const state = await client.readState({ scope: "session", sessionId: "s_old" });
    assert.deepEqual([state.position, state.unread], [2, 0]);
    const snapshot = await client.sync();
    const active = snapshot.sessions.find((session) => session.id === "s_old");
    assert.deepEqual(active?.previousNames, ["prior-session"]);
    const recovered = snapshot.sessions.find((session) => session.id === "s_removed");
    assert.deepEqual(
      recovered && [recovered.name, recovered.harness, recovered.state, recovered.removedAt],
      ["removed-session", "unknown", "removed", 12],
    );
    const archived = await client.historyPage({ scope: "session", sessionId: "s_removed" });
    assert.deepEqual(archived.messages.map((message) => message.id), ["m_orphan"]);
    await agent.request("register", { harness: "omp", key: "old-key", name: "old-session", cwd: "/old" });
    assert.deepEqual((await agent.request("inbox", { unread_only: true })).messages, []);
    assert.deepEqual(
      ((await agent.request("inbox")).messages as StoredMessage[]).map((message) => message.id), ["m_incoming"],
    );
    assert.equal(((await agent.request("inbox", { msgId: "m_incoming" })).messages as StoredMessage[])[0].text, "already delivered");
    const [control] = await send(agent, "human", "control after schema rollout", { kind: "control", action: "pause" });
    assert.equal(control.status, "posted");
    const migrated = await client.historyPage({ scope: "session", sessionId: "s_old" });
    assert.deepEqual(migrated.messages.map((message) => [message.id, message.action]), [
      ["m_old_1", undefined], ["m_old_2", undefined], ["m_incoming", undefined], [control.msgId, "pause"],
    ]);
  } finally {
    client.close();
    agent.close();
    await daemon.close();
    db.close();
    rmSync(home, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.ASENQ_HOME;
    else process.env.ASENQ_HOME = previousHome;
  }
});

test("activity orders and inbox summaries follow stable identities across renames, reuse and retention", async () => {
  env = await startEnv({ historyDays: 7 });
  const human = env.human();
  const original = await env.adapter("omp", "original-key", "alpha");
  const busy = await env.adapter("omp", "busy-key", "busy");
  const quiet = await env.adapter("omp", "quiet-key", "quiet");

  await send(original.client, "human", "from the original alpha");
  let busyLatest = "";
  for (let index = 1; index <= 65; index++) {
    env.clock.advance(2_100); // stay under the per-sender rate limit
    busyLatest = `busy ${index}`;
    assert.equal((await send(busy.client, "human", busyLatest))[0].status, "posted");
  }
  await human.request("rename", { from: "alpha", name: "gamma" });
  await send(original.client, "human", "original after rename");
  await original.client.request("unregister");
  const replacement = await env.adapter("omp", "replacement-key", "alpha");
  await send(replacement.client, "human", "from the new alpha");
  await send(human, "human", "note to self");
  const toBusy = await human.sendToSession(busy.session.id, "reply to busy");
  await original.client.request("channel_send", { channel: "general", text: "channel posts are not direct activity" });

  const summaries = await human.inboxSummaries();
  assert.deepEqual(
    summaries.map((summary) => [summary.sessionId, summary.name, summary.latest.text]),
    [
      [replacement.session.id, "alpha", "from the new alpha"],
      [original.session.id, "gamma", "original after rename"],
      [busy.session.id, "busy", busyLatest],
    ],
  );

  const snapshot = await human.sync();
  const busyPage = await human.historyPage({ scope: "session", sessionId: busy.session.id, limit: 1 });
  assert.equal(busyPage.messages[0].id, toBusy.msgId);
  assert.equal(snapshot.sessionLastOrders[busy.session.id], busyPage.messages[0].order);
  assert.equal(snapshot.sessionLastOrders[replacement.session.id], summaries[0].latest.order);
  assert.equal(snapshot.sessionLastOrders[original.session.id], summaries[1].latest.order);
  assert.equal(snapshot.sessionLastOrders[quiet.session.id], undefined);

  env.clock.advance(8 * 86_400_000);
  env.daemon.prune();
  const pruned = await human.sync();
  assert.deepEqual(pruned.sessionLastOrders, {});
  assert.deepEqual(await human.inboxSummaries(), []);
  assert.ok(!pruned.sessions.some((session) => session.id === original.session.id));
});

test("recent events return the newest bounded window in ascending order, including after restart", async () => {
  const previousHome = process.env.ASENQ_HOME;
  const home = mkdtempSync(join(tmpdir(), "asenq-events-"));
  process.env.ASENQ_HOME = home;
  const db = await openDb(join(home, "asenq.db"));
  const options = { socket: socketPath(), db, replyDir: join(home, "replies"), now: () => 1, timers: false, log: () => {} };
  let daemon = new Daemon(options);
  let client = new AsenqClient();
  try {
    await daemon.listen();
    const empty = new AsenqClient();
    assert.deepEqual(await empty.recentEvents(), []);
    empty.close();
    for (let index = 1; index <= 210; index++) await send(client, "human", `note ${index}`);
    const recent = await client.recentEvents();
    assert.equal(recent.length, 200);
    assert.ok(recent.every((entry, index) => index === 0 || recent[index - 1].position < entry.position));
    const last = recent.at(-1)!;
    assert.equal(last.event.type === "message" && last.event.msg.text, "note 210");
    assert.deepEqual((await client.recentEvents(3)).map((entry) => entry.position), recent.slice(-3).map((entry) => entry.position));

    client.close();
    await daemon.close();
    daemon = new Daemon(options);
    await daemon.listen();
    client = new AsenqClient();
    await send(client, "human", "after restart");
    const resumed = await client.recentEvents(2);
    assert.deepEqual(resumed.map((entry) => entry.position), [last.position, last.position + 1]);
    assert.equal(resumed[1].event.type === "message" && resumed[1].event.msg.text, "after restart");
  } finally {
    client.close();
    await daemon.close();
    db.close();
    rmSync(home, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.ASENQ_HOME;
    else process.env.ASENQ_HOME = previousHome;
  }
});

test("session inbox position survives daemon restart without skipping pending unread", async () => {
  const previousHome = process.env.ASENQ_HOME;
  const home = mkdtempSync(join(tmpdir(), "asenq-inbox-restart-"));
  process.env.ASENQ_HOME = home;
  const db = await openDb(join(home, "asenq.db"));
  let now = 1_700_000_000_000;
  const options = { socket: socketPath(), db, replyDir: join(home, "replies"), now: () => now, timers: false, log: () => {} };
  let daemon = new Daemon(options);
  let agent = new AsenqClient({
    onPush: (push) => { if (push.push === "deliver") void agent.request("ack", { msgId: push.msg.id, ok: true }); },
  });
  let human = new AsenqClient();
  try {
    await daemon.listen();
    const registered = await agent.request("register", { harness: "omp", key: "alpha-key", name: "alpha" });
    const first = (await send(human, "alpha", "first"))[0];
    const second = (await send(human, "alpha", "second"))[0];
    assert.deepEqual(
      ((await agent.request("inbox", { unread_only: true, limit: 1 })).messages as StoredMessage[]).map((message) => message.id),
      [first.msgId],
    );
    agent.close();
    human.close();
    await daemon.close();
    now += 1000;
    daemon = new Daemon(options);
    await daemon.listen();
    agent = new AsenqClient({
      onPush: (push) => { if (push.push === "deliver") void agent.request("ack", { msgId: push.msg.id, ok: true }); },
    });
    human = new AsenqClient();
    assert.deepEqual((await agent.request("register", { harness: "omp", key: "alpha-key", name: "alpha" })).session, registered.session);
    const third = (await send(human, "alpha", "third"))[0];
    assert.deepEqual(
      ((await agent.request("inbox", { unread_only: true })).messages as StoredMessage[]).map((message) => message.id),
      [second.msgId, third.msgId],
    );
    assert.deepEqual((await agent.request("inbox", { unread_only: true })).messages, []);
    assert.deepEqual(
      ((await agent.request("inbox")).messages as StoredMessage[]).map((message) => message.id),
      [third.msgId, second.msgId, first.msgId],
    );
    now += 8 * 86_400_000;
    daemon.prune();
    assert.deepEqual((await agent.request("inbox")).messages, []);
    agent.close();
    human.close();
    await daemon.close();
    daemon = new Daemon(options);
    await daemon.listen();
    agent = new AsenqClient({
      onPush: (push) => { if (push.push === "deliver") void agent.request("ack", { msgId: push.msg.id, ok: true }); },
    });
    human = new AsenqClient();
    await agent.request("register", { harness: "omp", key: "alpha-key", name: "alpha" });
    const afterPrune = (await send(human, "alpha", "after prune and reopen"))[0];
    assert.deepEqual(
      ((await agent.request("inbox", { unread_only: true })).messages as StoredMessage[]).map((message) => message.id),
      [afterPrune.msgId],
    );
  } finally {
    agent.close();
    human.close();
    await daemon.close();
    db.close();
    rmSync(home, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.ASENQ_HOME;
    else process.env.ASENQ_HOME = previousHome;
  }
});

test("control action survives database reopen in history, replay and queued delivery", async () => {
  const previousHome = process.env.ASENQ_HOME;
  const home = mkdtempSync(join(tmpdir(), "asenq-control-restart-"));
  process.env.ASENQ_HOME = home;
  let db = await openDb(join(home, "asenq.db"));
  let now = 1_700_000_000_000;
  const options = { socket: socketPath(), replyDir: join(home, "replies"), now: () => now, timers: false, log: () => {} };
  let daemon = new Daemon({ ...options, db });
  const gone = Promise.withResolvers<void>();
  let human = new AsenqClient({
    onPush: (push) => { if (push.push === "event" && isSession("gone", "beta")(push.event)) gone.resolve(); },
  });
  let alpha = new AsenqClient();
  let beta = new AsenqClient();
  try {
    await daemon.listen();
    await alpha.request("register", { harness: "omp", key: "alpha-key", name: "alpha" });
    const registered = await beta.request("register", { harness: "omp", key: "beta-key", name: "beta" });
    const before = await human.sync();
    const [posted] = await send(alpha, "human", "please cancel", { kind: "control", action: "cancel" });
    assert.equal(posted.status, "posted");
    await human.request("set_inbound", { name: "beta", mode: "hold" });
    const [held] = await send(alpha, "beta", "wait after restart", { kind: "control", action: "pause" });
    assert.equal(held.status, "held");
    await human.request("set_inbound", { name: "beta", mode: "accept" });
    await human.request("tail");
    beta.close();
    await gone.promise;
    const [queued] = await send(alpha, "beta", "resume after restart", { kind: "control", action: "resume" });
    assert.equal(queued.status, "queued");
    alpha.close();
    human.close();
    await daemon.close();
    db.close();
    now += 1000;
    db = await openDb(join(home, "asenq.db"));
    daemon = new Daemon({ ...options, db });
    await daemon.listen();
    const recoveredDelivery = Promise.withResolvers<void>();
    human = new AsenqClient({
      onPush: (push) => {
        if (push.push === "event" && isStatus(queued.msgId, "delivered")(push.event)) recoveredDelivery.resolve();
      },
    });
    await human.request("tail");
    alpha = new AsenqClient();
    await alpha.request("register", { harness: "omp", key: "alpha-key", name: "alpha" });
    const deliveries: Delivery[] = [];
    beta = new AsenqClient({
      onPush: (push) => {
        if (push.push !== "deliver") return;
        deliveries.push(push);
        void beta.request("ack", { msgId: push.msg.id, ok: true });
      },
    });
    assert.deepEqual((await beta.request("register", { harness: "omp", key: "beta-key", name: "beta" })).session, registered.session);
    await recoveredDelivery.promise;
    assert.equal((await logOf(human, queued.msgId!)).status, "delivered");
    assert.equal((await human.request("release", { msgId: held.msgId })).status, "delivered");
    assert.deepEqual(deliveries.map((delivery) => [delivery.msg.id, delivery.msg.action]), [[queued.msgId, "resume"], [held.msgId, "pause"]]);
    assert.match(deliveries[0].text, /\[URGENT\].*action=resume/);
    assert.match(deliveries[1].text, /\[URGENT\].*action=pause/);
    const retained = await logOf(human, posted.msgId!);
    assert.deepEqual([retained.kind, retained.action], ["control", "cancel"]);
    const history = await human.historyPage({ scope: "inbox" });
    assert.deepEqual(history.messages.map((message) => [message.id, message.kind, message.action]), [[posted.msgId, "control", "cancel"]]);
    const replay = await human.replay(before.watermark);
    assert.deepEqual(
      replay.events.filter((entry) => entry.event.type === "message" && entry.event.msg.id === posted.msgId)
        .map((entry) => entry.event.type === "message" && [entry.event.status, entry.event.msg.action]),
      [["posted", "cancel"]],
    );
  } finally {
    alpha.close();
    beta.close();
    human.close();
    await daemon.close();
    db.close();
    rmSync(home, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.ASENQ_HOME;
    else process.env.ASENQ_HOME = previousHome;
  }
});
