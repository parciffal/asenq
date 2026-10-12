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
import type { CityEvent } from "../src/city/host.js";
import { startCityServer } from "../src/city/server.js";
import { AsenqClient } from "../src/shared/client.js";
import type { ChannelSendResult, HistoryPage, SendResult } from "../src/shared/protocol.js";
import { DEFAULT_VIZ_SETTINGS } from "../src/viz/settings.js";
import { startEnv } from "./helpers.js";

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

async function city(t: TestContext) {
  const env = await startEnv();
  const root = mkdtempSync(join(tmpdir(), "asenq-city-static-"));
  writeFileSync(join(root, "index.html"), "<!doctype html><title>city transport test</title>");
  writeFileSync(join(root, "app.js"), "export const value = 1;\n");
  writeFileSync(join(root, "private.bin"), "not a public type");
  const host = new CityHost({
    client: (options) => new AsenqClient({ ...options, autoStart: false }),
    scan: async () => [], schedule: () => () => {},
    settings: () => ({ settings: DEFAULT_VIZ_SETTINGS, warning: null }),
  });
  const token = randomBytes(24).toString("base64url");
  const server = await startCityServer(host, { port: 0, token, root });
  const base = `http://127.0.0.1:${server.port}`;
  t.after(async () => { host.close(); await server.close(); await env.close(); rmSync(root, { recursive: true, force: true }); });
  host.start();
  await host.idle();
  return { env, root, host, server, token, base, headers: { "X-Asenq-Token": token, "Content-Type": "application/json", Origin: base } };
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
  const missingChannel = await http(c.base + "/api/send", { method: "POST", headers: c.headers, body });
  assert.equal(missingChannel.status, 404);
  assert.equal(JSON.parse(missingChannel.body).error, "unknown_channel");
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
