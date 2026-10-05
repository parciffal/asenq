import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";
import { claudeFrame, parseEnvelopeReply, replyAddr } from "../src/daemon/claude.js";
import { Daemon } from "../src/daemon/daemon.js";
import { AsenqClient } from "../src/shared/client.js";
import { socketPath } from "../src/shared/paths.js";
import { GRACE_MS, type SendResult, type StoredMessage, type TailEvent } from "../src/shared/protocol.js";
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

test("registration: different harness ids in the same cwd stay distinct, even when the requested name is gone", async () => {
  env = await startEnv();
  const human = env.human();
  const k1 = await env.adapter("opencode", "k1", "Worker API");
  assert.equal(k1.session.name, "worker-api");
  const k2 = await env.adapter("opencode", "k2", "Worker API");
  assert.equal(k2.session.name, "worker-api-2");
  assert.notEqual(k2.session.id, k1.session.id);

  const gone = await env.watch(isSession("gone", "worker-api"));
  k1.client.close();
  await gone.event;
  const [queued] = await send(human, "worker-api", "while you were away");
  assert.equal(queued.status, "queued");

  const k3 = await env.adapter("opencode", "k3", "Worker API");
  assert.equal(k3.session.name, "worker-api-3");
  assert.notEqual(k3.session.id, k1.session.id);
  assert.equal(await sessionState(human, "worker-api"), "gone");
  assert.equal((await logOf(human, queued.msgId!)).status, "queued");
  assert.deepEqual(k3.deliveries, []);

  const delivered = await env.watch(isStatus(queued.msgId, "delivered"));
  const resumed = await env.adapter("opencode", "k1", "ignored-request");
  assert.deepEqual(resumed.session, k1.session);
  assert.equal((await resumed.nextDelivery()).msg.id, queued.msgId);
  await delivered.event;
  const other = await env.adapter("opencode", "k4", "Worker API", { cwd: "/elsewhere" });
  assert.equal(other.session.name, "worker-api-4");
});

test("human roles validate, publish identity updates and survive rename and gone reconnection", async () => {
  env = await startEnv();
  const human = env.human();
  const alpha = await env.adapter("omp", "alpha-key", "alpha");
  const roleOf = async (name: string) => ((await human.request("list")).sessions as { name: string; role: string | null }[])
    .find((session) => session.name === name)?.role;
  assert.equal(await roleOf("alpha"), null);
  assert.equal((await human.sync()).sessions.find((session) => session.id === alpha.session.id)?.role, null);

  for (const role of ["orchestrator", "worker", null]) {
    const updated: { event: Promise<TailEvent> } = await env.watch(isSession("updated", "alpha"));
    await human.request("set_role", { name: "alpha", role });
    const event: TailEvent = await updated.event;
    assert.equal(event.type === "session" && event.session.role, role);
    assert.equal(await roleOf("alpha"), role);
  }
  for (const role of ["unset", "", "manager", 1, true, {}, []]) {
    await assert.rejects(human.request("set_role", { name: "alpha", role }), { code: "bad_request" });
  }
  await assert.rejects(human.request("set_role", { name: "alpha" }), { code: "bad_request" });
  await assert.rejects(human.request("set_role", { name: "missing", role: "worker" }), { code: "unknown_target" });
  assert.equal(await roleOf("alpha"), null);

  await human.request("set_role", { name: "alpha", role: "orchestrator" });
  await alpha.client.request("rename", { name: "renamed" });
  assert.equal(await roleOf("renamed"), "orchestrator");
  await assert.rejects(human.request("set_role", { name: "alpha", role: "worker" }), { code: "unknown_target" });
  const gone = await env.watch(isSession("gone", "renamed"));
  alpha.client.close();
  await gone.event;
  await human.request("set_role", { name: "renamed", role: "worker" });
  const resumed = await env.adapter("omp", "alpha-key", "renamed");
  assert.equal(resumed.session.id, alpha.session.id);
  assert.equal(await roleOf("renamed"), "worker");

  await resumed.client.request("unregister");
  await assert.rejects(human.request("set_role", { name: "renamed", role: null }), { code: "unknown_target" });
  assert.equal((await human.sync()).sessions.find((session) => session.id === alpha.session.id)?.role, "worker");
  const replacement = await env.adapter("omp", "replacement-key", "renamed");
  assert.notEqual(replacement.session.id, alpha.session.id);
  assert.equal(await roleOf("renamed"), null);
});

test("unset bound and attached agents cannot edit roles, and sender selection cannot become human", async () => {
  env = await startEnv();
  const human = env.human();
  const omp = await env.adapter("omp", "omp-key", "omp");
  const opencode = await env.adapter("opencode", "first-key", "first");
  await opencode.client.request("register", { harness: "opencode", key: "second-key", name: "second" });
  await human.request("claude_hook", { event: "start", key: "sid:claude", sessionId: "claude", name: "claude" });
  const claude = env.human();
  await claude.request("claude_attach", { sessionId: "claude" });
  for (const client of [omp.client, opencode.client, claude]) {
    for (const request of [
      { name: "omp", role: "worker" }, { name: "omp", role: null },
      { name: "missing", role: "invalid" }, {},
    ]) {
      await assert.rejects(client.request("set_role", request), { code: client === opencode.client ? "bad_request" : "not_permitted" });
    }
    await assert.rejects(client.request("set_role", { name: "omp", role: "worker", as: "unbound" }), { code: "bad_request" });
  }
  assert.ok((await human.sync()).sessions.every((session) => session.role === null));
});

test("push headers use the recipient role at delivery time without changing inbound policy", async () => {
  env = await startEnv();
  const human = env.human();
  const sender = await env.adapter("omp", "sender-key", "sender");
  const receiver = await env.adapter("opencode", "receiver-key", "receiver");
  await human.request("set_role", { name: "sender", role: "orchestrator" });
  await human.request("set_role", { name: "receiver", role: "worker" });
  assert.equal((await send(sender.client, "receiver", "ordinary"))[0].status, "delivered");
  assert.match((await receiver.nextDelivery()).text.split("\n")[0], /your-role=worker/);
  await send(receiver.client, "sender", "reverse");
  assert.match((await sender.nextDelivery()).text.split("\n")[0], /your-role=orchestrator/);

  await human.request("set_inbound", { name: "receiver", mode: "hold" });
  const [held] = await send(sender.client, "receiver", "held until role changes");
  assert.equal(held.status, "held");
  await human.request("set_role", { name: "receiver", role: "orchestrator" });
  assert.equal((await logOf(human, held.msgId!)).status, "held");
  assert.equal((await human.request("release", { msgId: held.msgId })).status, "delivered");
  const released = await receiver.nextDelivery();
  assert.equal(released.msg.id, held.msgId);
  assert.match(released.text.split("\n")[0], /your-role=orchestrator/);
  assert.equal((await send(human, "receiver", "human bypasses hold"))[0].status, "delivered");
  await receiver.nextDelivery();

  await human.request("set_inbound", { name: "receiver", mode: "refuse" });
  await human.request("set_role", { name: "receiver", role: null });
  assert.equal((await send(sender.client, "receiver", "still refused"))[0].status, "rejected");
  assert.equal((await send(human, "receiver", "human still refused"))[0].status, "rejected");
  await human.request("set_inbound", { name: "receiver", mode: "accept" });
  await send(sender.client, "receiver", "unset role header");
  assert.doesNotMatch((await receiver.nextDelivery()).text.split("\n")[0], /your-role=/);

  const gone = await env.watch(isSession("gone", "receiver"));
  receiver.client.close();
  await gone.event;
  const [queued] = await send(sender.client, "receiver", "queued before assignment");
  assert.equal(queued.status, "queued");
  await human.request("set_role", { name: "receiver", role: "worker" });
  const resumed = await env.adapter("opencode", "receiver-key", "receiver");
  const delivered = await resumed.nextDelivery();
  assert.equal(delivered.msg.id, queued.msgId);
  assert.match(delivered.text.split("\n")[0], /your-role=worker/);
});

test("Claude plain and envelope delivery headers show the recipient rather than sender role", async () => {
  for (const envelope of [false, true]) {
    env = await startEnv({ envelope });
    const human = env.human();
    const sender = await env.adapter("omp", "sender-key", "sender");
    const socket = join(env.home, "claude.sock");
    const fake = await fakeClaude(socket);
    try {
      await human.request("claude_hook", { event: "start", key: socket, socket, sessionId: "s1", name: "receiver" });
      await human.request("set_role", { name: "sender", role: "orchestrator" });
      await human.request("set_role", { name: "receiver", role: "worker" });
      assert.equal((await send(sender.client, "receiver", "assigned Claude body"))[0].status, "delivered");
      const assigned = JSON.parse(await fake.nextLine()) as { message: { content: string } };
      const header = assigned.message.content.split("\n").find((line) => line.startsWith("[asenq]"));
      assert.match(header!, /your-role=worker/);
      assert.doesNotMatch(header!, /your-role=orchestrator/);
      assert.ok(assigned.message.content.includes("\nassigned Claude body\n"));
      await human.request("set_role", { name: "receiver", role: null });
      await send(sender.client, "receiver", "unset Claude body");
      const unset = JSON.parse(await fake.nextLine()) as { message: { content: string } };
      assert.doesNotMatch(unset.message.content, /your-role=/);
    } finally {
      await fake.stop();
      await env.close();
      env = undefined;
    }
  }
});

test("Claude hook poll renders the current identity role for previously queued messages", async () => {
  env = await startEnv();
  const human = env.human();
  const sender = await env.adapter("omp", "sender-key", "sender");
  await human.request("set_role", { name: "sender", role: "orchestrator" });
  await human.request("claude_hook", { event: "start", key: "sid:s1", sessionId: "s1", name: "receiver" });
  const [queued] = await send(sender.client, "receiver", "before recipient assignment");
  assert.equal(queued.status, "queued");
  await human.request("set_role", { name: "receiver", role: "worker" });
  const assigned = (await human.request("claude_hook", { event: "poll", sessionId: "s1" })).texts as string[];
  assert.equal(assigned.length, 1);
  assert.match(assigned[0].split("\n")[0], /your-role=worker/);
  assert.equal((await logOf(human, queued.msgId!)).status, "delivered");
  await send(sender.client, "receiver", "before recipient unset");
  await human.request("set_role", { name: "receiver", role: null });
  const unset = (await human.request("claude_hook", { event: "poll", sessionId: "s1" })).texts as string[];
  assert.equal(unset.length, 1);
  assert.doesNotMatch(unset[0].split("\n")[0], /your-role=/);
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

test("file references deliver metadata and reading guidance without the file contents", async () => {
  env = await startEnv();
  const alpha = await env.adapter("omp", "file-alpha", "alpha");
  const beta = await env.adapter("omp", "file-beta", "beta");
  const path = join(env.home, "report.txt");
  writeFileSync(path, "abc");
  const summary = "Review the report";
  const sha256 = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
  const result = await alpha.client.request("send", { to: "beta", file: { path, summary } });
  const [sent] = result.results as SendResult[];
  assert.equal(sent.status, "delivered");
  const delivery = await beta.nextDelivery();
  assert.deepEqual(delivery.msg, {
    id: sent.msgId, from: "alpha", to: "beta", text: "", createdAt: env.clock.now(),
    file: { path, summary, sha256, size: 3 },
  });
  assert.ok(delivery.text.includes(summary));
  assert.ok(delivery.text.includes(path));
  assert.match(delivery.text, /3 bytes/);
  assert.ok(delivery.text.includes(sha256.slice(0, 12)));
  assert.ok(delivery.text.includes(`read the file; verify with asenq_file_check id=${sent.msgId}`));
  assert.ok(!delivery.text.includes("\nabc\n"));
  const retained = await beta.client.request("inbox", { msgId: sent.msgId });
  assert.deepEqual((retained.messages as Record<string, unknown>[])[0].file, { path, summary, sha256, size: 3 });
});

test("file checks compare send-time bytes and report missing for removed or non-regular paths", async () => {
  env = await startEnv();
  const alpha = await env.adapter("omp", "file-alpha", "alpha");
  const beta = await env.adapter("omp", "file-beta", "beta");
  const path = join(env.home, "report.txt");
  writeFileSync(path, "abc");
  const [sent] = await send(alpha.client, "beta", "Please review", { file: { path, summary: "Report" } });
  assert.equal((await alpha.client.request("file_check", { msgId: sent.msgId })).status, "match");
  assert.equal((await beta.client.request("file_check", { msgId: sent.msgId })).status, "match");
  writeFileSync(path, "abd");
  assert.equal((await beta.client.request("file_check", { msgId: sent.msgId })).status, "changed");
  const retained = (await beta.client.request("inbox", { msgId: sent.msgId })).messages as StoredMessage[];
  assert.equal(retained[0].file?.sha256, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(retained[0].file?.size, 3);
  rmSync(path);
  assert.equal((await beta.client.request("file_check", { msgId: sent.msgId })).status, "missing");
  execFileSync("mkfifo", [path]);
  assert.equal((await beta.client.request("file_check", { msgId: sent.msgId })).status, "missing");
  rmSync(path);
  mkdirSync(path);
  assert.equal((await beta.client.request("file_check", { msgId: sent.msgId })).status, "missing");
  await assert.rejects(alpha.client.request("file_check", { msgId: "m_absent" }), { code: "bad_request" });
});

test("Claude polling retains file metadata when text or thread exceeds the delivery budget", async () => {
  env = await startEnv();
  const human = env.human();
  await human.request("claude_hook", { event: "start", key: "file-poll", sessionId: "file-poll", name: "orch" });
  await human.request("set_role", { name: "orch", role: "worker" });
  const path = join(env.home, "report.txt");
  writeFileSync(path, "abc");
  const receiver = env.human();
  await receiver.request("claude_attach", { sessionId: "file-poll" });
  for (const thread of [undefined, "t".repeat(20_000)]) {
    const text = "long body ".repeat(2000);
    const [sent] = await send(human, "orch", text, { thread, file: { path, summary: "Review report" } });
    const texts = (await human.request("claude_hook", { event: "poll", sessionId: "file-poll" })).texts as string[];
    assert.ok(texts[0].split("\n")[0].includes("your-role=worker"));
    assert.ok(texts[0].includes("Review report"));
    assert.ok(texts[0].includes(path));
    assert.ok(texts[0].includes("3 bytes"));
    assert.ok(texts[0].includes("ba7816bf8f01"));
    assert.ok(texts[0].includes(`asenq_file_check id=${sent.msgId}`));
    assert.ok(texts[0].includes(`asenq_inbox id=${sent.msgId}`));
    assert.equal((await logOf(human, sent.msgId!)).status, "delivered");
    const retained = (await receiver.request("inbox", { msgId: sent.msgId })).messages as StoredMessage[];
    assert.equal(retained[0].text, text);
    assert.equal(retained[0].file?.path, path);
  }
});

test("file references reject malformed metadata and paths, including FIFOs without blocking", async () => {
  env = await startEnv();
  const human = env.human();
  const path = join(env.home, "report.txt");
  const fifo = join(env.home, "fifo");
  writeFileSync(path, "abc");
  execFileSync("mkfifo", [fifo]);
  for (const file of [
    null, "report.txt", [], 1, {}, { path }, { summary: "Report" },
    { path: 1, summary: "Report" }, { path, summary: 1 },
    { path: "relative.txt", summary: "Report" },
    { path: join(env.home, "absent.txt"), summary: "Report" },
    { path: env.home, summary: "Report" }, { path: fifo, summary: "Report" },
    { path: "/dev/zero", summary: "Report" }, { path: "/dev/random", summary: "Report" },
    { path: socketPath(), summary: "Report" },
    { path, summary: "" }, { path, summary: " " }, { path, summary: "x".repeat(501) },
  ]) {
    await assert.rejects(human.request("send", { to: "human", file }), { code: "bad_request" });
  }
  for (const text of [undefined, "", 1]) {
    await assert.rejects(human.request("send", { to: "human", text }), { code: "bad_request" });
  }
  const result = await human.request("send", { to: "human", file: { path, summary: "x".repeat(500) } });
  const [sent] = result.results as SendResult[];
  assert.equal((await human.request("file_check", { msgId: sent.msgId })).status, "match");
  assert.deepEqual(((await human.request("inbox")).messages as StoredMessage[]).map((m) => m.id), [sent.msgId]);
  writeFileSync(path, "é");
  const unicode = (await human.request("send", { to: "human", file: { path, summary: "UTF-8 report" } })).results as SendResult[];
  const unicodeMessage = ((await human.request("inbox", { msgId: unicode[0].msgId })).messages as StoredMessage[])[0];
  assert.equal(unicodeMessage.file?.size, 2);
});

test("unreadable file sends fail and retained references report missing", { skip: process.getuid?.() === 0 }, async () => {
  env = await startEnv();
  const human = env.human();
  const path = join(env.home, "report.txt");
  writeFileSync(path, "abc");
  const [sent] = (await human.request("send", { to: "human", file: { path, summary: "Report" } })).results as SendResult[];
  chmodSync(path, 0);
  try {
    await assert.rejects(human.request("send", { to: "human", file: { path, summary: "Report" } }), {
      code: "bad_request", message: /cannot read regular file/,
    });
    assert.equal((await human.request("file_check", { msgId: sent.msgId })).status, "missing");
  } finally {
    chmodSync(path, 0o600);
  }
});

test("file checks enforce exact direct-message identity and shared-connection selectors", async () => {
  env = await startEnv();
  const human = env.human();
  const alpha = await env.adapter("omp", "file-alpha", "alpha");
  const beta = await env.adapter("omp", "file-beta", "beta");
  const stranger = await env.adapter("omp", "file-stranger", "stranger");
  const path = join(env.home, "report.txt");
  writeFileSync(path, "abc");
  const file = { path, summary: "Report" };
  const [sent] = await send(alpha.client, "beta", "", { file });
  for (const client of [stranger.client, human]) {
    await assert.rejects(client.request("file_check", { msgId: sent.msgId }), { code: "bad_request" });
  }
  const [posted] = await send(alpha.client, "human", "", { file });
  assert.equal((await human.request("file_check", { msgId: posted.msgId })).status, "match");
  await assert.rejects(beta.client.request("file_check", { msgId: posted.msgId }), { code: "bad_request" });
  const [fromHuman] = await send(human, "beta", "", { file });
  assert.equal((await human.request("file_check", { msgId: fromHuman.msgId })).status, "match");
  assert.equal((await beta.client.request("file_check", { msgId: fromHuman.msgId })).status, "match");
  const shared = env.human();
  await shared.request("register", { harness: "omp", key: "file-alpha", name: "alpha" });
  await shared.request("register", { harness: "omp", key: "file-stranger", name: "stranger" });
  await assert.rejects(shared.request("file_check", { msgId: sent.msgId }), { code: "bad_request", message: /"as" is required/ });
  assert.equal((await shared.request("file_check", { msgId: sent.msgId, as: alpha.session.id })).status, "match");
  await assert.rejects(shared.request("file_check", { msgId: sent.msgId, as: stranger.session.id }), { code: "bad_request" });
  await assert.rejects(shared.request("file_check", { msgId: sent.msgId, as: beta.session.id }), { code: "bad_request", message: /not bound/ });
  await human.request("set_inbound", { name: "beta", mode: "hold" });
  const [held] = await send(shared, "beta", "held", { file, as: alpha.session.id });
  assert.equal(held.status, "held");
  assert.equal((await shared.request("file_check", { msgId: held.msgId, as: alpha.session.id })).status, "match");
  await assert.rejects(beta.client.request("file_check", { msgId: held.msgId }), { code: "bad_request" });
  await human.request("release", { msgId: held.msgId });
  assert.equal((await beta.client.request("file_check", { msgId: held.msgId })).status, "match");
  await beta.client.request("unregister");
  const replacement = await env.adapter("omp", "replacement-beta", "beta");
  await assert.rejects(replacement.client.request("file_check", { msgId: sent.msgId }), { code: "bad_request" });
  const [plain] = await send(human, "human", "legacy text");
  await assert.rejects(human.request("file_check", { msgId: plain.msgId }), { code: "bad_request" });
});

test("duplicate detection distinguishes reference path, summary, hash and control action", async () => {
  env = await startEnv();
  const alpha = await env.adapter("omp", "file-alpha", "alpha");
  const beta = await env.adapter("omp", "file-beta", "beta");
  const path = join(env.home, "report.txt");
  const otherPath = join(env.home, "other.txt");
  writeFileSync(path, "abc");
  writeFileSync(otherPath, "abc");
  const file = { path, summary: "Report" };
  const first = (await send(alpha.client, "beta", "", { file }))[0];
  assert.equal(first.status, "delivered");
  const duplicate = (await send(alpha.client, "beta", "", { file }))[0];
  assert.deepEqual([duplicate.status, duplicate.reason], ["dropped", "duplicate"]);
  for (const reference of [{ path: otherPath, summary: "Report" }, { path, summary: "Updated report" }]) {
    assert.equal((await send(alpha.client, "beta", "", { file: reference }))[0].status, "delivered");
  }
  writeFileSync(path, "abd");
  assert.equal((await send(alpha.client, "beta", "", { file }))[0].status, "delivered");
  for (const action of ["pause", "resume"]) {
    assert.equal((await send(alpha.client, "beta", "", { file, kind: "control", action }))[0].status, "delivered");
  }
  assert.deepEqual(beta.deliveries.map((delivery) => [delivery.msg.file?.path, delivery.msg.file?.summary, delivery.msg.action]), [
    [path, "Report", undefined], [otherPath, "Report", undefined], [path, "Updated report", undefined],
    [path, "Report", undefined], [path, "Report", "pause"], [path, "Report", "resume"],
  ]);
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

test("held bodies are user-only for both complete and name-filtered requests", async () => {
  env = await startEnv();
  const human = env.human();
  const agent = await env.adapter("omp", "held-guard-agent", "alpha");
  await env.adapter("omp", "held-guard-target", "beta");
  await human.request("set_inbound", { name: "beta", mode: "hold" });
  const [held] = await send(agent.client, "beta", "waiting for user approval");
  for (const params of [{}, { name: "beta" }]) {
    await assert.rejects(agent.client.request("held", params), {
      code: "bad_request", message: /only the user/,
    });
  }
  assert.deepEqual(
    ((await human.request("held", { name: "beta" })).messages as StoredMessage[]).map(({ id, status }) => [id, status]),
    [[held.msgId, "held"]],
  );
});

test("held payload keeps stable target identity across rename and exposes oldest-first order", async () => {
  env = await startEnv();
  const human = env.human();
  const sender = await env.adapter("omp", "held-shape-sender", "alpha");
  const target = await env.adapter("omp", "held-shape-target", "beta");
  await human.request("set_inbound", { name: "beta", mode: "hold" });
  const [first] = await send(sender.client, "beta", "before rename");
  await human.request("rename", { from: "beta", name: "renamed" });
  const [second] = await send(sender.client, "renamed", "after rename");

  const held = (await human.request("held")).messages as StoredMessage[];
  assert.deepEqual(held.map(({ id, fromSessionId, toSessionId, status }) => ({
    id, fromSessionId, toSessionId, status,
  })), [first, second].map(({ msgId }) => ({
    id: msgId, fromSessionId: sender.session.id, toSessionId: target.session.id, status: "held",
  })));
  assert.deepEqual(held.map(({ to }) => to), ["beta", "renamed"]);
  assert.ok(Number.isSafeInteger(held[0].order) && held[0].order > 0);
  assert.ok(held[1].order > held[0].order, "oldest-first selection uses durable storage order");
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

test("grace expiry removes the transport but preserves the queue without a delivery-failure notice", async () => {
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
  assert.equal(await sessionState(human, "beta"), "gone");
  env.clock.advance(1);
  env.daemon.sweep();
  assert.equal((await logOf(human, r.msgId!)).status, "queued");
  assert.equal(await sessionState(human, "beta"), undefined);
  assert.equal((await human.sync()).sessions.find((session) => session.id === b.session.id)?.state, "removed");
  assert.deepEqual(a.deliveries, []);

  const delivered = await env.watch(isStatus(r.msgId, "delivered"));
  const resumed = await env.adapter("omp", "b", "different-request");
  assert.deepEqual(resumed.session, b.session);
  assert.equal((await resumed.nextDelivery()).msg.id, r.msgId);
  await delivered.event;
  assert.equal((await logOf(human, r.msgId!)).status, "delivered");
  assert.deepEqual(a.deliveries, []);
});

test("Claude live resume recognizes the session id before a changed process key and keeps its renamed queue", async () => {
  env = await startEnv();
  const human = env.human();
  const first = (await human.request("claude_hook", {
    event: "start", key: "process1", socket: null, sessionId: "A", name: "claude-original", cwd: "/work",
  })).session as { id: string; name: string };
  const attached = env.human();
  await attached.request("claude_attach", { sessionId: "A" });
  await attached.request("rename", { name: "niche-manager" });
  const [queued] = await send(human, "niche-manager", "saved for the resumed conversation");
  assert.equal(queued.status, "queued");

  const resumed = (await human.request("claude_hook", {
    event: "start", key: "process2", socket: null, sessionId: "A", name: "different-request", cwd: "/work",
  })).session as { id: string; name: string };
  assert.deepEqual(resumed, { id: first.id, name: "niche-manager" });
  const texts = (await human.request("claude_hook", { event: "poll", sessionId: "A" })).texts as string[];
  assert.equal(texts.length, 1);
  assert.match(texts[0], /saved for the resumed conversation/);
  assert.equal((await logOf(human, queued.msgId!)).status, "delivered");
  assert.deepEqual((await human.historyPage({ scope: "session", sessionId: first.id })).messages.map(
    (message) => [message.id, message.toSessionId, message.status],
  ), [[queued.msgId, first.id, "delivered"]]);
  assert.deepEqual((await human.request("claude_hook", { event: "poll", sessionId: "A" })).texts, []);
});

const originalClaudeTranscript = fileURLToPath(new URL("../../test/fixtures/claude-lineage-original.jsonl", import.meta.url));
const resumedClaudeTranscript = fileURLToPath(new URL("../../test/fixtures/claude-lineage-resumed.jsonl", import.meta.url));
const originalClaudeId = "8dab0f9b-86f5-4bdb-a8d7-d3771dd75179";
const resumedClaudeId = "5caef88d-869b-41cd-990c-83f2032f0856";

test("Claude real resume lineage keeps the renamed identity and queued delivery across new session and process ids", async () => {
  env = await startEnv();
  const human = env.human();
  const first = (await human.request("claude_hook", {
    event: "start", key: "original-process", socket: null, sessionId: originalClaudeId,
    transcriptPath: originalClaudeTranscript, source: "startup", name: "claude-original",
  })).session as { id: string; name: string };
  await human.request("rename", { from: first.name, name: "niche-manager" });
  const [queued] = await send(human, "niche-manager", "saved across real Claude resume");
  assert.equal(queued.status, "queued");
  await human.request("claude_hook", { event: "end", sessionId: originalClaudeId });

  const resumed = (await human.request("claude_hook", {
    event: "start", key: "resumed-process", socket: null, sessionId: resumedClaudeId,
    transcriptPath: resumedClaudeTranscript, source: "resume", name: "claude-resumed",
  })).session as { id: string; name: string };
  assert.deepEqual(resumed, { id: first.id, name: "niche-manager" });
  const texts = (await human.request("claude_hook", { event: "poll", sessionId: resumedClaudeId })).texts as string[];
  assert.equal(texts.length, 1);
  assert.match(texts[0], /saved across real Claude resume/);
  assert.equal((await logOf(human, queued.msgId!)).status, "delivered");
  assert.deepEqual((await human.historyPage({ scope: "session", sessionId: first.id })).messages.map(
    (message) => [message.id, message.toSessionId, message.status],
  ), [[queued.msgId, first.id, "delivered"]]);
  assert.deepEqual((await human.request("claude_hook", { event: "poll", sessionId: resumedClaudeId })).texts, []);
});

test("Claude overlapping live lineage is a fork and cannot later steal the original queue", async () => {
  env = await startEnv();
  const human = env.human();
  const original = (await human.request("claude_hook", {
    event: "start", key: "original-process", sessionId: originalClaudeId, name: "original",
    transcriptPath: originalClaudeTranscript, source: "startup",
  })).session as { id: string; name: string };
  const [originalQueue] = await send(human, original.name, "belongs only to the original");
  const fork = (await human.request("claude_hook", {
    event: "start", key: "fork-process", sessionId: resumedClaudeId, name: "fork",
    transcriptPath: resumedClaudeTranscript, source: "resume",
  })).session as { id: string; name: string };
  assert.notEqual(fork.id, original.id);
  const [forkQueue] = await send(human, fork.name, "belongs only to the fork");
  await human.request("claude_hook", { event: "end", sessionId: originalClaudeId });
  const texts = (await human.request("claude_hook", {
    event: "poll", sessionId: resumedClaudeId, transcriptPath: resumedClaudeTranscript,
  })).texts as string[];
  assert.equal(texts.length, 1);
  assert.match(texts[0], /belongs only to the fork/);
  assert.equal((await logOf(human, originalQueue.msgId!)).status, "queued");
  assert.equal((await logOf(human, forkQueue.msgId!)).status, "delivered");
  assert.deepEqual((await env.human().request("claude_attach", { sessionId: resumedClaudeId })).session, fork);

  const third = (await human.request("claude_hook", {
    event: "start", key: "third-process", sessionId: "third", name: "third",
    transcriptPath: originalClaudeTranscript, source: "resume",
  })).session as { id: string; name: string };
  assert.notEqual(third.id, original.id);
  assert.notEqual(third.id, fork.id);
  assert.deepEqual((await human.request("claude_hook", { event: "poll", sessionId: "third" })).texts, []);
  assert.equal((await logOf(human, originalQueue.msgId!)).status, "queued");
});

test("Claude ambiguous offline lineage creates a new identity and reports every candidate without moving their queues", async () => {
  const logs: string[] = [];
  env = await startEnv({ log: (line) => logs.push(line) });
  const human = env.human();
  const candidates: { id: string; name: string }[] = [];
  const queues: SendResult[] = [];
  for (const [sessionId, transcriptPath, name] of [
    [originalClaudeId, originalClaudeTranscript, "original"],
    [resumedClaudeId, resumedClaudeTranscript, "fork"],
  ]) {
    const candidate = (await human.request("claude_hook", {
      event: "start", key: name + "-process", sessionId, transcriptPath, name, source: "resume",
    })).session as { id: string; name: string };
    candidates.push(candidate);
    queues.push((await send(human, candidate.name, "queue for " + name))[0]);
  }
  assert.notEqual(candidates[0].id, candidates[1].id);
  await human.request("claude_hook", { event: "end", sessionId: originalClaudeId });
  await human.request("claude_hook", { event: "end", sessionId: resumedClaudeId });
  const ambiguousPath = join(env.home, "ambiguous.jsonl");
  writeFileSync(ambiguousPath, readFileSync(resumedClaudeTranscript, "utf8"));
  const registered = await env.watch(isSession("registered", "ambiguous"));
  const fresh = (await human.request("claude_hook", {
    event: "start", key: "ambiguous-process", sessionId: "ambiguous", name: "ambiguous",
    transcriptPath: ambiguousPath, source: "resume",
  })).session as { id: string; name: string };
  assert.ok(candidates.every((candidate) => candidate.id !== fresh.id));
  const event = await registered.event;
  assert.equal(event.type, "session");
  if (event.type !== "session") assert.fail("expected session event");
  for (const candidate of candidates) {
    assert.ok(event.reason?.includes(candidate.id), "registration reason includes candidate " + candidate.id);
  }
  assert.ok(logs.some((line) => candidates.every((candidate) => line.includes(candidate.id))));
  writeFileSync(ambiguousPath, '{"type":"file-history-snapshot","messageId":"c3107927-0b2d-4dca-b85c-78e3b06af72d"}\n');
  assert.deepEqual((await human.request("claude_hook", {
    event: "poll", sessionId: "ambiguous", transcriptPath: ambiguousPath,
  })).texts, []);
  assert.deepEqual((await env.human().request("claude_attach", { sessionId: "ambiguous" })).session, fresh);
  for (const queued of queues) assert.equal((await logOf(human, queued.msgId!)).status, "queued");
});

for (const timing of ["start", "later hook"] as const) {
  test(`Claude partial resume head at ${timing} cannot select a fork before the complete head is ambiguous`, async () => {
    const logs: string[] = [];
    env = await startEnv({ log: (line) => logs.push(line) });
    const human = env.human();
    const original = (await human.request("claude_hook", {
      event: "start", key: "original", sessionId: "original", name: "original",
      transcriptPath: originalClaudeTranscript, source: "startup",
    })).session as { id: string; name: string };
    const fork = (await human.request("claude_hook", {
      event: "start", key: "fork", sessionId: "fork", name: "fork",
      transcriptPath: resumedClaudeTranscript, source: "resume",
    })).session as { id: string; name: string };
    const queues = [
      (await send(human, original.name, "original's waiting message"))[0],
      (await send(human, fork.name, "fork's waiting message"))[0],
    ];
    await human.request("claude_hook", { event: "end", sessionId: "original" });
    await human.request("claude_hook", { event: "end", sessionId: "fork" });
    const fullHead = readFileSync(resumedClaudeTranscript, "utf8");
    const partialHead = fullHead.split("\n").slice(0, 6).join("\n") + "\n";
    const path = join(env.home, "growing.jsonl");
    if (timing === "start") writeFileSync(path, partialHead);
    const provisional = (await human.request("claude_hook", {
      event: "start", key: "provisional", sessionId: "provisional", name: "provisional",
      transcriptPath: path, source: "resume",
    })).session as { id: string; name: string };
    assert.notEqual(provisional.id, original.id);
    assert.notEqual(provisional.id, fork.id);
    writeFileSync(path, partialHead);
    assert.deepEqual((await human.request("claude_hook", {
      event: "poll", sessionId: "provisional", transcriptPath: path,
    })).texts, []);
    writeFileSync(path, fullHead);
    assert.deepEqual((await human.request("claude_hook", {
      event: "poll", sessionId: "provisional", transcriptPath: path,
    })).texts, []);
    assert.deepEqual((await env.human().request("claude_attach", { sessionId: "provisional" })).session, provisional);
    for (const queued of queues) assert.equal((await logOf(human, queued.msgId!)).status, "queued");
    assert.ok(logs.some((line) => line.includes(original.id) && line.includes(fork.id)));
    assert.ok((await human.replay(0)).events.some(({ event }) => event.type === "session"
      && event.action === "registered" && event.reason?.includes(original.id) && event.reason.includes(fork.id)));
  });
}

test("Claude three-line original resume stays provisional until eight complete head lines arrive", async () => {
  env = await startEnv();
  const human = env.human();
  const originalPath = join(env.home, "short-original.jsonl");
  const resumedPath = join(env.home, "short-resumed.jsonl");
  const shortHead = '{"type":"mode"}\n{"type":"user","uuid":"short-user"}\n{"type":"assistant","uuid":"short-reply"}\n';
  writeFileSync(originalPath, shortHead);
  const original = (await human.request("claude_hook", {
    event: "start", key: "short-original", sessionId: "short-original", name: "niche-manager",
    transcriptPath: originalPath, source: "startup",
  })).session as { id: string; name: string };
  const [queued] = await send(human, original.name, "waiting for a complete copied head");
  await human.request("claude_hook", { event: "end", sessionId: "short-original" });
  writeFileSync(resumedPath, shortHead);
  const provisional = (await human.request("claude_hook", {
    event: "start", key: "short-resumed", sessionId: "short-resumed", name: "temporary",
    transcriptPath: resumedPath, source: "resume",
  })).session as { id: string; name: string };
  assert.notEqual(provisional.id, original.id);
  assert.deepEqual((await human.request("claude_hook", {
    event: "poll", sessionId: "short-resumed", transcriptPath: resumedPath,
  })).texts, []);
  assert.equal((await logOf(human, queued.msgId!)).status, "queued");
  writeFileSync(resumedPath, shortHead + Array.from({ length: 6 }, (_, index) =>
    JSON.stringify({ type: "attachment", uuid: `new-entry-${index}` }) + "\n").join(""));
  assert.deepEqual((await env.human().request("claude_attach", { sessionId: "short-resumed" })).session, original);
  const texts = (await human.request("claude_hook", { event: "poll", sessionId: "short-resumed" })).texts as string[];
  assert.match(texts[0], /waiting for a complete copied head/);
  assert.equal((await logOf(human, queued.msgId!)).status, "delivered");
  assert.ok(!(await human.sync()).sessions.some((session) => session.id === provisional.id));
});

for (const timing of ["start", "later hook"] as const) {
  test(`Claude complete unmatched resume head at ${timing} stays its own identity after a later fork ends`, async () => {
    env = await startEnv();
    const human = env.human();
    const path = timing === "start" ? originalClaudeTranscript : join(env.home, "initially-missing.jsonl");
    const original = (await human.request("claude_hook", {
      event: "start", key: "root-process", sessionId: "root", name: "root",
      transcriptPath: path, source: "resume",
    })).session as { id: string; name: string };
    if (timing === "later hook") {
      writeFileSync(path, readFileSync(originalClaudeTranscript, "utf8"));
      await human.request("claude_hook", { event: "reconcile", sessionId: "root", transcriptPath: path });
    }
    const [originalQueue] = await send(human, original.name, "belongs to the root");
    const fork = (await human.request("claude_hook", {
      event: "start", key: "fork-process", sessionId: "fork", name: "fork",
      transcriptPath: resumedClaudeTranscript, source: "resume",
    })).session as { id: string; name: string };
    assert.notEqual(fork.id, original.id);
    const [forkQueue] = await send(human, fork.name, "belongs only to the fork");
    await human.request("claude_hook", { event: "end", sessionId: "fork" });
    const texts = (await human.request("claude_hook", {
      event: "poll", sessionId: "root", transcriptPath: path,
    })).texts as string[];
    assert.equal(texts.length, 1);
    assert.match(texts[0], /belongs to the root/);
    assert.deepEqual((await env.human().request("claude_attach", { sessionId: "root" })).session, original);
    assert.equal((await logOf(human, originalQueue.msgId!)).status, "delivered");
    assert.equal((await logOf(human, forkQueue.msgId!)).status, "queued");
    const snapshot = await human.sync();
    assert.equal(snapshot.sessions.find((session) => session.id === original.id)?.name, "root");
    assert.equal(snapshot.sessions.find((session) => session.id === fork.id)?.state, "removed");
  });
}

test("Claude chained lineage unions old and new fingerprints durably across daemon reopen", async () => {
  env = await startEnv();
  let human = env.human();
  const original = (await human.request("claude_hook", {
    event: "start", key: "original-process", sessionId: originalClaudeId, name: "niche-manager",
    transcriptPath: originalClaudeTranscript, source: "startup",
  })).session as { id: string; name: string };
  await human.request("claude_hook", { event: "end", sessionId: originalClaudeId });
  assert.deepEqual((await human.request("claude_hook", {
    event: "start", key: "resumed-process", sessionId: resumedClaudeId,
    transcriptPath: resumedClaudeTranscript, source: "resume",
  })).session, original);
  const [queued] = await send(human, original.name, "survives chained resume and reopen");
  await human.request("claude_hook", { event: "end", sessionId: resumedClaudeId });
  await env.restart();
  human = env.human();
  const chainPath = join(env.home, "chain.jsonl");
  writeFileSync(chainPath, '{"type":"file-history-snapshot","messageId":"c3107927-0b2d-4dca-b85c-78e3b06af72d"}\n' + "{}\n".repeat(7));
  assert.deepEqual((await human.request("claude_hook", {
    event: "start", key: "third-process", sessionId: "third", transcriptPath: chainPath, source: "resume",
  })).session, original);
  const texts = (await human.request("claude_hook", { event: "poll", sessionId: "third" })).texts as string[];
  assert.equal(texts.length, 1);
  assert.match(texts[0], /survives chained resume and reopen/);
  assert.equal((await logOf(human, queued.msgId!)).status, "delivered");
  await human.request("claude_hook", { event: "end", sessionId: "third" });
  writeFileSync(chainPath, '{"type":"attachment","uuid":"7206c438-04ba-4b22-9553-1587dad1be33"}\n' + "{}\n".repeat(7));
  assert.deepEqual((await human.request("claude_hook", {
    event: "start", key: "fourth-process", sessionId: "fourth", transcriptPath: chainPath, source: "resume",
  })).session, original);
});

for (const initialHead of ["missing", "empty", "new hook only"] as const) {
  for (const reconciliation of ["poll", "attach"] as const) {
    test(`Claude late ${reconciliation} after ${initialHead} SessionStart merges provisional queues, history, mappings and bindings`, async () => {
      env = await startEnv();
      const human = env.human();
      const sender = await env.adapter("omp", "sender", "sender");
      const ancestor = (await human.request("claude_hook", {
        event: "start", key: "original-process", sessionId: originalClaudeId, name: "original",
        transcriptPath: originalClaudeTranscript, source: "startup",
      })).session as { id: string; name: string };
      await human.request("rename", { from: ancestor.name, name: "niche-manager" });
      await human.request("set_inbound", { name: "niche-manager", mode: "hold" });
      const [held] = await send(sender.client, "niche-manager", "ancestor held decision");
      const [oldQueue] = await send(human, "niche-manager", "ancestor queued message");
      await human.request("claude_hook", { event: "end", sessionId: originalClaudeId });

      const latePath = join(env.home, "late.jsonl");
      if (initialHead === "empty") writeFileSync(latePath, "");
      if (initialHead === "new hook only") {
        writeFileSync(latePath, '{"type":"attachment","uuid":"new-session-start-hook"}\n');
      }
      const provisional = (await human.request("claude_hook", {
        event: "start", key: "resumed-process", sessionId: resumedClaudeId, name: "provisional",
        transcriptPath: latePath, source: "resume",
      })).session as { id: string; name: string };
      assert.notEqual(provisional.id, ancestor.id);
      const bound = env.human();
      assert.deepEqual((await bound.request("claude_attach", { sessionId: resumedClaudeId })).session, provisional);
      const [newQueue] = await send(human, provisional.name, "provisional queued message");
      const [outgoing] = await send(bound, "human", "provisional history for human");
      assert.deepEqual([held.status, oldQueue.status, newQueue.status, outgoing.status], ["held", "queued", "queued", "posted"]);
      await human.request("set_inbound", { name: provisional.name, mode: "refuse" });
      writeFileSync(latePath, readFileSync(resumedClaudeTranscript, "utf8"));
      const removed = await env.watch(isSession("removed", provisional.name));

      let texts: string[];
      if (reconciliation === "attach") {
        assert.deepEqual((await env.human().request("claude_attach", { sessionId: resumedClaudeId })).session, {
          id: ancestor.id, name: "niche-manager",
        });
        texts = (await human.request("claude_hook", { event: "poll", sessionId: resumedClaudeId })).texts as string[];
      } else {
        texts = (await human.request("claude_hook", {
          event: "poll", sessionId: resumedClaudeId, transcriptPath: latePath,
        })).texts as string[];
      }
      assert.equal(texts.length, 2);
      assert.match(texts[0], /ancestor queued message/);
      assert.match(texts[1], /provisional queued message/);
      const removedEvent = await removed.event;
      assert.equal(removedEvent.type, "session");
      if (removedEvent.type !== "session") assert.fail("expected removal event");
      assert.equal(removedEvent.reason, "merged into niche-manager");
      const snapshot = await human.sync();
      assert.equal(snapshot.sessions.some((session) => session.id === provisional.id), false);
      const revived = snapshot.sessions.find((session) => session.id === ancestor.id)!;
      assert.deepEqual([revived.name, revived.inbound, revived.state, revived.previousNames], [
        "niche-manager", "hold", "live", ["original", "provisional"],
      ]);
      for (const sessionId of [originalClaudeId, resumedClaudeId]) {
        assert.deepEqual((await env.human().request("claude_attach", { sessionId })).session, {
          id: ancestor.id, name: "niche-manager",
        });
      }
      assert.equal(((await bound.request("list")).sessions as { name: string; you: boolean }[]).find((session) => session.you)?.name, "niche-manager");
      assert.deepEqual((await human.historyPage({ scope: "session", sessionId: ancestor.id })).messages.map(
        (message) => [message.id, message.fromSessionId, message.toSessionId, message.status],
      ), [
        [held.msgId, sender.session.id, ancestor.id, "held"],
        [oldQueue.msgId, undefined, ancestor.id, "delivered"],
        [newQueue.msgId, undefined, ancestor.id, "delivered"],
        [outgoing.msgId, ancestor.id, undefined, "posted"],
      ]);
      assert.deepEqual((await human.request("claude_hook", { event: "poll", sessionId: resumedClaudeId })).texts, []);
      assert.equal((await human.request("release", { msgId: held.msgId })).status, "queued");
      const released = (await human.request("claude_hook", { event: "poll", sessionId: resumedClaudeId })).texts as string[];
      assert.equal(released.length, 1);
      assert.match(released[0], /ancestor held decision/);
    });
  }
}

for (const initialHead of ["missing", "empty", "new hook only"] as const) {
  test(`Claude socket late reconciliation after ${initialHead} transfers ancestor delivery without polling twice`, async () => {
    env = await startEnv();
    const human = env.human();
    const ancestor = (await human.request("claude_hook", {
      event: "start", key: "original-process", sessionId: originalClaudeId, name: "niche-manager",
      transcriptPath: originalClaudeTranscript, source: "startup",
    })).session as { id: string; name: string };
    const [oldQueue] = await send(human, ancestor.name, "ancestor socket delivery");
    await human.request("claude_hook", { event: "end", sessionId: originalClaudeId });
    const latePath = join(env.home, "late-socket.jsonl");
    if (initialHead === "empty") writeFileSync(latePath, "");
    if (initialHead === "new hook only") writeFileSync(latePath, '{"type":"attachment","uuid":"new-hook"}\n');
    const sock = join(env.home, "claude.sock");
    const fake = await fakeClaude(sock);
    try {
      const provisional = (await human.request("claude_hook", {
        event: "start", key: sock, socket: sock, sessionId: resumedClaudeId, name: "provisional",
        transcriptPath: latePath, source: "resume",
      })).session as { id: string; name: string };
      assert.notEqual(provisional.id, ancestor.id);
      const [alreadyDelivered] = await send(human, provisional.name, "delivered before lineage");
      assert.equal(alreadyDelivered.status, "delivered");
      assert.match(await fake.nextLine(), /delivered before lineage/);
      writeFileSync(latePath, readFileSync(resumedClaudeTranscript, "utf8"));
      const delivered = await env.watch(isStatus(oldQueue.msgId, "delivered"));
      await human.request("claude_hook", {
        event: "reconcile", sessionId: resumedClaudeId, transcriptPath: latePath,
      });
      assert.match(await fake.nextLine(), /ancestor socket delivery/);
      await delivered.event;
      assert.equal((await logOf(human, oldQueue.msgId!)).status, "delivered");
      assert.deepEqual((await human.request("claude_hook", {
        event: "poll", sessionId: resumedClaudeId, transcriptPath: latePath,
      })).texts, []);
      await env.daemon.retry();
      assert.equal(fake.lines.length, 2);
      assert.deepEqual((await env.human().request("claude_attach", { sessionId: resumedClaudeId })).session, ancestor);
      assert.deepEqual((await human.historyPage({ scope: "session", sessionId: ancestor.id })).messages.map(
        (message) => [message.id, message.toSessionId, message.status],
      ), [[oldQueue.msgId, ancestor.id, "delivered"], [alreadyDelivered.msgId, ancestor.id, "delivered"]]);
    } finally {
      await fake.stop();
    }
  });
}

for (const largerMarker of ["ancestor", "provisional"] as const) {
  for (const reminders of ["ancestor", "provisional", "both"] as const) {
    test(`Claude late merge keeps MAX ${largerMarker} human read position and ${reminders} reminders`, async () => {
      const logs: string[] = [];
      env = await startEnv({ log: (line) => logs.push(line) });
      const human = env.human();
      const ancestor = (await human.request("claude_hook", {
        event: "start", key: "original-process", sessionId: originalClaudeId, name: "niche-manager",
        transcriptPath: originalClaudeTranscript, source: "startup",
      })).session as { id: string; name: string };
      const oldBound = env.human();
      await oldBound.request("claude_attach", { sessionId: originalClaudeId });
      const [oldMessage] = await send(oldBound, "human", "ancestor history");
      const ancestorScope = { scope: "session" as const, sessionId: ancestor.id };
      const oldOrder = (await human.historyPage(ancestorScope)).messages.find((message) => message.id === oldMessage.msgId)!.order;
      const oldRead = await human.readState(ancestorScope);
      assert.equal((await human.markRead(ancestorScope, oldOrder, oldRead.version)).applied, true);
      if (reminders !== "provisional") await human.markUnread(ancestorScope);
      await human.request("claude_hook", { event: "end", sessionId: originalClaudeId });

      const latePath = join(env.home, "late-read.jsonl");
      const provisional = (await human.request("claude_hook", {
        event: "start", key: "resumed-process", sessionId: resumedClaudeId, name: "provisional",
        transcriptPath: latePath, source: "resume",
      })).session as { id: string; name: string };
      const newBound = env.human();
      await newBound.request("claude_attach", { sessionId: resumedClaudeId });
      const [newMessage] = await send(newBound, "human", "provisional history");
      const provisionalScope = { scope: "session" as const, sessionId: provisional.id };
      const newOrder = (await human.historyPage(provisionalScope)).messages.find((message) => message.id === newMessage.msgId)!.order;
      assert.ok(newOrder > oldOrder);
      if (largerMarker === "provisional") {
        const read = await human.readState(provisionalScope);
        assert.equal((await human.markRead(provisionalScope, newOrder, read.version)).applied, true);
      }
      if (reminders !== "ancestor") await human.markUnread(provisionalScope);
      const beforeMerge = await human.readState(ancestorScope);
      writeFileSync(latePath, readFileSync(resumedClaudeTranscript, "utf8"));
      assert.deepEqual((await newBound.request("claude_attach", { sessionId: resumedClaudeId })).session, ancestor);
      const merged = await human.readState(ancestorScope);
      const expectedPosition = largerMarker === "ancestor" ? oldOrder : newOrder;
      const expectedReminder = reminders === "provisional" ? newOrder : oldOrder;
      const expectedUnread = largerMarker === "ancestor" && reminders !== "provisional" ? 2 : 1;
      assert.deepEqual([merged.position, merged.reminder, merged.unread], [
        expectedPosition, expectedReminder, expectedUnread,
      ]);
      assert.deepEqual((await human.historyPage(ancestorScope)).messages.map((message) => [
        message.id, message.fromSessionId,
      ]), [[oldMessage.msgId, ancestor.id], [newMessage.msgId, ancestor.id]]);
      const stale = await human.markRead(ancestorScope, newOrder, beforeMerge.version);
      assert.equal(stale.applied, false);
      assert.equal(stale.state.reminder, expectedReminder);
      if (reminders === "both") {
        assert.ok(logs.some((line) => line.includes("reminder") && line.includes(String(newOrder)) && line.includes(provisional.id)));
      }
      const cleared = await human.markRead(ancestorScope, newOrder, merged.version);
      assert.deepEqual([cleared.applied, cleared.state.position, cleared.state.reminder, cleared.state.unread], [
        true, newOrder, null, 0,
      ]);
      assert.equal((await human.readState()).some((state) => state.scope.scope === "session" && state.scope.sessionId === provisional.id), false);
    });
  }
}

const ignoredClaudeHeads: [string, string | undefined][] = [
  ["missing transcript", undefined],
  ["empty transcript", ""],
  ["malformed JSON", "{not-json}\n"],
  ["atis-latch identifiers", '{"type":"atis-latch","uuid":"7206c438-04ba-4b22-9553-1587dad1be33","messageId":"932e7924-5c15-4a0a-b8e1-6188de1037d0","atis":"shared-latch"}\n'],
  ["nested uuid", '{"type":"attachment","attachment":{"uuid":"7206c438-04ba-4b22-9553-1587dad1be33"}}\n'],
  ["non-snapshot messageId", '{"type":"mode","messageId":"932e7924-5c15-4a0a-b8e1-6188de1037d0"}\n'],
  ["ninth-line overlap", '{"type":"mode"}\n'.repeat(8) + '{"type":"file-history-snapshot","messageId":"932e7924-5c15-4a0a-b8e1-6188de1037d0"}\n'],
];
for (const [headDescription, head] of ignoredClaudeHeads) {
  test(`Claude ${headDescription} never claims an unrelated offline identity or its queue`, async () => {
    env = await startEnv();
    const human = env.human();
    const ancestor = (await human.request("claude_hook", {
      event: "start", key: "original-process", sessionId: originalClaudeId, name: "niche-manager",
      transcriptPath: originalClaudeTranscript, source: "startup",
    })).session as { id: string; name: string };
    const [queued] = await send(human, ancestor.name, "must not route to unrelated identity");
    await human.request("claude_hook", { event: "end", sessionId: originalClaudeId });
    const path = join(env.home, "unrelated.jsonl");
    if (head !== undefined) writeFileSync(path, head);
    const unrelated = (await human.request("claude_hook", {
      event: "start", key: "unrelated-process", sessionId: "unrelated", name: "unrelated",
      transcriptPath: path, source: "resume",
    })).session as { id: string; name: string };
    assert.notEqual(unrelated.id, ancestor.id);
    assert.deepEqual((await human.request("claude_hook", {
      event: "poll", sessionId: "unrelated", transcriptPath: path,
    })).texts, []);
    assert.equal((await logOf(human, queued.msgId!)).status, "queued");
    assert.deepEqual((await env.human().request("claude_attach", { sessionId: "unrelated" })).session, unrelated);
  });
}


for (const binding of ["recorded session id", "active process key"] as const) {
  test(`Claude ${binding} wins over changed lineage during compaction or clear`, async () => {
    env = await startEnv();
    const human = env.human();
    const original = (await human.request("claude_hook", {
      event: "start", key: "original-process", sessionId: originalClaudeId, name: "niche-manager",
      transcriptPath: originalClaudeTranscript, source: "startup",
    })).session as { id: string; name: string };
    const fork = (await human.request("claude_hook", {
      event: "start", key: "fork-process", sessionId: resumedClaudeId, name: "fork",
      transcriptPath: resumedClaudeTranscript, source: "resume",
    })).session as { id: string; name: string };
    assert.notEqual(fork.id, original.id);
    const [queued] = await send(human, original.name, "original queue through compaction");
    const changedId = binding === "recorded session id" ? originalClaudeId : "compacted";
    const changedKey = binding === "recorded session id" ? "new-process" : "original-process";
    const changedPath = join(env.home, "compacted.jsonl");
    writeFileSync(changedPath, '{"type":"file-history-snapshot","messageId":"c3107927-0b2d-4dca-b85c-78e3b06af72d"}\n');
    assert.deepEqual((await human.request("claude_hook", {
      event: "start", key: changedKey, sessionId: changedId, name: "ignored",
      transcriptPath: changedPath, source: "compact",
    })).session, original);
    const texts = (await human.request("claude_hook", { event: "poll", sessionId: changedId })).texts as string[];
    assert.equal(texts.length, 1);
    assert.match(texts[0], /original queue through compaction/);
    assert.equal((await logOf(human, queued.msgId!)).status, "delivered");
    assert.deepEqual((await human.request("claude_hook", { event: "poll", sessionId: resumedClaudeId })).texts, []);
  });
}

for (const lifecycle of ["gone", "grace removal", "end", "idle removal"] as const) {
  test(`Claude ${lifecycle} resume keeps identity, rename, queued and held messages across changed process keys`, async () => {
    env = await startEnv();
    const human = env.human();
    const sender = await env.adapter("omp", "sender", "sender");
    const first = (await human.request("claude_hook", {
      event: "start", key: "process1", socket: lifecycle === "gone" || lifecycle === "grace removal"
        ? join(env.home, "missing-claude.sock") : null,
      sessionId: "A", name: "original", cwd: "/work",
    })).session as { id: string; name: string };
    const attached = env.human();
    await attached.request("claude_attach", { sessionId: "A" });
    await attached.request("rename", { name: "niche-manager" });
    await human.request("set_inbound", { name: "niche-manager", mode: "hold" });
    const [held] = await send(sender.client, "niche-manager", "awaiting the human decision");
    assert.equal(held.status, "held");

    if (lifecycle === "gone" || lifecycle === "grace removal") {
      await env.daemon.probeClaude();
      assert.equal(await sessionState(human, "niche-manager"), "gone");
    }
    const [queued] = await send(human, "niche-manager", "resume this conversation");
    assert.equal(queued.status, "queued");
    if (lifecycle === "grace removal") {
      env.clock.advance(GRACE_MS);
      env.daemon.sweep();
    } else if (lifecycle === "end") {
      await human.request("claude_hook", { event: "end", sessionId: "A" });
    } else if (lifecycle === "idle removal") {
      env.clock.advance(12 * 3_600_000 + 1);
      await env.daemon.probeClaude();
    }
    const before = (await human.sync()).sessions.find((session) => session.id === first.id)!;
    assert.equal(before.state, lifecycle === "gone" ? "gone" : "removed");
    assert.equal((await logOf(human, queued.msgId!)).status, "queued");
    assert.equal((await logOf(human, held.msgId!)).status, "held");

    const resumed = (await human.request("claude_hook", {
      event: "start", key: "process2", socket: null, sessionId: "A", name: "ignored-request", cwd: "/work",
    })).session as { id: string; name: string };
    assert.deepEqual(resumed, { id: first.id, name: "niche-manager" });
    const current = (await human.sync()).sessions.find((session) => session.id === first.id)!;
    assert.deepEqual([current.state, current.inbound, current.previousNames], ["live", "hold", ["original"]]);
    const texts = (await human.request("claude_hook", { event: "poll", sessionId: "A" })).texts as string[];
    assert.equal(texts.length, 1);
    assert.match(texts[0], /resume this conversation/);
    assert.equal((await logOf(human, held.msgId!)).status, "held");
    assert.equal((await human.request("release", { msgId: held.msgId })).status, "queued");
    const released = (await human.request("claude_hook", { event: "poll", sessionId: "A" })).texts as string[];
    assert.equal(released.length, 1);
    assert.match(released[0], /awaiting the human decision/);
    assert.deepEqual((await human.historyPage({ scope: "session", sessionId: first.id })).messages.map(
      (message) => [message.id, message.toSessionId, message.status],
    ), [[held.msgId, first.id, "delivered"], [queued.msgId, first.id, "delivered"]]);
    assert.deepEqual(sender.deliveries, []);
  });
}

for (const harness of ["omp", "opencode"] as const) {
  for (const removal of ["grace", "unregister"] as const) {
    test(`${harness} revival after ${removal} preserves the renamed identity, queued and held delivery`, async () => {
      env = await startEnv();
      const human = env.human();
      const sender = await env.adapter("omp", "sender", "sender");
      const original = await env.adapter(harness, "retained-key", "original", { autoAck: removal !== "unregister" });
      await original.client.request("rename", { name: "niche-manager" });
      await human.request("set_inbound", { name: "niche-manager", mode: "hold" });
      const [held] = await send(sender.client, "niche-manager", "held through removal");
      assert.equal(held.status, "held");

      let queued: SendResult;
      if (removal === "unregister") {
        const sending = send(human, "niche-manager", "queued through removal");
        await original.nextDelivery();
        await original.client.request("unregister");
        original.client.close();
        [queued] = await sending;
      } else {
        const gone = await env.watch(isSession("gone", "niche-manager"));
        original.client.close();
        await gone.event;
        [queued] = await send(human, "niche-manager", "queued through removal");
        env.clock.advance(GRACE_MS);
        env.daemon.sweep();
      }
      assert.equal(queued.status, "queued");
      assert.equal((await logOf(human, queued.msgId!)).status, "queued");
      assert.equal((await logOf(human, held.msgId!)).status, "held");
      assert.equal((await human.sync()).sessions.find((session) => session.id === original.session.id)?.state, "removed");

      const delivered = await env.watch(isStatus(queued.msgId, "delivered"));
      const resumed = await env.adapter(harness, "retained-key", "ignored-request", { cwd: "/changed" });
      assert.deepEqual(resumed.session, { id: original.session.id, name: "niche-manager" });
      assert.equal((await resumed.nextDelivery()).msg.id, queued.msgId);
      await delivered.event;
      const current = (await human.sync()).sessions.find((session) => session.id === original.session.id)!;
      assert.deepEqual([current.state, current.inbound, current.cwd, current.previousNames], ["live", "hold", "/changed", ["original"]]);
      assert.equal((await logOf(human, held.msgId!)).status, "held");
      assert.equal((await human.request("release", { msgId: held.msgId })).status, "delivered");
      assert.equal((await resumed.nextDelivery()).msg.id, held.msgId);
      assert.deepEqual((await human.historyPage({ scope: "session", sessionId: original.session.id })).messages.map(
        (message) => [message.id, message.toSessionId, message.status],
      ), [[held.msgId, original.session.id, "delivered"], [queued.msgId, original.session.id, "delivered"]]);
      assert.deepEqual(sender.deliveries, []);
    });
  }
}

test("Claude sessions with different ids and process keys in the same cwd do not take over a gone name", async () => {
  env = await startEnv();
  const human = env.human();
  const first = (await human.request("claude_hook", {
    event: "start", key: "process1", socket: join(env.home, "missing.sock"), sessionId: "A", name: "same-name", cwd: "/work",
  })).session as { id: string; name: string };
  await env.daemon.probeClaude();
  const [queued] = await send(human, "same-name", "only for A");
  assert.equal(queued.status, "queued");
  const second = (await human.request("claude_hook", {
    event: "start", key: "process2", socket: null, sessionId: "B", name: "same-name", cwd: "/work",
  })).session as { id: string; name: string };
  assert.notEqual(second.id, first.id);
  assert.equal(second.name, "same-name-2");
  assert.equal(await sessionState(human, "same-name"), "gone");
  assert.deepEqual((await human.request("claude_hook", { event: "poll", sessionId: "B" })).texts, []);
  assert.equal((await logOf(human, queued.msgId!)).status, "queued");
  const resumed = (await human.request("claude_hook", {
    event: "start", key: "process3", socket: null, sessionId: "A", name: "not-the-stored-name", cwd: "/work",
  })).session as { id: string; name: string };
  assert.deepEqual(resumed, first);
  const texts = (await human.request("claude_hook", { event: "poll", sessionId: "A" })).texts as string[];
  assert.equal(texts.length, 1);
  assert.match(texts[0], /only for A/);
  assert.equal((await logOf(human, queued.msgId!)).status, "delivered");
});

for (const previousTransport of ["removed", "rotated"] as const) {
  test(`Claude reused ${previousTransport} process key does not transfer another harness session's queue`, async () => {
    env = await startEnv();
    const human = env.human();
    const original = (await human.request("claude_hook", {
      event: "start", key: "process1", sessionId: "A", name: "alpha", cwd: "/work",
    })).session as { id: string; name: string };
    const [queued] = await send(human, "alpha", "only for A");
    if (previousTransport === "removed") {
      await human.request("claude_hook", { event: "end", sessionId: "A" });
    } else {
      const resumed = (await human.request("claude_hook", {
        event: "start", key: "process2", sessionId: "A", cwd: "/work",
      })).session as { id: string; name: string };
      assert.deepEqual(resumed, original);
    }
    const unrelated = (await human.request("claude_hook", {
      event: "start", key: "process1", sessionId: "B", name: "beta", cwd: "/work",
    })).session as { id: string; name: string };
    assert.notEqual(unrelated.id, original.id);
    assert.equal(unrelated.name, "beta");
    assert.deepEqual((await human.request("claude_hook", { event: "poll", sessionId: "B" })).texts, []);
    assert.equal((await logOf(human, queued.msgId!)).status, "queued");
    const revived = (await human.request("claude_hook", {
      event: "start", key: "process3", sessionId: "A", cwd: "/work",
    })).session as { id: string; name: string };
    assert.deepEqual(revived, original);
    const texts = (await human.request("claude_hook", { event: "poll", sessionId: "A" })).texts as string[];
    assert.match(texts[0], /only for A/);
    assert.equal((await logOf(human, queued.msgId!)).status, "delivered");
  });
}

test("Claude restart reopens the database and preserves removed identity, rename, queue and accumulated session ids", async () => {
  env = await startEnv();
  let human = env.human();
  const first = (await human.request("claude_hook", {
    event: "start", key: "process1", socket: null, sessionId: "A", name: "original",
  })).session as { id: string; name: string };
  const compacted = (await human.request("claude_hook", {
    event: "start", key: "process1", socket: null, sessionId: "B", name: "ignored-compaction-name",
  })).session as { id: string; name: string };
  assert.deepEqual(compacted, first);
  const attached = env.human();
  await attached.request("claude_attach", { sessionId: "A" });
  await attached.request("rename", { name: "niche-manager" });
  const [queued] = await send(human, "niche-manager", "survives a database reopen");
  assert.equal(queued.status, "queued");
  await human.request("claude_hook", { event: "end", sessionId: "B" });
  assert.equal((await logOf(human, queued.msgId!)).status, "queued");

  await env.restart();
  human = env.human();
  assert.equal((await human.sync()).sessions.find((session) => session.id === first.id)?.state, "removed");
  const resumed = (await human.request("claude_hook", {
    event: "start", key: "process2", socket: null, sessionId: "A", name: "ignored-resume-name",
  })).session as { id: string; name: string };
  assert.deepEqual(resumed, { id: first.id, name: "niche-manager" });
  const oldId = env.human();
  assert.deepEqual((await oldId.request("claude_attach", { sessionId: "B" })).session, resumed);
  const texts = (await human.request("claude_hook", { event: "poll", sessionId: "B" })).texts as string[];
  assert.equal(texts.length, 1);
  assert.match(texts[0], /survives a database reopen/);
  assert.equal((await logOf(human, queued.msgId!)).status, "delivered");

  await env.restart();
  human = env.human();
  const [second] = await send(human, "niche-manager", "survives another restart");
  assert.equal(second.status, "queued");
  assert.deepEqual((await human.request("claude_hook", {
    event: "start", key: "process3", socket: null, sessionId: "B", name: "another-request",
  })).session, resumed);
  assert.deepEqual((await env.human().request("claude_attach", { sessionId: "A" })).session, resumed);
  const afterRestart = (await human.request("claude_hook", { event: "poll", sessionId: "A" })).texts as string[];
  assert.equal(afterRestart.length, 1);
  assert.match(afterRestart[0], /survives another restart/);
  assert.deepEqual((await human.historyPage({ scope: "session", sessionId: first.id })).messages.map(
    (message) => [message.id, message.status],
  ), [[queued.msgId, "delivered"], [second.msgId, "delivered"]]);
  assert.deepEqual((await human.sync()).sessions.find((session) => session.id === first.id)?.previousNames, ["original"]);
});

for (const harness of ["omp", "opencode"] as const) {
  test(`${harness} restart reopens the database and revives the removed renamed identity with its queue`, async () => {
    env = await startEnv();
    let human = env.human();
    const original = await env.adapter(harness, "persisted-key", "original");
    await original.client.request("rename", { name: "niche-manager" });
    const gone = await env.watch(isSession("gone", "niche-manager"));
    original.client.close();
    await gone.event;
    const [queued] = await send(human, "niche-manager", "saved across restart");
    assert.equal(queued.status, "queued");
    env.clock.advance(GRACE_MS);
    env.daemon.sweep();
    await env.restart();
    human = env.human();
    assert.equal((await logOf(human, queued.msgId!)).status, "queued");
    assert.equal((await human.sync()).sessions.find((session) => session.id === original.session.id)?.state, "removed");

    const delivered = await env.watch(isStatus(queued.msgId, "delivered"));
    const resumed = await env.adapter(harness, "persisted-key", "ignored-request");
    assert.deepEqual(resumed.session, { id: original.session.id, name: "niche-manager" });
    assert.equal((await resumed.nextDelivery()).msg.id, queued.msgId);
    await delivered.event;
    assert.deepEqual((await human.historyPage({ scope: "session", sessionId: original.session.id })).messages.map(
      (message) => [message.id, message.toSessionId, message.status],
    ), [[queued.msgId, original.session.id, "delivered"]]);
    assert.deepEqual((await human.sync()).sessions.find((session) => session.id === original.session.id)?.previousNames, ["original"]);
  });
}

for (const harness of ["claude", "omp"] as const) {
  for (const retention of ["inside", "outside"] as const) {
    test(`${harness} no-traffic identity ${retention} retention uses removal time rather than creation time`, async () => {
      env = await startEnv({ historyDays: 7 });
      const human = env.human();
      const original = harness === "claude"
        ? (await human.request("claude_hook", {
          event: "start", key: "process1", socket: null, sessionId: "A", name: "niche-manager",
        })).session as { id: string; name: string }
        : (await env.adapter("omp", "retained-key", "niche-manager")).session;
      env.clock.advance(8 * 86_400_000);
      if (harness === "claude") {
        await human.request("claude_hook", { event: "end", sessionId: "A" });
      } else {
        const connection = await env.adapter("omp", "retained-key", "ignored-request");
        await connection.client.request("unregister");
      }
      const removedAt = env.clock.now();
      env.daemon.prune();
      const removed = (await human.sync()).sessions.find((session) => session.id === original.id)!;
      assert.deepEqual([removed.state, removed.removedAt], ["removed", removedAt]);
      env.clock.advance(7 * 86_400_000 + (retention === "inside" ? -1 : 1));
      env.daemon.prune();
      const retained = (await human.sync()).sessions.find((session) => session.id === original.id);
      assert.equal(retained?.state, retention === "inside" ? "removed" : undefined);

      const resumed = harness === "claude"
        ? (await human.request("claude_hook", {
          event: "start", key: "process2", socket: null, sessionId: "A", name: "fresh-request",
        })).session as { id: string; name: string }
        : (await env.adapter("omp", "retained-key", "fresh-request")).session;
      if (retention === "inside") {
        assert.deepEqual(resumed, original);
      } else {
        assert.notEqual(resumed.id, original.id);
        assert.equal(resumed.name, "fresh-request");
      }
      assert.deepEqual((await human.historyPage({ scope: "session", sessionId: resumed.id })).messages, []);
    });
  }
}

test("pending queued and held messages retain a removed identity beyond its no-traffic retention window", async () => {
  env = await startEnv({ historyDays: 7 });
  let human = env.human();
  const sender = await env.adapter("omp", "sender", "sender");
  const original = await env.adapter("omp", "retained-key", "niche-manager");
  await human.request("set_inbound", { name: "niche-manager", mode: "hold" });
  const [held] = await send(sender.client, "niche-manager", "held beyond retention");
  const gone = await env.watch(isSession("gone", "niche-manager"));
  original.client.close();
  await gone.event;
  const [queued] = await send(human, "niche-manager", "queued beyond retention");
  assert.deepEqual([held.status, queued.status], ["held", "queued"]);
  env.clock.advance(GRACE_MS);
  env.daemon.sweep();
  env.clock.advance(8 * 86_400_000);
  env.daemon.prune();
  assert.equal((await human.sync()).sessions.find((session) => session.id === original.session.id)?.state, "removed");
  assert.deepEqual((await human.historyPage({ scope: "session", sessionId: original.session.id })).messages.map(
    (message) => [message.id, message.status],
  ), [[held.msgId, "held"], [queued.msgId, "queued"]]);

  await env.restart();
  human = env.human();
  const delivered = await env.watch(isStatus(queued.msgId, "delivered"));
  const resumed = await env.adapter("omp", "retained-key", "ignored-request");
  assert.deepEqual(resumed.session, original.session);
  assert.equal((await resumed.nextDelivery()).msg.id, queued.msgId);
  await delivered.event;
  assert.equal((await logOf(human, held.msgId!)).status, "held");
  assert.equal((await human.request("release", { msgId: held.msgId })).status, "delivered");
  assert.equal((await resumed.nextDelivery()).msg.id, held.msgId);
});

for (const harness of ["claude", "omp"] as const) {
  for (const holderState of ["live", "gone"] as const) {
    test(`${harness} revival around a ${holderState} name holder keeps its queue and emits the deterministic fallback rename`, async () => {
      env = await startEnv();
      const human = env.human();
      const original = harness === "claude"
        ? (await human.request("claude_hook", {
          event: "start", key: "process1", socket: null, sessionId: "A", name: "original", cwd: "/work",
        })).session as { id: string; name: string }
        : (await env.adapter("omp", "retained-key", "original")).session;
      await human.request("rename", { from: "original", name: "niche-manager" });
      let queued: SendResult;
      if (harness === "claude") {
        [queued] = await send(human, "niche-manager", "belongs to the original identity");
        await human.request("claude_hook", { event: "end", sessionId: "A" });
      } else {
        const connection = await env.adapter("omp", "retained-key", "ignored-request");
        const gone = await env.watch(isSession("gone", "niche-manager"));
        connection.client.close();
        await gone.event;
        [queued] = await send(human, "niche-manager", "belongs to the original identity");
        env.clock.advance(GRACE_MS);
        env.daemon.sweep();
      }
      assert.equal(queued.status, "queued");
      const holderAdapter = harness === "omp" ? await env.adapter("omp", "other-key", "niche-manager") : undefined;
      const holder = harness === "claude"
        ? (await human.request("claude_hook", {
          event: "start", key: "holder-process", socket: holderState === "gone" ? join(env.home, "missing-holder.sock") : null,
          sessionId: "B", name: "niche-manager", cwd: "/work",
        })).session as { id: string; name: string }
        : holderAdapter!.session;
      if (harness === "claude") {
        await human.request("claude_hook", {
          event: "start", key: "suffix-process", socket: null, sessionId: "C", name: "niche-manager", cwd: "/work",
        });
      } else {
        await env.adapter("omp", "suffix-key", "niche-manager");
      }
      if (holderState === "gone") {
        if (harness === "claude") {
          await env.daemon.probeClaude();
          assert.equal(await sessionState(human, "niche-manager"), "gone");
        } else {
          const gone = await env.watch(isSession("gone", "niche-manager"));
          holderAdapter!.client.close();
          await gone.event;
        }
      }
      const renamed = await env.watch(isSession("renamed", "niche-manager-3"));
      const delivered = await env.watch(isStatus(queued.msgId, "delivered"));
      if (harness === "claude") {
        assert.deepEqual((await human.request("claude_hook", {
          event: "start", key: "process2", socket: null, sessionId: "A", name: "ignored-request", cwd: "/work",
        })).session, { id: original.id, name: "niche-manager-3" });
        const texts = (await human.request("claude_hook", { event: "poll", sessionId: "A" })).texts as string[];
        assert.equal(texts.length, 1);
        assert.match(texts[0], /belongs to the original identity/);
      } else {
        const resumed = await env.adapter("omp", "retained-key", "ignored-request");
        assert.deepEqual(resumed.session, { id: original.id, name: "niche-manager-3" });
        assert.equal((await resumed.nextDelivery()).msg.id, queued.msgId);
      }
      await delivered.event;
      const event = await renamed.event;
      assert.ok(event.type === "session");
      assert.deepEqual([event.action, event.oldName, event.name, event.session.id], [
        "renamed", "niche-manager", "niche-manager-3", original.id,
      ]);
      const snapshot = await human.sync();
      const revived = snapshot.sessions.find((session) => session.id === original.id)!;
      assert.deepEqual([revived.name, revived.previousNames, revived.state], [
        "niche-manager-3", ["original", "niche-manager"], "live",
      ]);
      assert.equal(snapshot.sessions.find((session) => session.id === holder.id)?.state, holderState);
      if (harness === "claude") {
        assert.deepEqual((await human.request("claude_hook", { event: "poll", sessionId: "B" })).texts, []);
      } else {
        assert.deepEqual(holderAdapter!.deliveries, []);
      }
      assert.deepEqual((await human.historyPage({ scope: "session", sessionId: original.id })).messages.map(
        (message) => [message.id, message.toSessionId, message.status],
      ), [[queued.msgId, original.id, "delivered"]]);
      assert.deepEqual((await human.historyPage({ scope: "session", sessionId: holder.id })).messages, []);
    });
  }
}

test("legacy registration backfill survives repeated database reopen and removal for Claude, omp and OpenCode", async () => {
  env = await startEnv({}, (db) => {
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
      CREATE TABLE protocol_meta(key TEXT PRIMARY KEY, value INTEGER NOT NULL);
      INSERT INTO protocol_meta(key,value) VALUES('identity_backfill',1);
    `);
    for (const [harness, key, name] of [
      ["claude", "legacy-process", "niche-manager"],
      ["omp", "legacy-omp-key", "omp-manager"],
      ["opencode", "legacy-opencode-key", "opencode-manager"],
    ]) {
      const id = `s_legacy_${harness}`;
      db.run(
        `INSERT INTO sessions(id,harness,key,name,cwd,state,gone_at,claude_session_ids,created_at)
         VALUES(?,?,?,?,'/legacy','gone',1700000000000,?,1700000000000)`,
        id, harness, key, name, harness === "claude" ? '["legacy-A","legacy-B"]' : "[]",
      );
      db.run(
        `INSERT INTO session_identities(id,harness,name,previous_names,cwd,state,created_at)
         VALUES(?,?,?,?,'/legacy','gone',1700000000000)`,
        id, harness, name, JSON.stringify([`old-${harness}-name`]),
      );
      db.run(
        `INSERT INTO messages(id,from_name,to_name,to_session,text,status,created_at,updated_at)
         VALUES(?,'human',?,?,?,'queued',1700000000000,1700000000000)`,
        `m_legacy_${harness}`, name, id, `legacy queue for ${harness}`,
      );
    }
  });
  env.clock.advance(GRACE_MS);
  env.daemon.sweep();
  await env.restart();
  await env.restart();
  const human = env.human();
  const removed = await human.sync();
  assert.deepEqual(removed.sessions.map((session) => [session.id, session.state]).sort(), [
    ["s_legacy_claude", "removed"],
    ["s_legacy_omp", "removed"],
    ["s_legacy_opencode", "removed"],
  ]);

  const claude = (await human.request("claude_hook", {
    event: "start", key: "new-process", socket: null, sessionId: "legacy-A", name: "ignored-request",
  })).session as { id: string; name: string };
  assert.deepEqual(claude, { id: "s_legacy_claude", name: "niche-manager" });
  assert.deepEqual((await env.human().request("claude_attach", { sessionId: "legacy-B" })).session, claude);
  const texts = (await human.request("claude_hook", { event: "poll", sessionId: "legacy-B" })).texts as string[];
  assert.equal(texts.length, 1);
  assert.match(texts[0], /legacy queue for claude/);
  for (const harness of ["omp", "opencode"] as const) {
    const delivered = await env.watch(isStatus(`m_legacy_${harness}`, "delivered"));
    const resumed = await env.adapter(harness, `legacy-${harness}-key`, "ignored-request");
    assert.deepEqual(resumed.session, { id: `s_legacy_${harness}`, name: `${harness}-manager` });
    assert.equal((await resumed.nextDelivery()).msg.id, `m_legacy_${harness}`);
    await delivered.event;
  }
  const revived = await human.sync();
  for (const harness of ["claude", "omp", "opencode"] as const) {
    const identity = revived.sessions.find((session) => session.id === `s_legacy_${harness}`)!;
    assert.deepEqual([identity.state, identity.previousNames], ["live", [`old-${harness}-name`]]);
    assert.deepEqual((await human.historyPage({ scope: "session", sessionId: identity.id })).messages.map(
      (message) => [message.id, message.toSessionId, message.status],
    ), [[`m_legacy_${harness}`, identity.id, "delivered"]]);
  }
});

test("harness-scoped adapter keys revive distinct identities when omp and OpenCode share a key and cwd", async () => {
  env = await startEnv();
  const human = env.human();
  const omp = await env.adapter("omp", "shared-id", "shared-name");
  const opencode = await env.adapter("opencode", "shared-id", "shared-name");
  assert.notEqual(omp.session.id, opencode.session.id);
  assert.equal(opencode.session.name, "shared-name-2");
  const ompGone = await env.watch(isSession("gone", omp.session.name));
  const opencodeGone = await env.watch(isSession("gone", opencode.session.name));
  omp.client.close();
  opencode.client.close();
  await ompGone.event;
  await opencodeGone.event;
  const [ompMessage] = await send(human, omp.session.name, "only for omp");
  const [opencodeMessage] = await send(human, opencode.session.name, "only for OpenCode");
  assert.deepEqual([ompMessage.status, opencodeMessage.status], ["queued", "queued"]);
  env.clock.advance(GRACE_MS);
  env.daemon.sweep();
  await env.restart();
  const ompDelivered = await env.watch(isStatus(ompMessage.msgId, "delivered"));
  const opencodeDelivered = await env.watch(isStatus(opencodeMessage.msgId, "delivered"));
  const resumedOmp = await env.adapter("omp", "shared-id", "different-request");
  const resumedOpenCode = await env.adapter("opencode", "shared-id", "different-request");
  assert.deepEqual(resumedOmp.session, omp.session);
  assert.deepEqual(resumedOpenCode.session, opencode.session);
  assert.equal((await resumedOmp.nextDelivery()).msg.id, ompMessage.msgId);
  assert.equal((await resumedOpenCode.nextDelivery()).msg.id, opencodeMessage.msgId);
  await ompDelivered.event;
  await opencodeDelivered.event;
  assert.deepEqual(resumedOmp.deliveries.map((delivery) => delivery.msg.id), [ompMessage.msgId]);
  assert.deepEqual(resumedOpenCode.deliveries.map((delivery) => delivery.msg.id), [opencodeMessage.msgId]);
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

test("human channel lifecycle keeps empty channels, identity rosters and on-demand posts", async () => {
  env = await startEnv();
  const human = env.human();
  const alpha = await env.adapter("omp", "alpha-key", "alpha");
  const before = await human.sync();
  const empty = { name: "work", count: 0, lastAt: 0, lastOrder: 0, memberIds: [] };
  assert.deepEqual((await human.request("channel_create", { channel: "work" })).channel, empty);
  assert.deepEqual((await human.request("channel_create", { channel: "work" })).channel, empty);
  assert.deepEqual((await human.request("channel_list")).channels, [empty]);
  const marker = await human.readState({ scope: "channel", channel: "work" });
  assert.deepEqual([marker.position, marker.unread], [0, 0]);
  await human.markRead({ scope: "channel", channel: "work" }, 0, marker.version);
  for (const op of ["channel_create", "channel_add", "channel_remove", "channel_members"]) {
    await assert.rejects(human.request(op, { channel: "Bad Name", name: "alpha" }), { code: "invalid_name" });
  }
  for (const op of ["channel_add", "channel_remove", "channel_members"]) {
    await assert.rejects(human.request(op, { channel: "missing", name: "alpha" }), { code: "unknown_channel" });
  }
  await human.request("channel_add", { channel: "work", name: "alpha" });
  await human.request("channel_add", { channel: "work", name: "alpha" });
  await human.request("channel_create", { channel: "review" });
  await human.request("channel_add", { channel: "review", name: "alpha" });
  await alpha.client.request("rename", { name: "renamed" });
  await human.request("set_role", { name: "renamed", role: "worker" });
  const members = (await human.request("channel_members", { channel: "work" })).members;
  assert.deepEqual(members, [(await human.sync()).sessions.find((s) => s.id === alpha.session.id)]);
  const gone = await env.watch(isSession("gone", "renamed"));
  alpha.client.close();
  await gone.event;
  assert.equal(((await human.request("channel_members", { channel: "review" })).members as { state: string }[])[0].state, "gone");
  const resumed = await env.adapter("omp", "alpha-key", "renamed");
  assert.equal(resumed.session.id, alpha.session.id);
  await resumed.client.request("channel_send", { channel: "implicit", text: "@all still read on demand" });
  const implicit = (await human.sync()).channels.find((c) => c.name === "implicit");
  assert.deepEqual(implicit?.memberIds, []);
  assert.equal(implicit?.count, 1);
  assert.equal(resumed.deliveries.length, 0);
  await human.request("channel_remove", { channel: "work", name: "alpha" });
  await human.request("channel_remove", { channel: "work", sessionId: alpha.session.id });
  assert.deepEqual((await human.request("channel_members", { channel: "work" })).members, []);
  assert.deepEqual((await human.sync()).channels.find((c) => c.name === "review")?.memberIds, [alpha.session.id]);
  const replay = await human.replay(before.watermark);
  const events = replay.events.filter(({ event }) => event.type === "channel");
  assert.deepEqual(events.map(({ event }) => event.type === "channel" && [event.action, event.channel.name, event.channel.memberIds]), [
    ["created", "work", []], ["updated", "work", [alpha.session.id]],
    ["created", "review", []], ["updated", "review", [alpha.session.id]],
    ["created", "implicit", []], ["updated", "work", []],
  ]);
});

test("orchestrators edit only their channel rosters and shared roles, losing permission on self-removal", async () => {
  env = await startEnv();
  const human = env.human();
  const orch = await env.adapter("omp", "orch-key", "orch");
  const worker = await env.adapter("omp", "worker-key", "worker");
  const outside = await env.adapter("omp", "outside-key", "outside");
  await human.request("set_role", { name: "orch", role: "orchestrator" });
  await human.request("set_role", { name: "worker", role: "worker" });
  for (const channel of ["work", "other"]) await human.request("channel_create", { channel });
  await human.request("channel_add", { channel: "work", name: "orch" });
  await human.request("channel_add", { channel: "other", name: "outside" });
  await orch.client.request("channel_add", { channel: "work", name: "worker" });
  await orch.client.request("set_role", { name: "worker", role: "orchestrator" });
  assert.equal(((await worker.client.request("channel_members", { channel: "work" })).members as { name: string; role: string }[])
    .find((m) => m.name === "worker")?.role, "orchestrator");
  await orch.client.request("set_role", { name: "worker", role: "worker" });
  for (const client of [orch.client, worker.client, outside.client]) {
    await assert.rejects(client.request("channel_create", { channel: "forbidden" }), { code: "not_permitted" });
  }
  for (const op of ["channel_add", "channel_remove"]) {
    await assert.rejects(orch.client.request(op, { channel: "other", name: "missing" }), { code: "not_permitted" });
    await assert.rejects(worker.client.request(op, { channel: "work", name: "missing" }), { code: "not_permitted" });
    await assert.rejects(orch.client.request(op, { channel: "work", sessionId: worker.session.id }), { code: "not_permitted" });
  }
  await assert.rejects(orch.client.request("set_role", { name: "outside", role: "worker" }), { code: "not_permitted" });
  await assert.rejects(worker.client.request("set_role", { name: "missing", role: "invalid" }), { code: "not_permitted" });
  await assert.rejects(orch.client.request("channel_add", { channel: "work", name: "missing" }), { code: "unknown_target" });
  await orch.client.request("channel_remove", { channel: "work", name: "orch" });
  await assert.rejects(orch.client.request("channel_add", { channel: "work", name: "outside" }), { code: "not_permitted" });
  await assert.rejects(orch.client.request("set_role", { name: "worker", role: null }), { code: "not_permitted" });
  await human.request("set_role", { name: "outside", role: "worker" });
});

test("membership and role authorization select the bound or attached actor before target lookup", async () => {
  env = await startEnv();
  const human = env.human();
  const multi = await env.adapter("opencode", "orch-key", "orch");
  const registered = await multi.client.request("register", { harness: "opencode", key: "worker-key", name: "worker" });
  const worker = registered.session as { id: string; name: string };
  const target = await env.adapter("omp", "target-key", "target");
  await human.request("claude_hook", { event: "start", key: "sid:claude", sessionId: "claude", name: "claude" });
  const claude = env.human();
  await claude.request("claude_attach", { sessionId: "claude" });
  await human.request("channel_create", { channel: "work" });
  for (const name of ["orch", "worker", "claude", "target"]) await human.request("channel_add", { channel: "work", name });
  await human.request("set_role", { name: "orch", role: "orchestrator" });
  await human.request("set_role", { name: "claude", role: "orchestrator" });
  for (const op of ["channel_add", "channel_remove", "set_role", "channel_create"]) {
    const p = { channel: "work", name: "target", role: "worker" };
    await assert.rejects(multi.client.request(op, p), { code: "bad_request" });
    await assert.rejects(multi.client.request(op, { ...p, as: "unbound" }), { code: "bad_request" });
    await assert.rejects(multi.client.request(op, { ...p, as: worker.id }), { code: "not_permitted" });
  }
  await multi.client.request("set_role", { name: "target", role: "worker", as: multi.session.id });
  await multi.client.request("channel_remove", { channel: "work", name: "target", as: multi.session.id });
  await claude.request("channel_add", { channel: "work", name: "target" });
  await claude.request("set_role", { name: "target", role: null });
  assert.equal((await human.sync()).sessions.find((s) => s.id === target.session.id)?.role, null);
  await assert.rejects(claude.request("channel_remove", { channel: "work", sessionId: target.session.id }), { code: "not_permitted" });
  await assert.rejects(claude.request("channel_create", { channel: "forbidden" }), { code: "not_permitted" });
});

test("channel additions require live targets and removals resolve only roster identities with current-name precedence", async () => {
  env = await startEnv();
  const human = env.human();
  await human.request("channel_create", { channel: "work" });
  const first = await env.adapter("omp", "first-key", "alpha");
  await human.request("channel_add", { channel: "work", name: "alpha" });
  await first.client.request("channel_send", { channel: "work", text: "retained first identity" });
  await first.client.request("rename", { name: "first-renamed" });
  const gone = await env.watch(isSession("gone", "first-renamed"));
  first.client.close();
  await gone.event;
  await assert.rejects(human.request("channel_add", { channel: "work", name: "first-renamed" }), { code: "not_live" });
  env.clock.advance(GRACE_MS + 1);
  env.daemon.sweep();
  await assert.rejects(human.request("channel_add", { channel: "work", name: "first-renamed" }), { code: "not_live" });
  await assert.rejects(human.request("channel_add", { channel: "work", name: "alpha" }), { code: "not_live" });
  assert.equal(((await human.request("channel_members", { channel: "work" })).members as { state: string }[])[0].state, "removed");
  const second = await env.adapter("omp", "second-key", "alpha");
  await human.request("channel_add", { channel: "work", name: "alpha" });
  await second.client.request("channel_send", { channel: "work", text: "retained second identity" });
  await second.client.request("rename", { name: "second-renamed" });
  await second.client.request("unregister");
  const current = await env.adapter("omp", "current-key", "alpha");
  await human.request("channel_add", { channel: "work", name: "alpha" });
  await human.request("channel_remove", { channel: "work", name: "alpha" });
  assert.deepEqual((await human.sync()).channels.find((c) => c.name === "work")?.memberIds?.sort(), [first.session.id, second.session.id].sort());
  await assert.rejects(human.request("channel_remove", { channel: "work", name: "alpha" }), (error: unknown) => {
    const e = error as { code: string; message: string };
    assert.equal(e.code, "ambiguous_target");
    for (const value of [first.session.id, second.session.id, "first-renamed", "second-renamed", "state=removed"]) {
      assert.ok(e.message.includes(value));
    }
    return true;
  });
  await human.request("channel_remove", { channel: "work", sessionId: first.session.id });
  await human.request("channel_remove", { channel: "work", name: "alpha" });
  await assert.rejects(human.request("channel_remove", { channel: "work", name: current.session.name }), { code: "unknown_target" });
  await assert.rejects(human.request("channel_remove", { channel: "work", sessionId: "s_missing" }), { code: "unknown_target" });
  await assert.rejects(human.request("channel_remove", { channel: "work", name: "alpha", sessionId: current.session.id }), { code: "bad_request" });
  await assert.rejects(human.request("channel_add", { channel: "work", name: "never-known" }), { code: "unknown_target" });

  const duplicateOne = await env.adapter("omp", "duplicate-one", "duplicate");
  await human.request("channel_add", { channel: "work", name: "duplicate" });
  await duplicateOne.client.request("unregister");
  const duplicateTwo = await env.adapter("omp", "duplicate-two", "duplicate");
  await human.request("channel_add", { channel: "work", name: "duplicate" });
  await duplicateTwo.client.request("unregister");
  await assert.rejects(human.request("channel_remove", { channel: "work", name: "duplicate" }), { code: "ambiguous_target" });
  await human.request("channel_remove", { channel: "work", sessionId: duplicateOne.session.id });
  await human.request("channel_remove", { channel: "work", name: "duplicate" });
  assert.deepEqual((await human.request("channel_members", { channel: "work" })).members, []);
});

test("retention drops deleted identities from rosters without deleting channels or empty read markers", async () => {
  env = await startEnv({ historyDays: 7 });
  const human = env.human();
  const alpha = await env.adapter("omp", "alpha-key", "alpha");
  await human.request("channel_create", { channel: "empty" });
  await human.request("channel_add", { channel: "empty", name: "alpha" });
  await alpha.client.request("channel_send", { channel: "work", text: "retained until prune" });
  await human.request("channel_add", { channel: "work", name: "alpha" });
  await alpha.client.request("unregister");
  assert.deepEqual((await human.sync()).channels.find((c) => c.name === "work")?.memberIds, [alpha.session.id]);
  env.clock.advance(8 * 86_400_000);
  env.daemon.prune();
  const after = await human.sync();
  assert.equal(after.sessions.some((s) => s.id === alpha.session.id), false);
  assert.deepEqual(after.channels, [
    { name: "empty", count: 0, lastAt: 0, lastOrder: 0, memberIds: [] },
    { name: "work", count: 0, lastAt: 0, lastOrder: 0, memberIds: [] },
  ]);
  for (const channel of ["empty", "work"]) {
    assert.ok(after.readStates.some((state) => state.scope.scope === "channel" && state.scope.channel === channel));
    assert.equal((await human.readState({ scope: "channel", channel })).unread, 0);
  }
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
  db.run(
    `INSERT INTO messages(
      id,from_name,from_session,to_name,to_session,channel,text,kind,thread,reply_to,
      done,status,reason,attempts,created_at,updated_at)
     VALUES('m_channel','old-session','s_old','#legacy',NULL,'legacy','old post',NULL,NULL,NULL,0,'posted',NULL,0,14,14)`,
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
    assert.deepEqual(snapshot.channels, [{ name: "legacy", count: 1, lastAt: 14, lastOrder: 5, memberIds: [] }]);
    assert.deepEqual((await client.request("channel_members", { channel: "legacy" })).members, []);
    assert.equal((await client.readState({ scope: "channel", channel: "legacy" })).unread, 0);
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
    assert.deepEqual(migrated.messages.slice(0, 3).map((message) => [message.text, message.file]), [
      ["first", undefined], ["second", undefined], ["already delivered", undefined],
    ]);
    const path = join(home, "report.txt");
    writeFileSync(path, "abc");
    const [reference] = await send(agent, "human", "", { file: { path, summary: "Migrated report" } });
    assert.equal(reference.status, "posted");
    assert.equal((await agent.request("file_check", { msgId: reference.msgId })).status, "match");
    const fileHistory = await client.historyPage({ scope: "inbox" });
    assert.deepEqual(fileHistory.messages.at(-1)?.file, {
      path, summary: "Migrated report", sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", size: 3,
    });
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

test("legacy identity migration and database reopen preserve channel rosters, roles and empty read markers", async () => {
  const previousHome = process.env.ASENQ_HOME;
  const home = mkdtempSync(join(tmpdir(), "asenq-roles-restart-"));
  process.env.ASENQ_HOME = home;
  let db = await openDb(join(home, "asenq.db"));
  db.exec(`
    CREATE TABLE session_identities(
      id TEXT PRIMARY KEY, harness TEXT NOT NULL, name TEXT NOT NULL, previous_names TEXT NOT NULL DEFAULT '[]',
      cwd TEXT, inbound TEXT NOT NULL DEFAULT 'accept', state TEXT NOT NULL,
      created_at INTEGER NOT NULL, removed_at INTEGER);
    INSERT INTO session_identities(id,harness,name,state,created_at,removed_at)
      VALUES('s_archived','omp','archived','removed',1,2);
  `);
  let now = 1_700_000_000_000;
  const options = { socket: socketPath(), replyDir: join(home, "replies"), now: () => now, timers: false, log: () => {} };
  let daemon = new Daemon({ ...options, db });
  let human = new AsenqClient();
  let agent = new AsenqClient();
  try {
    await daemon.listen();
    assert.equal((await human.sync()).sessions.find((session) => session.id === "s_archived")?.role, null);
    await assert.rejects(human.request("set_role", { name: "archived", role: "worker" }), { code: "unknown_target" });
    const registered = await agent.request("register", { harness: "omp", key: "alpha-key", name: "alpha" });
    const session = registered.session;
    assert.ok(session && typeof session === "object" && "id" in session && typeof session.id === "string");
    const sessionId = session.id;
    const before = await human.sync();
    await human.request("channel_create", { channel: "work" });
    await human.request("channel_create", { channel: "empty" });
    await human.request("channel_add", { channel: "work", name: "alpha" });
    const emptyMarker = await human.readState({ scope: "channel", channel: "empty" });
    const markedEmpty = await human.markRead({ scope: "channel", channel: "empty" }, 0, emptyMarker.version);
    await agent.request("channel_send", { channel: "work", text: "before restart" });
    await human.request("set_role", { name: "alpha", role: "worker" });
    await agent.request("rename", { name: "renamed" });
    const gone = Promise.withResolvers<void>();
    human.close();
    human = new AsenqClient({
      onPush: (push) => { if (push.push === "event" && isSession("gone", "renamed")(push.event)) gone.resolve(); },
    });
    await human.request("tail");
    agent.close();
    await gone.promise;
    const [queued] = await send(human, "renamed", "persisted recipient role");
    assert.equal(queued.status, "queued");
    human.close();
    await daemon.close();
    db.close();
    now += 1000;
    db = await openDb(join(home, "asenq.db"));
    daemon = new Daemon({ ...options, db });
    await daemon.listen();
    human = new AsenqClient();
    const restored = (await human.sync()).sessions.find((session) => session.id === sessionId);
    assert.deepEqual(restored && [restored.name, restored.previousNames, restored.role], ["renamed", ["alpha"], "worker"]);
    assert.deepEqual((await human.request("channel_members", { channel: "work" })).members, [restored]);
    assert.deepEqual(await human.readState({ scope: "channel", channel: "empty" }), markedEmpty.state);
    assert.deepEqual((await human.sync()).channels.find((c) => c.name === "work")?.memberIds, [sessionId]);
    const replay = await human.replay(before.watermark);
    assert.ok(replay.events.some(({ event }) => event.type === "session" && event.action === "updated"
      && event.session.id === sessionId && event.session.role === "worker"));
    assert.ok(replay.events.some(({ event }) => event.type === "channel" && event.action === "updated"
      && event.channel.name === "work" && event.channel.memberIds?.includes(sessionId)));
    const delivery = Promise.withResolvers<Delivery>();
    agent = new AsenqClient({
      onPush: (push) => {
        if (push.push !== "deliver") return;
        delivery.resolve(push);
      },
    });
    const reconnected = await agent.request("register", { harness: "omp", key: "alpha-key", name: "renamed" });
    assert.deepEqual(reconnected.session, { id: sessionId, name: "renamed" });
    const received = await delivery.promise;
    assert.equal(received.msg.id, queued.msgId);
    assert.match(received.text.split("\n")[0], /your-role=worker/);
    await agent.request("ack", { msgId: received.msg.id, ok: true });
    await human.request("set_role", { name: "renamed", role: null });
    agent.close();
    human.close();
    await daemon.close();
    db.close();
    now += 1000;
    db = await openDb(join(home, "asenq.db"));
    daemon = new Daemon({ ...options, db });
    await daemon.listen();
    human = new AsenqClient();
    assert.equal((await human.sync()).sessions.find((session) => session.id === sessionId)?.role, null);
    const listed = (await human.request("list")).sessions as { name: string; role: string | null }[];
    assert.equal(listed.find((session) => session.name === "renamed")?.role, null);
    await human.request("set_role", { name: "renamed", role: "orchestrator" });
    assert.equal((await human.sync()).sessions.find((session) => session.id === sessionId)?.role, "orchestrator");
    const workHistory = await human.historyPage({ scope: "channel", channel: "work" });
    const workMarker = await human.readState({ scope: "channel", channel: "work" });
    const readWork = await human.markRead({ scope: "channel", channel: "work" }, workHistory.messages[0].order, workMarker.version);
    agent = new AsenqClient();
    await agent.request("register", { harness: "omp", key: "alpha-key", name: "renamed" });
    await agent.request("unregister");
    now += 8 * 86_400_000;
    daemon.prune();
    agent.close();
    human.close();
    await daemon.close();
    db.close();
    db = await openDb(join(home, "asenq.db"));
    daemon = new Daemon({ ...options, db });
    await daemon.listen();
    human = new AsenqClient();
    assert.deepEqual((await human.request("channel_members", { channel: "work" })).members, []);
    assert.deepEqual(await human.readState({ scope: "channel", channel: "work" }), readWork.state);
    const pruned = await human.sync();
    assert.equal(pruned.sessions.some((s) => s.id === sessionId), false);
    assert.deepEqual(pruned.channels, [
      { name: "empty", count: 0, lastAt: 0, lastOrder: 0, memberIds: [] },
      { name: "work", count: 0, lastAt: 0, lastOrder: 0, memberIds: [] },
    ]);
    assert.deepEqual(await human.readState({ scope: "channel", channel: "empty" }), markedEmpty.state);
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

test("file references persist across database reopen and queued delivery never rereads the file", async () => {
  const previousHome = process.env.ASENQ_HOME;
  const home = mkdtempSync(join(tmpdir(), "asenq-files-reopen-"));
  process.env.ASENQ_HOME = home;
  const path = join(home, "report.txt");
  writeFileSync(path, "abc");
  const file = {
    path, summary: "Durable report", sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", size: 3,
  };
  let db = await openDb(join(home, "asenq.db"));
  const options = { socket: socketPath(), replyDir: join(home, "replies"), now: () => 1, timers: false, log: () => {} };
  let daemon = new Daemon({ ...options, db });
  const gone = Promise.withResolvers<void>();
  let human = new AsenqClient({
    onPush: (push) => { if (push.push === "event" && isSession("gone", "beta")(push.event)) gone.resolve(); },
  });
  let alpha = new AsenqClient();
  let beta = new AsenqClient();
  try {
    await daemon.listen();
    await alpha.request("register", { harness: "omp", key: "file-alpha", name: "alpha" });
    const registered = await beta.request("register", { harness: "omp", key: "file-beta", name: "beta" });
    const before = await human.sync();
    const [posted] = await send(alpha, "human", "Read when needed", { file: { path, summary: file.summary } });
    await human.request("tail");
    beta.close();
    await gone.promise;
    const [queued] = await send(alpha, "beta", "", { file: { path, summary: file.summary } });
    assert.equal(queued.status, "queued");
    alpha.close();
    human.close();
    await daemon.close();
    db.close();
    rmSync(path);
    db = await openDb(join(home, "asenq.db"));
    daemon = new Daemon({ ...options, db });
    await daemon.listen();
    const delivered = Promise.withResolvers<void>();
    human = new AsenqClient({
      onPush: (push) => { if (push.push === "event" && isStatus(queued.msgId, "delivered")(push.event)) delivered.resolve(); },
    });
    await human.request("tail");
    alpha = new AsenqClient();
    await alpha.request("register", { harness: "omp", key: "file-alpha", name: "alpha" });
    const deliveries: Delivery[] = [];
    beta = new AsenqClient({
      onPush: (push) => {
        if (push.push !== "deliver") return;
        deliveries.push(push);
        void beta.request("ack", { msgId: push.msg.id, ok: true });
      },
    });
    assert.deepEqual((await beta.request("register", { harness: "omp", key: "file-beta", name: "beta" })).session, registered.session);
    await delivered.promise;
    assert.deepEqual(deliveries.map((delivery) => [delivery.msg.id, delivery.msg.text, delivery.msg.file]), [[queued.msgId, "", file]]);
    assert.ok(deliveries[0].text.includes(`read the file; verify with asenq_file_check id=${queued.msgId}`));
    assert.ok(!deliveries[0].text.includes("\nabc\n"));
    assert.equal((await beta.request("file_check", { msgId: queued.msgId })).status, "missing");
    const history = await human.historyPage({ scope: "inbox" });
    assert.deepEqual(history.messages.map((message) => [message.id, message.text, message.file]), [[posted.msgId, "Read when needed", file]]);
    const replay = await human.replay(before.watermark);
    assert.deepEqual(
      replay.events.filter((entry) => entry.event.type === "message" && entry.event.msg.id === posted.msgId)
        .map((entry) => entry.event.type === "message" && entry.event.msg.file),
      [file],
    );
    assert.equal((await human.request("file_check", { msgId: posted.msgId })).status, "missing");
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
