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
import { GRACE_MS, type SendResult, type SessionIdentity, type StoredMessage, type TailEvent } from "../src/shared/protocol.js";
import { renderInbound } from "../src/shared/render.js";
import { isStaleSession } from "../src/shared/sessions.js";
import { openDb } from "../src/shared/sqlite.js";
import { callTool } from "../src/shared/tools.js";
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

test("registration rejects explicit occupied names without merging distinct harness identities or gone queues", async () => {
  env = await startEnv();
  const human = env.human();
  const k1 = await env.adapter("opencode", "k1", "Worker API");
  assert.equal(k1.session.name, "worker-api");
  await assert.rejects(env.adapter("opencode", "k2", "Worker API"), { code: "name_taken" });
  const k2 = await env.adapter("opencode", "k2", "worker-two");
  assert.equal(k2.session.name, "worker-two");
  assert.notEqual(k2.session.id, k1.session.id);

  const gone = await env.watch(isSession("gone", "worker-api"));
  k1.client.close();
  await gone.event;
  const [queued] = await send(human, "worker-api", "while you were away");
  assert.equal(queued.status, "queued");

  await assert.rejects(env.adapter("opencode", "k3", "Worker API"), { code: "name_taken" });
  const k3 = await env.adapter("opencode", "k3", "worker-three");
  assert.equal(k3.session.name, "worker-three");
  assert.notEqual(k3.session.id, k1.session.id);
  assert.equal(await sessionState(human, "worker-api"), "gone");
  assert.equal((await logOf(human, queued.msgId!)).status, "queued");
  assert.deepEqual(k3.deliveries, []);

  const delivered = await env.watch(isStatus(queued.msgId, "delivered"));
  const resumed = await env.adapter("opencode", "k1", "worker-two");
  assert.deepEqual(resumed.session, k1.session);
  assert.equal((await resumed.nextDelivery()).msg.id, queued.msgId);
  await delivered.event;
  await assert.rejects(env.adapter("opencode", "k4", "Worker API", { cwd: "/elsewhere" }), { code: "name_taken" });
  const other = await env.adapter("opencode", "k4", "worker-four", { cwd: "/elsewhere" });
  assert.notEqual(other.session.id, k1.session.id);
});

test("former-name send after original to niche-manager rename delivers to the same identity with canonical history", async () => {
  env = await startEnv();
  const human = env.human();
  const original = await env.adapter("omp", "original-key", "original");
  await original.client.request("rename", { name: "niche-manager" });

  const [sent] = await send(human, "original", "late reply to the original address");
  assert.deepEqual([sent.to, sent.status], ["niche-manager", "delivered"]);
  const received = await original.nextDelivery();
  assert.deepEqual([received.session, received.msg.id, received.msg.to, received.msg.text], [
    original.session.id, sent.msgId, "niche-manager", "late reply to the original address",
  ]);
  const history = await human.historyPage({ scope: "session", sessionId: original.session.id });
  assert.deepEqual(history.messages.map((message) => [message.id, message.to, message.toSessionId]), [
    [sent.msgId, "niche-manager", original.session.id],
  ]);
});

test("closing a renamed identity ends former-name delivery, releases both names and makes harness revival fresh", async () => {
  env = await startEnv();
  const human = env.human();
  const sender = await env.adapter("opencode", "closure-forward-sender", "sender");
  const original = await env.adapter("omp", "closure-forward-original", "original");
  await original.client.request("rename", { name: "niche-manager" });
  const [forwarded] = await send(sender.client, "original", "forward before closure");
  assert.deepEqual([forwarded.to, forwarded.status], ["niche-manager", "delivered"]);
  const received = await original.nextDelivery();
  assert.deepEqual([received.session, received.msg.id, received.msg.to], [
    original.session.id, forwarded.msgId, "niche-manager",
  ]);
  assert.deepEqual(((await original.client.request("inbox", { unread_only: true })).messages as StoredMessage[]).map(
    (message) => [message.id, message.toSessionId],
  ), [[forwarded.msgId, original.session.id]]);

  const removed = await env.watch(isSession("removed", "niche-manager"));
  await human.request("close", { identity: original.session.id });
  const event = await removed.event;
  assert.ok(event.type === "session");
  assert.deepEqual([event.session.id, event.session.closedAt], [original.session.id, env.clock.now()]);
  const scope = { scope: "session" as const, sessionId: original.session.id };
  const sealed = (await human.historyPage(scope)).messages;
  assert.deepEqual(sealed.map((message) => [message.id, message.to, message.toSessionId]), [
    [forwarded.msgId, "niche-manager", original.session.id],
  ]);
  for (const name of ["original", "niche-manager"]) {
    for (const client of [human, sender.client]) {
      await assert.rejects(send(client, name, `no new delivery through ${name}`), { code: "unknown_target" });
    }
  }
  assert.deepEqual((await human.historyPage(scope)).messages, sealed);
  assert.deepEqual(original.deliveries.map((delivery) => delivery.msg.id), [forwarded.msgId]);
  assert.deepEqual((await sender.client.request("inbox", { unread_only: true })).messages, []);

  const freshClaim = await env.adapter("opencode", "closure-forward-fresh", "original");
  const renameClaim = await env.adapter("omp", "closure-forward-rename", "claimant");
  await renameClaim.client.request("rename", { name: "niche-manager" });
  const resumedHarness = await env.adapter("omp", "closure-forward-original", "fresh-return");
  assert.notEqual(freshClaim.session.id, original.session.id);
  assert.notEqual(resumedHarness.session.id, original.session.id);
  assert.equal(resumedHarness.session.name, "fresh-return");
  assert.deepEqual((await resumedHarness.client.request("inbox", { unread_only: true })).messages, []);
  assert.deepEqual(resumedHarness.deliveries, []);
  for (const [name, recipient] of [["original", freshClaim], ["niche-manager", renameClaim]] as const) {
    const [sent] = await send(human, name, `new claim for ${name}`);
    const delivery = await recipient.nextDelivery();
    assert.deepEqual([delivery.session, delivery.msg.id, delivery.msg.to], [recipient.session.id, sent.msgId, name]);
  }
  assert.deepEqual((await human.historyPage(scope)).messages, sealed);
  assert.deepEqual(original.deliveries.map((delivery) => delivery.msg.id), [forwarded.msgId]);
});

test("closed current and former names do not shadow a queueable removed former-name holder", async () => {
  env = await startEnv();
  const human = env.human();
  const closed = await env.adapter("omp", "closed-forward-holder", "original");
  await closed.client.request("rename", { name: "niche-manager" });
  await human.request("close", { identity: closed.session.id });
  const retained = await env.adapter("opencode", "retained-forward-holder", "original");
  await retained.client.request("rename", { name: "niche-manager" });
  await retained.client.request("rename", { name: "queueable" });
  const gone = await env.watch(isSession("gone", "queueable"));
  retained.client.close();
  await gone.event;
  const removed = await env.watch(isSession("removed", "queueable"));
  env.clock.advance(GRACE_MS);
  env.daemon.sweep();
  await removed.event;

  const ids: string[] = [];
  for (const name of ["original", "niche-manager"]) {
    const [queued] = await send(human, name, `queued through ${name}`);
    assert.deepEqual([queued.to, queued.status], ["queueable", "queued"]);
    ids.push(queued.msgId!);
  }
  const retainedScope = { scope: "session" as const, sessionId: retained.session.id };
  const closedScope = { scope: "session" as const, sessionId: closed.session.id };
  assert.deepEqual((await human.historyPage(retainedScope)).messages.map(
    (message) => [message.id, message.to, message.toSessionId, message.status],
  ), ids.map((id) => [id, "queueable", retained.session.id, "queued"]));
  assert.deepEqual((await human.historyPage(closedScope)).messages, []);
  const delivered = await env.watch(isStatus(ids[1], "delivered"));
  const revived = await env.adapter("opencode", "retained-forward-holder", "ignored");
  assert.deepEqual(revived.session, { id: retained.session.id, name: "queueable" });
  await delivered.event;
  assert.deepEqual(revived.deliveries.map((delivery) => [delivery.session, delivery.msg.id, delivery.msg.to]),
    ids.map((id) => [retained.session.id, id, "queueable"]));
  assert.deepEqual(((await revived.client.request("inbox", { unread_only: true })).messages as StoredMessage[]).map(
    (message) => message.id,
  ), ids);
  assert.deepEqual(closed.deliveries, []);
  assert.deepEqual((await human.historyPage(closedScope)).messages, []);
});

test("removed current names outrank removed former names and queue only for the current holder's stable identity", async () => {
  env = await startEnv();
  const human = env.human();
  const former = await env.adapter("omp", "removed-former-holder", "foo");
  await former.client.request("rename", { name: "alpha" });
  const formerGone = await env.watch(isSession("gone", "alpha"));
  former.client.close();
  await formerGone.event;
  env.clock.advance(GRACE_MS);
  env.daemon.sweep();
  const current = await env.adapter("opencode", "removed-current-holder", "foo");
  const currentGone = await env.watch(isSession("gone", "foo"));
  current.client.close();
  await currentGone.event;
  const removed = await env.watch(isSession("removed", "foo"));
  env.clock.advance(GRACE_MS);
  env.daemon.sweep();
  await removed.event;

  const [queued] = await send(human, "foo", "only the removed current holder receives this");
  assert.deepEqual([queued.to, queued.status], ["foo", "queued"]);
  const currentScope = { scope: "session" as const, sessionId: current.session.id };
  const formerScope = { scope: "session" as const, sessionId: former.session.id };
  assert.deepEqual((await human.historyPage(currentScope)).messages.map(
    (message) => [message.id, message.to, message.toSessionId, message.status],
  ), [[queued.msgId, "foo", current.session.id, "queued"]]);
  assert.deepEqual((await human.historyPage(formerScope)).messages, []);
  const delivered = await env.watch(isStatus(queued.msgId, "delivered"));
  const revivedCurrent = await env.adapter("opencode", "removed-current-holder", "ignored");
  assert.deepEqual(revivedCurrent.session, current.session);
  const received = await revivedCurrent.nextDelivery();
  assert.deepEqual([received.session, received.msg.id, received.msg.to], [current.session.id, queued.msgId, "foo"]);
  await delivered.event;
  const revivedFormer = await env.adapter("omp", "removed-former-holder", "ignored");
  assert.deepEqual(revivedFormer.session, { id: former.session.id, name: "alpha" });
  assert.deepEqual((await revivedFormer.client.request("inbox", { unread_only: true })).messages, []);
  assert.deepEqual(revivedFormer.deliveries, []);
  assert.deepEqual((await human.historyPage(formerScope)).messages, []);
  assert.deepEqual((await human.historyPage(currentScope)).messages.map(
    (message) => [message.id, message.toSessionId, message.status],
  ), [[queued.msgId, current.session.id, "delivered"]]);
});

test("rename chains forward every former name and let the identity reclaim its own former name", async () => {
  env = await startEnv();
  const human = env.human();
  const original = await env.adapter("opencode", "chain-key", "original");
  await original.client.request("rename", { name: "middle" });
  await original.client.request("rename", { name: "final" });
  const ids: string[] = [];
  for (const name of ["original", "middle", "final"]) {
    const [sent] = await send(human, name, `reply via ${name}`);
    assert.deepEqual([sent.to, sent.status], ["final", "delivered"]);
    const received = await original.nextDelivery();
    assert.deepEqual([received.session, received.msg.id, received.msg.to], [original.session.id, sent.msgId, "final"]);
    ids.push(sent.msgId!);
  }
  await original.client.request("rename", { name: "original" });
  for (const name of ["middle", "final"]) {
    const [sent] = await send(human, name, `after reclamation via ${name}`);
    assert.deepEqual([sent.to, sent.status], ["original", "delivered"]);
    assert.equal((await original.nextDelivery()).msg.id, sent.msgId);
    ids.push(sent.msgId!);
  }
  assert.deepEqual((await human.historyPage({ scope: "session", sessionId: original.session.id })).messages.map(
    (message) => [message.id, message.to, message.toSessionId],
  ), ids.map((id, index) => [id, index < 3 ? "final" : "original", original.session.id]));
});

for (const state of ["live", "gone"] as const) {
  test(`${state} current and former names reject explicit fresh claims and renames without diverting delivery`, async () => {
    env = await startEnv();
    const human = env.human();
    const owner = await env.adapter("omp", "owner-key", "former");
    await owner.client.request("rename", { name: "current" });
    const claimant = await env.adapter("opencode", "claimant-key", "claimant");
    if (state === "gone") {
      const gone = await env.watch(isSession("gone", "current"));
      owner.client.close();
      await gone.event;
    }
    for (const name of ["current", "former"]) {
      for (const harness of ["omp", "opencode"] as const) {
        await assert.rejects(env.adapter(harness, `${harness}-${name}`, name), { code: "name_taken" });
      }
      await assert.rejects(human.request("claude_hook", {
        event: "start", key: `claude-${name}`, sessionId: `claude-${name}`, name, socket: null,
      }), { code: "name_taken" });
      await assert.rejects(claimant.client.request("rename", { name }), { code: "name_taken" });
      await assert.rejects(human.request("rename", { from: "claimant", name }), { code: "name_taken" });
    }
    const [sent] = await send(human, "former", "only the reserved identity receives this");
    assert.deepEqual([sent.to, sent.status], ["current", state === "gone" ? "queued" : "delivered"]);
    const receiver = state === "gone" ? await env.adapter("omp", "owner-key", "claimant") : owner;
    assert.equal(receiver.session.id, owner.session.id);
    const received = await receiver.nextDelivery();
    assert.deepEqual([received.session, received.msg.id, received.msg.to], [owner.session.id, sent.msgId, "current"]);
    assert.deepEqual(claimant.deliveries, []);
    assert.deepEqual((await human.historyPage({ scope: "session", sessionId: claimant.session.id })).messages, []);
  });
}

test("generated fallback skips current and forwarding former reservations without taking over either identity", async () => {
  env = await startEnv({ defaultNameWords: { adjectives: ["calm"], animals: ["fox"] } });
  const human = env.human();
  const former = await env.adapter("omp", "former-key", "omp-calm-fox");
  await former.client.request("rename", { name: "renamed-default" });
  const current = await env.adapter("omp", "current-key", "omp-calm-fox-2");
  const generated = await env.adapter("omp", "generated-123456");
  assert.equal(generated.session.name, "omp-calm-fox-3");
  assert.notEqual(generated.session.id, former.session.id);
  assert.notEqual(generated.session.id, current.session.id);
  for (const [name, recipient] of [["omp-calm-fox", former], ["omp-calm-fox-2", current], ["omp-calm-fox-3", generated]] as const) {
    const [sent] = await send(human, name, `for ${name}`);
    assert.equal((await recipient.nextDelivery()).session, recipient.session.id);
    assert.equal((await human.historyPage({ scope: "session", sessionId: recipient.session.id })).messages[0].id, sent.msgId);
  }
});

test("automatically removed current and former names reserve nothing and new claims keep separate histories", async () => {
  env = await startEnv();
  const human = env.human();
  const original = await env.adapter("omp", "removed-key", "former");
  await original.client.request("rename", { name: "current" });
  const gone = await env.watch(isSession("gone", "current"));
  original.client.close();
  await gone.event;
  const [queued] = await send(human, "former", "retained for the removed identity");
  const removed = await env.watch(isSession("removed", "current"));
  env.clock.advance(GRACE_MS);
  env.daemon.sweep();
  await removed.event;
  const fresh = await env.adapter("omp", "fresh-key", "former");
  const claimant = await env.adapter("opencode", "rename-key", "claimant");
  await claimant.client.request("rename", { name: "current" });
  assert.notEqual(fresh.session.id, original.session.id);
  const [toFresh] = await send(human, "former", "new former-name owner");
  const [toClaimant] = await send(human, "current", "new current-name owner");
  assert.equal((await fresh.nextDelivery()).msg.id, toFresh.msgId);
  assert.equal((await claimant.nextDelivery()).msg.id, toClaimant.msgId);
  assert.deepEqual((await human.historyPage({ scope: "session", sessionId: original.session.id })).messages.map(
    (message) => [message.id, message.toSessionId, message.status],
  ), [[queued.msgId, original.session.id, "queued"]]);
  assert.equal((await human.historyPage({ scope: "session", sessionId: fresh.session.id })).messages[0].toSessionId, fresh.session.id);
  assert.equal((await human.historyPage({ scope: "session", sessionId: claimant.session.id })).messages[0].toSessionId, claimant.session.id);
});

for (const state of ["live", "gone"] as const) {
  test(`${state} current names outrank active former names after revival`, async () => {
    env = await startEnv();
    const human = env.human();
    const first = await env.adapter("omp", "first-key", "foo");
    await first.client.request("rename", { name: "alpha" });
    const gone = await env.watch(isSession("gone", "alpha"));
    first.client.close();
    await gone.event;
    env.clock.advance(GRACE_MS);
    env.daemon.sweep();
    const current = await env.adapter("opencode", "current-key", "foo");
    const revived = await env.adapter("omp", "first-key", "ignored");
    assert.deepEqual(revived.session, { id: first.session.id, name: "alpha" });
    if (state === "gone") {
      const goneCurrent = await env.watch(isSession("gone", "foo"));
      current.client.close();
      await goneCurrent.event;
    }
    const [sent] = await send(human, "foo", "current name wins over active forwarding");
    assert.deepEqual([sent.to, sent.status], ["foo", state === "gone" ? "queued" : "delivered"]);
    const receiver = state === "gone" ? await env.adapter("opencode", "current-key", "ignored") : current;
    assert.equal((await receiver.nextDelivery()).session, current.session.id);
    assert.deepEqual(revived.deliveries, []);
    assert.deepEqual((await human.historyPage({ scope: "session", sessionId: revived.session.id })).messages, []);
    assert.equal((await human.historyPage({ scope: "session", sessionId: current.session.id })).messages[0].id, sent.msgId);
  });
}

for (const state of ["live", "gone"] as const) {
  test(`${state} former names outrank removed current names`, async () => {
    env = await startEnv();
    const human = env.human();
    const removed = await env.adapter("omp", "removed-key", "foo");
    const gone = await env.watch(isSession("gone", "foo"));
    removed.client.close();
    await gone.event;
    env.clock.advance(GRACE_MS);
    env.daemon.sweep();
    const active = await env.adapter("opencode", "active-key", "foo");
    await active.client.request("rename", { name: "beta" });
    if (state === "gone") {
      const activeGone = await env.watch(isSession("gone", "beta"));
      active.client.close();
      await activeGone.event;
    }
    const [sent] = await send(human, "foo", "active former wins over removed current");
    assert.deepEqual([sent.to, sent.status], ["beta", state === "gone" ? "queued" : "delivered"]);
    const receiver = state === "gone" ? await env.adapter("opencode", "active-key", "ignored") : active;
    const received = await receiver.nextDelivery();
    assert.deepEqual([received.session, received.msg.id, received.msg.to], [active.session.id, sent.msgId, "beta"]);
    assert.deepEqual((await human.historyPage({ scope: "session", sessionId: removed.session.id })).messages, []);
  });
}

for (const level of ["current", "former"] as const) {
  test(`removed ${level} name ties return candidate ids and removal timestamps without reserving the name`, async () => {
    env = await startEnv();
    const human = env.human();
    const candidates: { id: string; name: string; timestamp: number }[] = [];
    for (const name of ["alpha", "beta"]) {
      const original = await env.adapter("omp", name, "foo");
      if (level === "former") await original.client.request("rename", { name });
      env.clock.advance(1000);
      await send(original.client, "human", `traffic from ${name}`);
      const currentName = level === "former" ? name : "foo";
      const gone = await env.watch(isSession("gone", currentName));
      original.client.close();
      await gone.event;
      env.clock.advance(GRACE_MS);
      env.daemon.sweep();
      candidates.push({ id: original.session.id, name: currentName, timestamp: env.clock.now() });
    }
    await env.restart();
    const observer = env.human();
    await assert.rejects(send(observer, "foo", "never choose a tied removed identity"), (error: unknown) => {
      assert.ok(error instanceof Error && "code" in error);
      assert.equal(error.code, "ambiguous_target");
      const message = error.message;
      for (const candidate of candidates) {
        assert.ok(message.includes(candidate.id), message);
        assert.ok(message.includes(candidate.name), message);
        assert.ok(message.includes(String(candidate.timestamp)), message);
      }
      return true;
    });
    for (const candidate of candidates) {
      assert.deepEqual((await observer.historyPage({ scope: "session", sessionId: candidate.id })).messages.map(
        (message) => [message.to, message.text],
      ), [["human", `traffic from ${candidate.id === candidates[0].id ? "alpha" : "beta"}`]]);
    }
    const claimant = await env.adapter("opencode", "claimant-key", "claimant");
    await claimant.client.request("rename", { name: "foo" });
    const [renamedSend] = await send(observer, "foo", "rename also ignores removed-only ambiguity");
    assert.equal((await claimant.nextDelivery()).msg.id, renamedSend.msgId);
    await claimant.client.request("unregister");
    const fresh = await env.adapter("omp", "fresh-key", "foo");
    const [sent] = await send(observer, "foo", "fresh claim resolves the removed tie");
    assert.equal((await fresh.nextDelivery()).msg.id, sent.msgId);
    assert.ok(!candidates.some((candidate) => candidate.id === fresh.session.id));
  });
}

test("revived active former-name ties are ambiguous and block fresh claims and own-name reclamation", async () => {
  env = await startEnv();
  const human = env.human();
  const first = await env.adapter("omp", "first-key", "foo");
  const firstCreatedAt = env.clock.now();
  await first.client.request("rename", { name: "alpha" });
  const gone = await env.watch(isSession("gone", "alpha"));
  first.client.close();
  await gone.event;
  env.clock.advance(GRACE_MS);
  env.daemon.sweep();
  const secondCreatedAt = env.clock.now();
  const second = await env.adapter("opencode", "second-key", "foo");
  await second.client.request("rename", { name: "beta" });
  const revived = await env.adapter("omp", "first-key", "ignored");
  assert.deepEqual(revived.session, { id: first.session.id, name: "alpha" });
  env.clock.advance(5000);
  await send(revived.client, "human", "traffic must not change candidate timestamps");
  await assert.rejects(send(human, "foo", "ambiguous forwarding"), (error: unknown) => {
    assert.ok(error instanceof Error && "code" in error);
    assert.equal(error.code, "ambiguous_target");
    const message = error.message;
    for (const value of [first.session.id, second.session.id, "alpha", "beta", String(firstCreatedAt), String(secondCreatedAt)]) {
      assert.ok(message.includes(value), message);
    }
    return true;
  });
  await assert.rejects(env.adapter("omp", "fresh-key", "foo"), { code: "name_taken" });
  await assert.rejects(revived.client.request("rename", { name: "foo" }), { code: "name_taken" });
  await assert.rejects(second.client.request("rename", { name: "foo" }), { code: "name_taken" });
  assert.deepEqual(revived.deliveries, []);
  assert.deepEqual(second.deliveries, []);
  assert.deepEqual((await human.historyPage({ scope: "session", sessionId: second.session.id })).messages, []);
  assert.deepEqual((await human.historyPage({ scope: "session", sessionId: first.session.id })).messages.map(
    (message) => [message.to, message.text],
  ), [["human", "traffic must not change candidate timestamps"]]);
});

test("former-name forwarding preserves hold, refuse, duplicate suppression and the recipient inbox identity", async () => {
  env = await startEnv();
  const human = env.human();
  const sender = await env.adapter("omp", "sender-key", "sender");
  const recipient = await env.adapter("opencode", "recipient-key", "former");
  await recipient.client.request("rename", { name: "current" });
  await human.request("set_inbound", { name: "current", mode: "hold" });
  const [held] = await send(sender.client, "former", "approval still required");
  assert.deepEqual([held.to, held.status], ["current", "held"]);
  assert.equal(recipient.deliveries.length, 0);
  assert.deepEqual((await recipient.client.request("inbox", { unread_only: true })).messages, []);
  assert.equal((await human.request("release", { msgId: held.msgId })).status, "delivered");
  assert.equal((await recipient.nextDelivery()).msg.id, held.msgId);
  assert.deepEqual(((await recipient.client.request("inbox", { unread_only: true })).messages as StoredMessage[]).map(
    (message) => [message.id, message.to, message.toSessionId],
  ), [[held.msgId, "current", recipient.session.id]]);
  assert.deepEqual((await recipient.client.request("inbox", { unread_only: true })).messages, []);

  await human.request("set_inbound", { name: "current", mode: "refuse" });
  for (const client of [sender.client, human]) {
    const [refused] = await send(client, "former", "refusal still applies");
    assert.deepEqual([refused.to, refused.status, refused.reason], ["current", "rejected", "target refuses messages"]);
  }
  await human.request("set_inbound", { name: "current", mode: "accept" });
  const [first] = await send(sender.client, "former", "one message across both addresses");
  assert.equal((await recipient.nextDelivery()).msg.id, first.msgId);
  const [duplicate] = await send(sender.client, "current", "one message across both addresses");
  assert.deepEqual([duplicate.status, duplicate.reason], ["dropped", "duplicate"]);
  assert.deepEqual(recipient.deliveries.map((delivery) => delivery.msg.id), [held.msgId, first.msgId]);
});

for (const holderState of ["live", "gone"] as const) {
  test(`revival suffixes a stored name reserved only as a ${holderState} former name and keeps its queued identity`, async () => {
    env = await startEnv();
    const human = env.human();
    const original = await env.adapter("omp", "original-key", "original");
    await original.client.request("rename", { name: "alpha" });
    const gone = await env.watch(isSession("gone", "alpha"));
    original.client.close();
    await gone.event;
    const [queued] = await send(human, "original", "waiting for the original identity");
    assert.deepEqual([queued.to, queued.status], ["alpha", "queued"]);
    env.clock.advance(GRACE_MS);
    env.daemon.sweep();

    const holder = await env.adapter("opencode", "holder-key", "alpha");
    await holder.client.request("rename", { name: "beta" });
    if (holderState === "gone") {
      const holderGone = await env.watch(isSession("gone", "beta"));
      holder.client.close();
      await holderGone.event;
    }
    const renamed = await env.watch(isSession("renamed", "alpha-2"));
    const delivered = await env.watch(isStatus(queued.msgId, "delivered"));
    const revived = await env.adapter("omp", "original-key", "beta");
    assert.deepEqual(revived.session, { id: original.session.id, name: "alpha-2" });
    assert.equal((await revived.nextDelivery()).msg.id, queued.msgId);
    await delivered.event;
    const event = await renamed.event;
    assert.ok(event.type === "session");
    assert.deepEqual([event.oldName, event.name, event.session.id], ["alpha", "alpha-2", original.session.id]);
    const snapshot = await human.sync();
    assert.deepEqual(snapshot.sessions.find((session) => session.id === original.session.id)?.previousNames, ["original", "alpha"]);
    assert.equal(snapshot.sessions.find((session) => session.id === holder.session.id)?.state, holderState);
    assert.deepEqual(holder.deliveries, []);
    assert.deepEqual((await human.historyPage({ scope: "session", sessionId: holder.session.id })).messages, []);
    assert.deepEqual((await human.historyPage({ scope: "session", sessionId: original.session.id })).messages.map(
      (message) => [message.id, message.toSessionId, message.status],
    ), [[queued.msgId, original.session.id, "delivered"]]);
  });
}

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

test("new nameless identities receive readable harness-prefixed word pairs", async () => {
  env = await startEnv();
  const human = env.human();
  for (const harness of ["omp", "opencode", "claude"] as const) {
    const session: { id: string; name: string } = harness === "claude"
      ? (await human.request("claude_hook", {
        event: "start", key: "process-key", socket: null, sessionId: "session-ABCDEF12",
      })).session as { id: string; name: string }
      : (await env.adapter(harness, "session-ABCDEF12")).session;
    assert.match(session.name, new RegExp(`^${harness}-[a-z]+-[a-z]+$`));
    assert.ok(session.name.length <= 40);
    assert.equal((await human.sync()).sessions.find((row) => row.id === session.id)?.name, session.name);
  }
});

for (const harness of ["omp", "opencode", "claude"] as const) {
  test(`${harness} default names are exactly deterministic across fresh databases and Claude process keys`, async () => {
    let firstName: string | undefined;
    for (const processKey of ["first-process", "unrelated-process"]) {
      env = await startEnv();
      const human = env.human();
      const session: { id: string; name: string } = harness === "claude"
        ? (await human.request("claude_hook", {
          event: "start", key: processKey, socket: null, sessionId: "stable-full-session-id",
        })).session as { id: string; name: string }
        : (await env.adapter(harness, "stable-full-session-id")).session;
      if (firstName === undefined) firstName = session.name;
      else assert.equal(session.name, firstName);
      assert.match(session.name, new RegExp(`^${harness}-[a-z]+-[a-z]+$`));
      assert.equal((await human.sync()).sessions.find((row) => row.id === session.id)?.name, session.name);
      await env.close();
      env = undefined;
    }
  });

  test(`${harness} missing, empty, invalid and slugged reserved names all use the session default`, async () => {
    let firstName: string | undefined;
    for (const name of [undefined, "", "!!!", "_invalid", " HUMAN ", "asenq", "all", "daemon"]) {
      env = await startEnv();
      const session: { id: string; name: string } = harness === "claude"
        ? (await env.human().request("claude_hook", {
          event: "start", key: "process-key", socket: null, sessionId: "same-default-seed", name,
        })).session as { id: string; name: string }
        : (await env.adapter(harness, "same-default-seed", name)).session;
      if (firstName === undefined) firstName = session.name;
      else assert.equal(session.name, firstName);
      assert.match(session.name, new RegExp(`^${harness}-[a-z]+-[a-z]+$`));
      await env.close();
      env = undefined;
    }
  });

  test(`${harness} explicit names and rename history survive live resume and removed identity revival`, async () => {
    env = await startEnv({ defaultNameWords: { adjectives: ["calm", "swift"], animals: ["fox", "owl"] } });
    const human = env.human();
    const adapter = harness === "claude" ? undefined : await env.adapter(harness, "explicit-seed", "Worker API");
    const original: { id: string; name: string } = harness === "claude"
      ? (await human.request("claude_hook", {
        event: "start", key: "process1", socket: null, sessionId: "explicit-seed", name: "Worker API",
      })).session as { id: string; name: string }
      : adapter!.session;
    assert.equal(original.name, "worker-api");
    assert.equal((await human.request("rename", { from: original.name, name: "Niche Manager" })).name, "niche-manager");
    const live: { id: string; name: string } = harness === "claude"
      ? (await human.request("claude_hook", {
        event: "start", key: "process2", socket: null, sessionId: "explicit-seed", name: "ignored-title",
      })).session as { id: string; name: string }
      : (await env.adapter(harness, "explicit-seed", "ignored-title")).session;
    assert.deepEqual(live, { id: original.id, name: "niche-manager" });
    if (harness === "claude") {
      await human.request("claude_hook", { event: "end", sessionId: "explicit-seed" });
    } else {
      const current = await env.adapter(harness, "explicit-seed");
      await current.client.request("unregister");
    }
    assert.equal((await human.sync()).sessions.find((row) => row.id === original.id)?.state, "removed");
    const revived: { id: string; name: string } = harness === "claude"
      ? (await human.request("claude_hook", {
        event: "start", key: "process3", socket: null, sessionId: "explicit-seed", name: "human",
      })).session as { id: string; name: string }
      : (await env.adapter(harness, "explicit-seed", "human")).session;
    assert.deepEqual(revived, live);
    const row = (await human.sync()).sessions.find((session) => session.id === original.id)!;
    assert.deepEqual([row.name, row.state, row.previousNames], ["niche-manager", "live", ["worker-api"]]);
  });
}

const defaultNameFixtures = [
  {
    harness: "omp", otherSeed: "other-AAAAAA", fullNames: ["omp-calm-owl", "omp-swift-fox"],
    collisionSeeds: ["collision-1", "collision-2", "collision-8", "fixture-AAAAAA"],
    pairOrder: ["omp-calm-owl", "omp-swift-fox", "omp-swift-owl", "omp-calm-fox"],
  },
  {
    harness: "opencode", otherSeed: "other-AAAAAA", fullNames: ["opencode-swift-owl", "opencode-calm-fox"],
    collisionSeeds: ["collision-3", "collision-5", "collision-6", "fixture-AAAAAA"],
    pairOrder: ["opencode-swift-owl", "opencode-calm-fox", "opencode-calm-owl", "opencode-swift-fox"],
  },
  {
    harness: "claude", otherSeed: "other-0-AAAAAA", fullNames: ["claude-calm-owl", "claude-swift-owl"],
    collisionSeeds: ["collision-4", "collision-6", "collision-14", "fixture-AAAAAA"],
    pairOrder: ["claude-calm-owl", "claude-swift-fox", "claude-swift-owl", "claude-calm-fox"],
  },
] as const;

for (const { harness, otherSeed, fullNames, collisionSeeds, pairOrder } of defaultNameFixtures) {
  test(`${harness} default naming uses the full session id rather than its shared last six characters`, async () => {
    env = await startEnv({ defaultNameWords: { adjectives: ["calm", "swift"], animals: ["fox", "owl"] } });
    const human = env.human();
    const actual: { id: string; name: string }[] = [];
    for (const seed of ["fixture-AAAAAA", otherSeed]) {
      const session: { id: string; name: string } = harness === "claude"
        ? (await human.request("claude_hook", {
          event: "start", key: `process-${seed}`, socket: null, sessionId: seed,
        })).session as { id: string; name: string }
        : (await env.adapter(harness, seed)).session;
      actual.push(session);
    }
    assert.deepEqual(actual.map((session) => session.name), fullNames);
    assert.notEqual(actual[0].id, actual[1].id);
    assert.deepEqual((await human.sync()).sessions.map((session) => session.name).sort(), [...fullNames].sort());
  });

  test(`${harness} live and gone clashes walk every pair before exhaustion uses the first pair with -2 and -3`, async () => {
    env = await startEnv({ defaultNameWords: { adjectives: ["calm", "swift"], animals: ["fox", "owl"] } });
    const human = env.human();
    const live = await env.adapter("omp", "live-holder", pairOrder[0]);
    const gone = await env.adapter("opencode", "gone-holder", pairOrder[1]);
    const goneEvent = await env.watch(isSession("gone", pairOrder[1]));
    gone.client.close();
    await goneEvent.event;
    assert.equal(await sessionState(human, pairOrder[0]), "live");
    assert.equal(await sessionState(human, pairOrder[1]), "gone");

    const expected = [pairOrder[2], pairOrder[3], `${pairOrder[0]}-2`, `${pairOrder[0]}-3`];
    const registered: { id: string; name: string }[] = [];
    for (const [index, seed] of collisionSeeds.entries()) {
      const session: { id: string; name: string } = harness === "claude"
        ? (await human.request("claude_hook", {
          event: "start", key: `process-${seed}`, socket: null, sessionId: seed,
        })).session as { id: string; name: string }
        : (await env.adapter(harness, seed)).session;
      assert.equal(session.name, expected[index]);
      assert.ok(session.name.length <= 40);
      registered.push(session);
    }
    const snapshot = await human.sync();
    assert.equal(snapshot.sessions.find((session) => session.id === live.session.id)?.name, pairOrder[0]);
    assert.equal(snapshot.sessions.find((session) => session.id === gone.session.id)?.state, "gone");
    assert.deepEqual(registered.map(({ id }) => snapshot.sessions.find((session) => session.id === id)?.name), expected);
    assert.equal(new Set([live.session.id, gone.session.id, ...registered.map((session) => session.id)]).size, 6);
  });
}

test("default name skips a live session's former name and keeps its late replies on that identity", async () => {
  env = await startEnv({ defaultNameWords: { adjectives: ["calm", "swift"], animals: ["fox", "owl"] } });
  const human = env.human();
  const former = await env.adapter("omp", "former-word-pair", "omp-calm-owl");
  await former.client.request("rename", { name: "niche-manager" });
  const generated = await env.adapter("omp", "fixture-AAAAAA");
  assert.equal(generated.session.name, "omp-swift-fox");
  assert.notEqual(generated.session.id, former.session.id);
  const [late] = await send(human, "omp-calm-owl", "late reply to the reserved former word pair");
  assert.deepEqual([late.to, late.status], ["niche-manager", "delivered"]);
  assert.equal((await former.nextDelivery()).msg.id, late.msgId);
  const [fresh] = await send(human, "omp-swift-fox", "message for the generated identity");
  assert.equal((await generated.nextDelivery()).msg.id, fresh.msgId);
  assert.deepEqual((await human.historyPage({ scope: "session", sessionId: former.session.id })).messages.map(
    (message) => [message.id, message.to, message.toSessionId],
  ), [[late.msgId, "niche-manager", former.session.id]]);
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
  await assert.rejects(human.request("claude_hook", {
    event: "start", key: "process2", socket: null, sessionId: "B", name: "same-name", cwd: "/work",
  }), { code: "name_taken" });
  const second = (await human.request("claude_hook", {
    event: "start", key: "process2", socket: null, sessionId: "B", name: "other-name", cwd: "/work",
  })).session as { id: string; name: string };
  assert.notEqual(second.id, first.id);
  assert.equal(second.name, "other-name");
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
  env = await startEnv({ historyDays: 7, ...{ queueTtlMs: 10 * 86_400_000 } });
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
          event: "start", key: "suffix-process", socket: null, sessionId: "C", name: "niche-manager-2", cwd: "/work",
        });
        await human.request("rename", { from: "niche-manager-2", name: "suffix-holder" });
      } else {
        const suffix = await env.adapter("omp", "suffix-key", "niche-manager-2");
        await suffix.client.request("rename", { name: "suffix-holder" });
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
  await assert.rejects(env.adapter("opencode", "shared-id", "shared-name"), { code: "name_taken" });
  const opencode = await env.adapter("opencode", "shared-id", "opencode-peer");
  assert.notEqual(omp.session.id, opencode.session.id);
  assert.equal(opencode.session.name, "opencode-peer");
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
  assert.equal((await human.request("sync")).failedCount, 0);
  const conn = net.createConnection(decodeURIComponent(frame.from.slice(4)));
  const failed = await env.watch(isStatus(sent.msgId, "failed"));
  conn.write(JSON.stringify({ type: "control", action: "peer_message_status", msg_id: frame.msg_id, status: "failed", reason: "peer unavailable" }) + "\n");
  const failedEvent = await failed.event;
  assert.ok("failedCount" in failedEvent);
  assert.equal(failedEvent.failedCount, 1);
  assert.equal((await human.request("sync")).failedCount, 1);
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
  const receiver = env.human();
  await receiver.request("claude_attach", { sessionId: "s1" });
  assert.equal((await send(receiver, "human", "reply after failure", { replyTo: sent.msgId }))[0].status, "posted");
  assert.equal((await logOf(human, sent.msgId!)).status, "failed");
  await receiver.request("ack", { msgId: sent.msgId, ok: true });
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

test("broadcast scopes channel members to the union of live co-members without duplicates or self", async () => {
  env = await startEnv();
  const human = env.human();
  const sender = await env.adapter("omp", "sender", "sender");
  const overlap = await env.adapter("opencode", "overlap", "overlap", { cwd: "/other" });
  const second = await env.adapter("omp", "second", "second");
  const outsider = await env.adapter("omp", "outsider", "outsider");
  const offline = await env.adapter("omp", "offline", "offline");
  const removed = await env.adapter("omp", "removed", "removed");
  for (const [channel, names] of [
    ["first", ["sender", "overlap", "offline", "removed"]],
    ["second", ["sender", "overlap", "second"]],
    ["unrelated", ["outsider"]],
  ] as const) {
    await human.request("channel_create", { channel });
    for (const name of names) await human.request("channel_add", { channel, name });
  }
  const removedGone = await env.watch(isSession("gone", "removed"));
  removed.client.close();
  await removedGone.event;
  env.clock.advance(GRACE_MS + 1);
  env.daemon.sweep();
  assert.equal(await sessionState(human, "removed"), undefined);
  const gone = await env.watch(isSession("gone", "offline"));
  offline.client.close();
  await gone.event;
  const results = await send(sender.client, "*", "scoped broadcast");
  assert.deepEqual(results.map((r) => [r.to, r.status]).sort(), [
    ["overlap", "delivered"], ["second", "delivered"],
  ]);
  for (const member of [overlap, second]) {
    assert.deepEqual(member.deliveries.map((p) => [p.msg.from, p.msg.to, p.msg.text]), [
      ["sender", member.session.name, "scoped broadcast"],
    ]);
  }
  assert.deepEqual(sender.deliveries, []);
  assert.deepEqual(outsider.deliveries, []);
  const history = (await human.request("log", { name: "sender" })).messages as StoredMessage[];
  assert.deepEqual(history.map((m) => m.to).sort(), ["overlap", "second"]);
});

test("broadcast keeps an isolated member scoped, then restores machine-wide reach after its last membership is removed", async () => {
  env = await startEnv();
  const human = env.human();
  const sender = await env.adapter("omp", "sender", "sender");
  const peer = await env.adapter("opencode", "peer", "peer");
  await human.request("channel_create", { channel: "alone" });
  await human.request("channel_add", { channel: "alone", name: "sender" });
  assert.deepEqual(await send(sender.client, "*", "nobody shares my channel"), []);
  const [direct] = await send(sender.client, "peer", "direct remains unrestricted");
  assert.equal(direct.status, "delivered");
  await human.request("channel_remove", { channel: "alone", name: "sender" });
  assert.deepEqual((await send(sender.client, "*", "machine-wide agent")).map((r) => [r.to, r.status]), [
    ["peer", "delivered"],
  ]);
  assert.deepEqual((await send(human, "*", "machine-wide human")).map((r) => [r.to, r.status]).sort(), [
    ["peer", "delivered"], ["sender", "delivered"],
  ]);
  assert.deepEqual(peer.deliveries.map((p) => p.msg.text), [
    "direct remains unrestricted", "machine-wide agent", "machine-wide human",
  ]);
  assert.deepEqual(sender.deliveries.map((p) => p.msg.text), ["machine-wide human"]);
});

test("broadcast scope follows the selected identity on a shared OpenCode connection", async () => {
  env = await startEnv();
  const human = env.human();
  const shared = await env.adapter("opencode", "scoped", "scoped");
  const unscoped = (await shared.client.request("register", {
    harness: "opencode", key: "unscoped", name: "unscoped", cwd: "/work",
  })).session as { id: string };
  const peer = await env.adapter("omp", "peer", "peer");
  await human.request("channel_create", { channel: "work" });
  for (const name of ["scoped", "peer"]) await human.request("channel_add", { channel: "work", name });
  assert.deepEqual((await send(shared.client, "*", "selected member", { as: shared.session.id }))
    .map((r) => [r.to, r.status]), [["peer", "delivered"]]);
  assert.deepEqual((await send(shared.client, "*", "selected non-member", { as: unscoped.id }))
    .map((r) => [r.to, r.status]).sort(), [["peer", "delivered"], ["scoped", "delivered"]]);
  assert.deepEqual(peer.deliveries.map((p) => [p.msg.from, p.msg.text]), [
    ["scoped", "selected member"], ["unscoped", "selected non-member"],
  ]);
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
  for (const client of [worker.client, outside.client]) {
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
  const multiCreated = (await multi.client.request("channel_create", { channel: "multi-work", as: multi.session.id })).channel as { memberIds: string[] };
  assert.deepEqual(multiCreated.memberIds, [multi.session.id]);
  await assert.rejects(multi.client.request("channel_add", { channel: "multi-work", name: "worker", as: worker.id }), { code: "not_permitted" });
  await multi.client.request("channel_remove", { channel: "work", name: "target", as: multi.session.id });
  await claude.request("channel_add", { channel: "work", name: "target" });
  await claude.request("set_role", { name: "target", role: null });
  assert.equal((await human.sync()).sessions.find((s) => s.id === target.session.id)?.role, null);
  await assert.rejects(claude.request("channel_remove", { channel: "work", sessionId: target.session.id }), { code: "not_permitted" });
  const created = (await claude.request("channel_create", { channel: "claude-work" })).channel as { memberIds: string[] };
  const claudeIdentity = (await human.sync()).sessions.find((s) => s.name === "claude")!;
  assert.deepEqual(created.memberIds, [claudeIdentity.id]);
});

test("orchestrators bootstrap new channels and explicitly self-join existing channels before managing others", async () => {
  env = await startEnv();
  const human = env.human();
  const orch = await env.adapter("omp", "orch-key", "orch");
  const worker = await env.adapter("omp", "worker-key", "worker");
  const unset = await env.adapter("omp", "unset-key", "unset");
  await human.request("set_role", { name: "orch", role: "orchestrator" });
  await human.request("set_role", { name: "worker", role: "worker" });
  const before = await human.sync();
  const created = (await orch.client.request("channel_create", { channel: "new" })).channel;
  assert.deepEqual(created, { name: "new", count: 0, lastAt: 0, lastOrder: 0, memberIds: [orch.session.id] });
  await orch.client.request("channel_add", { channel: "new", name: "worker" });
  await human.request("channel_create", { channel: "existing" });
  assert.deepEqual((await orch.client.request("channel_create", { channel: "existing" })).channel,
    { name: "existing", count: 0, lastAt: 0, lastOrder: 0, memberIds: [] });
  await assert.rejects(orch.client.request("channel_add", { channel: "existing", name: "worker" }), { code: "not_permitted" });
  await assert.rejects(orch.client.request("set_role", { name: "unset", role: "worker" }), { code: "not_permitted" });
  await assert.rejects(unset.client.request("channel_create", { channel: "unset-denied" }), { code: "not_permitted" });
  await assert.rejects(unset.client.request("channel_add", { channel: "existing", name: "unset" }), { code: "not_permitted" });
  await orch.client.request("channel_add", { channel: "existing", name: "orch" });
  await orch.client.request("channel_add", { channel: "existing", name: "unset" });
  await orch.client.request("set_role", { name: "unset", role: "worker" });
  await orch.client.request("channel_remove", { channel: "existing", name: "unset" });
  for (const participant of [worker, unset]) {
    await assert.rejects(participant.client.request("channel_create", { channel: "denied" }), { code: "not_permitted" });
    await assert.rejects(participant.client.request("channel_add", { channel: "existing", name: participant.session.name }), { code: "not_permitted" });
  }
  await orch.client.request("channel_send", { channel: "post-only", text: "implicit creates still have no roster" });
  assert.deepEqual((await human.sync()).channels.find((c) => c.name === "post-only")?.memberIds, []);
  await orch.client.request("channel_remove", { channel: "new", name: "orch" });
  assert.deepEqual((await orch.client.request("channel_create", { channel: "new" })).channel,
    { name: "new", count: 0, lastAt: 0, lastOrder: 0, memberIds: [worker.session.id] });
  await assert.rejects(orch.client.request("channel_remove", { channel: "new", name: "worker" }), { code: "not_permitted" });
  await orch.client.request("channel_add", { channel: "new", name: "orch" });
  await orch.client.request("channel_remove", { channel: "new", name: "worker" });
  const replay = await human.replay(before.watermark);
  const creation = replay.events.filter(({ event }) => event.type === "channel" && event.action === "created" && event.channel.name === "new");
  assert.deepEqual(creation.map(({ event }) => event.type === "channel" && event.channel.memberIds), [[orch.session.id]]);
  assert.deepEqual((await human.sync()).channels.find((c) => c.name === "new")?.memberIds, [orch.session.id]);
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
  const queued = await human.sendToSession(original.session.id, "must not retarget");
  assert.equal(queued.status, "queued");
  assert.deepEqual(replacement.deliveries, []);
  assert.deepEqual((await human.historyPage({ scope: "session", sessionId: original.session.id })).messages.map(
    (message) => [message.id, message.toSessionId, message.status],
  ), [[originalMessage.msgId, original.session.id, "delivered"], [queued.msgId, original.session.id, "queued"]]);
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

test("only the human can close stable identities; close expires held and in-flight messages exactly once", async () => {
  env = await startEnv();
  const human = env.human();
  const alpha = await env.adapter("omp", "close-sender", "alpha");
  const beta = await env.adapter("omp", "close-target", "beta", { autoAck: false });
  await assert.rejects(alpha.client.request("close", { identity: beta.session.id }), { code: "bad_request" });
  await assert.rejects(alpha.client.request("purge", { all: true }), { code: "bad_request" });
  await assert.rejects(human.request("close", { identity: "beta" }), { code: "no_session" });
  await assert.rejects(human.request("close", { identity: "s_unknown" }), { code: "no_session" });
  await human.request("set_inbound", { name: "beta", mode: "hold" });
  const [held] = await send(alpha.client, "beta", "held until a human decides");
  await human.request("set_inbound", { name: "beta", mode: "accept" });
  const sending = send(alpha.client, "beta", "already in flight");
  const delivery = await beta.nextDelivery();
  const heldNotice = await env.watch((event) => event.type === "message"
    && event.msg.from === "asenq" && event.msg.replyTo === held.msgId && event.status === "delivered");
  const flightNotice = await env.watch((event) => event.type === "message"
    && event.msg.from === "asenq" && event.msg.replyTo === delivery.msg.id && event.status === "delivered");
  const closed = (await human.request("close", { identity: beta.session.id })).session as SessionIdentity;
  assert.deepEqual([closed.id, closed.state, closed.closedAt], [beta.session.id, "removed", env.clock.now()]);
  assert.equal((await sending)[0].status, "expired");
  await heldNotice.event;
  await flightNotice.event;
  assert.equal((await logOf(human, held.msgId!)).status, "expired");
  assert.equal((await logOf(human, delivery.msg.id)).status, "expired");
  await beta.client.request("ack", { msgId: delivery.msg.id, ok: true });
  await assert.rejects(human.request("release", { msgId: held.msgId }), { code: "bad_request" });
  await assert.rejects(send(human, "beta", "closed name"), { code: "unknown_target" });
  await assert.rejects(human.sendToSession(beta.session.id, "closed identity"), { code: "unknown_target" });
  // The old transport stays agent-bound even though its registration has been removed.
  await assert.rejects(beta.client.request("purge", { all: true }), { code: "not_registered" });
  const beforeRepeat = await human.sync();
  assert.deepEqual((await human.request("close", { identity: beta.session.id })).session, closed);
  assert.equal((await human.sync()).watermark, beforeRepeat.watermark);
  await env.daemon.retry();
  assert.deepEqual(beta.deliveries.map((item) => item.msg.id), [delivery.msg.id]);
  const notices = (await alpha.client.request("inbox")).messages as StoredMessage[];
  assert.deepEqual(notices.map((message) => message.replyTo).sort(), [held.msgId, delivery.msg.id].sort());
  assert.ok(notices.every((message) => message.from === "asenq" && message.status === "delivered"));
});

test("close of a non-terminal archive expires its retained queue and never revives its former names", async () => {
  env = await startEnv();
  const human = env.human();
  const alpha = await env.adapter("omp", "archive-sender", "alpha");
  const beta = await env.adapter("omp", "archive-target", "beta");
  await beta.client.request("rename", { name: "renamed" });
  const gone = await env.watch(isSession("gone", "renamed"));
  beta.client.close();
  await gone.event;
  const [queued] = await send(alpha.client, "renamed", "waiting through automatic removal");
  env.clock.advance(GRACE_MS);
  env.daemon.sweep();
  const archived = (await human.sync()).sessions.find((session) => session.id === beta.session.id)!;
  assert.equal(archived.state, "removed");
  assert.equal(archived.closedAt, undefined);
  const noticed = await env.watch((event) => event.type === "message"
    && event.msg.from === "asenq" && event.msg.replyTo === queued.msgId && event.status === "delivered");
  await human.request("close", { identity: beta.session.id });
  await noticed.event;
  assert.equal((await logOf(human, queued.msgId!)).status, "expired");
  for (const name of ["beta", "renamed"]) {
    await assert.rejects(send(human, name, "must not resolve terminal identity"), { code: "unknown_target" });
  }
  const replacement = await env.adapter("omp", "archive-target", "replacement");
  assert.notEqual(replacement.session.id, beta.session.id);
  assert.deepEqual(replacement.deliveries, []);
});

test("purge deletes only archived direct history and markers, retaining channel posts, activity and sender notices", async () => {
  env = await startEnv();
  const human = env.human();
  const alpha = await env.adapter("omp", "purge-sender", "alpha");
  const beta = await env.adapter("omp", "purge-archive", "beta", { autoAck: false });
  const live = await env.adapter("omp", "purge-live", "live");
  const [betaHuman] = await send(beta.client, "human", "archive human inbox");
  const [unrelated] = await send(live.client, "human", "preserve this human inbox");
  const channel = await beta.client.request("channel_send", { channel: "work", text: "keep this channel post" });
  const betaScope = { scope: "session" as const, sessionId: beta.session.id };
  await human.markUnread(betaScope);
  const liveScope = { scope: "session" as const, sessionId: live.session.id };
  await human.markUnread(liveScope);
  const liveRead = await human.readState(liveScope);
  const channelScope = { scope: "channel" as const, channel: "work" };
  await human.markUnread(channelScope);
  const channelRead = await human.readState(channelScope);
  const sending = send(alpha.client, "beta", "expire then purge");
  const delivery = await beta.nextDelivery();
  const noticed = await env.watch((event) => event.type === "message"
    && event.msg.from === "asenq" && event.msg.replyTo === delivery.msg.id && event.status === "delivered");
  await human.request("close", { identity: beta.session.id });
  assert.equal((await sending)[0].status, "expired");
  await noticed.event;
  const notice = ((await alpha.client.request("inbox")).messages as StoredMessage[])[0];
  assert.equal(notice.replyTo, delivery.msg.id);
  assert.equal(notice.replyToMissing, undefined);
  const [reply] = await send(alpha.client, "human", "retained reply to the original", {
    replyTo: delivery.msg.id, thread: "purged-reply",
  });
  const before = await human.sync();
  const reset = await env.watch((event) => event.type === "retention");
  assert.deepEqual((await human.request("purge", { identity: beta.session.id })).purged, [beta.session.id]);
  await reset.event;
  await beta.client.request("ack", { msgId: delivery.msg.id, ok: true });
  await assert.rejects(logOf(human, betaHuman.msgId!), { code: "bad_request" });
  await assert.rejects(logOf(human, delivery.msg.id), { code: "bad_request" });
  await assert.rejects(human.historyPage(betaScope), { code: "no_session" });
  await assert.rejects(human.readState(betaScope), { code: "no_session" });
  const after = await human.sync();
  assert.ok(!after.sessions.some((session) => session.id === beta.session.id));
  assert.equal(after.sessionLastOrders[beta.session.id], undefined);
  assert.equal(after.sessionLastActivity[beta.session.id], undefined);
  assert.ok(!after.readStates.some((state) => state.scope.scope === "session" && state.scope.sessionId === beta.session.id));
  assert.deepEqual(await human.readState(liveScope), liveRead);
  assert.deepEqual(await human.readState(channelScope), channelRead);
  assert.deepEqual((await human.inboxSummaries()).map((summary) => summary.latest.id), [reply.msgId, unrelated.msgId]);
  assert.deepEqual((await human.historyPage(channelScope)).messages.map((message) => [message.id, message.from]),
    [[channel.msgId, "beta"]]);
  const retainedNotice = ((await alpha.client.request("inbox")).messages as StoredMessage[])[0];
  assert.deepEqual([retainedNotice.id, retainedNotice.replyTo, retainedNotice.replyToMissing],
    [notice.id, delivery.msg.id, true]);
  const retainedReply = (await human.historyPage({ scope: "inbox" })).messages.find((message) => message.id === reply.msgId)!;
  assert.deepEqual([retainedReply.replyTo, retainedReply.replyToMissing], [delivery.msg.id, true]);
  const thread = (await human.request("thread_read", { thread: "purged-reply" })).messages as StoredMessage[];
  assert.deepEqual(thread.map((message) => [message.id, message.replyToMissing]), [[reply.msgId, true]]);
  for (const events of [await human.recentEvents(200), (await human.replay(0)).events]) {
    assert.ok(!events.some(({ event }) => event.type === "session" && event.session.id === beta.session.id));
    assert.ok(!events.some(({ event }) => event.type === "read"
      && event.state.scope.scope === "session" && event.state.scope.sessionId === beta.session.id));
    assert.ok(!events.some(({ event }) => event.type === "message" && event.msg.channel === undefined
      && (event.msg.fromSessionId === beta.session.id || event.msg.toSessionId === beta.session.id)));
    assert.ok(events.some(({ event }) => event.type === "message" && event.msg.id === channel.msgId));
    assert.ok(events.some(({ event }) => event.type === "message" && event.msg.id === unrelated.msgId));
    assert.ok(events.filter(({ event }) => event.type === "message" && event.msg.id === notice.id)
      .every(({ event }) => event.type === "message" && event.msg.replyToMissing === true));
  }
  assert.ok(after.watermark > before.watermark);
  const replay = await human.replay(before.watermark);
  assert.deepEqual(replay.events.map((entry) => [entry.position, entry.event.type]), [[before.watermark + 1, "retention"]]);
  await env.daemon.retry();
  assert.deepEqual(beta.deliveries.map((item) => item.msg.id), [delivery.msg.id]);
});

test("purge validates exclusive parameters and never deletes live or gone identities", async () => {
  env = await startEnv();
  const human = env.human();
  const live = await env.adapter("omp", "purge-still-live", "live");
  const gone = await env.adapter("omp", "purge-gone", "gone");
  const archive = await env.adapter("omp", "purge-removed", "archive");
  const closed = await env.adapter("omp", "purge-closed", "closed");
  await archive.client.request("unregister");
  await human.request("close", { identity: closed.session.id });
  const disappeared = await env.watch(isSession("gone", "gone"));
  gone.client.close();
  await disappeared.event;
  for (const params of [{}, { all: false }, { all: "true" }, { identity: archive.session.id, all: true }]) {
    await assert.rejects(human.request("purge", params), { code: "bad_request" });
  }
  for (const identity of [live.session.id, gone.session.id]) {
    await assert.rejects(human.request("purge", { identity }), { code: "bad_request" });
  }
  await assert.rejects(human.request("purge", { identity: "archive" }), { code: "no_session" });
  assert.deepEqual(((await human.request("purge", { all: true })).purged as string[]).sort(),
    [archive.session.id, closed.session.id].sort());
  assert.deepEqual((await human.sync()).sessions.map((session) => [session.id, session.state]).sort(),
    [[live.session.id, "live"], [gone.session.id, "gone"]].sort());
  assert.deepEqual((await human.request("purge", { all: true })).purged, []);
  await assert.rejects(human.request("purge", { identity: closed.session.id }), { code: "no_session" });
});

test("terminal omp close clears the harness association once, then the replacement identity revives normally", async () => {
  env = await startEnv();
  let human = env.human();
  const original = await env.adapter("omp", "same-harness-id", "original");
  await original.client.request("rename", { name: "old-role" });
  await human.request("close", { identity: original.session.id });
  const fresh = await env.adapter("omp", "same-harness-id", "fresh");
  assert.notEqual(fresh.session.id, original.session.id);
  assert.equal(fresh.session.name, "fresh");
  await fresh.client.request("rename", { name: "new-role" });
  await fresh.client.request("unregister");
  assert.deepEqual((await env.adapter("omp", "same-harness-id", "ignored")).session,
    { id: fresh.session.id, name: "new-role" });
  // Re-closing the old archive must not delete the new association for the reused harness id.
  await human.request("close", { identity: original.session.id });
  await env.restart();
  human = env.human();
  const resumed = await env.adapter("omp", "same-harness-id", "ignored-after-restart");
  assert.deepEqual(resumed.session, { id: fresh.session.id, name: "new-role" });
  assert.equal((await human.sync()).sessions.find((session) => session.id === original.session.id)?.closedAt,
    1_700_000_000_000);
});

test("Claude terminal close forgets both recorded session ids and transcript lineage, without breaking later revival", async () => {
  env = await startEnv();
  const human = env.human();
  const path = join(env.home, "terminal-lineage.jsonl");
  writeFileSync(path, '{"type":"user","uuid":"terminal-lineage-message"}\n' + "{}\n".repeat(7));
  const original = (await human.request("claude_hook", {
    event: "start", key: "old-process", sessionId: "old-claude", name: "original",
    transcriptPath: path, source: "startup",
  })).session as { id: string; name: string };
  const attached = env.human();
  await attached.request("claude_attach", { sessionId: "old-claude" });
  await assert.rejects(attached.request("close", { identity: original.id }), { code: "bad_request" });
  await human.request("close", { identity: original.id });
  await assert.rejects(attached.request("purge", { all: true }), { code: "not_registered" });
  const fresh = (await human.request("claude_hook", {
    event: "start", key: "new-process", sessionId: "new-claude", name: "fresh",
    transcriptPath: path, source: "resume",
  })).session as { id: string; name: string };
  assert.notEqual(fresh.id, original.id);
  assert.equal(fresh.name, "fresh");
  await assert.rejects(env.human().request("claude_attach", { sessionId: "old-claude" }), { code: "no_session" });
  await human.request("close", { identity: original.id });
  await human.request("claude_hook", { event: "end", sessionId: "new-claude" });
  assert.deepEqual((await human.request("claude_hook", {
    event: "start", key: "third-process", sessionId: "third-claude", name: "ignored",
    transcriptPath: path, source: "resume",
  })).session, fresh);
  await human.request("claude_hook", { event: "end", sessionId: "third-claude" });
  assert.deepEqual((await human.request("claude_hook", {
    event: "start", key: "fourth-process", sessionId: "new-claude", name: "ignored-again",
  })).session, fresh);
});

test("direct activity uses outgoing creation and first incoming delivery, ignoring held messages and channel posts", async () => {
  env = await startEnv();
  const human = env.human();
  const alpha = await env.adapter("omp", "stale-sender", "alpha");
  const beta = await env.adapter("omp", "stale-target", "beta");
  const idle = await env.adapter("omp", "stale-idle", "idle");
  const created = env.clock.now();
  await human.request("set_inbound", { name: "beta", mode: "hold" });
  env.clock.advance(3600_000);
  const [held] = await send(alpha.client, "beta", "not incoming activity until delivered");
  await beta.client.request("channel_send", { channel: "work", text: "not direct activity" });
  let synced = await human.sync();
  assert.equal(synced.sessionLastActivity[alpha.session.id], created + 3600_000);
  assert.equal(synced.sessionLastActivity[beta.session.id], undefined);
  assert.equal(synced.sessionLastActivity[idle.session.id], undefined);
  assert.equal((await human.request("release", { msgId: held.msgId })).status, "delivered");
  const deliveredAt = env.clock.now();
  synced = await human.sync();
  assert.equal(synced.sessionLastActivity[beta.session.id], deliveredAt);
  env.clock.advance(3600_000);
  await beta.client.request("ack", { msgId: held.msgId, ok: true });
  assert.equal((await human.sync()).sessionLastActivity[beta.session.id], deliveredAt);
});

test("offline incoming activity starts at late delivery, never queue creation", async () => {
  env = await startEnv();
  const human = env.human();
  const beta = await env.adapter("omp", "late-delivery", "beta");
  const gone = await env.watch(isSession("gone", "beta"));
  beta.client.close();
  await gone.event;
  env.clock.advance(3600_000);
  const [queued] = await send(human, "beta", "late activity");
  assert.equal(queued.status, "queued");
  assert.equal((await human.sync()).sessionLastActivity[beta.session.id], undefined);
  env.clock.advance(12 * 3600_000);
  const delivered = await env.watch(isStatus(queued.msgId, "delivered"));
  const resumed = await env.adapter("omp", "late-delivery", "ignored");
  assert.equal((await resumed.nextDelivery()).msg.id, queued.msgId);
  await delivered.event;
  const synced = await human.sync();
  assert.equal(synced.sessionLastActivity[beta.session.id], env.clock.now());
});

test("direct activity survives message retention and database reopen", async () => {
  env = await startEnv({ historyDays: 1 });
  let human = env.human();
  const alpha = await env.adapter("omp", "durable-activity", "alpha");
  const created = env.clock.now();
  env.clock.advance(3 * 86_400_000);
  await send(alpha.client, "human", "direct activity at day three");
  const activeAt = env.clock.now();
  env.clock.advance(2 * 86_400_000);
  env.daemon.prune();
  assert.deepEqual((await human.historyPage({ scope: "session", sessionId: alpha.session.id })).messages, []);
  await env.restart();
  human = env.human();
  const resumed = await env.adapter("omp", "durable-activity", "ignored");
  assert.equal(resumed.session.id, alpha.session.id);
  const synced = await human.sync();
  const session = synced.sessions.find((identity) => identity.id === alpha.session.id)!;
  assert.equal(synced.sessionLastActivity[session.id], activeAt);
  assert.equal(session.createdAt, created);
});

test("reply availability treats private and missing targets identically for agents, while human history is authoritative", async () => {
  env = await startEnv();
  const human = env.human();
  const alpha = await env.adapter("omp", "reply-reader", "alpha");
  const beta = await env.adapter("omp", "reply-private-sender", "beta");
  const gamma = await env.adapter("omp", "reply-private-target", "gamma");
  const [privateMessage] = await send(beta.client, "gamma", "private beta to gamma");
  const [privateReply] = await send(alpha.client, "human", "reply to private id", {
    replyTo: privateMessage.msgId, thread: "availability",
  });
  const [missingReply] = await send(alpha.client, "human", "reply to absent id", {
    replyTo: "m_not_retained", thread: "availability",
  });
  const agentThread = (await alpha.client.request("thread_read", { thread: "availability" })).messages as StoredMessage[];
  assert.deepEqual(agentThread.map((message) => [message.id, message.replyToMissing]),
    [[privateReply.msgId, true], [missingReply.msgId, true]]);
  const humanThread = (await human.request("thread_read", { thread: "availability" })).messages as StoredMessage[];
  assert.deepEqual(humanThread.map((message) => [message.id, message.replyToMissing]),
    [[privateReply.msgId, undefined], [missingReply.msgId, true]]);
  const [incomingPrivate] = await send(human, "alpha", "incoming reply to inaccessible id", { replyTo: privateMessage.msgId });
  const [incomingMissing] = await send(human, "alpha", "incoming reply to missing id", { replyTo: "m_not_retained" });
  const inbox = (await alpha.client.request("inbox")).messages as StoredMessage[];
  assert.deepEqual(inbox.map((message) => [message.id, message.replyToMissing]),
    [[incomingMissing.msgId, true], [incomingPrivate.msgId, true]]);
});

test("purge settles delivery still waiting on a non-terminal removed transport without restoring its deleted message", async () => {
  env = await startEnv();
  const human = env.human();
  const alpha = await env.adapter("omp", "purge-flight-sender", "alpha");
  const beta = await env.adapter("omp", "purge-flight-target", "beta", { autoAck: false });
  const sending = send(alpha.client, "beta", "purged while awaiting adapter ack");
  const delivery = await beta.nextDelivery();
  await beta.client.request("unregister");
  assert.equal((await logOf(human, delivery.msg.id)).status, "queued");
  assert.deepEqual((await human.request("purge", { identity: beta.session.id })).purged, [beta.session.id]);
  assert.equal((await sending)[0].status, "expired");
  await beta.client.request("ack", { msgId: delivery.msg.id, ok: true });
  await env.daemon.retry();
  await assert.rejects(logOf(human, delivery.msg.id), { code: "bad_request" });
  assert.deepEqual(beta.deliveries.map((item) => item.msg.id), [delivery.msg.id]);
  assert.deepEqual((await alpha.client.request("inbox")).messages, []);
});

test("purging an old terminal identity leaves the replacement harness association intact", async () => {
  env = await startEnv();
  const human = env.human();
  const old = await env.adapter("omp", "purged-reused-key", "old");
  await human.request("close", { identity: old.session.id });
  const replacement = await env.adapter("omp", "purged-reused-key", "replacement");
  await human.request("purge", { identity: old.session.id });
  await replacement.client.request("unregister");
  assert.deepEqual((await env.adapter("omp", "purged-reused-key", "ignored")).session, replacement.session);
  await assert.rejects(human.historyPage({ scope: "session", sessionId: old.session.id }), { code: "no_session" });
});

test("late Claude lineage carries durable provisional direct activity after its original messages were retained away", async () => {
  env = await startEnv({ historyDays: 1, queueTtlMs: 7 * 86_400_000 });
  const human = env.human();
  const originalPath = join(env.home, "activity-ancestor.jsonl");
  const latePath = join(env.home, "activity-late.jsonl");
  const head = '{"type":"user","uuid":"activity-lineage-message"}\n' + "{}\n".repeat(7);
  writeFileSync(originalPath, head);
  const ancestor = (await human.request("claude_hook", {
    event: "start", key: "activity-original", sessionId: "activity-original", name: "ancestor",
    transcriptPath: originalPath, source: "startup",
  })).session as { id: string; name: string };
  await send(human, ancestor.name, "retain the ancestor while lineage arrives");
  await human.request("claude_hook", { event: "end", sessionId: "activity-original" });
  const provisional = (await human.request("claude_hook", {
    event: "start", key: "activity-provisional", sessionId: "activity-provisional", name: "provisional",
    transcriptPath: latePath, source: "resume",
  })).session as { id: string; name: string };
  assert.notEqual(provisional.id, ancestor.id);
  const attached = env.human();
  await attached.request("claude_attach", { sessionId: "activity-provisional" });
  env.clock.advance(3600_000);
  await send(attached, "human", "provisional direct activity");
  const activeAt = env.clock.now();
  env.clock.advance(2 * 86_400_000);
  env.daemon.prune();
  assert.deepEqual((await human.historyPage({ scope: "session", sessionId: provisional.id })).messages, []);
  writeFileSync(latePath, head);
  assert.deepEqual((await human.request("claude_hook", {
    event: "reconcile", sessionId: "activity-provisional", transcriptPath: latePath,
  })).session, ancestor);
  const synced = await human.sync();
  assert.equal(synced.sessionLastActivity[ancestor.id], activeAt);
  assert.equal(synced.sessionLastActivity[provisional.id], undefined);
});

test("human ping distinguishes quiet responsive, hung, dead Claude, hook-only Claude and legacy sessions", async () => {
  env = await startEnv({ pingTimeoutMs: 20 });
  const human = env.human();
  const responsive = await env.adapter("omp", "ping-responsive", "z-responsive");
  const hung = await env.adapter("opencode", "ping-hung", "a-hung", { autoPong: false });
  const legacy = await env.adapter("omp", "ping-legacy", "d-legacy", { pingSupport: false });
  const dead = (await human.request("claude_hook", {
    event: "start", key: "ping-dead", sessionId: "ping-dead", name: "b-dead",
    socket: join(env.home, "missing-claude.sock"),
  })).session as { id: string; name: string };
  const hookOnly = await env.adapter("claude", "ping-hook", "c-hook");
  env.clock.advance(6 * 3600_000);
  const responding = await env.watch((event) => event.type === "ping"
    && event.sessionId === responsive.session.id && event.ping === "responding");
  const deadResult = await env.watch((event) => event.type === "ping" && event.sessionId === dead.id);
  const pending = human.request("ping");
  await hung.nextPing();
  await responding.event;
  await deadResult.event;
  env.clock.advance(19);
  env.daemon.sweep();
  assert.equal((await human.sync()).sessionPings[hung.session.id], undefined);
  env.clock.advance(1);
  env.daemon.sweep();
  assert.deepEqual((await pending).results, [
    { sessionId: hung.session.id, name: "a-hung", ping: "not_responding" },
    { sessionId: dead.id, name: "b-dead", ping: "not_responding" },
    { sessionId: hookOnly.session.id, name: "c-hook", ping: "unknown" },
    { sessionId: legacy.session.id, name: "d-legacy", ping: "unknown" },
    { sessionId: responsive.session.id, name: "z-responsive", ping: "responding" },
  ]);
  assert.deepEqual(hookOnly.pings, []);
  assert.deepEqual(legacy.pings, []);
  const snapshot = await human.sync();
  assert.ok(snapshot.sessions.every((session) => session.state === "live"));
  assert.equal(snapshot.sessionLastActivity[responsive.session.id], undefined);
  const stale = snapshot.sessions.filter((session) => isStaleSession(session, snapshot.sessionPings[session.id]));
  assert.deepEqual(stale.map((session) => session.id).sort(), [hung.session.id, dead.id].sort());
  for (const session of stale) await human.request("close", { identity: session.id });
  assert.deepEqual((await human.sync()).sessions.filter((session) => session.state === "live")
    .map((session) => session.id).sort(), [responsive.session.id, hookOnly.session.id, legacy.session.id].sort());
});

test("several unanswered pings share one timeout window and outlive the ordinary client timeout", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const pingTimeoutMs = 6000;
  env = await startEnv({ pingTimeoutMs });
  const human = env.human();
  const targets = await Promise.all(["alpha", "beta", "gamma"].map((name) =>
    env!.adapter("omp", `parallel-ping-${name}`, name, { autoPong: false })));
  const pending = human.request("ping");
  let settled = false;
  let failure: unknown;
  void pending.then(() => { settled = true; }, (error: unknown) => { settled = true; failure = error; });
  await Promise.all(targets.map((target) => target.nextPing()));
  env.clock.advance(5001);
  context.mock.timers.tick(5001);
  env.daemon.sweep();
  await human.request("list");
  assert.equal(failure, undefined, "ping must not inherit the ordinary five-second client deadline");
  assert.equal(settled, false, "all targets are still inside their shared ping deadline");
  env.clock.advance(pingTimeoutMs - 5001);
  context.mock.timers.tick(pingTimeoutMs - 5001);
  env.daemon.sweep();
  assert.deepEqual((await pending).results, targets.map((target) => ({
    sessionId: target.session.id, name: target.session.name, ping: "not_responding",
  })));
});

test("ping targets current names or stable ids and denies every bound agent, even on multi-session connections", async () => {
  env = await startEnv();
  const human = env.human();
  const alpha = await env.adapter("omp", "ping-target", "alpha");
  await alpha.client.request("rename", { name: "renamed" });
  const expected = [{ sessionId: alpha.session.id, name: "renamed", ping: "responding" }];
  assert.deepEqual((await human.request("ping", { name: "renamed" })).results, expected);
  assert.deepEqual((await human.request("ping", { sessionId: alpha.session.id })).results, expected);
  await assert.rejects(human.request("ping", { name: "alpha" }), { code: "unknown_target" });
  await assert.rejects(human.request("ping", { sessionId: "s_missing" }), { code: "unknown_target" });
  await assert.rejects(human.request("ping", { name: "renamed", sessionId: alpha.session.id }), { code: "bad_request" });
  await assert.rejects(alpha.client.request("ping"), { code: "bad_request" });
  await alpha.client.request("register", { harness: "opencode", key: "second-ping-binding", name: "second", caps: ["ping"] });
  await assert.rejects(alpha.client.request("ping"), { code: "bad_request" });
  await assert.rejects(alpha.client.request("ping", { as: alpha.session.id }), { code: "bad_request" });
  const claude = (await human.request("claude_hook", {
    event: "start", key: "attached-ping", sessionId: "attached-ping", name: "claude",
  })).session as { id: string };
  const attached = env.human();
  await attached.request("claude_attach", { sessionId: "attached-ping" });
  await assert.rejects(attached.request("ping", { sessionId: claude.id }), { code: "bad_request" });
});

test("foreign and expired pongs are harmless; default timeout uses clock and only a current response replaces failure", async () => {
  env = await startEnv();
  const human = env.human();
  const alpha = await env.adapter("omp", "ping-token", "alpha", { autoPong: false });
  const foreign = await env.adapter("omp", "ping-foreign", "foreign", { autoPong: false });
  const pending = human.request("ping", { sessionId: alpha.session.id });
  const ping = await alpha.nextPing();
  await foreign.client.request("pong", { pingId: ping.pingId });
  await human.request("pong", { pingId: ping.pingId });
  await alpha.client.request("pong", { pingId: "unknown-token" });
  assert.deepEqual((await human.sync()).sessionPings, {});
  env.clock.advance(2999);
  env.daemon.sweep();
  assert.deepEqual((await human.sync()).sessionPings, {});
  env.clock.advance(1);
  // timers:false never expires a request without the explicit sweep, even beyond the deadline.
  let settled = false;
  void pending.then(() => { settled = true; });
  await human.sync();
  assert.equal(settled, false);
  env.daemon.sweep();
  assert.deepEqual((await pending).results, [{ sessionId: alpha.session.id, name: "alpha", ping: "not_responding" }]);
  await alpha.client.request("pong", { pingId: ping.pingId });
  assert.deepEqual((await human.sync()).sessionPings, { [alpha.session.id]: "not_responding" });
  const updated = await env.watch((event) => event.type === "ping" && event.sessionId === alpha.session.id
    && event.ping === "responding");
  const next = human.request("ping", { name: "alpha" });
  const fresh = await alpha.nextPing();
  await alpha.client.request("pong", { pingId: fresh.pingId });
  await next;
  assert.deepEqual(await updated.event, { type: "ping", sessionId: alpha.session.id, ping: "responding" });
  assert.deepEqual((await human.sync()).sessionPings, { [alpha.session.id]: "responding" });
});

test("concurrent ping completion preserves newest result; replacement invalidates old tokens and capabilities", async () => {
  env = await startEnv({ pingTimeoutMs: 10 });
  const human = env.human();
  const alpha = await env.adapter("opencode", "ping-generation", "alpha", { autoPong: false });
  const first = human.request("ping", { sessionId: alpha.session.id });
  const old = await alpha.nextPing();
  const second = human.request("ping", { sessionId: alpha.session.id });
  const newest = await alpha.nextPing();
  await alpha.client.request("pong", { pingId: newest.pingId });
  assert.deepEqual((await second).results, [{ sessionId: alpha.session.id, name: "alpha", ping: "responding" }]);
  env.clock.advance(10);
  env.daemon.sweep();
  assert.deepEqual((await first).results, [{ sessionId: alpha.session.id, name: "alpha", ping: "not_responding" }]);
  assert.equal((await human.sync()).sessionPings[alpha.session.id], "responding");
  await alpha.client.request("pong", { pingId: old.pingId });
  const replacing = human.request("ping", { sessionId: alpha.session.id });
  const abandoned = await alpha.nextPing();
  const replacement = await env.adapter("opencode", "ping-generation", "ignored", { pingSupport: false });
  assert.equal(replacement.session.id, alpha.session.id);
  assert.deepEqual((await replacing).results, [{ sessionId: alpha.session.id, name: "alpha", ping: "unknown" }]);
  const noCaps = await human.request("ping", { sessionId: alpha.session.id });
  assert.deepEqual(noCaps.results, [{ sessionId: alpha.session.id, name: "alpha", ping: "unknown" }]);
  await alpha.client.request("pong", { pingId: abandoned.pingId });
  await replacement.client.request("pong", { pingId: abandoned.pingId });
  assert.equal((await human.sync()).sessionPings[alpha.session.id], "unknown");
  assert.deepEqual(replacement.pings, []);
});

test("capabilities and tokens belong to individual bindings on shared OpenCode connections", async () => {
  env = await startEnv({ pingTimeoutMs: 10 });
  const human = env.human();
  const multi = await env.adapter("opencode", "ping-multi-one", "one", { autoPong: false });
  const two = (await multi.client.request("register", {
    harness: "opencode", key: "ping-multi-two", name: "two",
  })).session as { id: string; name: string };
  assert.deepEqual((await human.request("ping", { sessionId: two.id })).results,
    [{ sessionId: two.id, name: "two", ping: "unknown" }]);
  const first = human.request("ping", { sessionId: multi.session.id });
  await multi.client.request("pong", { pingId: (await multi.nextPing()).pingId });
  assert.deepEqual((await first).results, [{ sessionId: multi.session.id, name: "one", ping: "responding" }]);
  await multi.client.request("register", { harness: "opencode", key: "ping-multi-two", caps: ["ping"] });
  const all = human.request("ping");
  const onePing = await multi.nextPing();
  const twoPing = await multi.nextPing();
  await multi.client.request("pong", { pingId: twoPing.pingId });
  assert.equal((await human.sync()).sessionPings[two.id], "responding");
  env.clock.advance(10);
  env.daemon.sweep();
  assert.deepEqual((await all).results, [
    { sessionId: multi.session.id, name: "one", ping: "not_responding" },
    { sessionId: two.id, name: "two", ping: "responding" },
  ]);
  await multi.client.request("pong", { pingId: onePing.pingId });
  assert.equal((await human.sync()).sessionPings[multi.session.id], "not_responding");
});

test("gone clears persisted ping and cancels probes; revival reuses identity without inheriting failure", async () => {
  env = await startEnv({ pingTimeoutMs: 10 });
  let human = env.human();
  const alpha = await env.adapter("omp", "ping-gone", "alpha", { autoPong: false });
  const failed = human.request("ping", { sessionId: alpha.session.id });
  await alpha.nextPing();
  env.clock.advance(10);
  env.daemon.sweep();
  await failed;
  const probing = human.request("ping", { sessionId: alpha.session.id });
  await alpha.nextPing();
  const gone = await env.watch(isSession("gone", "alpha"));
  alpha.client.close();
  await gone.event;
  assert.deepEqual((await probing).results, [{ sessionId: alpha.session.id, name: "alpha", ping: "unknown" }]);
  const snapshot = await human.sync();
  assert.deepEqual(snapshot.sessionPings, {});
  assert.equal(isStaleSession(snapshot.sessions.find((session) => session.id === alpha.session.id)!, undefined), true);
  assert.deepEqual((await human.request("ping")).results, []);
  await env.restart();
  human = env.human();
  const revived = await env.adapter("omp", "ping-gone", "ignored");
  assert.equal(revived.session.id, alpha.session.id);
  assert.deepEqual((await human.sync()).sessionPings, {});
  await human.request("ping");
  await env.restart();
  human = env.human();
  assert.deepEqual((await human.sync()).sessionPings, {});
});

test("Claude socket ping persists across reopen without a delivery or model turn", async () => {
  env = await startEnv();
  let human = env.human();
  const path = join(env.home, "ping-live-claude.sock");
  const fixture = await fakeClaude(path);
  try {
    const claude = (await human.request("claude_hook", {
      event: "start", key: "ping-live-claude", sessionId: "ping-live-claude", name: "claude", socket: path,
    })).session as { id: string };
    assert.deepEqual((await human.request("ping")).results, [{ sessionId: claude.id, name: "claude", ping: "responding" }]);
    assert.deepEqual(fixture.lines, []);
    assert.deepEqual((await human.historyPage({ scope: "session", sessionId: claude.id })).messages, []);
    await env.restart();
    human = env.human();
    assert.deepEqual((await human.sync()).sessionPings, { [claude.id]: "responding" });
    await human.request("close", { identity: claude.id });
    assert.deepEqual((await human.sync()).sessionPings, {});
    assert.equal(isStaleSession((await human.sync()).sessions.find((session) => session.id === claude.id)!, "not_responding"), false);
    await human.request("purge", { identity: claude.id });
    assert.ok((await human.replay(0)).events.every(({ event }) => event.type !== "ping" || event.sessionId !== claude.id));
  } finally {
    await fixture.stop();
  }
});

for (const removal of ["gone", "removed", "closed"] as const) {
  test(`close retains one delivery notice for a ${removal} sender only when revival is allowed`, async () => {
    env = await startEnv();
    const human = env.human();
    const sender = await env.adapter("omp", "notice-sender", "sender");
    const target = await env.adapter("omp", "notice-target", "target");
    const targetGone = await env.watch(isSession("gone", "target"));
    target.client.close();
    await targetGone.event;
    const [queued] = await send(sender.client, "target", "waiting while target is offline");
    assert.equal(queued.status, "queued");
    if (removal === "closed") await human.request("close", { identity: sender.session.id });
    else {
      const gone = await env.watch(isSession("gone", "sender"));
      sender.client.close();
      await gone.event;
      if (removal === "removed") {
        env.clock.advance(GRACE_MS);
        env.daemon.sweep();
      }
    }
    await human.request("close", { identity: target.session.id });
    await human.request("close", { identity: target.session.id });
    const beforeRevival = await human.historyPage({ scope: "session", sessionId: sender.session.id });
    const notices = beforeRevival.messages.filter((message) => message.from === "asenq" && message.replyTo === queued.msgId);
    assert.deepEqual(notices.map((message) => message.status), removal === "closed" ? [] : ["queued"]);
    const revived = await env.adapter("omp", "notice-sender", "ignored", { autoAck: false });
    if (removal === "closed") {
      assert.notEqual(revived.session.id, sender.session.id);
      assert.deepEqual((await revived.client.request("inbox")).messages, []);
    } else {
      assert.equal(revived.session.id, sender.session.id);
      const delivered = await revived.nextDelivery();
      assert.equal(delivered.msg.id, notices[0].id);
      await revived.client.request("ack", { msgId: delivered.msg.id, ok: true });
      const inbox = (await revived.client.request("inbox")).messages as StoredMessage[];
      assert.deepEqual(inbox.filter((message) => message.from === "asenq").map((message) => [message.id, message.status]),
        [[notices[0].id, "delivered"]]);
      await env.daemon.retry();
      assert.deepEqual(revived.deliveries.map((delivery) => delivery.msg.id), [notices[0].id]);
    }
  });
}

test("close and purge remove memberships while preserving channels, unrelated members and purged author posts", async () => {
  env = await startEnv();
  const human = env.human();
  const closing = await env.adapter("omp", "membership-close", "closing");
  const purging = await env.adapter("omp", "membership-purge", "purging");
  const kept = await env.adapter("omp", "membership-kept", "kept");
  for (const channel of ["work", "review"]) {
    await human.request("channel_create", { channel });
    for (const name of ["closing", "purging", "kept"]) await human.request("channel_add", { channel, name });
  }
  const post = await purging.client.request("channel_send", { channel: "work", text: "retain author history" });
  const before = await human.sync();
  await human.request("close", { identity: closing.session.id });
  const fresh = await env.adapter("omp", "membership-close", "fresh");
  assert.notEqual(fresh.session.id, closing.session.id);
  await purging.client.request("unregister");
  await human.request("purge", { identity: purging.session.id });
  const snapshot = await human.sync();
  assert.deepEqual(snapshot.channels.map((channel) => [channel.name, channel.memberIds]).sort(),
    [["review", [kept.session.id]], ["work", [kept.session.id]]]);
  assert.deepEqual((await human.request("channel_members", { channel: "work" })).members,
    snapshot.sessions.filter((session) => session.id === kept.session.id));
  assert.deepEqual((await human.historyPage({ scope: "channel", channel: "work" })).messages.map((message) => message.id), [post.msgId]);
  const events = (await human.replay(before.watermark)).events.filter(({ event }) => event.type === "channel");
  for (const name of ["work", "review"]) {
    assert.deepEqual(events.filter(({ event }) => event.type === "channel" && event.channel.name === name)
      .map(({ event }) => event.type === "channel" && event.channel.memberIds?.slice().sort()), [
      [purging.session.id, kept.session.id].sort(), [kept.session.id],
    ]);
  }
});

for (const action of ["unregister", "close", "shutdown"] as const) {
  test(`${action} cancels pending ping without a stale completion changing revived identities`, async () => {
    env = await startEnv({ pingTimeoutMs: 10 });
    const human = env.human();
    const alpha = await env.adapter("omp", "ping-cancel", "alpha", { autoPong: false });
    const pending = human.request("ping", { sessionId: alpha.session.id });
    // Install the rejection handler before shutdown destroys the human's connection.
    const result = pending.then((reply) => ({ reply, error: undefined }),
      (error: unknown) => ({ reply: undefined, error }));
    const abandoned = await alpha.nextPing();
    if (action === "shutdown") {
      await env.daemon.close();
      assert.ok((await result).error instanceof Error);
      return;
    }
    if (action === "unregister") await alpha.client.request("unregister");
    else await human.request("close", { identity: alpha.session.id });
    assert.deepEqual((await result).reply?.results,
      [{ sessionId: alpha.session.id, name: "alpha", ping: "unknown" }]);
    const replacement = await env.adapter("omp", "ping-cancel", "replacement");
    assert.equal(replacement.session.id === alpha.session.id, action === "unregister");
    await replacement.client.request("pong", { pingId: abandoned.pingId });
    await human.request("ping", { sessionId: replacement.session.id });
    env.clock.advance(10);
    env.daemon.sweep();
    assert.equal((await human.sync()).sessionPings[replacement.session.id], "responding");
  });
}

test("deadline pongs without a prior sweep expire rather than revive the target", async () => {
  env = await startEnv({ pingTimeoutMs: 10 });
  const human = env.human();
  const alpha = await env.adapter("omp", "deadline-pong", "alpha", { autoPong: false });
  const pending = human.request("ping", { sessionId: alpha.session.id });
  const ping = await alpha.nextPing();
  env.clock.advance(10);
  await alpha.client.request("pong", { pingId: ping.pingId });
  assert.deepEqual((await pending).results, [{ sessionId: alpha.session.id, name: "alpha", ping: "not_responding" }]);
  assert.equal((await human.sync()).sessionPings[alpha.session.id], "not_responding");
});

test("new sends after grace removal queue by current name and stable id and revive after database reopen", async () => {
  env = await startEnv();
  let human = env.human();
  const original = await env.adapter("omp", "offline-key", "offline");
  const gone = await env.watch(isSession("gone", "offline"));
  original.client.close();
  await gone.event;
  env.clock.advance(GRACE_MS);
  env.daemon.sweep();
  const [byName] = await send(human, "offline", "sent after removal by name");
  const byId = await human.sendToSession(original.session.id, "sent after removal by id");
  assert.deepEqual([byName.status, byId.status], ["queued", "queued"]);
  await assert.rejects(send(human, "never-registered", "unknown"), { code: "unknown_target" });
  await env.restart();
  human = env.human();
  const holder = await env.adapter("omp", "new-holder", "offline");
  assert.notEqual(holder.session.id, original.session.id);
  assert.deepEqual(holder.deliveries, []);
  const delivered = await env.watch(isStatus(byId.msgId, "delivered"));
  const revived = await env.adapter("omp", "offline-key", "ignored");
  assert.equal(revived.session.id, original.session.id);
  assert.notEqual(revived.session.name, holder.session.name);
  await delivered.event;
  assert.deepEqual(revived.deliveries.map((delivery) => delivery.msg.id), [byName.msgId, byId.msgId]);
  assert.deepEqual(holder.deliveries, []);
  assert.deepEqual((await human.historyPage({ scope: "session", sessionId: original.session.id })).messages.map(
    (message) => [message.id, message.toSessionId, message.status],
  ), [[byName.msgId, original.session.id, "delivered"], [byId.msgId, original.session.id, "delivered"]]);
});

test("close seals an automatically removed conversation after name and stable-id queue admission", async () => {
  env = await startEnv();
  let human = env.human();
  const sender = await env.adapter("omp", "sealed-sender", "sender");
  const receiver = await env.adapter("omp", "sealed-receiver", "receiver");
  await human.request("set_inbound", { name: "receiver", mode: "hold" });
  const [held] = await send(sender.client, "receiver", "held before automatic removal");
  await human.request("set_inbound", { name: "receiver", mode: "accept" });
  const gone = await env.watch(isSession("gone", "receiver"));
  receiver.client.close();
  await gone.event;
  env.clock.advance(GRACE_MS);
  env.daemon.sweep();
  const removed = (await human.sync()).sessions.find((session) => session.id === receiver.session.id)!;
  assert.deepEqual([removed.state, removed.closedAt], ["removed", undefined]);
  const [byName] = await send(sender.client, "receiver", "queued by name after automatic removal");
  const byId = await human.sendToSession(receiver.session.id, "queued by stable id after automatic removal");
  assert.deepEqual([held.status, byName.status, byId.status], ["held", "queued", "queued"]);
  const scope = { scope: "session" as const, sessionId: receiver.session.id };
  assert.deepEqual((await human.historyPage(scope)).messages.map((message) => [message.id, message.status]),
    [[held.msgId, "held"], [byName.msgId, "queued"], [byId.msgId, "queued"]]);
  const notices = await Promise.all([held, byName].map((result) => env!.watch((event) =>
    event.type === "message" && event.msg.from === "asenq"
      && event.msg.replyTo === result.msgId && event.status === "delivered")));
  await human.request("close", { identity: receiver.session.id });
  await Promise.all(notices.map((notice) => notice.event));
  const sealed = (await human.historyPage(scope)).messages;
  assert.deepEqual(sealed.map((message) => [message.id, message.status]),
    [[held.msgId, "expired"], [byName.msgId, "expired"], [byId.msgId, "expired"]]);
  await assert.rejects(send(sender.client, "receiver", "agent cannot append after close"), { code: "unknown_target" });
  await assert.rejects(send(human, "receiver", "human cannot append by name after close"), { code: "unknown_target" });
  await assert.rejects(human.sendToSession(receiver.session.id, "human cannot append by id after close"), { code: "unknown_target" });
  await assert.rejects(human.request("release", { msgId: held.msgId }), { code: "bad_request" });
  assert.deepEqual((await human.historyPage(scope)).messages, sealed);
  env.clock.advance(86_400_000);
  env.daemon.sweep();
  await env.daemon.retry();
  assert.deepEqual((await human.historyPage(scope)).messages, sealed);
  assert.deepEqual(receiver.deliveries, []);
  assert.deepEqual(((await sender.client.request("inbox")).messages as StoredMessage[]).map(
    (message) => [message.from, message.replyTo, message.status],
  ).sort(), [["asenq", held.msgId, "delivered"], ["asenq", byName.msgId, "delivered"]].sort());
  await env.restart();
  human = env.human();
  const replacement = await env.adapter("omp", "sealed-receiver", "replacement");
  assert.notEqual(replacement.session.id, receiver.session.id);
  await env.daemon.retry();
  env.daemon.sweep();
  await assert.rejects(send(human, "receiver", "closed name after restart"), { code: "unknown_target" });
  await assert.rejects(human.sendToSession(receiver.session.id, "closed stable id after restart"), { code: "unknown_target" });
  assert.deepEqual((await human.historyPage(scope)).messages, sealed);
  assert.deepEqual(replacement.deliveries, []);
  assert.deepEqual((await replacement.client.request("inbox", { unread_only: true })).messages, []);
});

test("TTL notices skip closed senders but queue for automatically removed senders and deliver on revival", async () => {
  env = await startEnv();
  let human = env.human();
  const receiver = await env.adapter("omp", "notice-receiver", "receiver");
  const closedSender = await env.adapter("omp", "closed-notice-sender", "closed-sender");
  const removedSender = await env.adapter("omp", "removed-notice-sender", "removed-sender");
  const receiverGone = await env.watch(isSession("gone", "receiver"));
  receiver.client.close();
  await receiverGone.event;
  const [fromClosed] = await send(closedSender.client, "receiver", "sender closes before TTL");
  const [fromRemoved] = await send(removedSender.client, "receiver", "sender is automatically removed before TTL");
  assert.deepEqual([fromClosed.status, fromRemoved.status], ["queued", "queued"]);
  await human.request("close", { identity: closedSender.session.id });
  const senderGone = await env.watch(isSession("gone", "removed-sender"));
  removedSender.client.close();
  await senderGone.event;
  env.clock.advance(GRACE_MS);
  env.daemon.sweep();
  const removed = (await human.sync()).sessions.find((session) => session.id === removedSender.session.id)!;
  assert.deepEqual([removed.state, removed.closedAt], ["removed", undefined]);
  env.clock.advance(86_400_000 - GRACE_MS - 1);
  env.daemon.sweep();
  assert.equal((await logOf(human, fromClosed.msgId!)).status, "queued");
  assert.equal((await logOf(human, fromRemoved.msgId!)).status, "queued");
  const closedScope = { scope: "session" as const, sessionId: closedSender.session.id };
  const removedScope = { scope: "session" as const, sessionId: removedSender.session.id };
  env.clock.advance(1);
  env.daemon.sweep();
  const closedHistory = (await human.historyPage(closedScope)).messages;
  assert.deepEqual(closedHistory.map((message) => [message.id, message.status]), [[fromClosed.msgId, "expired"]]);
  const removedHistory = (await human.historyPage(removedScope)).messages;
  assert.deepEqual(removedHistory.map((message) => [message.from, message.toSessionId, message.status, message.replyTo]), [
    ["removed-sender", receiver.session.id, "expired", undefined],
    ["asenq", removedSender.session.id, "queued", fromRemoved.msgId],
  ]);
  const notice = removedHistory[1];
  assert.equal(notice.kind, "status");
  assert.ok(notice.text.includes(fromRemoved.msgId!));
  env.daemon.sweep();
  await env.daemon.retry();
  assert.deepEqual((await human.historyPage(closedScope)).messages, closedHistory);
  assert.deepEqual((await human.historyPage(removedScope)).messages, removedHistory);
  assert.deepEqual(closedSender.deliveries, []);
  assert.deepEqual(removedSender.deliveries, []);
  await env.restart();
  human = env.human();
  assert.deepEqual((await human.historyPage(closedScope)).messages, closedHistory);
  assert.deepEqual((await human.historyPage(removedScope)).messages, removedHistory);
  const delivered = await env.watch(isStatus(notice.id, "delivered"));
  const revived = await env.adapter("omp", "removed-notice-sender", "ignored");
  assert.equal(revived.session.id, removedSender.session.id);
  await delivered.event;
  assert.deepEqual(revived.deliveries.map((delivery) => [delivery.msg.id, delivery.msg.from, delivery.msg.replyTo]),
    [[notice.id, "asenq", fromRemoved.msgId]]);
  const replacement = await env.adapter("omp", "closed-notice-sender", "replacement");
  assert.notEqual(replacement.session.id, closedSender.session.id);
  const revivedReceiver = await env.adapter("omp", "notice-receiver", "ignored");
  assert.equal(revivedReceiver.session.id, receiver.session.id);
  env.daemon.sweep();
  await env.daemon.retry();
  assert.deepEqual((await human.historyPage(closedScope)).messages, closedHistory);
  assert.deepEqual((await human.historyPage(removedScope)).messages.map((message) => [message.id, message.status]),
    [[fromRemoved.msgId, "expired"], [notice.id, "delivered"]]);
  assert.deepEqual(revived.deliveries.map((delivery) => delivery.msg.id), [notice.id]);
  assert.deepEqual(replacement.deliveries, []);
  assert.deepEqual(revivedReceiver.deliveries, []);
});

test("closed current-name holders do not make retained routing ambiguous or displace a live holder", async () => {
  env = await startEnv();
  const human = env.human();
  const sender = await env.adapter("omp", "closed-name-sender", "sender");
  const closed = await env.adapter("omp", "closed-name-holder", "shared");
  await human.request("close", { identity: closed.session.id });
  const retained = await env.adapter("opencode", "retained-name-holder", "shared");
  assert.notEqual(retained.session.id, closed.session.id);
  const gone = await env.watch(isSession("gone", "shared"));
  retained.client.close();
  await gone.event;
  env.clock.advance(GRACE_MS);
  env.daemon.sweep();
  assert.deepEqual((await human.sync()).sessions.filter((session) => session.name === "shared").map(
    (session) => [session.id, session.state, session.closedAt !== undefined],
  ).sort(), [[closed.session.id, "removed", true], [retained.session.id, "removed", false]].sort());
  const [queued] = await send(sender.client, "shared", "only the nonclosed retained holder may queue");
  assert.equal(queued.status, "queued");
  const retainedScope = { scope: "session" as const, sessionId: retained.session.id };
  const closedScope = { scope: "session" as const, sessionId: closed.session.id };
  assert.deepEqual((await human.historyPage(retainedScope)).messages.map((message) => [message.id, message.toSessionId, message.status]),
    [[queued.msgId, retained.session.id, "queued"]]);
  await assert.rejects(human.sendToSession(closed.session.id, "closed id despite reused name"), { code: "unknown_target" });
  const live = await env.adapter("omp", "live-name-holder", "shared");
  const [toLive] = await send(sender.client, "shared", "current live holder wins");
  assert.equal(toLive.status, "delivered");
  assert.deepEqual(live.deliveries.map((delivery) => delivery.msg.id), [toLive.msgId]);
  const delivered = await env.watch(isStatus(queued.msgId, "delivered"));
  const revived = await env.adapter("opencode", "retained-name-holder", "ignored");
  assert.equal(revived.session.id, retained.session.id);
  assert.notEqual(revived.session.name, live.session.name);
  await delivered.event;
  assert.deepEqual(revived.deliveries.map((delivery) => delivery.msg.id), [queued.msgId]);
  assert.deepEqual(live.deliveries.map((delivery) => delivery.msg.id), [toLive.msgId]);
  assert.deepEqual(closed.deliveries, []);
  assert.deepEqual((await human.historyPage(closedScope)).messages, []);
  assert.deepEqual((await human.historyPage(retainedScope)).messages.map((message) => [message.id, message.status]),
    [[queued.msgId, "delivered"]]);
});

test("queued messages expire at exactly the default 24-hour boundary with one live sender notice", async () => {
  env = await startEnv();
  const human = env.human();
  const sender = await env.adapter("omp", "sender-key", "sender");
  const receiver = await env.adapter("omp", "receiver-key", "receiver");
  const gone = await env.watch(isSession("gone", "receiver"));
  receiver.client.close();
  await gone.event;
  const [queued] = await send(sender.client, "receiver", "expires after one day");
  assert.equal(queued.status, "queued");
  env.clock.advance(86_400_000 - 1);
  env.daemon.sweep();
  assert.equal((await logOf(human, queued.msgId!)).status, "queued");
  assert.equal(sender.deliveries.length, 0);
  const expired = await env.watch(isStatus(queued.msgId, "expired"));
  env.clock.advance(1);
  env.daemon.sweep();
  await expired.event;
  const notice = await sender.nextDelivery();
  assert.deepEqual([notice.msg.from, notice.msg.kind, notice.msg.replyTo], ["asenq", "status", queued.msgId]);
  assert.ok(notice.text.includes(queued.msgId!));
  assert.equal((await logOf(human, queued.msgId!)).status, "expired");
  env.daemon.sweep();
  await sender.client.request("inbox");
  assert.deepEqual(sender.deliveries.map((delivery) => delivery.msg.replyTo), [queued.msgId]);
});

test("agents can resolve reply references to retained originals after replying", async () => {
  env = await startEnv();
  const human = env.human();
  const sender = await env.adapter("omp", "reference-sender", "sender");
  const receiver = await env.adapter("omp", "reference-receiver", "receiver");
  const [original] = await send(sender.client, "receiver", "question");
  await receiver.nextDelivery();
  await send(receiver.client, "sender", "answer", { replyTo: original.msgId });
  assert.equal((await logOf(human, original.msgId!)).status, "replied");
  const [followup] = await send(sender.client, "receiver", "follow-up to answered question", {
    replyTo: original.msgId,
  });
  const delivery = await receiver.nextDelivery();
  assert.equal(delivery.msg.replyTo, original.msgId);
  assert.equal(delivery.msg.replyToMissing, undefined);
  const recovered = (await receiver.client.request("inbox", { msgId: followup.msgId })).messages as StoredMessage[];
  assert.deepEqual(recovered.map((message) => [message.replyTo, message.replyToMissing]),
    [[original.msgId, undefined]]);
  const rendered = await callTool(receiver.client, "asenq_inbox", { id: followup.msgId });
  assert.ok(rendered.includes(followup.msgId!));
  assert.doesNotMatch(rendered, /purged message/);
});

test("a delivered reciprocal reply is retained as replied in history, inbox recovery and MCP output", async () => {
  env = await startEnv();
  const human = env.human();
  const sender = await env.adapter("omp", "sender-key", "sender");
  const receiver = await env.adapter("omp", "receiver-key", "receiver");
  const [original] = await send(sender.client, "receiver", "question", { thread: "work" });
  assert.equal(original.status, "delivered");
  const before = await human.sync();
  const [reply] = await send(receiver.client, "sender", "answer", { replyTo: original.msgId });
  assert.equal(reply.status, "delivered");
  const history = await human.historyPage({ scope: "session", sessionId: sender.session.id });
  assert.deepEqual(history.messages.map((message) => [message.id, message.status]), [
    [original.msgId, "replied"], [reply.msgId, "delivered"],
  ]);
  for (const participant of [sender.client, receiver.client]) {
    const recovered = (await participant.request("inbox", { msgId: original.msgId })).messages as StoredMessage[];
    assert.deepEqual(recovered.map((message) => [message.id, message.status]), [[original.msgId, "replied"]]);
    const rendered = await callTool(participant, "asenq_inbox", { id: original.msgId });
    assert.ok(rendered.includes(original.msgId!));
    assert.match(rendered, /\breplied\b/);
  }
  const replay = await human.replay(before.watermark);
  assert.ok(replay.events.some(({ event }) =>
    event.type === "message" && event.msg.id === original.msgId && event.status === "replied"));
});

test("sync failedCount increments on direct expiry and decrements when retained messages are pruned", async () => {
  env = await startEnv({ historyDays: 7, ...{ queueTtlMs: 1000 } });
  const human = env.human();
  const receiver = await env.adapter("omp", "receiver-key", "receiver");
  assert.equal((await human.request("sync")).failedCount, 0);
  const gone = await env.watch(isSession("gone", "receiver"));
  receiver.client.close();
  await gone.event;
  const [queued] = await send(human, "receiver", "short-lived queue");
  const before = await human.sync();
  env.clock.advance(999);
  env.daemon.sweep();
  assert.equal((await logOf(human, queued.msgId!)).status, "queued");
  assert.equal((await human.request("sync")).failedCount, 0);
  env.clock.advance(1);
  env.daemon.sweep();
  assert.equal((await logOf(human, queued.msgId!)).status, "expired");
  assert.equal((await human.request("sync")).failedCount, 1);
  const expired = (await human.replay(before.watermark)).events.find(({ event }) =>
    event.type === "message" && event.msg.id === queued.msgId && event.status === "expired")?.event;
  assert.ok(expired && "failedCount" in expired);
  assert.equal(expired.failedCount, 1);
  env.clock.advance(8 * 86_400_000);
  env.daemon.prune();
  assert.equal((await human.request("sync")).failedCount, 0);
  assert.deepEqual((await human.historyPage({ scope: "session", sessionId: receiver.session.id })).messages, []);
});

test("ambiguous retained current names reject name routing while stable ids retain separate queues", async () => {
  env = await startEnv();
  const human = env.human();
  const first = await env.adapter("omp", "first-key", "shared", { cwd: "/first" });
  await first.client.request("unregister");
  const second = await env.adapter("opencode", "second-key", "shared", { cwd: "/second" });
  assert.notEqual(first.session.id, second.session.id);
  assert.equal((await send(human, "shared", "active holder wins"))[0].status, "delivered");
  assert.equal((await second.nextDelivery()).msg.text, "active holder wins");
  const gone = await env.watch(isSession("gone", "shared"));
  second.client.close();
  await gone.event;
  const [toGoneHolder] = await send(human, "shared", "gone holder wins");
  assert.equal(toGoneHolder.status, "queued");
  assert.equal((await human.historyPage({ scope: "session", sessionId: second.session.id })).messages.at(-1)?.toSessionId, second.session.id);
  const delivered = await env.watch(isStatus(toGoneHolder.msgId, "delivered"));
  const reconnected = await env.adapter("opencode", "second-key", "ignored", { cwd: "/second" });
  await delivered.event;
  await reconnected.client.request("unregister");
  await assert.rejects(send(human, "shared", "must not guess"), (error: unknown) => {
    assert.ok(error instanceof Error && "code" in error);
    assert.equal(error.code, "ambiguous_target");
    for (const detail of [first.session.id, second.session.id, "shared", "omp", "opencode", "/first", "/second"]) {
      assert.ok(error.message.includes(detail), `ambiguity must identify ${detail}`);
    }
    assert.ok(error.message.includes(String(env!.clock.now())) || error.message.includes(new Date(env!.clock.now()).toISOString()),
      "ambiguity must include the candidates' last-seen timestamp");
    return true;
  });
  const toFirst = await human.sendToSession(first.session.id, "only first");
  const toSecond = await human.sendToSession(second.session.id, "only second");
  assert.deepEqual([toFirst.status, toSecond.status], ["queued", "queued"]);
  for (const [identity, message] of [[first.session, toFirst], [second.session, toSecond]] as const) {
    const history = await human.historyPage({ scope: "session", sessionId: identity.id });
    assert.deepEqual(history.messages.filter((row) => row.status === "queued").map(
      (row) => [row.id, row.toSessionId],
    ), [[message.msgId, identity.id]]);
  }
});

for (const path of ["adapter reconnect", "Claude fallback poll"] as const) {
  test(`expired queued messages cannot deliver through ${path} without a preceding sweep`, async () => {
    env = await startEnv({ ...{ queueTtlMs: 1000 } });
    const human = env.human();
    let queued: SendResult;
    if (path === "adapter reconnect") {
      const receiver = await env.adapter("omp", "receiver-key", "receiver");
      const gone = await env.watch(isSession("gone", "receiver"));
      receiver.client.close();
      await gone.event;
      [queued] = await send(human, "receiver", "stale before reconnect");
      env.clock.advance(1000);
      const revived = await env.adapter("omp", "receiver-key", "ignored");
      assert.equal((await logOf(human, queued.msgId!)).status, "expired");
      assert.deepEqual(revived.deliveries, []);
      assert.deepEqual((await revived.client.request("inbox", { unread_only: true })).messages, []);
    } else {
      await human.request("claude_hook", { event: "start", key: "claude-key", sessionId: "s1", name: "receiver", socket: null });
      [queued] = await send(human, "receiver", "stale before hook");
      env.clock.advance(1000);
      assert.deepEqual((await human.request("claude_hook", { event: "poll", sessionId: "s1" })).texts, []);
      assert.equal((await logOf(human, queued.msgId!)).status, "expired");
    }
  });
}

test("only a reciprocal direct reply counts; third-party and channel references do not", async () => {
  env = await startEnv();
  const human = env.human();
  const sender = await env.adapter("omp", "sender-key", "sender");
  const receiver = await env.adapter("omp", "receiver-key", "receiver");
  const outsider = await env.adapter("omp", "outsider-key", "outsider");
  const [original] = await send(sender.client, "receiver", "private question");
  await send(outsider.client, "sender", "wrong author", { replyTo: original.msgId });
  await send(receiver.client, "outsider", "wrong recipient", { replyTo: original.msgId });
  await receiver.client.request("channel_send", { channel: "work", text: "channel reply", replyTo: original.msgId });
  assert.equal((await logOf(human, original.msgId!)).status, "delivered");
  await sender.client.request("channel_send", { channel: "work", text: "channel original" });
  const channelMessages = (await human.request("channel_read", { channel: "work" })).messages as StoredMessage[];
  const channelOriginal = channelMessages.find((row) => row.text === "channel original")!;
  assert.ok(channelOriginal);
  await send(receiver.client, "sender", "not a direct original", { replyTo: channelOriginal.id });
  assert.equal((await logOf(human, channelOriginal.id)).status, "posted");
  await sender.client.request("rename", { name: "sender-renamed" });
  await receiver.client.request("rename", { name: "receiver-renamed" });
  const [reply] = await send(receiver.client, "sender-renamed", "identity-safe answer", { replyTo: original.msgId });
  assert.equal(reply.status, "delivered");
  assert.equal((await logOf(human, original.msgId!)).status, "replied");
});

test("held and queued reciprocal replies count only when delivered and do not duplicate original unread", async () => {
  env = await startEnv();
  const human = env.human();
  const sender = await env.adapter("omp", "sender-key", "sender");
  const receiver = await env.adapter("omp", "receiver-key", "receiver");
  const [original] = await send(sender.client, "receiver", "question for held reply");
  assert.deepEqual(((await receiver.client.request("inbox", { unread_only: true })).messages as StoredMessage[]).map(
    (row) => row.id,
  ), [original.msgId]);
  await human.request("set_inbound", { name: "sender", mode: "hold" });
  const [held] = await send(receiver.client, "sender", "held answer", { replyTo: original.msgId });
  assert.equal(held.status, "held");
  assert.equal((await logOf(human, original.msgId!)).status, "delivered");
  assert.equal((await human.request("release", { msgId: held.msgId })).status, "delivered");
  assert.equal((await logOf(human, original.msgId!)).status, "replied");
  await receiver.client.request("ack", { msgId: original.msgId, ok: true });
  await receiver.client.request("ack", { msgId: original.msgId, ok: true });
  assert.equal((await logOf(human, original.msgId!)).status, "replied");
  assert.deepEqual((await receiver.client.request("inbox", { unread_only: true })).messages, []);
  assert.deepEqual(((await receiver.client.request("inbox")).messages as StoredMessage[]).map(
    (row) => [row.id, row.status],
  ), [[original.msgId, "replied"]]);

  await human.request("set_inbound", { name: "sender", mode: "accept" });
  const [second] = await send(sender.client, "receiver", "question for queued reply");
  const gone = await env.watch(isSession("gone", "sender"));
  sender.client.close();
  await gone.event;
  const [queued] = await send(receiver.client, "sender", "queued answer", { replyTo: second.msgId });
  assert.equal(queued.status, "queued");
  assert.equal((await logOf(human, second.msgId!)).status, "delivered");
  const delivered = await env.watch(isStatus(queued.msgId, "delivered"));
  const resumed = await env.adapter("omp", "sender-key", "ignored");
  await delivered.event;
  assert.equal((await resumed.nextDelivery()).msg.id, queued.msgId);
  assert.equal((await logOf(human, second.msgId!)).status, "replied");
});

test("a delivered reply before the original acknowledgement becomes effective after that acknowledgement", async () => {
  env = await startEnv();
  const human = env.human();
  const sender = await env.adapter("omp", "sender-key", "sender");
  const receiver = await env.adapter("omp", "receiver-key", "receiver", { autoAck: false });
  const pending = send(sender.client, "receiver", "ack is still pending");
  const original = await receiver.nextDelivery();
  const [reply] = await send(receiver.client, "sender", "answer first", { replyTo: original.msg.id });
  assert.equal(reply.status, "delivered");
  assert.equal((await logOf(human, original.msg.id)).status, "queued");
  await receiver.client.request("ack", { msgId: original.msg.id, ok: true });
  await pending;
  assert.equal((await logOf(human, original.msg.id)).status, "replied");
  assert.deepEqual(((await receiver.client.request("inbox", { unread_only: true })).messages as StoredMessage[]).map(
    (row) => [row.id, row.status],
  ), [[original.msg.id, "replied"]]);
  await receiver.client.request("ack", { msgId: original.msg.id, ok: true });
  assert.deepEqual((await receiver.client.request("inbox", { unread_only: true })).messages, []);
});

test("human reciprocal replies use posted admission for the human and delivered arrival for the session", async () => {
  env = await startEnv();
  const human = env.human();
  const agent = await env.adapter("omp", "agent-key", "agent");
  const [toHuman] = await send(agent.client, "human", "question for human");
  assert.equal(toHuman.status, "posted");
  const gone = await env.watch(isSession("gone", "agent"));
  agent.client.close();
  await gone.event;
  const [humanReply] = await send(human, "agent", "answer while offline", { replyTo: toHuman.msgId });
  assert.equal(humanReply.status, "queued");
  assert.equal((await logOf(human, toHuman.msgId!)).status, "posted");
  const delivered = await env.watch(isStatus(humanReply.msgId, "delivered"));
  const resumed = await env.adapter("omp", "agent-key", "ignored");
  await delivered.event;
  assert.equal((await logOf(human, toHuman.msgId!)).status, "replied");
  const [fromHuman] = await send(human, "agent", "question from human");
  assert.equal(fromHuman.status, "delivered");
  const [agentReply] = await send(resumed.client, "human", "answer to human", { replyTo: fromHuman.msgId });
  assert.equal(agentReply.status, "posted");
  assert.equal((await logOf(human, fromHuman.msgId!)).status, "replied");
  assert.deepEqual(((await human.request("inbox", { msgId: toHuman.msgId })).messages as StoredMessage[]).map(
    (row) => [row.id, row.status],
  ), [[toHuman.msgId, "replied"]]);
  await env.restart();
  const restored = await env.human().historyPage({ scope: "session", sessionId: agent.session.id });
  assert.deepEqual(restored.messages.filter((row) => row.id === toHuman.msgId || row.id === fromHuman.msgId).map(
    (row) => [row.id, row.status],
  ), [[toHuman.msgId, "replied"], [fromHuman.msgId, "replied"]]);
});

test("held messages never expire until release, then use their original creation age before delivery", async () => {
  env = await startEnv({ ...{ queueTtlMs: 1000 } });
  const human = env.human();
  const sender = await env.adapter("omp", "sender-key", "sender");
  const receiver = await env.adapter("omp", "receiver-key", "receiver");
  await human.request("set_inbound", { name: "receiver", mode: "hold" });
  const [held] = await send(sender.client, "receiver", "awaiting a human beyond queue TTL");
  assert.equal(held.status, "held");
  env.clock.advance(1000);
  env.daemon.sweep();
  assert.equal((await logOf(human, held.msgId!)).status, "held");
  assert.deepEqual(receiver.deliveries, []);
  assert.deepEqual(sender.deliveries, []);
  assert.equal((await human.request("release", { msgId: held.msgId })).status, "expired");
  assert.equal((await logOf(human, held.msgId!)).status, "expired");
  assert.deepEqual(receiver.deliveries, []);
  const notice = await sender.nextDelivery();
  assert.deepEqual([notice.msg.from, notice.msg.replyTo], ["asenq", held.msgId]);
  assert.equal((await logOf(human, held.msgId!)).status, "expired");
});

test("expired and dropped originals cannot become replied or be resurrected by late acknowledgements", async () => {
  env = await startEnv({ ...{ queueTtlMs: 1000 } });
  const human = env.human();
  const sender = await env.adapter("omp", "sender-key", "sender");
  const receiver = await env.adapter("omp", "receiver-key", "receiver");
  await human.request("set_inbound", { name: "receiver", mode: "hold" });
  const [dropped] = await send(sender.client, "receiver", "original dropped by user");
  await human.request("drop", { msgId: dropped.msgId });
  assert.equal((await logOf(human, dropped.msgId!)).status, "dropped");
  const [aged] = await send(sender.client, "receiver", "original expires on release");
  env.clock.advance(1000);
  assert.equal((await human.request("release", { msgId: aged.msgId })).status, "expired");
  await sender.nextDelivery();
  for (const [original, status] of [[dropped, "dropped"], [aged, "expired"]] as const) {
    assert.equal((await send(receiver.client, "sender", `late answer to ${status}`, { replyTo: original.msgId }))[0].status, "delivered");
    await receiver.client.request("ack", { msgId: original.msgId, ok: true });
    assert.equal((await logOf(human, original.msgId!)).status, status);
  }
  assert.deepEqual((await receiver.client.request("inbox", { unread_only: true })).messages, []);
});

test("failedCount excludes pending, policy rejected, dropped and posted messages and includes every retained failure once", async () => {
  env = await startEnv({ ...{ queueTtlMs: 1000 } });
  const human = env.human();
  const sender = await env.adapter("omp", "sender-key", "sender");
  const receiver = await env.adapter("omp", "receiver-key", "receiver");
  await human.request("set_inbound", { name: "receiver", mode: "hold" });
  const [held] = await send(sender.client, "receiver", "held");
  const [toDrop] = await send(sender.client, "receiver", "dropped");
  await human.request("drop", { msgId: toDrop.msgId });
  assert.equal((await logOf(human, toDrop.msgId!)).status, "dropped");
  await human.request("set_inbound", { name: "receiver", mode: "refuse" });
  const [rejected] = await send(sender.client, "receiver", "rejected");
  assert.equal(rejected.status, "rejected");
  assert.equal((await send(sender.client, "human", "human inbox post"))[0].status, "posted");
  await sender.client.request("channel_send", { channel: "work", text: "channel post" });
  await human.request("set_inbound", { name: "receiver", mode: "accept" });
  const gone = await env.watch(isSession("gone", "receiver"));
  receiver.client.close();
  await gone.event;
  const [first] = await send(human, "receiver", "first queued");
  const [second] = await send(human, "receiver", "second queued");
  assert.deepEqual([held.status, first.status, second.status], ["held", "queued", "queued"]);
  const before = await human.sync();
  assert.equal((await human.request("sync")).failedCount, 0);
  env.clock.advance(1000);
  env.daemon.sweep();
  assert.equal((await human.request("sync")).failedCount, 2);
  assert.equal((await logOf(human, held.msgId!)).status, "held");
  const replay = await human.replay(before.watermark);
  const counts = replay.events.flatMap(({ event }) =>
    event.type === "message" && event.status === "expired" && "failedCount" in event ? [event.failedCount] : []);
  assert.deepEqual(counts, [1, 2]);
  env.daemon.sweep();
  assert.equal((await human.request("sync")).failedCount, 2);
  const afterExpiry = await human.sync();
  await sender.client.request("channel_send", { channel: "work", text: "post after expiry" });
  const events = (await human.replay(afterExpiry.watermark)).events.filter(({ event }) => event.type === "message");
  assert.deepEqual(events.map(({ event }) => "failedCount" in event ? event.failedCount : undefined), [2]);
  await env.restart();
  assert.equal((await env.human().request("sync")).failedCount, 2);
});

test("named channel mention delivers one direct message with channel context and retains one post", async () => {
  env = await startEnv();
  const human = env.human();
  const poster = await env.adapter("omp", "mention-poster", "poster");
  const member = await env.adapter("omp", "mention-member", "member");
  const other = await env.adapter("omp", "mention-other", "other");
  await human.request("channel_create", { channel: "work" });
  for (const name of ["poster", "member", "other"]) await human.request("channel_add", { channel: "work", name });
  const reply = await poster.client.request("channel_send", { channel: "work", text: "Review @member; @member needs this." });
  assert.equal(member.deliveries.length, 1);
  assert.equal(poster.deliveries.length, 0);
  assert.equal(other.deliveries.length, 0);
  const delivery = member.deliveries[0];
  assert.equal(delivery.msg.from, "poster");
  assert.match(delivery.text.split("\n")[0], /#work/);
  const results = reply.results as SendResult[];
  assert.deepEqual(results.map((result) => [result.to, result.status, result.msgId]), [["member", "delivered", delivery.msg.id]]);
  const posts = (await human.request("channel_read", { channel: "work" })).messages as StoredMessage[];
  assert.deepEqual(posts.map((post) => post.id), [reply.msgId]);
  const inbox = (await member.client.request("inbox", { unread_only: true })).messages as StoredMessage[];
  assert.deepEqual(inbox.map((message) => message.id), [delivery.msg.id], "pushed posts remain direct inbox messages");
});
