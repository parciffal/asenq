import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { AsenqClient } from "../src/shared/client.js";
import type { ListedSession } from "../src/shared/protocol.js";
import type { TerminalAdapterOptions, TerminalFrame, TerminalLine, TerminalSize } from "../src/tui/terminal.js";
import { VizApp } from "../src/viz/app.js";
import { buildWorld } from "../src/viz/model.js";
import type { ProcInfo } from "../src/viz/scan.js";
import { renderScene } from "../src/viz/scene.js";
import type { Hit } from "../src/viz/types.js";
import { isSession, startEnv, type Adapter, type TestEnv } from "./helpers.js";

let env: TestEnv | undefined;
let open: Viz | undefined;
const home = process.env.ASENQ_HOME;
const scratch: string[] = [];
afterEach(async () => {
  open?.interrupt();
  open = undefined;
  await env?.close();
  env = undefined;
  if (home === undefined) delete process.env.ASENQ_HOME;
  else process.env.ASENQ_HOME = home;
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Viz = {
  app: VizApp;
  size: TerminalSize;
  done: Promise<number>;
  cleanups(): number;
  lists(): number;
  rows(): string[];
  press(name: string): Promise<void>;
  click(column: number, row: number): Promise<void>;
  resize(columns: number, rows: number): Promise<void>;
  step(ms: number): Promise<void>;
  interrupt(): void;
  until(predicate: () => boolean, what: string): Promise<void>;
};

const lineText = (line: TerminalLine | undefined): string =>
  line === undefined ? "" : typeof line === "string" ? line : line.map((span) => span.text).join("");

type VizOptions = { columns?: number; rows?: number; scan?: () => Promise<ProcInfo[]> };

/** Runs the real app against the test daemon with a recording screen and a manually stepped clock. */
function startViz(o: VizOptions = {}): Viz {
  let handlers: TerminalAdapterOptions = {};
  let frame: TerminalFrame = { lines: [] };
  let cleanups = 0;
  let lists = 0;
  const size = { columns: o.columns ?? 160, rows: o.rows ?? 48 };
  const app = new VizApp({
    client: (options) => {
      const client = new AsenqClient({ ...options, autoStart: false });
      const request = client.request.bind(client);
      client.request = async (op, params) => {
        if (op === "list") lists++;
        return request(op, params);
      };
      return client;
    },
    screen: (options) => {
      handlers = options;
      return { size, start() {}, render(next) { frame = next; }, cleanup() { cleanups++; } };
    },
    scan: o.scan ?? (async () => []),
    now: () => env?.clock.now() ?? Date.now(),
    schedule: () => () => {},
  });
  const done = app.run();
  const viz: Viz = {
    app, size, done,
    lists: () => lists,
    cleanups: () => cleanups,
    rows: () => frame.lines.map(lineText),
    async press(name) {
      const text = [...name].length === 1 ? name : undefined;
      handlers.onKey?.({ name, matches: [name], ...(text ? { text } : {}), ctrl: name.startsWith("CTRL_"), alt: false, shift: name.startsWith("SHIFT_") });
      await app.idle();
    },
    async click(column, row) {
      handlers.onMouse?.({ name: "MOUSE_LEFT_BUTTON_PRESSED", column, row, action: "press", button: "left", ctrl: false, alt: false, shift: false });
      await app.idle();
    },
    async resize(columns, rows) {
      Object.assign(size, { columns, rows });
      handlers.onResize?.(size);
      await app.idle();
    },
    async step(ms) {
      app.step(ms);
      await app.idle();
    },
    interrupt: () => handlers.onInterrupt?.(),
    async until(predicate, what) {
      const deadline = Date.now() + 3000;
      for (;;) {
        await app.idle();
        if (predicate()) return;
        if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}:\n${viz.rows().join("\n")}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
  };
  open = viz;
  return viz;
}

const has = (viz: Viz, text: string): boolean => viz.rows().some((row) => row.includes(text));
const count = (viz: Viz, text: string): number => viz.rows().join("\n").split(text).length - 1;
/** The TARGET panel's first body row: names the selected bug, or a hint when none is selected. */
const target = (viz: Viz): string => {
  const rows = viz.rows();
  const header = rows.findIndex((row) => row.includes("TARGET"));
  return header < 0 ? "" : rows[header + 1] ?? "";
};

type Fleet = { boss: Adapter; alpha: Adapter; beta: Adapter };

/** claude orchestrator `boss-queen` with omp workers `wrk-alpha`/`wrk-beta` sharing channel `ops`. */
async function fleet(e: TestEnv): Promise<Fleet> {
  const human = e.human();
  const boss = await e.adapter("claude", "viz-boss", "boss-queen", { cwd: "/work/boss" });
  const alpha = await e.adapter("omp", "viz-alpha", "wrk-alpha", { cwd: "/work/alpha-project" });
  const beta = await e.adapter("omp", "viz-beta", "wrk-beta", { cwd: "/work/beta-project" });
  await human.request("set_role", { name: "boss-queen", role: "orchestrator" });
  await human.request("set_role", { name: "wrk-alpha", role: "worker" });
  await human.request("set_role", { name: "wrk-beta", role: "worker" });
  await human.request("channel_create", { channel: "ops" });
  for (const name of ["boss-queen", "wrk-alpha", "wrk-beta"]) await human.request("channel_add", { channel: "ops", name });
  return { boss, alpha, beta };
}

/** Hit rectangle centre for a bug, computed with the same pure scene the app draws. */
async function centreOf(e: TestEnv, viz: Viz, id: string): Promise<{ column: number; row: number }> {
  const sessions = (await e.human().request("list")).sessions as ListedSession[];
  const now = e.clock.now();
  const world = buildWorld({ sessions, procs: [], feed: [], connection: "connected", now });
  const hits: Hit[] = renderScene(world, [], { selectedId: null, filter: null, focus: false, feral: true }, 0, viz.size, now).hits;
  const hit = hits.find((h) => h.id === id);
  assert.ok(hit, `no hit rectangle for ${id}`);
  return { column: hit.column + Math.floor(hit.width / 2), row: hit.row + Math.floor(hit.height / 2) };
}

test("shows registered sessions by name and reports the connection", async () => {
  env = await startEnv();
  await fleet(env);
  const viz = startViz();
  await viz.until(() => has(viz, "boss-queen") && has(viz, "wrk-alpha") && has(viz, "wrk-beta"), "all sessions drawn");
  assert.ok(has(viz, "netrunner"));
  assert.ok(!has(viz, "SIGNAL LOST"));
});

test("a session registering after start appears without a manual refresh", async () => {
  env = await startEnv();
  await fleet(env);
  const viz = startViz();
  await viz.until(() => has(viz, "wrk-beta"), "initial world");
  await env.adapter("opencode", "viz-late", "latecomer");
  await viz.until(() => has(viz, "latecomer"), "late session event");
});

test("a message between orchestrator and worker produces a feed row", async () => {
  env = await startEnv();
  const { boss, alpha } = await fleet(env);
  const viz = startViz();
  await viz.until(() => has(viz, "wrk-alpha"), "initial world");
  await boss.client.request("send", { to: "wrk-alpha", text: "ship ledger", kind: "task" });
  await alpha.nextDelivery();
  await viz.until(() => has(viz, "ship ledger"), "feed row");
  // later status events for the same message do not duplicate the row
  await viz.step(100);
  assert.equal(count(viz, "ship ledger"), 1);
});

test("a channel post shows in the feed without needing a link", async () => {
  env = await startEnv();
  const { boss } = await fleet(env);
  const viz = startViz();
  await viz.until(() => has(viz, "wrk-beta"), "initial world");
  await boss.client.request("channel_send", { channel: "ops", text: "standup in five" });
  await viz.until(() => has(viz, "standup in five"), "channel post in feed");
});

test("q resolves run with 0 and releases the terminal once", async () => {
  env = await startEnv();
  await fleet(env);
  const viz = startViz();
  await viz.until(() => has(viz, "boss-queen"), "initial world");
  await viz.press("q");
  assert.equal(await viz.done, 0);
  assert.equal(viz.cleanups(), 1);
  viz.interrupt();
  assert.equal(viz.cleanups(), 1, "interrupt after quit is a no-op");
});

test("Escape and the interrupt callback also quit", async () => {
  env = await startEnv();
  const escape = startViz();
  await escape.press("ESCAPE");
  assert.equal(await escape.done, 0);
  const interrupted = startViz();
  interrupted.interrupt();
  assert.equal(await interrupted.done, 0);
});

test("f cycles the harness filter and hides sessions of other harnesses", async () => {
  env = await startEnv();
  await fleet(env);
  const viz = startViz();
  await viz.until(() => has(viz, "wrk-alpha"), "initial world");
  await viz.press("f"); // claude: only the claude orchestrator (and the netrunner) remain
  assert.ok(has(viz, "boss-queen"));
  assert.ok(!has(viz, "wrk-alpha") && !has(viz, "wrk-beta"), viz.rows().join("\n"));
  await viz.press("f"); // omp: workers plus the orchestrator that leads them
  assert.ok(has(viz, "wrk-alpha") && has(viz, "wrk-beta") && has(viz, "boss-queen"));
  await viz.press("f"); // opencode: nothing registered
  assert.ok(!has(viz, "wrk-alpha") && !has(viz, "boss-queen"));
  await viz.press("f"); // codex
  await viz.press("f"); // back to everything
  assert.ok(has(viz, "wrk-alpha") && has(viz, "boss-queen"));
});

test("a mouse press on a bug selects it and the TARGET panel shows its name", async () => {
  env = await startEnv();
  await fleet(env);
  const viz = startViz();
  await viz.until(() => has(viz, "wrk-alpha") && has(viz, "wrk-beta"), "initial world");
  assert.ok(has(viz, "TARGET"));
  const before = count(viz, "wrk-alpha");
  const at = await centreOf(env, viz, await sessionId(env, "wrk-alpha"));
  await viz.click(at.column, at.row);
  assert.ok(count(viz, "wrk-alpha") > before, `selected name is repeated in the TARGET panel:\n${viz.rows().join("\n")}`);
  assert.equal(count(viz, "wrk-beta"), 1, "the other worker is not the target");
  const other = await centreOf(env, viz, await sessionId(env, "wrk-beta"));
  await viz.click(other.column, other.row);
  assert.ok(count(viz, "wrk-beta") > 1 && count(viz, "wrk-alpha") === before);
});

test("keyboard navigation selects bugs and Tab cycles through them", async () => {
  env = await startEnv();
  await fleet(env);
  const viz = startViz();
  await viz.until(() => has(viz, "wrk-alpha") && has(viz, "wrk-beta"), "initial world");
  const names = ["boss-queen", "wrk-alpha", "wrk-beta"];
  const selected = (): string[] => names.filter((n) => target(viz).includes(n));
  assert.deepEqual(selected(), [], "initial selection is none");
  await viz.press("TAB");
  assert.equal(selected().length, 1, "Tab selects one bug");
  const seen = new Set(selected());
  for (let i = 0; i < 6; i++) {
    await viz.press("TAB");
    for (const n of selected()) seen.add(n);
  }
  assert.equal(seen.size, names.length, "Tab reaches every bug");
  await viz.press("SHIFT_TAB");
  await viz.press("j");
  await viz.press("RIGHT");
  await viz.press("ENTER"); // focus on
  await viz.press("ENTER"); // focus off
  assert.ok(has(viz, "boss-queen"), "navigation and focus never crash the scene");
});

test("a detected codex process draws as codex-<pid> and u toggles feral bugs", async () => {
  env = await startEnv();
  const codex: ProcInfo = { pid: 4242, harness: "codex", command: "codex --model x", elapsedSec: 7, cpu: 12 };
  const viz = startViz({ scan: async () => [codex] });
  await viz.until(() => has(viz, "codex-4242"), "feral codex bug");
  await viz.press("u");
  assert.ok(!has(viz, "codex-4242"));
  await viz.press("u");
  assert.ok(has(viz, "codex-4242"));
});

test("r rescans processes immediately and the 5s poll picks up new ones", async () => {
  env = await startEnv();
  let procs: ProcInfo[] = [];
  let scans = 0;
  const viz = startViz({ scan: async () => (scans++, procs) });
  await viz.until(() => scans === 1, "initial scan");
  procs = [{ pid: 77, harness: "codex", command: "codex", elapsedSec: 1, cpu: 0 }];
  await viz.step(4900);
  assert.equal(scans, 1, "no rescan before 5s");
  assert.ok(!has(viz, "codex-77"));
  await viz.step(100);
  await viz.until(() => has(viz, "codex-77"), "scan after 5s");
  procs = [];
  await viz.press("r");
  await viz.until(() => !has(viz, "codex-77"), "manual rescan");
});

test("the 2s poll relists sessions without any event", async () => {
  env = await startEnv();
  await fleet(env);
  const viz = startViz();
  await viz.until(() => has(viz, "wrk-alpha"), "initial world");
  const initial = viz.lists();
  await viz.step(1900);
  assert.equal(viz.lists(), initial, "no relist before 2s");
  await viz.step(100);
  await viz.until(() => viz.lists() === initial + 1, "relist at 2s");
  await viz.step(2000);
  await viz.until(() => viz.lists() === initial + 2, "relist at 4s");
});

test("a renamed session is drawn under its new name", async () => {
  env = await startEnv();
  await fleet(env);
  const viz = startViz();
  await viz.until(() => has(viz, "wrk-alpha"), "initial world");
  await env.human().request("rename", { from: "wrk-alpha", name: "wrk-renamed" });
  await viz.until(() => has(viz, "wrk-renamed"), "rename event refresh");
  assert.ok(!has(viz, "wrk-alpha"), "former name is gone from the map");
});

test("feed rows name the resolved endpoints, including after a rename", async () => {
  env = await startEnv();
  const { boss } = await fleet(env);
  const viz = startViz();
  await viz.until(() => has(viz, "wrk-beta"), "initial world");
  await env.human().request("rename", { from: "wrk-beta", name: "wrk-gamma" });
  await viz.until(() => has(viz, "wrk-gamma"), "renamed session");
  await boss.client.request("send", { to: "wrk-gamma", text: "after rename", kind: "status" });
  await viz.until(() => has(viz, "after rename"), "feed row");
  const row = viz.rows().find((r) => r.includes("after rename"));
  assert.ok(row?.includes("wrk-gamma") && row.includes("boss-queen"), `feed row names both ends: ${row}`);
});

test("a gone session lingers flatlined, then vanishes after 30 minutes and clears its selection", async () => {
  env = await startEnv();
  const { beta } = await fleet(env);
  const viz = startViz();
  await viz.until(() => has(viz, "wrk-beta"), "initial world");
  const at = await centreOf(env, viz, await sessionId(env, "wrk-beta"));
  await viz.click(at.column, at.row);
  assert.ok(count(viz, "wrk-beta") > 1, "selected");
  const gone = await env.watch(isSession("gone", "wrk-beta"));
  beta.client.close();
  await gone.event;
  env.clock.advance(31 * 60_000);
  await viz.step(2000);
  await viz.until(() => !has(viz, "wrk-beta"), "aged-out bug removed (selection cleared with it)");
  assert.ok(has(viz, "wrk-alpha"));
});

test("resize redraws at the new size", async () => {
  env = await startEnv();
  await fleet(env);
  const viz = startViz({ columns: 160, rows: 48 });
  await viz.until(() => has(viz, "wrk-alpha"), "initial world");
  await viz.resize(100, 30);
  assert.ok(viz.rows().length <= 30, `${viz.rows().length} rows exceed 30`);
  assert.ok(has(viz, "boss-queen"));
});

test("with no daemon it renders SIGNAL LOST without throwing, then recovers when the daemon appears", async () => {
  const empty = mkdtempSync(join(tmpdir(), "asenq-viz-"));
  scratch.push(empty);
  process.env.ASENQ_HOME = empty;
  const viz = startViz();
  await viz.until(() => has(viz, "SIGNAL LOST"), "SIGNAL LOST");
  assert.ok(has(viz, "netrunner"), "the netrunner node survives a lost signal");
  await viz.step(2000); // still down: another failed poll must not throw
  assert.ok(has(viz, "SIGNAL LOST"));
  env = await startEnv();
  await env.adapter("omp", "viz-recover", "wrk-recovered");
  await viz.step(2000);
  await viz.until(() => has(viz, "wrk-recovered"), "recovery on the next poll");
  assert.ok(!has(viz, "SIGNAL LOST"));
});

async function sessionId(e: TestEnv, name: string): Promise<string> {
  const sessions = (await e.human().request("list")).sessions as { id: string; name: string }[];
  const found = sessions.find((s) => s.name === name);
  assert.ok(found, `no session ${name}`);
  return found.id;
}
