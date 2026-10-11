import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { afterEach, test } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { AsenqClient } from "../src/shared/client.js";
import type { ClientOpts } from "../src/shared/client.js";
import type { ChannelSummary, PositionedEvent } from "../src/shared/protocol.js";
import { terminalTextWidth } from "../src/tui/terminal.js";
import type { MouseInput, TerminalAdapterOptions, TerminalFrame, TerminalLine, TerminalSize } from "../src/tui/terminal.js";
import { VizApp } from "../src/viz/app.js";
import type { VizDeps } from "../src/viz/app.js";
import type { VizMap } from "../src/viz/map.js";
import type { ProcInfo } from "../src/viz/scan.js";
import { startEnv } from "./helpers.js";
import type { TestEnv } from "./helpers.js";

let env: TestEnv | undefined;
let open: Viz | undefined;
afterEach(async () => {
  open?.interrupt();
  open = undefined;
  await env?.close();
  env = undefined;
});

const lineText = (line: TerminalLine): string => typeof line === "string" ? line : line.map((span) => span.text).join("");
type Viz = {
  app: VizApp; map: VizMap; size: TerminalSize; done: Promise<number>;
  rows(): string[]; lists(): number; cleanups(): number;
  press(name: string): Promise<void>; search(name: string): Promise<void>;
  mouse(action: MouseInput["action"], column: number, row: number): Promise<void>;
  resize(columns: number, rows: number): Promise<void>; step(ms: number): Promise<void>;
  interrupt(): void; until(predicate: () => boolean, what: string): Promise<void>;
};

/** Real daemon/client, recording terminal and manual animation clock. */
function startViz(deps: Omit<VizDeps, "screen" | "now" | "schedule"> = {}): Viz {
  let handlers: TerminalAdapterOptions = {};
  let frame: TerminalFrame = { lines: [] };
  let lists = 0;
  let cleanups = 0;
  const size = { columns: 160, rows: 48 };
  const app = new VizApp({
    ...deps,
    client: (options) => {
      const client = deps.client?.(options) ?? new AsenqClient({ ...options, autoStart: false });
      const request = client.request.bind(client);
      client.request = async (op, params) => { if (op === "list") lists++; return request(op, params); };
      return client;
    },
    screen: (options) => {
      handlers = options;
      return { size, start() {}, render(next) { frame = next; }, cleanup() { cleanups++; } };
    },
    scan: deps.scan ?? (async () => []),
    now: () => env!.clock.now(),
    schedule: () => () => {},
  });
  const done = app.run();
  // Packet/animation counts and selected scope are public controller seams, not terminal glyph assertions.
  const inner = app as unknown as { map: VizMap };
  const map = inner.map;
  const viz: Viz = {
    app, map, size, done, rows: () => frame.lines.map(lineText), lists: () => lists, cleanups: () => cleanups,
    async press(name) {
      const text = [...name].length === 1 ? name : undefined;
      handlers.onKey?.({ name, matches: [name], ...(text ? { text } : {}), ctrl: name.startsWith("CTRL_"), alt: false, shift: name.startsWith("SHIFT_") });
      await app.idle();
    },
    async search(name) { await viz.press("/"); for (const ch of name) await viz.press(ch); await viz.press("ENTER"); },
    async mouse(action, column, row) {
      handlers.onMouse?.({ name: "MOUSE", action, column, row, button: "left", ctrl: false, alt: false, shift: false });
      await app.idle();
    },
    async resize(columns, rows) { Object.assign(size, { columns, rows }); handlers.onResize?.(size); await app.idle(); },
    async step(ms) { app.step(ms); await app.idle(); },
    interrupt: () => handlers.onInterrupt?.(),
    async until(predicate, what) {
      for (let turn = 0; turn < 2000; turn++) { await app.idle(); if (predicate()) return; await nextTurn(); }
      assert.fail(`never reached ${what}:\n${viz.rows().join("\n")}`);
    },
  };
  open = viz;
  return viz;
}
const has = (viz: Viz, text: string): boolean => viz.rows().some((row) => row.includes(text));
async function fleet() {
  const e = env!;
  const boss = await e.adapter("claude", "viz-boss", "boss-queen");
  const alpha = await e.adapter("omp", "viz-alpha", "wrk-alpha");
  await e.human().request("channel_create", { channel: "ops" });
  await e.human().request("channel_create", { channel: "empty" });
  for (const name of ["boss-queen", "wrk-alpha"]) await e.human().request("channel_add", { channel: "ops", name });
  return { boss, alpha };
}
async function ready(viz: Viz): Promise<void> { await viz.until(() => !has(viz, "SIGNAL LOST") && viz.lists() > 0, "successful city snapshot"); }
function within(viz: Viz): void {
  assert.equal(viz.rows().length, viz.size.rows);
  for (const row of viz.rows()) assert.ok(terminalTextWidth(row) <= viz.size.columns, row);
  assert.ok(!has(viz, "RENDER FAULT"));
}

test("empty venues and every registered identity are searchable, including archived roster members", async () => {
  env = await startEnv();
  const { alpha } = await fleet();
  await alpha.client.request("unregister");
  const viz = startViz();
  await ready(viz);
  await viz.search("empty");
  assert.deepEqual(viz.map.conversation(), { scope: "channel", channel: "empty" });
  assert.ok(has(viz, "empty"));
  await viz.search("wrk-alpha");
  assert.deepEqual(viz.map.conversation(), { scope: "session", sessionId: alpha.session.id });
  assert.ok(has(viz, "wrk-alpha"));
  await viz.press("I");
  assert.ok(has(viz, "REMOVED"));
  within(viz);
});

test("legacy channel summaries resolve rosters from channel_members, including unresolved identities", async () => {
  env = await startEnv();
  const { alpha } = await fleet();
  await alpha.client.request("unregister");
  const viz = startViz({ client: (options) => {
    const client = new AsenqClient({ ...options, autoStart: false });
    const sync = client.sync.bind(client);
    client.sync = async () => { const s = await sync(); return { ...s, sessions: s.sessions.filter((identity) => identity.id !== alpha.session.id) }; };
    const request = client.request.bind(client);
    client.request = async (op, params) => {
      const reply = await request(op, params);
      if (op === "channel_list") reply.channels = (reply.channels as ChannelSummary[]).map(({ memberIds: _ids, ...channel }) => channel);
      return reply;
    };
    return client;
  } });
  await ready(viz);
  await viz.search("wrk-alpha");
  assert.deepEqual(viz.map.conversation(), { scope: "session", sessionId: alpha.session.id });
  assert.ok(has(viz, "wrk-alpha"));
});

test("fresh direct and channel traffic animates once; status events deduplicate and expire", async () => {
  env = await startEnv();
  const { boss, alpha } = await fleet();
  const viz = startViz();
  await ready(viz);
  await boss.client.request("send", { to: "wrk-alpha", text: "ship ledger", kind: "task" });
  await alpha.nextDelivery();
  await viz.until(() => has(viz, "ship ledger"), "direct feed");
  assert.equal(viz.map.packetCount, 1);
  assert.equal(viz.map.animationCount, 1);
  await boss.client.request("channel_send", { channel: "ops", text: "plain post" });
  await viz.until(() => has(viz, "plain post"), "channel feed");
  assert.equal(viz.map.packetCount, 2, "one venue packet, not one per member");
  await viz.step(1400);
  assert.equal(viz.map.packetCount, 0);
  assert.equal(viz.map.animationCount, 0);
});

test("standalone Enter inspects without reading or messaging, including search acceptance", async () => {
  env = await startEnv();
  const { alpha } = await fleet();
  await alpha.client.request("send", { to: "human", text: "unread incoming" });
  const viz = startViz();
  await ready(viz);
  await viz.search("wrk-alpha");
  await viz.press("ENTER");
  assert.ok(has(viz, "wrk-alpha"));
  assert.equal((await env.human().readState({ scope: "session", sessionId: alpha.session.id })).unread, 1);
  assert.equal(alpha.deliveries.length, 0);
});

test("search consumes q and shortcut letters, Escape only cancels search, interrupt always quits", async () => {
  env = await startEnv();
  const q = await env.adapter("omp", "viz-query", "qfirst");
  const viz = startViz();
  await ready(viz);
  await viz.search("qfirst");
  assert.deepEqual(viz.map.conversation(), { scope: "session", sessionId: q.session.id });
  assert.equal(viz.cleanups(), 0);
  await viz.press("/");
  await viz.press("q");
  await viz.press("ESCAPE");
  assert.equal(viz.cleanups(), 0);
  await viz.press("CTRL_C");
  assert.equal(await viz.done, 0);
  assert.equal(viz.cleanups(), 1);
  viz.interrupt();
  assert.equal(viz.cleanups(), 1);
});

test("Tab cycles every venue and character, filter leaves venue access and uppercase follow is distinct", async () => {
  env = await startEnv();
  const { boss, alpha } = await fleet();
  const viz = startViz();
  await ready(viz);
  const scopes = new Set<string>();
  for (let i = 0; i < 10; i++) { await viz.press("TAB"); scopes.add(JSON.stringify(viz.map.conversation())); }
  for (const scope of [{ scope: "channel", channel: "empty" }, { scope: "channel", channel: "ops" }, { scope: "session", sessionId: boss.session.id }, { scope: "session", sessionId: alpha.session.id }]) assert.ok(scopes.has(JSON.stringify(scope)));
  await viz.search("boss-queen");
  await viz.press("F");
  assert.ok(!viz.map.flags.includes("FILTER"));
  await viz.press("f");
  assert.ok(viz.map.flags.includes("FILTER:claude"));
  await viz.search("empty");
  assert.deepEqual(viz.map.conversation(), { scope: "channel", channel: "empty" });
});

test("detected processes remain inspectable without a conversation and u toggles their candidates", async () => {
  env = await startEnv();
  const procs: ProcInfo[] = [{ pid: 4242, harness: "codex", command: "codex", elapsedSec: 7, cpu: 12 }];
  const viz = startViz({ scan: async () => procs });
  await ready(viz);
  await viz.search("codex-4242");
  assert.deepEqual(viz.map.selected, { kind: "character", id: "proc:4242" });
  assert.equal(viz.map.conversation(), undefined);
  await viz.press("ENTER");
  assert.ok(has(viz, "4242") && has(viz, "inferred"));
  await viz.press("ESCAPE");
  await viz.press("u");
  assert.ok(viz.map.flags.includes("FERAL OFF"));
});

test("two-second snapshots and five-second process scans are manually driven; r refreshes immediately", async () => {
  env = await startEnv();
  await fleet();
  let scans = 0;
  const viz = startViz({ scan: async () => (scans++, []) });
  await ready(viz);
  const lists = viz.lists();
  await viz.step(1900);
  assert.equal(viz.lists(), lists);
  await viz.step(100);
  assert.equal(viz.lists(), lists + 1);
  await viz.step(3000);
  assert.equal(scans, 2);
  await viz.press("r");
  assert.equal(scans, 3);
});

test("snapshot failure retains selected city; full list/channel bundle restores connection", async () => {
  env = await startEnv();
  const { alpha } = await fleet();
  let outage = false;
  const viz = startViz({ client: (options) => {
    const client = new AsenqClient({ ...options, autoStart: false });
    const request = client.request.bind(client);
    client.request = async (op, params) => { if (op === "channel_list" && outage) throw new Error("no channel signal"); return request(op, params); };
    return client;
  } });
  await ready(viz);
  await viz.search("wrk-alpha");
  outage = true;
  await viz.step(2000);
  assert.ok(has(viz, "SIGNAL LOST") && has(viz, "wrk-alpha"));
  assert.deepEqual(viz.map.conversation(), { scope: "session", sessionId: alpha.session.id });
  assert.equal(viz.map.packetCount, 0);
  assert.equal(viz.map.animationCount, 0);
  outage = false;
  await viz.step(2000);
  assert.ok(!has(viz, "SIGNAL LOST"));
});

test("reconnect pages replay before snapshot watermark, preserves observed rename, ignores duplicates and never animates history", async () => {
  env = await startEnv();
  const { boss, alpha } = await fleet();
  let receive: ClientOpts["onPush"];
  let reconnect: ClientOpts["onReconnect"];
  let hold = false;
  const held: PositionedEvent[] = [];
  const viz = startViz({ client: (options) => {
    receive = options.onPush;
    reconnect = options.onReconnect;
    const client = new AsenqClient({ ...options, autoStart: false, onPush: (p) => {
      if (hold && p.push === "event") held.push({ position: p.position, event: p.event });
      else options.onPush?.(p);
    } });
    const replay = client.replay.bind(client);
    client.replay = async (after) => replay(after, 1);
    return client;
  } });
  await ready(viz);
  await viz.search("ops");
  const selected = viz.map.selected;
  hold = true;
  await env.human().request("channel_rename", { channel: "ops", name: "renamed" });
  await boss.client.request("send", { to: "wrk-alpha", text: "missed while offline" });
  await alpha.nextDelivery();
  await reconnect?.();
  await viz.app.idle();
  assert.deepEqual(viz.map.selected, selected);
  assert.deepEqual(viz.map.conversation(), { scope: "channel", channel: "renamed" });
  assert.equal(viz.map.packetCount, 0);
  assert.equal(viz.map.animationCount, 0);
  assert.ok(has(viz, "missed while offline"));
  for (const item of held) receive?.({ push: "event", ...item });
  await viz.app.idle();
  assert.equal(viz.map.packetCount, 0);
});

test("replay gap adopts authoritative snapshot with visible HISTORY GAP, not guessed channel rename", async () => {
  env = await startEnv();
  await fleet();
  let reconnect: ClientOpts["onReconnect"];
  let gap = false;
  const viz = startViz({ client: (options) => {
    reconnect = options.onReconnect;
    const client = new AsenqClient({ ...options, autoStart: false });
    const replay = client.replay.bind(client);
    client.replay = async (after) => { const r = await replay(after); return gap ? { ...r, events: [], gap: true, hasMore: false } : r; };
    return client;
  } });
  await ready(viz);
  gap = true;
  await reconnect?.();
  await viz.app.idle();
  assert.ok(has(viz, "HISTORY GAP"));
  await viz.search("empty");
  assert.deepEqual(viz.map.conversation(), { scope: "channel", channel: "empty" });
});

test("Unicode former names stay searchable through resize, pan, zoom, compact mode and mouse selection", async () => {
  env = await startEnv();
  const session = await env.adapter("omp", "viz-unicode", "city-界");
  const viz = startViz();
  await ready(viz);
  await env.human().request("rename", { from: "city-界", name: "renamed-city" });
  await viz.until(() => has(viz, "renamed-city"), "rename applied");
  for (const [columns, rows] of [[160, 48], [80, 24], [40, 16], [1, 1], [160, 48]]) {
    await viz.resize(columns, rows);
    await viz.search("city-界");
    assert.deepEqual(viz.map.conversation(), { scope: "session", sessionId: session.session.id });
    within(viz);
  }
  for (const key of ["RIGHT", "+", "-", "0"]) await viz.press(key);
  const row = viz.rows().findIndex((line) => line.includes("renamed-city"));
  assert.ok(row >= 0);
  await viz.mouse("press", viz.rows()[row].indexOf("renamed-city"), row);
  assert.deepEqual(viz.map.conversation(), { scope: "session", sessionId: session.session.id });
  within(viz);
});

test("settings warnings and reduced motion are visible and busy frames remain static", async () => {
  env = await startEnv();
  const { alpha } = await fleet();
  await alpha.client.request("session_status", { busy: true });
  const viz = startViz({ reducedMotion: true, settings: () => ({ settings: { reducedMotion: false, sessions: {}, harnesses: {} }, warning: "viz.json: appearance.sessions.bad: invalid outfit" }) });
  await ready(viz);
  await viz.search("wrk-alpha");
  await viz.press("I");
  assert.ok(has(viz, "REDUCED MOTION") && has(viz, "viz.json:"));
  const before = viz.rows();
  await viz.step(50);
  assert.deepEqual(viz.rows(), before);
  assert.ok(has(viz, "neutral") && has(viz, "unknown"));
});

test("CLI rejects invalid and repeated reduced-motion arguments before creating a terminal", () => {
  for (const command of ["viz", "tui"]) for (const args of [["--bogus"], ["--reduced-motion", "--reduced-motion"]]) {
    const result = spawnSync(process.execPath, ["dist/src/cli.js", command, ...args], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.equal(result.stderr.trim(), `usage: asenq ${command} [--reduced-motion]`);
  }
});
