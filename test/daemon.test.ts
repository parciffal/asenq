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
  assert.equal(afterPrune.gap, true);
  assert.ok(afterPrune.eventFloor >= messageEvents.at(-1)!.position);
  const history = await resumed.historyPage({ scope: "session", sessionId: alpha.session.id });
  assert.deepEqual(history, { messages: [], hasMore: false });
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

  await alpha.client.request("channel_send", { channel: "general", text: "initializes stream" });
  await first.request("channel_send", { channel: "general", text: "human post" });
  await alpha.client.request("channel_send", { channel: "general", text: "counts unread" });
  const channel = await first.readState({ scope: "channel", channel: "general" });
  assert.equal(channel.unread, 1);
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
  `);
  db.run(
    `INSERT INTO sessions(id,harness,key,name,cwd,inbound,state,created_at)
     VALUES('s_old','omp','old-key','old-session','/old','accept','live',1)`,
  );
  for (const [id, text] of [["m_old_1", "first"], ["m_old_2", "second"]]) {
    db.run(
      `INSERT INTO messages(
        id,from_name,from_session,to_name,to_session,channel,text,kind,thread,reply_to,
        done,status,reason,attempts,created_at,updated_at)
       VALUES(?,'old-session','s_old','human',NULL,NULL,?,NULL,NULL,NULL,0,'posted',NULL,0,10,10)`,
      id, text,
    );
  }

  const daemon = new Daemon({
    socket: socketPath(),
    db,
    replyDir: join(home, "replies"),
    now: () => 20,
    timers: false,
    log: () => {},
  });
  const client = new AsenqClient();
  try {
    await daemon.listen();
    const page = await client.historyPage({ scope: "inbox" });
    assert.deepEqual(page.messages.map((message: StoredMessage) => [message.id, message.order]), [
      ["m_old_1", 1],
      ["m_old_2", 2],
    ]);
    const state = await client.readState({ scope: "session", sessionId: "s_old" });
    assert.deepEqual([state.position, state.unread], [2, 0]);
  } finally {
    client.close();
    await daemon.close();
    db.close();
    rmSync(home, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.ASENQ_HOME;
    else process.env.ASENQ_HOME = previousHome;
  }
});
