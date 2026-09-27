import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { claudeFrame, parseEnvelopeReply, replyAddr } from "../src/daemon/claude.js";
import type { AsenqClient } from "../src/shared/client.js";
import { GRACE_MS, type SendResult } from "../src/shared/protocol.js";
import { renderInbound } from "../src/shared/render.js";
import { isSession, isStatus, logOf, startEnv, type TestEnv } from "./helpers.js";

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
