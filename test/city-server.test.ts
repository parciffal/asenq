import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { runCity } from "../src/city/command.js";
import { CityHost } from "../src/city/host.js";
import type { CityDeps, CityEvent, ConversationSummary } from "../src/city/host.js";
import { startCityServer } from "../src/city/server.js";
import { AsenqClient } from "../src/shared/client.js";
import type { ChannelSendResult, HistoryPage, ListedSession, SendResult, StoredMessage } from "../src/shared/protocol.js";
import { DEFAULT_VIZ_SETTINGS } from "../src/viz/settings.js";
import type { ProcInfo } from "../src/viz/scan.js";
import { startEnv } from "./helpers.js";

type CityHttp = { base: string; headers: Record<string, string> };
type HttpReply = { status: number; headers: IncomingHttpHeaders; body: string };
function http(url: string, options: { method?: string; headers?: Record<string, string>; body?: string; path?: string } = {}): Promise<HttpReply> {
  const { promise, resolve, reject } = Promise.withResolvers<HttpReply>();
  const req = request(url, { method: options.method ?? "GET", headers: options.headers, ...(options.path ? { path: options.path } : {}) }, (res) => {
    let body = "";
    res.setEncoding("utf8");
    res.on("data", (chunk) => { body += chunk; });
    res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    res.on("error", reject);
  });
  req.on("error", reject);
  req.end(options.body);
  return promise;
}

async function stream(url: string) {
  const events: CityEvent[] = [];
  const ready = Promise.withResolvers<void>();
  const ended = Promise.withResolvers<void>();
  const req = request(url, (res) => {
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["cache-control"], "no-store");
    res.setEncoding("utf8");
    let buffer = "";
    res.on("data", (chunk) => {
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const event = frame.split("\n").find((line) => line.startsWith("event: "))?.slice(7);
        const data = frame.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
        if (event && data) { events.push({ event, data: JSON.parse(data) } as CityEvent); ready.resolve(); }
      }
    });
    res.on("end", () => ended.resolve());
    res.on("close", () => ended.resolve());
    res.on("error", () => ended.resolve());
  });
  req.on("error", (error) => { ready.reject(error); ended.resolve(); });
  req.end();
  await ready.promise;
  return {
    events, ended: ended.promise, close: () => req.destroy(),
    async until(predicate: (events: CityEvent[]) => boolean) {
      for (let turn = 0; turn < 2000; turn++) { if (predicate(events)) return; await nextTurn(); }
      assert.fail("SSE did not reach the requested city state");
    },
  };
}

async function city(t: TestContext, deps: Pick<CityDeps, "scan" | "kill"> = {}) {
  const env = await startEnv();
  const root = mkdtempSync(join(tmpdir(), "asenq-city-static-"));
  writeFileSync(join(root, "index.html"), "<!doctype html><title>city transport test</title>");
  writeFileSync(join(root, "app.js"), "export const value = 1;\n");
  writeFileSync(join(root, "private.bin"), "not a public type");
  const host = new CityHost({
    client: (options) => new AsenqClient({ ...options, autoStart: false }),
    scan: async () => [], schedule: () => () => {},
    settings: () => ({ settings: DEFAULT_VIZ_SETTINGS, warning: null }),
    ...deps,
  });
  const token = randomBytes(24).toString("base64url");
  const server = await startCityServer(host, { port: 0, token, root });
  const base = `http://127.0.0.1:${server.port}`;
  t.after(async () => { host.close(); await server.close(); await env.close(); rmSync(root, { recursive: true, force: true }); });
  host.start();
  await host.idle();
  return { env, root, host, server, token, base, headers: { "X-Asenq-Token": token, "Content-Type": "application/json", Origin: base } };
}

async function manage(c: CityHttp, body: Record<string, unknown>): Promise<HttpReply> {
  return http(c.base + "/api/manage", { method: "POST", headers: c.headers, body: JSON.stringify(body) });
}

async function conversations(c: CityHttp): Promise<ConversationSummary[]> {
  const reply = await http(c.base + "/api/conversations", { headers: c.headers });
  assert.equal(reply.status, 200);
  const result: { conversations: ConversationSummary[] } = JSON.parse(reply.body);
  return result.conversations;
}

test("localhost guard, static confinement, CSP and token checks", { timeout: 10_000 }, async (t) => {
  const c = await city(t);
  assert.equal((await http(c.base, { headers: { Host: "evil.example" } })).status, 421);
  assert.equal((await http(c.base + "/api/history?scope=channel&channel=missing")).status, 401);
  assert.equal((await http(c.base + "/api/events?token=wrong")).status, 401);
  assert.equal((await http(c.base + "/api/history?scope=session&sessionId=missing", { headers: { "X-Asenq-Token": "x".repeat(32) } })).status, 401);
  assert.equal((await http(c.base, { path: "/..%2f..%2fpackage.json" })).status, 404);
  assert.equal((await http(c.base + "/private.bin")).status, 404);
  symlinkSync(join(c.env.home, "asenq.db"), join(c.root, "outside.json"));
  assert.equal((await http(c.base + "/outside.json")).status, 404);
  const page = await http(c.base);
  assert.equal(page.status, 200);
  assert.match(page.body, /city transport test/);
  assert.match(String(page.headers["content-security-policy"]), /script-src 'self'/);
  assert.match(String(page.headers["content-security-policy"]), /frame-ancestors 'none'/);
  assert.equal(page.headers["x-content-type-options"], "nosniff");
  assert.equal(page.headers["referrer-policy"], "no-referrer");
  assert.equal(page.headers["access-control-allow-origin"], undefined);
  assert.equal((await http(c.base + "/app.js", { headers: { Host: `localhost:${c.server.port}` } })).status, 200);
  assert.equal((await http(c.base, { method: "POST" })).status, 405);
});

test("SSE projects empty venues and real sessions then sends one human packet per channel post or DM", { timeout: 10_000 }, async (t) => {
  const c = await city(t);
  const s = await stream(c.base + `/api/events?token=${c.token}`);
  t.after(() => s.close());
  const human = c.env.human();
  await human.request("channel_create", { channel: "empty" });
  const a = await c.env.adapter("omp", "city-a", "wrk-a");
  const b = await c.env.adapter("omp", "city-b", "wrk-b");
  await s.until((events) => events.some((e) => e.event === "state" && e.data.venues.some((v) => v.name === "empty")
    && e.data.characters.some((ch) => ch.id === a.session.id && ch.appearance.reason === "no-model-metadata")));
  const empty = c.host.current().venues.find((venue) => venue.name === "empty")!;
  assert.deepEqual(empty.rosterIds, []);
  await human.request("channel_create", { channel: "design" });
  for (const name of ["wrk-a", "wrk-b"]) await human.request("channel_add", { channel: "design", name });
  await s.until((events) => events.some((e) => e.event === "state" && e.data.venues.some((v) => v.name === "design" && v.rosterIds.length === 2)));
  await c.host.idle();
  const design = c.host.current().venues.find((venue) => venue.name === "design")!;
  const operator = c.host.current().characters.find((ch) => ch.source === "human")!;
  const post = await http(c.base + "/api/send", { method: "POST", headers: c.headers, body: JSON.stringify({ target: { kind: "channel", name: "design" }, text: "hi" }) });
  assert.equal(post.status, 200);
  const channelReply = JSON.parse(post.body) as ChannelSendResult;
  assert.ok(channelReply.msgId);
  await s.until((events) => events.some((e) => e.event === "message" && e.data.msg.id === channelReply.msgId));
  await c.host.idle();
  const channelHistory = await http(c.base + "/api/history?scope=channel&channel=design", { headers: c.headers });
  assert.equal(channelHistory.status, 200);
  const posted = (JSON.parse(channelHistory.body) as HistoryPage).messages.find((m) => m.id === channelReply.msgId)!;
  assert.equal(posted.text, "hi");
  assert.equal(posted.from, "human");
  assert.equal(posted.fromSessionId, undefined);
  assert.equal(a.deliveries.length, 0);
  assert.equal(b.deliveries.length, 0);
  await s.until((events) => events.filter((e) => e.event === "packet").length === 1);
  const channelPacket = s.events.filter((e) => e.event === "packet");
  assert.equal(channelPacket.length, 1);
  assert.deepEqual(channelPacket[0].data.from, { kind: "character", id: operator.id });
  assert.deepEqual(channelPacket[0].data.to, { kind: "venue", venueKey: design.key });
  const dm = await http(c.base + "/api/send", { method: "POST", headers: c.headers, body: JSON.stringify({ target: { kind: "session", id: a.session.id }, text: "direct from browser" }) });
  assert.equal(dm.status, 200);
  const dmReply = JSON.parse(dm.body) as { result: SendResult };
  const delivery = await a.nextDelivery();
  assert.equal(delivery.msg.id, dmReply.result.msgId);
  assert.equal(delivery.msg.from, "human");
  assert.equal(delivery.msg.text, "direct from browser");
  await s.until((events) => events.some((e) => e.event === "message" && e.data.msg.id === dmReply.result.msgId && e.data.msg.status === "delivered"));
  await s.until((events) => events.filter((e) => e.event === "packet").length === 2);
  const packets = s.events.filter((e) => e.event === "packet");
  assert.equal(packets.length, 2, "delivery status must not duplicate the packet");
  assert.deepEqual(packets[1].data.to, { kind: "character", id: a.session.id });
  assert.equal(packets[1].data.senderId, operator.id);
});

test("a first human post publishes its new venue before exactly one packet", { timeout: 10_000 }, async (t) => {
  const c = await city(t);
  const s = await stream(c.base + `/api/events?token=${c.token}`);
  t.after(() => s.close());
  assert.equal(c.host.current().connection, "connected");
  assert.equal(c.host.current().venues.length, 0);
  const posted = await http(c.base + "/api/send", {
    method: "POST", headers: c.headers,
    body: JSON.stringify({ target: { kind: "channel", name: "brandnew" }, text: "first post" }),
  });
  assert.equal(posted.status, 200);
  const reply = JSON.parse(posted.body) as ChannelSendResult;
  await s.until((events) => events.some((event) => event.event === "state" && event.data.feed.some((line) => line.text === "first post")));
  await c.host.idle();
  const venue = c.host.current().venues.find((item) => item.name === "brandnew")!;
  const packets = s.events.filter((event) => event.event === "packet");
  assert.equal(packets.length, 1);
  assert.deepEqual(packets[0].data.from, { kind: "character", id: "human" });
  assert.deepEqual(packets[0].data.to, { kind: "venue", venueKey: venue.key });
  const venueState = s.events.findIndex((event) => event.event === "state" && event.data.layout.venues.some((item) => item.key === venue.key));
  assert.ok(venueState >= 0 && venueState < s.events.indexOf(packets[0]), "state must make the endpoints available before the packet");
  await c.env.human().request("channel_create", { channel: "followup" });
  await s.until((events) => events.some((event) => event.event === "state" && event.data.venues.some((item) => item.name === "followup")));
  await c.host.idle();
  assert.equal(s.events.filter((event) => event.event === "packet").length, 1, "a followup refresh must not replay the first post");
  const history = JSON.parse((await http(c.base + "/api/history?scope=channel&channel=brandnew", { headers: c.headers })).body) as HistoryPage;
  assert.equal(history.messages.find((message) => message.id === reply.msgId)?.text, "first post");
});

test("wire feed preserves long message text and control characters exactly as retained history", { timeout: 10_000 }, async (t) => {
  const c = await city(t);
  await c.env.human().request("channel_create", { channel: "raw" });
  await c.host.idle();
  const s = await stream(c.base + `/api/events?token=${c.token}`);
  t.after(() => s.close());
  const text = "a".repeat(500) + "\u001b[31m\u202e raw \n\t\u2066";
  const posted = await http(c.base + "/api/send", {
    method: "POST", headers: c.headers,
    body: JSON.stringify({ target: { kind: "channel", name: "raw" }, text }),
  });
  assert.equal(posted.status, 200);
  await s.until((events) => events.some((event) => event.event === "state" && event.data.feed.some((line) => line.channel === "raw")));
  const feedState = s.events.find((event) => event.event === "state" && event.data.feed.some((line) => line.channel === "raw"));
  assert.ok(feedState && feedState.event === "state");
  assert.equal(feedState.data.feed.find((line) => line.channel === "raw")!.text, text);
  assert.equal(c.host.current().feed.find((line) => line.channel === "raw")!.text, text);
  const reply = JSON.parse(posted.body) as ChannelSendResult;
  const history = JSON.parse((await http(c.base + "/api/history?scope=channel&channel=raw", { headers: c.headers })).body) as HistoryPage;
  assert.equal(history.messages.find((message) => message.id === reply.msgId)!.text, text);
});

test("send validates Origin, JSON, targets and body limit and preserves daemon errors", { timeout: 10_000 }, async (t) => {
  const c = await city(t);
  const body = JSON.stringify({ target: { kind: "channel", name: "missing" }, text: "hi" });
  const { Origin, ...withoutOrigin } = c.headers;
  assert.equal((await http(c.base + "/api/send", { method: "POST", headers: withoutOrigin, body })).status, 403);
  assert.equal((await http(c.base + "/api/send", { method: "POST", headers: { ...c.headers, Origin: "https://evil.example" }, body })).status, 403);
  assert.equal((await http(c.base + "/api/send", { method: "POST", headers: { ...c.headers, "Content-Type": "text/plain" }, body })).status, 415);
  const blank = await http(c.base + "/api/send", { method: "POST", headers: c.headers, body: JSON.stringify({ target: { kind: "channel", name: "missing" }, text: " \n\t" }) });
  assert.equal(blank.status, 400);
  assert.deepEqual(JSON.parse(blank.body), { error: "bad_request", message: "text is required" });
  for (const invalid of ["{", "null", JSON.stringify({ target: { kind: "session", id: 123 }, text: "hi" })]) {
    assert.equal((await http(c.base + "/api/send", { method: "POST", headers: c.headers, body: invalid })).status, 400);
  }
  assert.equal((await http(c.base + "/api/send", { method: "POST", headers: c.headers, body: "x".repeat(1024 * 1024 + 1) })).status, 413);
  assert.ok(!c.host.current().venues.some((venue) => venue.name === "missing"));
  const createdChannel = await http(c.base + "/api/send", { method: "POST", headers: c.headers, body });
  assert.equal(createdChannel.status, 200, "the human can implicitly create a channel by posting");
  const createdReply = JSON.parse(createdChannel.body) as ChannelSendResult;
  assert.ok(createdReply.msgId);
  const createdHistory = await http(c.base + "/api/history?scope=channel&channel=missing", { headers: c.headers });
  assert.equal(createdHistory.status, 200);
  const createdPost = (JSON.parse(createdHistory.body) as HistoryPage).messages.find((message) => message.id === createdReply.msgId);
  assert.ok(createdPost);
  assert.equal(createdPost.text, "hi");
  assert.equal(createdPost.from, "human");
  assert.equal(createdPost.channel, "missing");
  assert.equal(createdPost.status, "posted");
  const missingSession = await http(c.base + "/api/send", { method: "POST", headers: c.headers, body: JSON.stringify({ target: { kind: "session", id: "missing" }, text: "hi" }) });
  assert.equal(missingSession.status, 404);
  assert.equal(JSON.parse(missingSession.body).error, "unknown_target");
  await c.env.human().request("channel_create", { channel: "valid" });
  const tooLong = await http(c.base + "/api/send", { method: "POST", headers: c.headers, body: JSON.stringify({ target: { kind: "channel", name: "valid" }, text: "x".repeat(32_001) }) });
  assert.equal(tooLong.status, 400);
  assert.equal(JSON.parse(tooLong.body).error, "too_large");
  c.host.close();
  const offline = await http(c.base + "/api/send", { method: "POST", headers: c.headers, body });
  assert.equal(offline.status, 502);
  assert.equal(JSON.parse(offline.body).error, "daemon_unavailable");
});

test("history pagination leaves both channel and session human unread positions unchanged", { timeout: 10_000 }, async (t) => {
  const c = await city(t);
  const human = c.env.human();
  const a = await c.env.adapter("omp", "history-a", "history-a");
  await human.request("channel_create", { channel: "history" });
  await human.request("channel_add", { channel: "history", name: a.session.name });
  const channelScope = { scope: "channel" as const, channel: "history" };
  const sessionScope = { scope: "session" as const, sessionId: a.session.id };
  await human.readState(channelScope);
  await human.readState(sessionScope);
  for (let i = 0; i < 61; i++) await a.client.request("channel_send", { channel: "history", text: `post ${i}` });
  await a.client.request("send", { to: "human", text: "unread direct" });
  const channelBefore = await human.readState(channelScope);
  const sessionBefore = await human.readState(sessionScope);
  assert.equal(channelBefore.unread, 61);
  assert.equal(sessionBefore.unread, 1);
  const latest = await http(c.base + "/api/history?scope=channel&channel=history", { headers: c.headers });
  assert.equal(latest.status, 200);
  assert.equal(latest.headers["cache-control"], "no-store");
  const page = JSON.parse(latest.body) as HistoryPage;
  assert.equal(page.messages.length, 60);
  assert.equal(page.hasMore, true);
  assert.equal(page.messages[0].text, "post 1");
  const older = JSON.parse((await http(c.base + `/api/history?scope=channel&channel=history&before=${page.messages[0].order}`, { headers: c.headers })).body) as HistoryPage;
  assert.deepEqual(older.messages.map((m) => m.text), ["post 0"]);
  const direct = JSON.parse((await http(c.base + `/api/history?scope=session&sessionId=${a.session.id}`, { headers: c.headers })).body) as HistoryPage;
  assert.equal(direct.messages[0].text, "unread direct");
  assert.deepEqual(await human.readState(channelScope), channelBefore);
  assert.deepEqual(await human.readState(sessionScope), sessionBefore);
  for (const query of ["scope=inbox", "scope=channel", "scope=session&sessionId=x&before=1.5", "scope=channel&channel=history&before=NaN", "scope=channel&channel=history&extra=x"]) {
    assert.equal((await http(c.base + `/api/history?${query}`, { headers: c.headers })).status, 400);
  }
});

test("manage shares send guards and rejects unknown or mistyped operations", { timeout: 10_000 }, async (t) => {
  const c = await city(t);
  const body = JSON.stringify({ op: "channel.create", name: "guarded" });
  const { Origin, ...withoutOrigin } = c.headers;
  assert.equal((await http(c.base + "/api/manage", { method: "POST", headers: withoutOrigin, body })).status, 403);
  assert.equal((await http(c.base + "/api/manage", { method: "POST", headers: { ...c.headers, Origin: "https://evil.example" }, body })).status, 403);
  assert.equal((await http(c.base + "/api/manage", { method: "POST", headers: { ...c.headers, "Content-Type": "text/plain" }, body })).status, 415);
  assert.equal((await http(c.base + "/api/manage", { method: "POST", body })).status, 401);
  assert.equal((await http(c.base + "/api/manage", { method: "POST", headers: c.headers, body: "x".repeat(1024 * 1024 + 1) })).status, 413);
  for (const operation of [
    { op: "unknown" }, { op: "channel.create" }, { op: "channel.rename", name: "guarded", to: 7 },
    { op: "session.close", id: "missing", terminate: "yes" }, { op: "session.role", id: "missing", role: "manager" },
    { op: "session.inbound", id: "missing", mode: "allow" }, { op: "session.replace", fromId: "missing" },
    { op: "session.purge", id: "missing", all: true }, { op: "held.release", msgId: 1 },
    { op: "process.kill", pid: -1 }, { op: "process.kill", pid: 1.5 },
    { op: "read.mark", scope: { scope: "inbox" }, state: "read" },
    { op: "read.mark", scope: { scope: "channel", channel: "guarded" }, state: "other" },
    { op: "session.close", id: "missing", terminate: true, pid: 42 },
  ]) {
    const reply = await manage(c, operation);
    assert.equal(reply.status, 400);
    assert.equal(JSON.parse(reply.body).error, "bad_request");
  }
  assert.equal((await manage(c, { op: "session.close", id: "missing", terminate: false })).status, 404);
  assert.equal((await manage(c, { op: "session.rename", id: "missing", name: "next" })).status, 404);
  assert.equal((await manage(c, { op: "channel.delete", name: "missing" })).status, 404);
});

test("channel management creates, renames and deletes venues without moving the remaining city", { timeout: 10_000 }, async (t) => {
  const c = await city(t);
  const s = await stream(c.base + `/api/events?token=${c.token}`);
  t.after(() => s.close());
  assert.equal((await manage(c, { op: "channel.create", name: "stable" })).status, 200);
  await s.until((events) => events.some((event) => event.event === "state" && event.data.venues.some((venue) => venue.name === "stable")));
  const stable = c.host.current().layout.venues.find((venue) => c.host.current().venues.find((item) => item.key === venue.key)?.name === "stable")!;
  assert.equal((await manage(c, { op: "channel.create", name: "lab" })).status, 200);
  await s.until((events) => events.some((event) => event.event === "state" && event.data.venues.some((venue) => venue.name === "lab")));
  const labKey = c.host.current().venues.find((venue) => venue.name === "lab")!.key;
  assert.equal((await manage(c, { op: "channel.rename", name: "lab", to: "lab2" })).status, 200);
  await s.until((events) => events.some((event) => event.event === "state" && event.data.venues.some((venue) => venue.name === "lab2" && venue.key === labKey)));
  const collision = await manage(c, { op: "channel.rename", name: "lab2", to: "stable" });
  assert.equal(collision.status, 409);
  assert.equal(JSON.parse(collision.body).error, "name_taken");
  const start = s.events.length;
  const deleted = await manage(c, { op: "channel.delete", name: "lab2" });
  assert.equal(deleted.status, 200);
  assert.equal(JSON.parse(deleted.body).ok, true);
  await s.until((events) => events.slice(start).some((event) => event.event === "state" && !event.data.venues.some((venue) => venue.key === labKey)));
  await c.host.idle();
  assert.deepEqual(c.host.current().layout.venues.find((venue) => venue.key === stable.key)!.rect, stable.rect);
  assert.ok(!(await conversations(c)).some((conversation) => conversation.title === "lab2"));
});

test("session management publishes role, inbound and exact current name and returns ping replies", { timeout: 10_000 }, async (t) => {
  const c = await city(t);
  const a = await c.env.adapter("omp", "manage-session-a", "manage-a");
  const b = await c.env.adapter("omp", "manage-session-b", "manage-b");
  const s = await stream(c.base + `/api/events?token=${c.token}`);
  t.after(() => s.close());
  await s.until((events) => events.some((event) => event.event === "state" && event.data.characters.some((ch) => ch.id === a.session.id)));
  assert.equal((await manage(c, { op: "session.role", id: a.session.id, role: "worker" })).status, 200);
  await s.until((events) => events.some((event) => event.event === "state" && event.data.characters.some((ch) => ch.id === a.session.id && ch.role === "worker")));
  assert.equal((await manage(c, { op: "session.inbound", id: a.session.id, mode: "hold" })).status, 200);
  await s.until((events) => events.some((event) => event.event === "state" && event.data.characters.some((ch) => ch.id === a.session.id && ch.inbound === "hold")));
  assert.equal((await manage(c, { op: "session.rename", id: a.session.id, name: "renamed-a" })).status, 200);
  await s.until((events) => events.some((event) => event.event === "state" && event.data.characters.some((ch) => ch.id === a.session.id && ch.name === "renamed-a")));
  assert.equal((await manage(c, { op: "session.rename", id: a.session.id, name: b.session.name })).status, 409);
  const ping = await manage(c, { op: "session.ping", id: a.session.id });
  assert.equal(ping.status, 200);
  assert.equal(JSON.parse(ping.body).results[0].ping, "responding");
  assert.equal((await manage(c, { op: "session.role", id: a.session.id, role: null })).status, 200);
  await s.until((events) => events.some((event) => event.event === "state" && event.data.characters.some((ch) => ch.id === a.session.id && ch.name === "renamed-a" && ch.role === null)));
});

test("close always archives first and SIGTERMs only one freshly identified safe owner", { timeout: 10_000 }, async (t) => {
  let procs: ProcInfo[] = [];
  const killed: { pid: number; signal: string }[] = [];
  const c = await city(t, { scan: async () => procs, kill: (pid, signal) => { killed.push({ pid, signal }); } });
  for (const [label, pids, reason] of [
    ["unique", [700_001], undefined], ["missing", [], "process not identified"],
    ["ambiguous", [700_002, 700_003], "ambiguous"], ["self", [process.pid], "refused"],
    ["parent", [process.ppid], "refused"],
  ] as const) {
    const key = `resume-close-${label}`;
    const a = await c.env.adapter("omp", key, `close-${label}`);
    procs = pids.map((pid) => ({ pid, harness: "omp", command: `omp --resume ${key}`, elapsedSec: 1, cpu: 0 }));
    const reply = await manage(c, { op: "session.close", id: a.session.id, terminate: true });
    assert.equal(reply.status, 200);
    const result = JSON.parse(reply.body);
    assert.equal(result.closed, true);
    assert.equal(result.session.state, "removed");
    assert.equal(result.terminated, label === "unique" ? 700_001 : null);
    if (reason) assert.equal(result.reason, reason);
    else assert.equal(result.inferred, true);
    const identities = (await c.env.human().sync()).sessions;
    assert.equal(identities.find((session) => session.id === a.session.id)!.state, "removed");
  }
  assert.deepEqual(killed, [{ pid: 700_001, signal: "SIGTERM" }]);
  const short = await c.env.adapter("omp", "short", "close-short");
  procs = [{ pid: 700_004, harness: "omp", command: "omp --resume short", elapsedSec: 1, cpu: 0 }];
  assert.equal(JSON.parse((await manage(c, { op: "session.close", id: short.session.id, terminate: true })).body).terminated, null);
  assert.equal(killed.length, 1);
});

test("city state exposes owner pid only for unique long resume-id matches", { timeout: 10_000 }, async (t) => {
  const procs: ProcInfo[] = [
    { pid: 710_001, harness: "omp", command: "omp --resume owner-unique-city", elapsedSec: 1, cpu: 0 },
    { pid: 710_002, harness: "omp", command: "omp --resume owner-ambiguous-city", elapsedSec: 1, cpu: 0 },
    { pid: 710_003, harness: "omp", command: "omp --resume owner-ambiguous-city", elapsedSec: 1, cpu: 0 },
    { pid: 710_004, harness: "omp", command: "omp --resume tiny", elapsedSec: 1, cpu: 0 },
  ];
  const c = await city(t, { scan: async () => procs, kill: () => assert.fail("projection must never terminate processes") });
  const a = await c.env.adapter("omp", "owner-unique-city", "owner-unique");
  const b = await c.env.adapter("omp", "owner-ambiguous-city", "owner-ambiguous");
  const short = await c.env.adapter("omp", "tiny", "owner-short");
  const missing = await c.env.adapter("omp", "owner-missing-city", "owner-missing");
  const s = await stream(c.base + `/api/events?token=${c.token}`);
  t.after(() => s.close());
  await s.until((events) => events.some((event) => event.event === "state" && event.data.characters.some((ch) => ch.id === missing.session.id)));
  const characters = c.host.current().characters;
  assert.equal(characters.find((ch) => ch.id === a.session.id)!.ownerPid, 710_001);
  for (const id of [b.session.id, short.session.id, missing.session.id]) assert.equal(characters.find((ch) => ch.id === id)!.ownerPid, undefined);
  assert.ok(characters.filter((ch) => ch.source !== "registered").every((ch) => ch.inbound === undefined && ch.ownerPid === undefined));
});

test("a termination failure reports successful closure and process kill rechecks fresh scan ownership", { timeout: 10_000 }, async (t) => {
  let procs: ProcInfo[] = [];
  let fail = true;
  const killed: number[] = [];
  const c = await city(t, {
    scan: async () => procs,
    kill: (pid) => { if (fail) throw new Error("SIGTERM unavailable"); killed.push(pid); },
  });
  const a = await c.env.adapter("omp", "resume-terminate-failure", "terminate-failure");
  procs = [{ pid: 700_005, harness: "omp", command: "omp --resume resume-terminate-failure", elapsedSec: 1, cpu: 0 }];
  const closed = await manage(c, { op: "session.close", id: a.session.id, terminate: true });
  assert.equal(closed.status, 200);
  const result = JSON.parse(closed.body);
  assert.equal(result.closed, true);
  assert.equal(result.session.state, "removed");
  assert.equal(result.terminated, null);
  fail = false;
  procs = [];
  assert.equal((await manage(c, { op: "process.kill", pid: 700_005 })).status, 404);
  for (const pid of [process.pid, process.ppid]) {
    procs = [{ pid, harness: "omp", command: "omp", elapsedSec: 1, cpu: 0 }];
    assert.equal((await manage(c, { op: "process.kill", pid })).status, 404);
  }
  procs = [{ pid: 700_006, harness: "omp", command: "omp", elapsedSec: 1, cpu: 0 }];
  const killedReply = await manage(c, { op: "process.kill", pid: 700_006 });
  assert.equal(killedReply.status, 200);
  assert.equal(JSON.parse(killedReply.body).terminated, 700_006);
  assert.deepEqual(killed, [700_006]);
});

test("conversations expose live and archived activity and read management broadcasts reminders", { timeout: 10_000 }, async (t) => {
  const c = await city(t);
  const a = await c.env.adapter("omp", "conversation-a", "conversation-a");
  const empty = await c.env.adapter("omp", "conversation-empty", "conversation-empty");
  const s = await stream(c.base + `/api/events?token=${c.token}`);
  t.after(() => s.close());
  const scope = { scope: "session", sessionId: a.session.id };
  await a.client.request("send", { to: "human", text: "incoming preview" });
  let list = await conversations(c);
  let conversation = list.find((entry) => entry.key === `s:${a.session.id}`)!;
  assert.equal(conversation.unread, 1);
  assert.equal(conversation.archived, false);
  assert.equal(conversation.preview!.text, "incoming preview");
  assert.equal(conversation.preview!.from, a.session.name);
  assert.ok(conversation.lastActivity > 0 && conversation.lastOrder > 0);
  assert.equal((await manage(c, { op: "read.mark", scope, state: "read" })).status, 200);
  assert.equal((await conversations(c)).find((entry) => entry.key === conversation.key)!.unread, 0);
  const unread = await manage(c, { op: "read.mark", scope, state: "unread" });
  assert.equal(unread.status, 200);
  assert.equal(JSON.parse(unread.body).state.unread, 1);
  await s.until((events) => events.some((event) => event.event === "read" && event.data.state.scope.scope === "session"
    && event.data.state.scope.sessionId === a.session.id && event.data.state.reminder !== null));
  conversation = (await conversations(c)).find((entry) => entry.key === conversation.key)!;
  assert.equal(conversation.reminder, true);
  assert.equal((await manage(c, { op: "read.mark", scope, state: "read" })).status, 200);
  conversation = (await conversations(c)).find((entry) => entry.key === conversation.key)!;
  assert.equal(conversation.unread, 0);
  assert.equal(conversation.reminder, false);
  assert.equal((await manage(c, { op: "channel.create", name: "conversation-channel" })).status, 200);
  await c.env.human().request("channel_add", { channel: "conversation-channel", name: a.session.name });
  await a.client.request("channel_send", { channel: "conversation-channel", text: "channel activity" });
  list = await conversations(c);
  assert.equal(list.find((entry) => entry.key === "ch:conversation-channel")!.unread, 1);
  assert.equal((await manage(c, { op: "read.mark", scope: { scope: "channel", channel: "conversation-channel" }, state: "read" })).status, 200);
  assert.equal((await conversations(c)).find((entry) => entry.key === "ch:conversation-channel")!.unread, 0);
  assert.equal((await manage(c, { op: "session.close", id: a.session.id, terminate: false })).status, 200);
  assert.equal((await manage(c, { op: "session.close", id: empty.session.id, terminate: false })).status, 200);
  list = await conversations(c);
  assert.equal(list.find((entry) => entry.key === conversation.key)!.archived, true);
  assert.ok(!list.some((entry) => entry.key === `s:${empty.session.id}`));
});

test("session send options deliver actual control messages and invalid channel or option payloads fail", { timeout: 10_000 }, async (t) => {
  const c = await city(t);
  const a = await c.env.adapter("omp", "control-options", "control-options");
  const target = { kind: "session", id: a.session.id };
  const options = { kind: "control", action: "pause", thread: "city-control", done: true };
  const reply = await http(c.base + "/api/send", { method: "POST", headers: c.headers, body: JSON.stringify({ target, text: "pause now", options }) });
  assert.equal(reply.status, 200);
  const delivery = await a.nextDelivery();
  assert.equal(delivery.msg.kind, "control");
  assert.equal(delivery.msg.action, "pause");
  assert.equal(delivery.msg.thread, "city-control");
  assert.equal(delivery.msg.done, true);
  for (const invalid of [
    null, [], { kind: "unknown" }, { action: "pause" }, { kind: "chat", action: "pause" },
    { kind: "control", action: "stop" }, { thread: "x".repeat(201) }, { replyTo: 1 }, { done: "yes" }, { reset: "compact" },
  ]) {
    assert.equal((await http(c.base + "/api/send", { method: "POST", headers: c.headers, body: JSON.stringify({ target, text: "invalid", options: invalid }) })).status, 400);
  }
  assert.equal((await http(c.base + "/api/send", {
    method: "POST", headers: c.headers, body: JSON.stringify({ target: { kind: "channel", name: "options" }, text: "invalid", options: {} }),
  })).status, 400);
  assert.equal(a.deliveries.length, 1);
});

test("held management releases and drops real agent messages", { timeout: 10_000 }, async (t) => {
  const c = await city(t);
  const a = await c.env.adapter("omp", "held-target-city", "held-target");
  const sender = await c.env.adapter("omp", "held-sender-city", "held-sender");
  await c.env.human().request("set_inbound", { name: a.session.name, mode: "hold" });
  const releaseId = ((await sender.client.request("send", { to: a.session.name, text: "release me" })).results as SendResult[])[0].msgId!;
  const dropId = ((await sender.client.request("send", { to: a.session.name, text: "drop me" })).results as SendResult[])[0].msgId!;
  const held = await http(c.base + "/api/held", { headers: c.headers });
  assert.equal(held.status, 200);
  const result: { messages: StoredMessage[] } = JSON.parse(held.body);
  const messages = result.messages;
  assert.deepEqual(messages.map((message) => [message.id, message.status]), [[releaseId, "held"], [dropId, "held"]]);
  assert.equal((await manage(c, { op: "held.release", msgId: releaseId })).status, 200);
  assert.equal((await a.nextDelivery()).msg.id, releaseId);
  assert.equal((await manage(c, { op: "held.drop", msgId: dropId })).status, 200);
  assert.deepEqual(JSON.parse((await http(c.base + "/api/held", { headers: c.headers })).body).messages, []);
  const history = await c.env.human().historyPage({ scope: "session", sessionId: a.session.id });
  assert.equal(history.messages.find((message) => message.id === releaseId)!.status, "delivered");
  assert.equal(history.messages.find((message) => message.id === dropId)!.status, "dropped");
});

test("membership, replacement, stale closure and purging use stable session identities", { timeout: 10_000 }, async (t) => {
  const c = await city(t);
  const a = await c.env.adapter("omp", "membership-city-a", "membership-a");
  const b = await c.env.adapter("omp", "membership-city-b", "membership-b");
  const s = await stream(c.base + `/api/events?token=${c.token}`);
  t.after(() => s.close());
  await s.until((events) => events.some((event) => event.event === "state" && event.data.characters.some((ch) => ch.id === b.session.id)));
  assert.equal((await manage(c, { op: "channel.create", name: "members" })).status, 200);
  assert.equal((await manage(c, { op: "channel.add", name: "members", id: a.session.id })).status, 200);
  await s.until((events) => events.some((event) => event.event === "state" && event.data.venues.some((venue) => venue.name === "members" && venue.rosterIds.includes(a.session.id))));
  assert.equal((await manage(c, { op: "channel.remove", name: "members", id: a.session.id })).status, 200);
  assert.deepEqual((await c.env.human().request("channel_members", { channel: "members" })).members, []);
  assert.equal((await manage(c, { op: "channel.add", name: "members", id: a.session.id })).status, 200);
  assert.equal((await manage(c, { op: "session.role", id: a.session.id, role: "worker" })).status, 200);
  assert.equal((await manage(c, { op: "session.replace", fromId: a.session.id, toId: b.session.id })).status, 200);
  const listed = (await c.env.human().request("list")).sessions as ListedSession[];
  assert.ok(!listed.some((session) => session.id === a.session.id));
  assert.equal(listed.find((session) => session.id === b.session.id)!.role, "worker");
  assert.deepEqual(listed.find((session) => session.id === b.session.id)!.channels, ["members"]);
  assert.equal((await manage(c, { op: "session.purge", id: a.session.id })).status, 200);
  b.client.close();
  for (let turn = 0; turn < 2000; turn++) {
    const sessions = (await c.env.human().request("list")).sessions as ListedSession[];
    if (sessions.some((session) => session.id === b.session.id && session.stale)) break;
    await nextTurn();
  }
  const stale = (await c.env.human().request("list")).sessions as ListedSession[];
  assert.equal(stale.find((session) => session.id === b.session.id)!.stale, true);
  const closed = await manage(c, { op: "session.closeStale" });
  assert.equal(closed.status, 200);
  assert.equal(JSON.parse(closed.body).closed, 1);
  assert.equal((await manage(c, { op: "session.purge", all: true })).status, 200);
  assert.deepEqual((await c.env.human().sync()).sessions, []);
});

test("server close terminates open SSE streams", { timeout: 10_000 }, async (t) => {
  const c = await city(t);
  const s = await stream(c.base + `/api/events?token=${c.token}`);
  t.after(() => s.close());
  await c.server.close();
  await s.ended;
  await c.server.close();
});

test("city rejects unknown options, positional arguments and invalid ports", async () => {
  for (const args of [["--bogus"], ["unexpected"], ["--port", "-1"], ["--port", "65536"], ["--port", "1.5"], ["--port", ""]]) {
    assert.equal(await runCity(args), 1);
  }
});

test("city CLI SIGINT closes active SSE and exits zero", { timeout: 15_000 }, async (t) => {
  const env = await startEnv();
  t.after(() => env.close());
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", fileURLToPath(new URL("../src/cli.js", import.meta.url)), "city", "--no-open", "--port", "0"], {
    env: { ...process.env, ASENQ_HOME: env.home, HOME: env.home }, stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); });
  const ready = Promise.withResolvers<string>();
  const exited = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>();
  let output = "";
  let errors = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { errors += chunk; });
  child.stdout.on("data", (chunk) => {
    output += chunk;
    const url = /asenq city: (http:\/\/127\.0\.0\.1:\d+\/#token=[^\s]+)/.exec(output)?.[1];
    if (url) ready.resolve(url);
  });
  child.once("error", ready.reject);
  child.once("exit", (code, signal) => { exited.resolve({ code, signal }); ready.reject(new Error(`city exited before readiness: ${errors}`)); });
  const url = new URL(await ready.promise);
  const token = new URLSearchParams(url.hash.slice(1)).get("token")!;
  const s = await stream(`${url.origin}/api/events?token=${token}`);
  t.after(() => s.close());
  child.kill("SIGINT");
  assert.deepEqual(await exited.promise, { code: 0, signal: null }, errors);
  await s.ended;
});
