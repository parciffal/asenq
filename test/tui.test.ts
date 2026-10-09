import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { AsenqClient } from "../src/shared/client.js";
import type { ClientOpts } from "../src/shared/client.js";
import { GRACE_MS, type PositionedEvent, type SendResult, type SessionIdentity, type StoredMessage } from "../src/shared/protocol.js";
import type { ProcInfo } from "../src/viz/scan.js";
import { ConsoleApp, type ConsoleDeps } from "../src/tui/app.js";
import { paneWidths } from "../src/tui/layout.js";
import {
  changedTerminalRows, normalizeTerminalLine, terminalTextWidth, translateKeyboardInput, truncateTerminalText, wrapTerminalText,
  type TerminalAdapterOptions, type TerminalFrame, type TerminalLine, type TerminalSize,
} from "../src/tui/terminal.js";
import { logOf, startEnv, type Adapter, type TestEnv } from "./helpers.js";

let env: TestEnv | undefined;
let open: Console | undefined;
afterEach(async () => {
  open?.close();
  open = undefined;
  await env?.close();
  env = undefined;
});

type Console = {
  app: ConsoleApp;
  size: TerminalSize;
  rows(): string[];
  frame(): TerminalFrame;
  press(name: string): Promise<void>;
  burst(keys: string[]): Promise<void>;
  click(column: number, row?: number): Promise<void>;
  paste(text: string): Promise<void>;
  resize(columns: number, rows: number): Promise<void>;
  close(): void;
  type(text: string): Promise<void>;
  paste(text: string): Promise<void>;
  until(predicate: () => boolean | Promise<boolean>, what: string): Promise<void>;
};

const lineText = (line: TerminalLine | undefined): string =>
  line === undefined ? "" : typeof line === "string" ? line : line.map((span) => span.text).join("");

/** Runs the real ui against the test daemon with a recording screen instead of a TTY. */
async function startConsole(columns: number, rows: number, client?: ConsoleDeps["client"], deps: Pick<ConsoleDeps, "scan" | "now" | "schedule"> = {}): Promise<Console> {
  let handlers: TerminalAdapterOptions = {};
  let frame: TerminalFrame = { lines: [] };
  const size = { columns, rows };
  const app = new ConsoleApp({
    ...(client ? { client } : {}),
    ...deps,
    screen: (options) => {
      handlers = options;
      return { size, start() {}, render(next) { frame = next; }, cleanup() {} };
    },
  });
  void app.run();
  const ui: Console = {
    app,
    size,
    rows: () => frame.lines.map(lineText),
    frame: () => frame,
    async press(name) {
      const text = [...name].length === 1 ? name : undefined;
      handlers.onKey?.({ name, matches: [name], ...(text ? { text } : {}), ctrl: name.startsWith("CTRL_"), alt: false, shift: name.startsWith("SHIFT_") });
      await app.idle();
    },
    async burst(keys) {
      for (const name of keys) {
        const text = [...name].length === 1 ? name : undefined;
        handlers.onKey?.({ name, matches: [name], ...(text ? { text } : {}), ctrl: name.startsWith("CTRL_"), alt: false, shift: name.startsWith("SHIFT_") });
      }
      await app.idle();
    },
    async click(column, row = 0) {
      handlers.onMouse?.({ name: "MOUSE_LEFT_BUTTON_PRESSED", column, row, action: "press", button: "left", ctrl: false, alt: false, shift: false });
      await app.idle();
    },
    async paste(text) {
      handlers.onPaste?.(text);
      await app.idle();
    },
    async resize(columns, rows) {
      Object.assign(size, { columns, rows });
      handlers.onResize?.(size);
      await app.idle();
    },
    close: () => handlers.onInterrupt?.(),
    async type(text) {
      for (const character of text) await ui.press(character);
    },
    async until(predicate, what) {
      const deadline = Date.now() + 3000;
      for (;;) {
        await app.idle();
        if (await predicate()) return;
        if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}:\n${ui.rows().join("\n")}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
  };
  open = ui;
  await ui.until(() => ui.rows()[0]?.includes("●") ?? false, "connection");
  return ui;
}

async function unread(human: AsenqClient, sessionId: string): Promise<number> {
  return (await human.readState({ scope: "session", sessionId })).unread;
}

function assertWithin(ui: Console): void {
  const rows = ui.rows();
  assert.ok(rows.length <= ui.size.rows, `${rows.length} rows exceed ${ui.size.rows}`);
  for (const row of rows) assert.ok(terminalTextWidth(row) <= ui.size.columns, `row wider than ${ui.size.columns}: ${row}`);
}

const size = { columns: 10, rows: 4 };

test("file-only direct messages show the summary and path in transcript rows", async () => {
  env = await startEnv();
  const sender = await env.adapter("omp", "file-row-sender", "sender");
  const path = join(env.home, "report.txt");
  writeFileSync(path, "private report contents");
  await sender.client.request("send", {
    to: "human", file: { path, summary: "File report ready" },
  });
  const ui = await startConsole(120, 28);
  await ui.until(() => ui.rows().some((row) => row.includes("sender")), "sender selection");
  const rows = ui.rows().join("\n");
  assert.ok(rows.includes("File report ready"), rows);
  assert.ok(rows.includes(path), rows);
  assert.ok(!rows.includes("private report contents"));
  assertWithin(ui);
});

test("held shortcuts retain search, palette and form typing and cannot act from hidden surfaces", async () => {
  env = await startEnv();
  const human = env.human();
  const sender = await env.adapter("omp", "held-typing-sender", "alpha");
  const target = await env.adapter("omp", "held-typing-target", "rx-target");
  await human.request("set_inbound", { name: "rx-target", mode: "hold" });
  const reply = await sender.client.request("send", { to: "rx-target", text: "await human decision" });
  const msgId = (reply.results as { msgId: string }[])[0].msgId;
  const ui = await startConsole(120, 32);
  await ui.press("/");
  await ui.type("rx");
  assert.ok(ui.rows().some((row) => row.includes("/ rx")), "r and x enter the session filter");
  await ui.press("ENTER");
  await ui.press("ENTER");
  assert.ok(ui.rows().some((row) => row.includes("⏸") && row.includes("held")), "target bar is visible before opening overlays");

  await ui.press("?");
  await ui.type("rx");
  assert.ok(ui.rows().some((row) => row.startsWith("? rx")), "r and x enter the palette filter");
  await ui.press("ESCAPE");
  await ui.press("CTRL_E");
  await ui.type("rx");
  await ui.press("CTRL_D");
  await ui.until(() => target.deliveries.length > 0, "expected form message delivery");
  assert.equal((await target.nextDelivery()).msg.text, "rx", "form typing reaches the target as a human message");
  assert.equal((await logOf(human, msgId)).status, "held");

  await ui.press("a");
  await ui.type("rx");
  assert.equal((await logOf(human, msgId)).status, "held", "activity cannot act on the previous bar");
  ui.size.columns = 60;
  await ui.press("s");
  await ui.type("rx");
  assert.equal((await logOf(human, msgId)).status, "held", "narrow picker cannot act on a hidden bar");
  assert.ok(!ui.rows().some((row) => row.includes("⏸") && row.includes("held")), "picker has no actionable bar");
  assertWithin(ui);
});

test("held actions stay bound to the target identity across rename and name reuse", async () => {
  env = await startEnv();
  const human = env.human();
  const sender = await env.adapter("omp", "held-rename-sender", "alpha");
  const target = await env.adapter("omp", "held-rename-target", "beta");
  await human.request("set_inbound", { name: "beta", mode: "hold" });
  const first = await sender.client.request("send", { to: "beta", text: "first identity-held message" });
  const second = await sender.client.request("send", { to: "beta", text: "second identity-held message" });
  const firstId = (first.results as { msgId: string }[])[0].msgId;
  const secondId = (second.results as { msgId: string }[])[0].msgId;
  const ui = await startConsole(120, 32);
  await ui.press("/");
  await ui.type("beta");
  await ui.press("ENTER");
  await ui.press("ENTER");
  await human.request("rename", { from: "beta", name: "renamed" });
  await ui.until(() => ui.rows().some((row) => row.includes("to renamed")), "bound target rename");
  await ui.press("r");
  await ui.until(() => target.deliveries.length > 0, "expected oldest held message delivery after rename");
  assert.equal((await target.nextDelivery()).msg.id, firstId);
  assert.equal((await logOf(human, secondId)).status, "held");
  await assert.rejects(env.adapter("omp", "held-rename-blocked", "beta"), { code: "name_taken" });
  await target.client.request("unregister");
  const replacement = await env.adapter("omp", "held-rename-replacement", "beta");
  assert.notEqual(replacement.session.id, target.session.id);
  await ui.until(() => ui.rows()[0].includes("2 live"), "removed identity's name reused");
  await ui.press("ESCAPE");
  const listWidth = paneWidths(120)!.list;
  const replacementRow = ui.rows().findIndex((row) => truncateTerminalText(row, listWidth).includes("beta") && !row.includes("renamed"));
  assert.ok(replacementRow >= 0);
  await ui.click(3, replacementRow);
  assert.ok(!ui.rows().some((row) => row.includes("⏸") && row.includes("held")), "new beta does not inherit renamed target's held messages");
  await ui.type("rx");
  assert.equal((await logOf(human, secondId)).status, "held");
  await ui.press("CTRL_K");
  await ui.type("renamed");
  await ui.press("ENTER");
  await ui.until(() => ui.rows().some((row) => row.includes("archived · read only")), "original held conversation opened");
  await ui.press("x");
  assert.equal((await logOf(human, secondId)).status, "dropped");
  assert.equal(replacement.deliveries.length, 0);
  assertWithin(ui);
});

test("stale held actions refresh without consuming the next message or a newly opened target", async () => {
  env = await startEnv();
  const human = env.human();
  const sender = await env.adapter("omp", "held-stale-sender", "alpha");
  const beta = await env.adapter("omp", "held-stale-beta", "beta");
  await env.adapter("omp", "held-stale-gamma", "gamma");
  for (const name of ["beta", "gamma"]) await human.request("set_inbound", { name, mode: "hold" });
  const gamma = await sender.client.request("send", { to: "gamma", text: "gamma must remain held" });
  const first = await sender.client.request("send", { to: "beta", text: "externally released oldest" });
  const second = await sender.client.request("send", { to: "beta", text: "next beta must remain held" });
  const gammaId = (gamma.results as { msgId: string }[])[0].msgId;
  const firstId = (first.results as { msgId: string }[])[0].msgId;
  const secondId = (second.results as { msgId: string }[])[0].msgId;
  let interleave: (() => void) | undefined;
  const overlapping: Promise<void>[] = [];
  let delayRelease = true;
  const ui = await startConsole(120, 32, (options) => new class extends AsenqClient {
    override async request(op: string, params: Record<string, unknown> = {}) {
      if (op === "release" && delayRelease) {
        delayRelease = false;
        await human.request("release", { msgId: firstId });
        interleave?.();
      }
      return super.request(op, params);
    }
  }(options));
  await ui.press("/");
  await ui.type("beta");
  await ui.press("ENTER");
  await ui.press("ESCAPE");
  const listWidth = paneWidths(120)!.list;
  const gammaRow = ui.rows().findIndex((row) => truncateTerminalText(row, listWidth).includes("gamma"));
  assert.ok(gammaRow >= 0);
  interleave = () => {
    overlapping.push(ui.click(3, gammaRow));
    assert.ok(ui.rows().some((row) => row.includes("⏸") && row.includes("held") && row.includes("gamma")), "the overlapping shortcuts see gamma's actionable bar");
    overlapping.push(ui.press("r"), ui.press("x"), ui.press("c"), ui.press("r"), ui.press("x"));
  };
  await ui.press("r");
  await Promise.all(overlapping);
  await ui.until(() => beta.deliveries.length > 0, "expected competing release delivery");
  assert.equal((await beta.nextDelivery()).msg.id, firstId);
  assert.equal((await logOf(human, secondId)).status, "held", "a stale captured ID never falls through to the next beta message");
  assert.equal((await logOf(human, gammaId)).status, "held", "overlapping keys do not act on the newly opened target");
  assert.ok(ui.rows().some((row) => row.includes("not held")), "stale release retains the existing error notice");
  assert.ok(ui.rows().some((row) => row.includes("to gamma")), "action completion keeps the new target");
  assert.ok(ui.rows().some((row) => row.includes("› rx")), "action completion keeps the new target's draft");
  assert.match(ui.rows()[0], /2 held/);
  assertWithin(ui);
});

test("archived conversation keeps held controls while release queues until the same identity revives", async () => {
  env = await startEnv();
  const human = env.human();
  const sender = await env.adapter("omp", "archived-held-sender", "orch");
  const target = await env.adapter("omp", "archived-held-target", "worker");
  await human.request("set_inbound", { name: "worker", mode: "hold" });
  const [drop] = (await sender.client.request("send", { to: "worker", text: "archived-drop-preview" })).results as SendResult[];
  const [release] = (await sender.client.request("send", { to: "worker", text: "archived-release-preview" })).results as SendResult[];
  await target.client.request("unregister");
  const ui = await startConsole(120, 32);
  await ui.press("CTRL_K");
  await ui.type("worker");
  await ui.press("ENTER");
  await ui.until(() => ui.rows().some((row) => row.includes("archived · read only")), "archived conversation opened");
  assert.ok(ui.rows().some((row) => row.includes("⏸ held 2") && row.includes("archived-drop-preview")));
  assert.equal(ui.frame().cursor, undefined, "archived conversation has no editable composer");
  assert.ok(!ui.rows().some((row) => row.includes("Write to worker")));
  await ui.press("x");
  assert.equal((await logOf(human, drop.msgId!)).status, "dropped");
  await ui.until(() => ui.rows().some((row) => row.includes("⏸ held") && row.includes("archived-release-preview")), "next archived held preview");
  await ui.press("r");
  assert.equal((await logOf(human, release.msgId!)).status, "queued");
  assert.equal(target.deliveries.length, 0, "release cannot deliver to the removed transport");
  assert.ok(!ui.rows().some((row) => row.includes("⏸ held")));
  assert.match(ui.rows()[0], /0 held/);
  const revived = await env.adapter("omp", "archived-held-target", "ignored-name");
  assert.equal(revived.session.id, target.session.id);
  await ui.until(() => revived.deliveries.length === 1, "queued release delivered on revival");
  assert.equal((await revived.nextDelivery()).msg.id, release.msgId);
  assert.equal((await logOf(human, release.msgId!)).status, "delivered");
  assertWithin(ui);
});

test("header hydrates held messages and follows hold, release, drop, removal and revival", async () => {
  env = await startEnv();
  const human = env.human();
  const alpha = await env.adapter("omp", "held-alpha", "alpha");
  const beta = await env.adapter("omp", "held-beta", "beta");
  await human.request("set_inbound", { name: "beta", mode: "hold" });
  const hold = async (text: string): Promise<string> => {
    const reply = await alpha.client.request("send", { to: "beta", text });
    return (reply.results as { msgId: string }[])[0].msgId;
  };
  const release = await hold("release this");
  const drop = await hold("drop this");
  const ui = await startConsole(120, 32);
  assert.match(ui.rows()[0], /2 live · 0 reconnecting · 2 held · 0 unread/);

  const pending = await hold("keep until removal");
  await ui.until(() => ui.rows()[0].includes("3 held"), "new held message");
  await human.request("release", { msgId: release });
  await ui.until(() => ui.rows()[0].includes("2 held"), "released message leaves held count");
  await human.request("drop", { msgId: drop });
  await ui.until(() => ui.rows()[0].includes("1 held"), "dropped message leaves held count");
  await beta.client.request("unregister");
  await ui.until(() => /1 live · 0 reconnecting · 1 held/.test(ui.rows()[0]), "removed target keeps held messages");
  const revived = await env.adapter("omp", "held-beta", "ignored");
  assert.deepEqual(revived.session, beta.session);
  await ui.until(() => /2 live · 0 reconnecting · 1 held/.test(ui.rows()[0]), "revived target keeps held messages");
  await human.request("release", { msgId: pending });
  assert.equal((await revived.nextDelivery()).msg.id, pending);
  await ui.until(() => /2 live · 0 reconnecting · 0 held/.test(ui.rows()[0]), "release after revival clears held count");
  assertWithin(ui);
});

test("header counts human session and channel unread markers and gone sessions separately", async () => {
  env = await startEnv();
  const human = env.human();
  const alpha = await env.adapter("omp", "counter-alpha", "alpha");
  const beta = await env.adapter("omp", "counter-beta", "beta");
  await alpha.client.request("send", { to: "human", text: "private unread" });
  await beta.client.request("channel_send", { channel: "updates", text: "channel unread" });
  const ui = await startConsole(120, 32);
  assert.match(ui.rows()[0], /2 live · 0 reconnecting · 0 held · 2 unread/);
  const state = await human.readState({ scope: "session", sessionId: alpha.session.id });
  const page = await human.historyPage({ scope: "session", sessionId: alpha.session.id });
  await human.markRead(state.scope, page.messages.at(-1)!.order, state.version);
  await ui.until(() => ui.rows()[0].includes("1 unread"), "shared read marker updates total");
  const gone = await env.watch((e) => e.type === "session" && e.action === "gone" && e.name === "beta");
  beta.client.close();
  await gone.event;
  await ui.until(() => ui.rows()[0].includes("1 live · 1 reconnecting"), "gone session counter");
  const returned = await env.adapter("omp", "counter-beta", "beta");
  assert.equal(returned.session.id, beta.session.id);
  await ui.until(() => ui.rows()[0].includes("2 live · 0 reconnecting"), "reconnected identity counter");
});

test("header hydrates retained expired messages, follows live expiry and decreases after pruning", async () => {
  env = await startEnv({ queueTtlMs: 1000, historyDays: 1 });
  const human = env.human();
  const alpha = await env.adapter("omp", "failed-alpha", "alpha");
  const beta = await env.adapter("omp", "failed-beta", "beta");
  const gone = await env.watch((e) => e.type === "session" && e.action === "gone" && e.name === "beta");
  beta.client.close();
  await gone.event;
  await human.request("send", { to: "beta", text: "expired before opening the console" });
  env.clock.advance(1000);
  env.daemon.sweep();

  const ui = await startConsole(120, 32);
  assert.match(ui.rows()[0], /1 live · 1 reconnecting · 0 held · 0 unread · 1 failed/);
  const assertFailedStyle = (text: string): void => {
    const header = ui.frame().lines[0];
    assert.ok(typeof header !== "string" && header?.some((span) =>
      span.text === text && span.style?.foreground === "red" && span.style.bold), "failed count is visibly an error");
  };
  assertFailedStyle("1 failed");
  await human.request("send", { to: "beta", text: "expires while the console is open" });
  env.clock.advance(1000);
  env.daemon.sweep();
  await ui.until(() => ui.rows()[0].includes("2 failed"), "live expiry updates the authoritative count");
  await alpha.client.request("send", { to: "human", text: "an unrelated successful message" });
  await ui.until(() => ui.rows()[0].includes("1 unread"), "successful message arrives");
  assert.ok(ui.rows()[0].includes("2 failed"), "success does not clear retained failures outside the selected history");

  ui.size.columns = 80;
  await ui.press("s");
  assert.match(ui.rows()[0], /1 L · 1 R · 0 H · 1 U · 2 F/);
  assertFailedStyle("2 F");
  assertWithin(ui);
  for (const columns of [40, 20, 5, 2, 1]) {
    ui.size.columns = columns;
    await ui.press("s");
    assert.ok(ui.rows()[0].includes("●"), "connection remains visible when counters cannot fit");
    assertWithin(ui);
  }
  ui.size.columns = 120;
  await ui.press("s");
  env.clock.advance(86_400_000 - 2000 + 1);
  env.daemon.prune();
  await ui.until(() => ui.rows()[0].includes("1 failed"), "pruning only the older expiry decreases the count");
  env.clock.advance(1000);
  env.daemon.prune();
  await ui.until(() => ui.rows()[0].includes("0 failed"), "pruning the remaining expiry clears the count");
  assertWithin(ui);
});

test("a delivered direct reply renders the original as successful rather than failed", async () => {
  env = await startEnv();
  const alpha = await env.adapter("omp", "replied-alpha", "alpha");
  const beta = await env.adapter("omp", "replied-beta", "beta");
  const original = await alpha.client.request("send", { to: "beta", text: "original question" });
  const msgId = (original.results as { msgId: string }[])[0].msgId;
  await beta.nextDelivery();
  const ui = await startConsole(120, 32);
  await ui.until(() => ui.rows().some((row) => row.includes("original question")), "original conversation");
  await beta.client.request("send", { to: "alpha", text: "direct answer", replyTo: msgId });
  await alpha.nextDelivery();
  await ui.until(() => ui.rows().some((row) => row.includes("replied")), "original changes to replied");
  const statusRows = ui.frame().lines.filter((row) => lineText(row).includes("replied"));
  assert.ok(statusRows.some((row) => typeof row !== "string" && row.some((span) =>
    span.text === "replied" && span.style?.foreground === "green")), "replied is a successful transcript status");
  assert.ok(ui.rows()[0].includes("0 failed"), "a replied message is not a failure");
  assertWithin(ui);
});

test("compact tabs remain mouse reachable without stealing the connection hit area", async () => {
  env = await startEnv();
  const ui = await startConsole(20, 12);
  for (const [key, initial, expected] of [
    ["i", "I", "Senders"], ["#", "C", "No channels yet"], ["s", "S", "No sessions yet"],
  ]) {
    await ui.press(key);
    await ui.press("s");
    const header = ui.rows()[0];
    const column = header.indexOf(initial);
    assert.ok(column >= 0 && column < header.indexOf("●"), `${initial} precedes connection`);
    await ui.click(column);
    assert.ok(ui.rows()[1].includes(expected), `${initial} opens its tab`);
    const before = ui.rows().slice(1);
    await ui.click(ui.rows()[0].indexOf("●"));
    assert.deepEqual(ui.rows().slice(1), before, "connection is not a clipped tab target");
    assertWithin(ui);
  }
  await ui.press("a");
  const before = ui.rows().slice(1);
  await ui.press("s");
  await ui.click(ui.rows()[0].indexOf("A"));
  assert.deepEqual(ui.rows().slice(1), before, "Activity mouse target selects the same view as its key");
});

test("the Map tab stays mouse reachable at compact widths and shows a too-small notice below the scene minimum", async () => {
  env = await startEnv();
  const ui = await startConsole(100, 24, undefined, { scan: async () => [] });
  for (const columns of [100, 60, 40, 30, 24, 20]) {
    await ui.resize(columns, 24);
    await ui.press("s");
    const header = ui.rows()[0];
    const column = header.includes("Map") ? header.indexOf("Map") : header.indexOf("M");
    assert.ok(column >= 0 && column < header.indexOf("●"), `Map precedes the connection symbol at ${columns}: ${header}`);
    await ui.click(column);
    assert.ok(ui.rows().some((row) => /NETWATCH|TOO SMALL/.test(row)), `Map opened at ${columns}:\n${ui.rows().join("\n")}`);
    assertWithin(ui);
  }
});

test("wrapping keeps every visible character within the cell width", () => {
  const cases: [string, number][] = [
    ["the quick brown fox jumps over the lazy dog", 10],
    ["https://example.com/a/very/long/unbroken/path?with=query", 12],
    ["漢字かな交じり文を折り返す", 7],
    ["emoji 👍🏽👩‍💻 flags 🇯🇵 e\u0301\u0301 done", 5],
  ];
  for (const [text, width] of cases) {
    const rows = wrapTerminalText(text, width);
    for (const row of rows) assert.ok(terminalTextWidth(row) <= width, `${JSON.stringify(row)} exceeds ${width}`);
    assert.equal(rows.join("").replaceAll(" ", ""), text.replaceAll(" ", ""), "no content lost");
  }
});

test("wrapping preserves explicit and blank lines and removes terminal controls", () => {
  assert.deepEqual(wrapTerminalText("one\n\n  indented\r\nlast", 20), ["one", "", "  indented", "last"]);
  assert.deepEqual(wrapTerminalText("\u001b[2Jred\u001b[31m text\u0007", 20), ["red text"]);
  assert.deepEqual(wrapTerminalText("", 5), [""]);
  assert.deepEqual(wrapTerminalText("abc", 0), []);
});

test("wrapping breaks between words and splits only oversized words", () => {
  assert.deepEqual(wrapTerminalText("alpha beta gamma", 11), ["alpha beta", "gamma"]);
  assert.deepEqual(wrapTerminalText("ab abcdefghij", 5), ["ab ab", "cdefg", "hij"]);
  assert.deepEqual(wrapTerminalText("日本語です", 3), ["日", "本", "語", "で", "す"]);
});

test("normalized rows clip at a grapheme boundary and merge equal styles", () => {
  const spans = normalizeTerminalLine([
    { text: "ab", style: { bold: true } },
    { text: "cd", style: { bold: true } },
    { text: "日本語", style: { foreground: "cyan" } },
  ], 7);
  assert.deepEqual(spans, [
    { text: "abcd", style: { bold: true } },
    { text: "日", style: { foreground: "cyan" } },
  ]);
  assert.deepEqual(normalizeTerminalLine([{ text: "x", style: { foreground: "red", inverse: true } }], 5, false), [
    { text: "x", style: { inverse: true } },
  ]);
});

test("keyboard protocol reports become legacy keys, and Shift+Enter its own key", () => {
  assert.deepEqual(translateKeyboardInput("a\u001b[13;2ub"), [{ text: "a" }, { key: "SHIFT_ENTER" }, { text: "b" }]);
  assert.deepEqual(translateKeyboardInput("\u001b[27;2;13~"), [{ key: "SHIFT_ENTER" }]);
  assert.deepEqual(translateKeyboardInput("\u001b[99;5u\u001b[27u\u001b[9;2u\u001b[97;3u\u001b[13u"), [{ text: "\u0003\u001b\u001b[Z\u001ba\r" }]);
  assert.deepEqual(translateKeyboardInput("\u001b[57399u\u001b[200~x\u001b[1;2A"), [{ text: "\u001b[200~x\u001b[1;2A" }]);
  assert.deepEqual(translateKeyboardInput("\u001b[107;5u\u001b[27;5;107~\u000b"), [{ text: "\u000b\u000b\u000b" }]);
});

test("frame diff reports only rows whose visible text or style changed", () => {
  const first: TerminalFrame = { lines: ["header", [{ text: "status", style: { foreground: "green" } }], "body"] };
  assert.deepEqual(changedTerminalRows(undefined, first, size), [0, 1, 2, 3]);
  assert.deepEqual(changedTerminalRows(first, { lines: [...first.lines] }, size), []);
  assert.deepEqual(
    changedTerminalRows(first, { lines: ["header", [{ text: "status", style: { foreground: "red" } }], "body"] }, size),
    [1],
  );
  assert.deepEqual(changedTerminalRows(first, { lines: ["header", "status", "bo"] }, size), [1, 2]);
  assert.deepEqual(changedTerminalRows(first, { lines: ["header"] }, size), [1, 2]);
  assert.deepEqual(changedTerminalRows(first, { lines: ["header", first.lines[1], "body", "this row is too long"] }, size), [3]);
  // Differences beyond the visible width are not repainted.
  assert.deepEqual(changedTerminalRows({ lines: ["0123456789-a"] }, { lines: ["0123456789-b"] }, size), []);
});

test("wide console lists live sessions by recent activity, collapses the archive and wraps without overlap", async () => {
  env = await startEnv();
  const human = env.human();
  const old = await env.adapter("omp", "old-key", "legacy-name");
  await human.request("rename", { from: "legacy-name", name: "retired" });
  await human.sendToSession(old.session.id, "archived conversation");
  await old.client.request("unregister");
  const alpha = await env.adapter("omp", "alpha-key", "alpha");
  const beta = await env.adapter("omp", "beta-key", "beta");
  const long = `${"wrapped words keep flowing across the pane ".repeat(8)}https://example.com/${"x".repeat(150)} 漢字かな交じり文 end-of-alpha`;
  await alpha.client.request("send", { to: "human", text: long });
  await beta.client.request("send", { to: "human", text: "beta is most recent" });

  const ui = await startConsole(100, 30);
  const listWidth = paneWidths(100)!.list;
  await ui.until(() => ui.rows().some((row) => row.includes("beta")), "session list");
  let rows = ui.rows();
  const index = (text: string): number => rows.findIndex((row) => truncateTerminalText(row, listWidth).includes(text));
  assert.ok(index("beta") < index("alpha"), "most recent activity first");
  assert.ok(index("alpha") < index("archive"), "live before archive");
  assert.equal(index("retired"), -1, "archive starts collapsed");

  await ui.press("DOWN");
  await ui.until(() => ui.rows().some((row) => row.includes("end-of-alpha")), "alpha conversation");
  assert.equal(await unread(human, alpha.session.id), 1, "moving through the list does not mark a conversation read");
  rows = ui.rows();
  assertWithin(ui);
  const top = rows[1];
  assert.ok(top.startsWith("╭─ Sessions "), "list title is inset into its rounded top border");
  assert.ok(top.slice(listWidth + 1).startsWith("╭─ "), "conversation has its own rounded top border");
  assert.ok(rows.at(-2)!.startsWith("╰"), "list panel has a rounded bottom border");
  assert.ok(rows.at(-2)!.slice(listWidth + 1).startsWith("╰"), "conversation panel has a rounded bottom border");
  for (const row of rows.slice(2, -2)) {
    const left = truncateTerminalText(row, listWidth);
    assert.equal(terminalTextWidth(left), listWidth, `list panel is padded: ${row}`);
    assert.equal(left[0], "│", `list left edge is intact: ${row}`);
    assert.equal(left.at(-1), "│", `list right edge is intact: ${row}`);
    assert.equal(row.slice(left.length, left.length + 2), " │", `panels remain separate: ${row}`);
    assert.equal(row.at(-1), "│", `conversation right edge is intact: ${row}`);
  }
  const conversation = rows.slice(2, -2).map((row) => row.slice(truncateTerminalText(row, listWidth).length + 2, -1)).join("");
  assert.ok(conversation.replace(/\s+/g, "").includes(long.replace(/\s+/g, "")), "the whole message body is visible");

  await ui.press("/");
  await ui.type("legacy");
  await ui.until(() => ui.rows().some((row) => truncateTerminalText(row, listWidth).includes("retired")), "former-name search finds the archived session");
  await ui.press("ESCAPE");
  assert.equal(ui.rows().findIndex((row) => row.includes("retired")), -1, "clearing search collapses the archive again");
});

test("narrow console reaches every wrapped row and marks an open conversation read only once its last incoming row is shown", async () => {
  env = await startEnv();
  const human = env.human();
  const alpha = await env.adapter("omp", "alpha-key", "alpha");
  const lines = (label: string) => Array.from({ length: 12 }, (_, index) => `${label} ${index + 1} carries enough words to wrap twice here`);
  await alpha.client.request("send", { to: "human", text: lines("intro").join("\n") });

  const ui = await startConsole(40, 12);
  await ui.until(() => ui.rows().some((row) => row.includes("alpha")), "picker");
  assert.ok(!ui.rows().some((row) => /[╭╮╰╯]/.test(row)), "narrow picker is not boxed");
  assert.equal(await unread(human, alpha.session.id), 1, "the picker alone does not mark anything read");
  await ui.press("ENTER");
  await ui.until(async () => await unread(human, alpha.session.id) === 0, "opening shows the newest row and reads it");

  await ui.press("HOME");
  const paragraphs = lines("paragraph");
  const text = [...paragraphs, "", "final-row-marker"].join("\n");
  await alpha.client.request("send", { to: "human", text });
  await ui.until(async () => await unread(human, alpha.session.id) === 1, "arrival while scrolled up stays unread");
  const seen = new Set<string>();
  for (let step = 0; step < 120; step++) {
    assertWithin(ui);
    for (const row of ui.rows()) seen.add(row.trim());
    const reached = ui.rows().some((row) => row.includes("final-row-marker"));
    const count = await unread(human, alpha.session.id);
    if (reached) {
      assert.equal(count, 0, "reaching the last incoming row marks it read");
      break;
    }
    assert.equal(count, 1, `still unread before the last row is shown (step ${step})`);
    await ui.press("DOWN");
  }
  assert.ok(ui.rows().some((row) => row.includes("final-row-marker")), "the last row became reachable");
  for (const row of wrapTerminalText(text, 38)) assert.ok(seen.has(row.trim()), `reached: ${row}`);

  await ui.press("u");
  await new Promise((resolve) => setTimeout(resolve, 50));
  await ui.app.idle();
  assert.equal(await unread(human, alpha.session.id), 1, "a u reminder survives while the conversation stays open");
  await ui.press("END");
  await ui.until(async () => await unread(human, alpha.session.id) === 0, "End reads the reminder");
});

test("new arrivals keep a scrolled reader in place, and the composer sends once by stable identity", async () => {
  env = await startEnv();
  const alpha = await env.adapter("omp", "alpha-key", "alpha");
  for (let index = 1; index <= 6; index++) {
    env.clock.advance(1000);
    await alpha.client.request("send", { to: "human", text: `message ${index}\nsecond line ${index}\nthird line ${index}` });
  }
  const ui = await startConsole(60, 16);
  await ui.press("ENTER");
  await ui.until(() => ui.rows().some((row) => row.includes("third line 6")), "latest message");
  await ui.press("PAGE_UP");
  const before = ui.rows().slice(2, 8);
  await alpha.client.request("send", { to: "human", text: "a later arrival" });
  await ui.until(() => ui.rows().at(-1)!.includes("New message from alpha"), "arrival notice");
  assert.deepEqual(ui.rows().slice(2, 8), before, "the viewport did not move");

  await ui.press("c");
  await ui.type("hello");
  await ui.press("SHIFT_ENTER");
  await ui.type("there");
  const pending = alpha.deliveries.length;
  await ui.press("ENTER");
  await ui.until(() => alpha.deliveries.length > pending, "delivery");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(alpha.deliveries.length, pending + 1, "sent exactly once");
  assert.equal(alpha.deliveries.at(-1)!.msg.text, "hello\nthere");
  assert.ok(!ui.rows().some((row) => row.includes("› hello") || row.includes("› there")), "draft cleared after send");
});

test("human role form updates the selected session through protocol events and can unset it", async () => {
  env = await startEnv();
  const human = env.human();
  await env.adapter("omp", "form-alpha", "alpha");
  await env.adapter("omp", "form-bravo", "bravo");
  const ui = await startConsole(120, 20);
  await ui.press("/");
  await ui.type("alpha");
  await ui.press("ENTER");
  const listWidth = paneWidths(120)!.list;
  const sessionRow = (): string => ui.rows().map((row) => truncateTerminalText(row, listWidth)).find((row) => row.includes("alpha") && row.includes("●")) ?? "";

  for (const [value, tag] of [["orchestrator", "orch"], ["worker", "wrk"], ["unset", ""]]) {
    await ui.press("?");
    await ui.type("Set role");
    await ui.press("ENTER");
    await ui.press("TAB");
    await ui.press("CTRL_U");
    await ui.type(value);
    await ui.press("CTRL_D");
    await ui.until(() => tag ? sessionRow().includes(tag) : !!sessionRow() && !/\b(?:orch|wrk)\b/.test(sessionRow()), `${value} role event renders`);
    const reply = await human.request("list");
    const sessions = reply.sessions as { name: string; role: string | null }[];
    assert.equal(sessions.find((session) => session.name === "alpha")!.role, value === "unset" ? null : value);
    assert.equal(sessions.find((session) => session.name === "bravo")!.role, null, "another session is unchanged");
    assertWithin(ui);
  }
});

test("channel rosters show shared identities and follow name, role and lifecycle updates without posts", async () => {
  env = await startEnv();
  const human = env.human();
  const alpha = await env.adapter("omp", "roster-alpha", "alpha");
  await env.adapter("omp", "roster-bravo", "bravo");
  await env.adapter("omp", "roster-charlie", "charlie");
  await human.request("set_role", { name: "alpha", role: "orchestrator" });
  await human.request("set_role", { name: "bravo", role: "worker" });
  await human.request("channel_create", { channel: "one" });
  await human.request("channel_create", { channel: "two" });
  for (const name of ["alpha", "bravo", "charlie"]) await human.request("channel_add", { channel: "one", name });
  await human.request("channel_add", { channel: "two", name: "alpha" });
  const ui = await startConsole(120, 22);
  await ui.press("#");
  const listRows = (): string[] => {
    const width = paneWidths(ui.size.columns)?.list ?? ui.size.columns;
    return ui.rows().map((row) => truncateTerminalText(row, width));
  };
  assert.equal(listRows().filter((row) => row.includes("alpha") && row.includes("orch") && row.includes("●")).length, 2);
  assert.ok(listRows().some((row) => row.includes("bravo") && row.includes("wrk") && row.includes("●")));
  assert.ok(listRows().some((row) => row.includes("charlie") && row.includes("unset") && row.includes("●")));
  for (const columns of [79, 80, 120]) {
    await ui.resize(columns, 22);
    assert.ok(listRows().some((row) => row.includes("#one")));
    assert.ok(listRows().some((row) => row.includes("#two")));
    assertWithin(ui);
  }
  await human.request("rename", { from: "alpha", name: "renamed" });
  await human.request("set_role", { name: "renamed", role: "worker" });
  await ui.until(() => listRows().filter((row) => row.includes("renamed") && row.includes("wrk")).length === 2, "both rosters update the same identity");
  const gone = await env.watch((e) => e.type === "session" && e.action === "gone" && e.session.id === alpha.session.id);
  alpha.client.close();
  await gone.event;
  await ui.until(() => listRows().filter((row) => row.includes("renamed") && row.includes("◌")).length === 2, "both rosters show reconnecting");
  env.clock.advance(GRACE_MS);
  env.daemon.sweep();
  await ui.until(() => ui.rows().filter((row, index) => truncateTerminalText(row, paneWidths(120)!.list).includes("renamed") && normalizeTerminalLine(ui.frame().lines[index], ui.size.columns).some((span) => span.text.includes("renamed") && span.style?.dim)).length === 2, "both rosters show archived identities");
  assert.deepEqual((await human.request("channel_read", { channel: "one" })).messages, []);
  assertWithin(ui);
});

test("channel palette edits and member hit targets keep delivery in channel scope and removal bound to identity", async () => {
  env = await startEnv();
  const human = env.human();
  const alpha = await env.adapter("omp", "palette-alpha", "alpha");
  const ui = await startConsole(120, 22);
  const palette = async (action: string): Promise<void> => {
    await ui.press("?");
    await ui.type(action);
    await ui.press("ENTER");
  };
  await palette("Create channel");
  await ui.type("empty");
  await ui.press("CTRL_D");
  await ui.until(() => ui.rows().some((row) => row.includes("#empty")), "created empty channel appears without posting");
  assert.deepEqual((await human.request("channel_read", { channel: "empty" })).messages, []);
  await ui.press("a");
  const created = ui.rows().findIndex((row) => row.includes("channel") && row.includes("#empty"));
  assert.ok(created >= 1, "empty channel creation has its own activity row");
  await ui.click(0, created);
  await ui.press("c");
  assert.ok(ui.rows().some((row) => row.includes("to #empty")), "opening a channel activity event keeps the channel composer");
  await ui.press("ESCAPE");
  await ui.press("#");
  await palette("Add channel member");
  await ui.press("TAB");
  await ui.type("alpha");
  await ui.press("CTRL_D");
  await ui.until(() => ui.rows().some((row) => row.includes("alpha") && row.includes("unset") && row.includes("●")), "palette add renders roster event");

  for (const columns of [79, 80, 120]) {
    await ui.resize(columns, 22);
    await ui.press("#");
    const width = paneWidths(columns)?.list ?? columns;
    const row = ui.rows().findIndex((row) => truncateTerminalText(row, width).includes("alp") && truncateTerminalText(row, width).includes("●"));
    assert.ok(row >= 1);
    await ui.click(columns >= 80 ? 1 : 0, row);
    await ui.press("ENTER");
    await ui.press("c");
    await ui.type(`post-${columns}`);
    await ui.press("ENTER");
    const posts = (await human.request("channel_read", { channel: "empty" })).messages as StoredMessage[];
    assert.ok(posts.some((post) => post.text === `post-${columns}` && post.from === "human"));
    assert.deepEqual(alpha.deliveries, [], "selecting a member never targets a direct message");
    assertWithin(ui);
    await ui.press("ESCAPE");
  }
  await ui.press("#");
  await ui.press("DOWN"); // select alpha's identity, not just the channel
  await palette("Remove channel member");
  await human.request("rename", { from: "alpha", name: "retired" });
  const gone = await env.watch((e) => e.type === "session" && e.action === "gone" && e.session.id === alpha.session.id);
  alpha.client.close();
  await gone.event;
  env.clock.advance(GRACE_MS);
  env.daemon.sweep();
  const replacement = await env.adapter("omp", "palette-new-alpha", "alpha");
  await human.request("channel_add", { channel: "empty", name: "alpha" });
  await ui.press("CTRL_D");
  await ui.until(() => ui.rows().some((row) => row.includes("alpha") && row.includes("●")) && !ui.rows().some((row) => row.includes("retired")), "remove event leaves the new identity visible");
  const members = (await human.request("channel_members", { channel: "empty" })).members as SessionIdentity[];
  assert.deepEqual(members.map((member) => member.id), [replacement.session.id], "removal follows selected identity through rename, archive and name reuse");
  assertWithin(ui);
});

test("rapid removal palette input stays in its identity form instead of sending a direct message", async () => {
  env = await startEnv();
  const human = env.human();
  const alpha = await env.adapter("omp", "rapid-remove-alpha", "alpha");
  await human.request("channel_create", { channel: "work" });
  await human.request("channel_add", { channel: "work", name: "alpha" });
  const ui = await startConsole(80, 22);
  await ui.press("#");
  await ui.press("?");
  await ui.type("Remove channel member");
  await ui.burst(["ENTER", "TAB", "CTRL_U", ...alpha.session.id, "CTRL_D"]);
  const members = (await human.request("channel_members", { channel: "work" })).members as SessionIdentity[];
  assert.deepEqual(members, []);
  assert.deepEqual(alpha.deliveries, [], "form input must never leak into a session composer");
});

test("rounded panes resize at the wide boundary without overflowing or moving mouse and cursor targets onto borders", async () => {
  env = await startEnv();
  const human = env.human();
  const alpha = await env.adapter("omp", "panel-alpha", "alpha");
  const beta = await env.adapter("omp", "panel-beta", "beta");
  await alpha.client.request("send", { to: "human", text: "alpha-message-tail" });
  await beta.client.request("send", { to: "human", text: "beta-message-tail" });
  let handlers: TerminalAdapterOptions = {};
  let frame: TerminalFrame = { lines: [] };
  const size = { columns: 100, rows: 18 };
  const app = new ConsoleApp({
    screen: (options) => {
      handlers = options;
      return { size, start() {}, render(next) { frame = next; }, cleanup() {} };
    },
  });
  const rows = (): string[] => frame.lines.map(lineText);
  const press = async (name: string): Promise<void> => {
    const text = [...name].length === 1 ? name : undefined;
    handlers.onKey?.({ name, matches: [name], ...(text ? { text } : {}), ctrl: false, alt: false, shift: false });
    await app.idle();
  };
  const resize = async (columns: number, height: number): Promise<void> => {
    Object.assign(size, { columns, rows: height });
    handlers.onResize?.(size);
    await app.idle();
  };
  const click = async (column: number, row: number): Promise<void> => {
    handlers.onMouse?.({ name: "MOUSE_LEFT_BUTTON_PRESSED", action: "press", button: "left", column, row, ctrl: false, alt: false, shift: false });
    await app.idle();
  };
  try {
    void app.run();
    await app.idle();
    assert.ok(rows().some((row) => row.includes("beta-message-tail")), "initial conversation loaded");
    for (const columns of [79, 80, 81, 100]) {
      for (const height of [0, 1, 2, 3, 4, 5, 6, 8, 18]) {
        await resize(columns, height);
        const rendered = rows();
        assert.ok(rendered.length <= height, `${columns}×${height}: frame exceeds the terminal height`);
        for (const row of rendered) assert.ok(terminalTextWidth(row) <= columns, `${columns}×${height}: ${row}`);
        if (columns < 80) {
          assert.ok(rendered.every((row) => !row.includes("╭") || row.startsWith("╭─ to ")), "only the composer may be boxed in narrow mode");
          continue;
        }
        const top = height >= 4 ? 1 : 0;
        const bottom = height >= 2 ? 1 : 0;
        const body = rendered.slice(top, height - bottom);
        const listWidth = paneWidths(columns)!.list;
        for (const row of body) {
          assert.equal(terminalTextWidth(row), columns, "both outer pane widths fill the frame");
          assert.equal(row[listWidth], " ", "exactly one column separates the outer panels");
        }
        if (body.length) {
          assert.ok(body[0]!.startsWith("╭─ Sessions"), "picker title is inset in its top border");
          assert.ok(body[0]!.slice(listWidth + 1).startsWith("╭─ beta"), "conversation title is inset in its top border");
          assert.equal(body[0]![listWidth - 1], "╮");
          assert.ok(body[0]!.endsWith("╮"));
        }
        if (body.length >= 2) {
          assert.equal(body.at(-1)![0], "╰");
          assert.equal(body.at(-1)![listWidth - 1], "╯");
          assert.equal(body.at(-1)![listWidth + 1], "╰");
          assert.ok(body.at(-1)!.endsWith("╯"));
        }
        for (const row of body.slice(1, -1)) {
          assert.equal(row[0], "│");
          assert.equal(row[listWidth - 1], "│");
          assert.equal(row[listWidth + 1], "│");
          assert.ok(row.endsWith("│"));
        }
      }
    }
    assert.equal(await unread(human, alpha.session.id), 1, "resize and list focus do not read alpha");
    assert.equal(await unread(human, beta.session.id), 1, "resize and list focus do not read beta");

    await resize(100, 18);
    const listWidth = paneWidths(100)!.list;
    await press("/");
    assert.deepEqual(frame.cursor, { row: 2, column: 3 }, "search cursor is inside the bordered picker");
    for (let index = 0; index < 40; index++) await press("z");
    assert.deepEqual(frame.cursor, { row: 2, column: listWidth - 2 }, "long search cursor stops before the right border");
    await press("ESCAPE");
    const alphaRow = rows().findIndex((row) => row.slice(0, listWidth).includes("alpha"));
    assert.ok(alphaRow >= 2);
    await click(1, alphaRow);
    assert.ok(rows()[1]!.slice(listWidth + 1).startsWith("╭─ alpha"), "clicking the inset list row selects alpha");
    assert.equal(await unread(human, alpha.session.id), 1, "list click does not read the conversation");
    const messageRow = rows().findIndex((row) => row.slice(listWidth + 2).includes("alpha-message-tail"));
    assert.ok(messageRow >= 2);
    await click(listWidth + 1, messageRow);
    assert.equal(await unread(human, alpha.session.id), 1, "the conversation border is not a transcript hit");
    await click(listWidth + 2, messageRow);
    assert.equal(await unread(human, alpha.session.id), 0, "the inset transcript hit reads the visible newest row");
    const composerRow = rows().findIndex((row) => row.slice(listWidth + 2).startsWith("│› "));
    assert.ok(composerRow > messageRow);
    const promptColumn = rows()[composerRow]!.indexOf("› ", listWidth + 2);
    await click(listWidth + 2, composerRow);
    const beforeTyping = frame;
    await press("x");
    assert.deepEqual(frame.cursor, { row: composerRow, column: promptColumn + terminalTextWidth("› x") }, "composer cursor follows the typed text inside both borders");
    assert.deepEqual(changedTerminalRows(beforeTyping, frame, size), [composerRow], "typing without a wrap redraws only the input row");
    await resize(80, 8);
    assert.ok(frame.cursor && frame.cursor.column > paneWidths(80)!.list + 1 && frame.cursor.column < 79);
    assert.ok(frame.cursor.row >= 2 && frame.cursor.row < 6, "resized composer cursor stays above the bottom border");
    await press("ENTER");
    assert.equal((await alpha.nextDelivery()).msg.text, "x", "mouse-focused composer sends to the selected identity after resize");

    await press("ESCAPE");
    await resize(79, 18);
    const narrowPromptRow = rows().findIndex((row) => row.startsWith("│› "));
    assert.ok(narrowPromptRow >= 0, "the narrow conversation exposes the boxed composer");
    assert.ok(rows().filter((row) => row.includes("╭")).every((row) => row.startsWith("╭─ to ")), "the narrow picker has no outer box");
    await click(1, narrowPromptRow);
    const draft = "0123456789abcdefghijklmnopqrstuvwxyz";
    for (const character of draft) await press(character);
    await press("ALT_ENTER");
    await press("z");
    await press("CTRL_J");
    await press("y");
    for (const [columns, height] of [[20, 8], [5, 6], [79, 5], [79, 3], [79, 1], [80, 5], [100, 18]] as const) {
      await resize(columns, height);
      assert.ok(rows().length <= height);
      for (const row of rows()) assert.ok(terminalTextWidth(row) <= columns);
      assert.ok(frame.cursor, `${columns}×${height}: focused editor has an input cell`);
      assert.ok(frame.cursor.row >= 0 && frame.cursor.row < height);
      assert.ok(frame.cursor.column >= 0 && frame.cursor.column < columns);
      assert.ok(!"╭╮╰╯│─".includes(rows()[frame.cursor.row]![frame.cursor.column]!), "wrapped cursor never lands on a border");
    }
    await press("ENTER");
    assert.equal((await alpha.nextDelivery()).msg.text, `${draft}\nz\ny`, "hard-wrapping and short-pane fallbacks preserve the full multiline draft");

    await press("ESCAPE");
    await press("a");
    assert.ok(rows().every((row) => !row.includes("╭") && !row.includes("╰")), "activity remains full-width");
    await press("?");
    assert.ok(rows().every((row) => !row.includes("╭") && !row.includes("╰")), "command palette remains unboxed");
  } finally {
    handlers.onInterrupt?.();
    await app.idle();
  }
});

test("held bar is target-scoped and hidden by non-session surfaces and text overlays", async () => {
  env = await startEnv();
  const human = env.human();
  const orch = await env.adapter("omp", "held-scopes-orch", "orch");
  const worker = await env.adapter("omp", "held-scopes-worker", "worker");
  await human.request("set_inbound", { name: "worker", mode: "hold" });
  await orch.client.request("send", { to: "worker", text: "target-held-preview" });
  await worker.client.request("send", { to: "human", text: "grouped-inbox-message" });
  await human.request("channel_send", { channel: "held-scopes", text: "channel-message" });
  const ui = await startConsole(120, 32);
  await ui.press("/");
  await ui.type("orch");
  await ui.press("ENTER");
  assert.ok(ui.rows().every((row) => !row.includes("⏸ held")), "sending a held message does not give the sender a bar");
  await ui.press("/");
  await ui.press("ESCAPE");
  await ui.press("/");
  await ui.type("worker");
  await ui.press("ENTER");
  await ui.until(() => ui.rows().some((row) => row.includes("⏸ held")), "target bar");
  await ui.press("ENTER");
  await ui.press("?");
  assert.ok(ui.rows().every((row) => !row.includes("⏸ held")), "palette hides the bar");
  await ui.press("ESCAPE");
  await ui.press("CTRL_E");
  assert.ok(ui.rows().every((row) => !row.includes("⏸ held")), "full editor hides the bar");
  await ui.press("ESCAPE");
  await ui.press("i");
  assert.ok(ui.rows().some((row) => row.includes("target-held-preview")), "grouped inbox opens the same target identity");
  await ui.press("v");
  assert.ok(ui.rows().every((row) => !row.includes("⏸ held")), "aggregate inbox is not a target conversation");
  await ui.press("#");
  assert.ok(ui.rows().every((row) => !row.includes("⏸ held")), "channel has no session bar");
  await ui.press("a");
  assert.ok(ui.rows().every((row) => !row.includes("⏸ held")), "activity has no bar");
  assertWithin(ui);
});

test("held bar keeps a sanitized preview and monochrome emphasis without stealing a resized draft's input", async () => {
  env = await startEnv();
  const human = env.human();
  const orch = await env.adapter("omp", "held-resize-orch", "orch");
  const worker = await env.adapter("omp", "held-resize-worker", "worker");
  await human.request("set_inbound", { name: "worker", mode: "hold" });
  const [held] = (await orch.client.request("send", { to: "worker", text: "safe-preview\nsecond-line \u001b[31mred\u001b[0m" })).results as SendResult[];
  const ui = await startConsole(120, 32);
  await ui.press("/");
  await ui.type("worker");
  await ui.press("ENTER");
  const barRow = ui.rows().findIndex((row) => row.includes("⏸ held"));
  assert.ok(barRow >= 0);
  assert.match(ui.rows()[barRow]!, /"safe-preview second-line red"/);
  const spans = normalizeTerminalLine(ui.frame().lines[barRow], ui.size.columns);
  assert.ok(spans.some((span) => span.text.includes("⏸ held") && span.style?.foreground === "yellow" && span.style.bold));
  assert.ok(spans.some((span) => span.text.includes("│") && span.style?.foreground === "yellow" && span.style.dim));
  const monochrome = normalizeTerminalLine(ui.frame().lines[barRow], ui.size.columns, false);
  assert.ok(monochrome.some((span) => span.text.includes("⏸ held") && span.style?.bold && !span.style.foreground));
  assert.ok(monochrome.some((span) => span.text.includes("│") && span.style?.dim && !span.style.foreground));
  const composerRow = ui.rows().findIndex((row) => row.includes("Write to worker"));
  assert.ok(composerRow > barRow, "composer input stays below the held bar");
  const promptColumn = ui.rows()[composerRow]!.indexOf("› ");
  await ui.click(promptColumn, composerRow);
  await ui.press("r");
  await ui.press("x");
  for (const [columns, height, visible] of [[79, 8, true], [79, 6, true], [79, 5, false], [79, 3, false], [7, 6, false], [80, 8, true], [120, 32, true]] as const) {
    Object.assign(ui.size, { columns, rows: height });
    await ui.press("LEFT");
    assertWithin(ui);
    assert.equal(ui.rows().some((row) => row.includes("⏸ held")), visible, `${columns}×${height}: held chrome visibility`);
    const cursor = ui.frame().cursor;
    assert.ok(cursor && cursor.row >= 0 && cursor.row < height && cursor.column >= 0 && cursor.column < columns);
    assert.ok(!"╭╮╰╯│─".includes(ui.rows()[cursor.row]![cursor.column]!), "draft cursor stays off the held and composer borders");
  }
  assert.deepEqual(((await human.request("held")).messages as StoredMessage[]).map((message) => message.id), [held.msgId], "typing and resizing never release or drop the held message");
  await ui.press("ENTER");
  await ui.until(() => worker.deliveries.length === 1, "draft survives held-bar resizing");
  assert.equal((await worker.nextDelivery()).msg.text, "rx", "composer r/x remain editable text through held-bar resize");
});

test("held chrome does not read a hidden or scrolled-away newest incoming row", async () => {
  env = await startEnv();
  const human = env.human();
  const orch = await env.adapter("omp", "held-reader-orch", "orch");
  const worker = await env.adapter("omp", "held-reader-worker", "worker");
  await human.request("set_inbound", { name: "worker", mode: "hold" });
  await orch.client.request("send", { to: "worker", text: "held-reader-preview" });
  await worker.client.request("send", { to: "human", text: `${"long incoming paragraph\n".repeat(40)}latest-incoming-tail` });
  const ui = await startConsole(120, 32);
  await ui.press("/");
  await ui.type("worker");
  await ui.press("ENTER");
  ui.size.columns = 80;
  ui.size.rows = 4;
  await ui.press("ENTER");
  assert.ok(ui.rows().every((row) => !row.includes("⏸ held") && !row.includes("latest-incoming-tail")));
  assert.equal(await unread(human, worker.session.id), 1, "hidden body and bar do not expose the incoming row");
  ui.size.columns = 120;
  ui.size.rows = 32;
  await ui.press("u");
  await ui.press("HOME");
  assert.ok(ui.rows().some((row) => row.includes("held-reader-preview")));
  assert.ok(ui.rows().every((row) => !row.includes("latest-incoming-tail")));
  assert.equal(await unread(human, worker.session.id), 1, "a visible held preview is not the incoming message");
  await ui.press("END");
  assert.ok(ui.rows().some((row) => row.includes("latest-incoming-tail")));
  assert.equal(await unread(human, worker.session.id), 0, "only the reached newest incoming row advances the marker");
  assertWithin(ui);
});

test("wide bordered conversation keeps every wrapped body row reachable and reads only the visible last incoming row", async () => {
  env = await startEnv();
  const human = env.human();
  const alpha = await env.adapter("omp", "bordered-reader", "alpha");
  const text = [
    ...Array.from({ length: 12 }, (_, index) => `paragraph ${index + 1} carries words across the inset conversation 漢字 and preserves all content`),
    "",
    "final-bordered-row-marker",
  ].join("\n");
  await alpha.client.request("send", { to: "human", text });
  const ui = await startConsole(80, 8);
  await ui.until(() => ui.rows().some((row) => row.includes("final-bordered-row-marker")), "bordered conversation preview");
  ui.size.rows = 4;
  await ui.press("ENTER");
  assertWithin(ui);
  assert.equal(await unread(human, alpha.session.id), 1, "a title and bottom border alone do not expose or read the message");
  ui.size.rows = 8;
  await ui.press("u");
  await ui.press("HOME");
  const listWidth = paneWidths(80)!.list;
  const seen = new Set<string>();
  let reached = false;
  for (let step = 0; step < 120; step++) {
    assertWithin(ui);
    const body = ui.rows().slice(2, -2).map((row) => row.slice(truncateTerminalText(row, listWidth).length + 2, -1).trim());
    for (const row of body) seen.add(row);
    reached = body.includes("final-bordered-row-marker");
    assert.equal(await unread(human, alpha.session.id), reached ? 0 : 1, "the marker advances only when the final incoming body row is on screen");
    if (reached) break;
    await ui.press("PAGE_DOWN");
  }
  assert.ok(reached, "the last row is reachable through the bordered viewport");
  for (const row of wrapTerminalText(text, paneWidths(80)!.conversation - 4)) {
    assert.ok(seen.has(row.trim()), `reached wrapped row: ${row}`);
  }
});

test("unread archived sessions remain distinguishable at the 80-column boundary", async () => {
  env = await startEnv();
  const alpha = await env.adapter("omp", "archived-alpha", "alpha");
  const bravo = await env.adapter("omp", "archived-bravo", "bravo");
  for (const session of [alpha, bravo]) {
    await session.client.request("send", { to: "human", text: "unread archived conversation" });
    await session.client.request("unregister");
  }
  const ui = await startConsole(80, 18);
  await ui.press("ENTER");
  const listWidth = paneWidths(80)!.list;
  const archived = ui.rows().map((row) => truncateTerminalText(row, listWidth)).filter((row) => row.includes("alpha") || row.includes("bravo"));
  assert.equal(archived.length, 2);
  assert.ok(archived.some((row) => row.includes("al")), "alpha retains a visible name prefix");
  assert.ok(archived.some((row) => row.includes("br")), "bravo retains a distinct visible name prefix");
  for (const row of archived) assert.ok(row.includes("+1"), "unread count remains visible");
  assertWithin(ui);
});

test("chrome header shows all counters and highlights the active tab as a pill", async () => {
  env = await startEnv();
  await env.adapter("omp", "chrome-header", "reviewer");
  const ui = await startConsole(120, 32);
  assert.match(ui.rows()[0], /1 live · 0 reconnecting · 0 held · 0 unread · 0 failed/);
  assert.match(ui.rows()[0], /● connected$/);
  const spans = ui.frame().lines[0] as readonly { text: string; style?: { inverse?: boolean } }[];
  assert.ok(spans.some((span) => span.text.includes("Sessions") && span.style?.inverse), "active Sessions tab is an inverse pill");
  await ui.press("i");
  const inbox = ui.frame().lines[0] as typeof spans;
  assert.ok(inbox.some((span) => span.text.includes("Inbox") && span.style?.inverse), "the active pill follows keyboard tab changes");
  assertWithin(ui);
});

test("chrome footer renders context keys as inverse chips with dim labels", async () => {
  env = await startEnv();
  await env.adapter("omp", "chrome-footer", "reviewer");
  const ui = await startConsole(120, 32);
  const footer = ui.frame().lines.at(-1) as readonly { text: string; style?: { inverse?: boolean; dim?: boolean } }[];
  assert.ok(footer.some((span) => /Enter|⏎/.test(span.text) && span.style?.inverse), "Enter is an inverse key chip");
  assert.ok(footer.some((span) => span.text.includes("open") && span.style?.dim && !span.style.inverse), "open is a dim label rather than part of the key chip");
  await ui.press("c");
  const composerFooter = ui.frame().lines.at(-1) as typeof footer;
  assert.ok(composerFooter.some((span) => /Shift\+Enter|⇧⏎/.test(span.text) && span.style?.inverse), "composer newline key stays discoverable");
  assertWithin(ui);
});

test("chrome composer is a focused rounded box with target and editing hints", async () => {
  env = await startEnv();
  const reviewer = await env.adapter("omp", "chrome-composer", "reviewer");
  const ui = await startConsole(120, 32);
  await ui.press("c");
  const listWidth = paneWidths(120)!.list;
  const conversation = ui.rows().map((row) => row.slice(listWidth + 2, -1));
  const titleRow = conversation.findIndex((row) => row.startsWith("╭─ to reviewer "));
  assert.ok(titleRow > 1, "composer target is inset into a separate top border");
  assert.ok(conversation[titleRow + 1].startsWith("│› "), "prompt sits inside the composer");
  assert.ok(conversation[titleRow + 2].startsWith("╰"), "composer has its own rounded bottom border");
  assert.ok(conversation.some((row) => row.includes("⏎ send") && row.includes("⇧⏎ newline") && row.includes("^E editor")), "editing hints are visible in the composer");
  const title = ui.frame().lines[titleRow] as readonly { text: string; style?: { foreground?: string } }[];
  assert.ok(title.some((span) => span.text.includes("╭") && span.style?.foreground === "cyan"), "focused composer border is cyan");
  await ui.type("hello");
  await ui.press("SHIFT_ENTER");
  await ui.type("there");
  await ui.press("ENTER");
  assert.equal((await reviewer.nextDelivery()).msg.text, "hello\nthere");
  assertWithin(ui);
});

test("console shows control actions beside their kind without changing ordinary message tags", async () => {
  env = await startEnv();
  const alpha = await env.adapter("omp", "alpha-key", "alpha");
  await alpha.client.request("send", { to: "human", text: "Ordinary status", kind: "status" });
  await alpha.client.request("send", { to: "human", text: "Please pause here", kind: "control", action: "pause" });
  const ui = await startConsole(120, 30);
  await ui.until(() => ui.rows().some((row) => row.includes("Please pause here")), "control message");

  const control = ui.rows().find((row) => row.includes("control pause"));
  const ordinary = ui.rows().find((row) => /\bstatus\b/.test(row) && row.includes("→"));
  assert.ok(control?.includes("pause"), "the visible control tag carries its action");
  assert.ok(ordinary, "ordinary status tag remains visible");
  assert.ok(!ordinary.includes("pause") && !ordinary.includes("control"), "ordinary metadata is unchanged");
  assertWithin(ui);
});

async function quickJump(ui: Console, query: string, body: string): Promise<void> {
  await ui.press("CTRL_K");
  assert.ok(ui.rows().some((row) => row.includes("Quick jump")), "finder opens");
  await ui.type(query);
  await ui.press("ENTER");
  await ui.until(() => ui.rows().some((row) => row.includes(body)), `jump to ${body}`);
  assert.ok(!ui.rows().some((row) => row.includes("Quick jump")), "Enter closes the finder");
}

test("quick jump opens from every focus and Esc restores the focus and composer cursor", async () => {
  env = await startEnv();
  const alpha = await env.adapter("omp", "jump-alpha", "alpha");
  await alpha.client.request("send", { to: "human", text: "alpha-focus-history" });
  const ui = await startConsole(100, 24);
  await ui.until(() => ui.rows().some((row) => row.includes("alpha-focus-history")), "initial history");
  const cancel = async (focus: string): Promise<void> => {
    const cursor = ui.frame().cursor;
    await ui.press("CTRL_K");
    assert.ok(ui.rows().some((row) => row.includes("Quick jump")), `opens from ${focus}`);
    await ui.type("no-such-session");
    await ui.press("ESCAPE");
    assert.ok(!ui.rows().some((row) => row.includes("Quick jump")), `closes from ${focus}`);
    assert.deepEqual(ui.frame().cursor, cursor, `${focus} cursor is restored`);
  };
  await cancel("list");
  await ui.press("SHIFT_TAB");
  await cancel("tabs");
  await ui.press("RIGHT");
  await ui.press("s");
  await ui.press("TAB");
  await ui.press("ENTER");
  await cancel("transcript");
  await ui.press("c");
  await ui.type("ab");
  await ui.press("LEFT");
  await cancel("composer");
  await ui.type("X");
  await ui.press("ENTER");
  assert.equal((await alpha.nextDelivery()).msg.text, "aXb", "Esc returns to the same draft insertion point");
});

test("quick jump suspends search, the action palette and full editor without editing their text", async () => {
  env = await startEnv();
  const alpha = await env.adapter("omp", "jump-modal-alpha", "alpha");
  await alpha.client.request("send", { to: "human", text: "modal-alpha-history" });
  const ui = await startConsole(120, 32);
  await ui.press("/");
  await ui.type("alp");
  await ui.press("CTRL_K");
  assert.ok(ui.rows().some((row) => row.includes("Quick jump")));
  await ui.type("missing");
  await ui.press("ESCAPE");
  await ui.type("ha");
  assert.ok(ui.rows().some((row) => row.includes("/ alpha")), "search query and search focus are restored");
  await ui.press("ESCAPE");

  await ui.press("?");
  await ui.type("ren");
  await ui.press("CTRL_K");
  assert.ok(ui.rows().some((row) => row.includes("Quick jump")));
  await ui.type("missing");
  await ui.press("ESCAPE");
  await ui.type("ame");
  assert.ok(ui.rows().some((row) => row.includes("Rename session")), "palette query resumes");
  assert.ok(!ui.rows().some((row) => row.includes("Daemon start")), "palette filter remains active");
  await ui.press("ESCAPE");

  await ui.press("CTRL_E");
  await ui.type("editor draft");
  const cursor = ui.frame().cursor;
  await ui.press("CTRL_K");
  assert.ok(ui.rows().some((row) => row.includes("Quick jump")));
  await ui.type("missing");
  await ui.press("ESCAPE");
  assert.deepEqual(ui.frame().cursor, cursor, "full editor returns to its original field");
  await ui.type(" retained");
  await ui.press("CTRL_D");
  assert.equal((await alpha.nextDelivery()).msg.text, "editor draft retained", "finder text never enters the editor draft");
});

test("quick jump matches former names, reconnecting and archived identities and channel subsequences", async () => {
  env = await startEnv();
  const human = env.human();
  const archived = await env.adapter("omp", "jump-archive", "reviewer");
  await archived.client.request("send", { to: "human", text: "retired-history-marker" });
  await human.request("rename", { from: "reviewer", name: "retired" });
  await archived.client.request("unregister");
  const reconnecting = await env.adapter("omp", "jump-reconnect", "remote-worker");
  await reconnecting.client.request("send", { to: "human", text: "reconnecting-history-marker" });
  const gone = await env.watch((event) => event.type === "session" && event.action === "gone" && event.name === "remote-worker");
  reconnecting.client.close();
  await gone.event;
  const alpha = await env.adapter("omp", "jump-live", "alpha");
  await alpha.client.request("send", { to: "human", text: "live-alpha-marker" });
  await human.request("channel_send", { channel: "release-work", text: "release-channel-marker" });
  const ui = await startConsole(120, 32);

  await ui.press("/");
  await ui.type("alpha");
  await quickJump(ui, "RvW", "retired-history-marker");
  await ui.press("LEFT");
  const list = ui.rows().map((row) => truncateTerminalText(row, paneWidths(120)!.list)).join("\n");
  assert.ok(list.includes("retired"), "archive is expanded and the previous session filter is cleared");
  assert.ok(list.includes("alpha"), "unrelated live identities remain reachable after jumping");
  await quickJump(ui, "RmW", "reconnecting-history-marker");
  await ui.press("CTRL_K");
  await ui.type("rlw");
  assert.ok(ui.rows().some((row) => row.includes("#release-work")), "channels carry a # label");
  await ui.press("ENTER");
  await ui.until(() => ui.rows().some((row) => row.includes("release-channel-marker")), "unprefixed channel subsequence");
  await quickJump(ui, "#RLW", "release-channel-marker");
});

test("quick jump ranks exact before prefix before subsequence and live before archived ties", async () => {
  env = await startEnv();
  const archived = await env.adapter("omp", "rank-archived", "review");
  await archived.client.request("send", { to: "human", text: "archived-exact-marker" });
  await archived.client.request("unregister");
  env.clock.advance(1000);
  const exact = await env.adapter("omp", "rank-live", "review");
  await exact.client.request("send", { to: "human", text: "live-exact-marker" });
  env.clock.advance(1000);
  const prefix = await env.adapter("omp", "rank-prefix", "reviewer");
  await prefix.client.request("send", { to: "human", text: "live-prefix-marker" });
  env.clock.advance(1000);
  const subsequence = await env.adapter("omp", "rank-subsequence", "red-view");
  await subsequence.client.request("send", { to: "human", text: "live-subsequence-marker" });
  const ui = await startConsole(100, 24);
  for (const [index, marker] of ["live-exact-marker", "archived-exact-marker", "live-prefix-marker", "live-subsequence-marker"].entries()) {
    await ui.press("CTRL_K");
    await ui.type("ReViEw");
    const results = ui.rows().filter((row) => row.includes("review") || row.includes("red-view"));
    assert.ok(results.some((row) => row.includes("reviewer")), "prefix match is rendered");
    assert.ok(results.some((row) => row.includes("red-view")), "ordered subsequence match is rendered");
    assert.ok(results.some((row) => row.includes("archived")), "reused names retain their archived identity");
    for (let step = 0; step < index; step++) await ui.press("DOWN");
    await ui.press("ENTER");
    await ui.until(() => ui.rows().some((row) => row.includes(marker)), `rank ${index + 1} opens its own history`);
    for (const other of ["live-exact-marker", "archived-exact-marker", "live-prefix-marker", "live-subsequence-marker"]) {
      if (other !== marker) assert.ok(!ui.rows().some((row) => row.includes(other)), "same or similar names do not merge histories");
    }
  }
});

test("quick jumps preserve separate identity and channel drafts and send once to the renamed identity", async () => {
  env = await startEnv();
  const human = env.human();
  const reviewer = await env.adapter("omp", "jump-draft-reviewer", "reviewer");
  const peer = await env.adapter("omp", "jump-draft-peer", "peer");
  await reviewer.client.request("send", { to: "human", text: "reviewer-draft-history" });
  await peer.client.request("send", { to: "human", text: "peer-draft-history" });
  await human.request("channel_send", { channel: "work", text: "work-draft-history" });
  const ui = await startConsole(120, 32);
  await quickJump(ui, "reviewer", "reviewer-draft-history");
  await ui.press("c");
  await ui.type("identity draft");
  await human.request("rename", { from: "reviewer", name: "renamed" });
  await ui.until(() => ui.rows().some((row) => row.includes("renamed")), "rename");
  await quickJump(ui, "#work", "work-draft-history");
  await ui.press("c");
  await ui.type("channel draft");
  await quickJump(ui, "peer", "peer-draft-history");
  await ui.press("c");
  await ui.type("peer draft");
  await quickJump(ui, "#work", "work-draft-history");
  assert.ok(ui.rows().some((row) => row.includes("channel draft")), "channel draft survives a jump");
  assert.ok(!ui.rows().some((row) => row.includes("identity draft") || row.includes("peer draft")), "drafts do not leak between targets");
  await quickJump(ui, "RvW", "reviewer-draft-history");
  assert.ok(ui.rows().some((row) => row.includes("identity draft")), "former-name jump restores the stable identity draft");
  await ui.press("c");
  await ui.press("ENTER");
  await ui.press("ENTER");
  assert.equal((await reviewer.nextDelivery()).msg.text, "identity draft");
  const history = await human.historyPage({ scope: "session", sessionId: reviewer.session.id });
  assert.equal(history.messages.filter((message) => message.from === "human" && message.text === "identity draft").length, 1, "draft is sent exactly once");
  const peerHistory = await human.historyPage({ scope: "session", sessionId: peer.session.id });
  assert.ok(!peerHistory.messages.some((message) => message.text === "identity draft"), "no send to another identity");
  await quickJump(ui, "peer", "peer-draft-history");
  assert.ok(ui.rows().some((row) => row.includes("peer draft")), "unsent peer draft is intact");
});

test("late replies to a former name appear in the already selected canonical conversation", async () => {
  env = await startEnv();
  const human = env.human();
  const original = await env.adapter("omp", "former-reply-key", "original");
  const peer = await env.adapter("opencode", "late-reply-key", "peer");
  await original.client.request("send", { to: "human", text: "original-conversation-marker" });
  const ui = await startConsole(120, 32);
  await quickJump(ui, "original", "original-conversation-marker");
  await original.client.request("rename", { name: "niche-manager" });
  await ui.until(() => ui.rows().some((row) => row.includes("niche-manager")), "selected identity rename");

  await peer.client.request("send", { to: "original", text: "late-former-name-reply-marker" });
  const received = await original.nextDelivery();
  assert.deepEqual([received.session, received.msg.to, received.msg.text], [
    original.session.id, "niche-manager", "late-former-name-reply-marker",
  ]);
  await ui.until(() => ui.rows().some((row) => row.includes("late-former-name-reply-marker")), "late reply in selected conversation");
  assert.ok(ui.rows().some((row) => row.includes("original-conversation-marker")), "the same conversation retains its earlier exchange");
  const history = await human.historyPage({ scope: "session", sessionId: original.session.id });
  assert.deepEqual(history.messages.map((message) => message.text), [
    "original-conversation-marker", "late-former-name-reply-marker",
  ]);
  assertWithin(ui);
});

test("quick jump empty results cannot open or send and Backspace recovers without changing the draft", async () => {
  env = await startEnv();
  const alpha = await env.adapter("omp", "jump-empty", "alpha");
  await alpha.client.request("send", { to: "human", text: "empty-recovery-history" });
  const ui = await startConsole(80, 20);
  await ui.press("c");
  await ui.type("untouched draft");
  await ui.press("CTRL_K");
  await ui.type("alphaz");
  assert.ok(!ui.rows().some((row) => row.includes("empty-recovery-history")), "finder replaces the transcript");
  await ui.press("ENTER");
  assert.ok(ui.rows().some((row) => row.includes("Quick jump")), "Enter with no match stays in the finder");
  assert.equal(alpha.deliveries.length, 0, "Enter in the finder never submits the composer");
  await ui.press("BACKSPACE");
  assert.ok(ui.rows().some((row) => row.includes("alpha")), "Backspace restores the matching identity");
  await ui.press("ENTER");
  await ui.until(() => ui.rows().some((row) => row.includes("empty-recovery-history")), "recovered selection");
  assert.ok(ui.rows().some((row) => row.includes("untouched draft")), "draft was not used as the query");
});

test("quick jump scrolls beyond the visible results and clips in narrow and tiny terminals", async () => {
  env = await startEnv();
  for (let index = 0; index < 12; index++) {
    const session = await env.adapter("omp", `jump-scroll-${index}`, `worker-${String(index).padStart(2, "0")}`);
    await session.client.request("send", { to: "human", text: `scroll-history-${index}` });
  }
  const ui = await startConsole(24, 8);
  await ui.press("CTRL_K");
  assert.ok(ui.rows().some((row) => row.includes("Quick jump")));
  await ui.type("worker");
  const initiallyVisible = ui.rows().join("\n");
  for (let index = 0; index < 11; index++) {
    await ui.press("DOWN");
    assertWithin(ui);
  }
  const result = ui.rows().find((row) => row.includes("›") && /worker-\d\d/.test(row));
  assert.ok(result, "selected result remains visible after scrolling");
  const selected = Number(result.match(/worker-(\d\d)/)![1]);
  assert.ok(!initiallyVisible.includes(`worker-${String(selected).padStart(2, "0")}`), "selection reached a result outside the original viewport");
  await ui.press("ENTER");
  await ui.until(() => ui.rows().some((row) => row.includes(`scroll-history-${selected}`)), "off-screen result history");
  await ui.press("CTRL_K");
  for (const dimensions of [{ columns: 10, rows: 4 }, { columns: 1, rows: 3 }, { columns: 24, rows: 8 }]) {
    Object.assign(ui.size, dimensions);
    await ui.press("DOWN");
    assertWithin(ui);
  }
  await ui.press("ESCAPE");
  assert.ok(ui.rows().some((row) => row.includes(`scroll-history-${selected}`)), "tiny rendering does not alter the selected conversation");
});

test("pasting into quick jump filters results without leaking into a suspended composer", async () => {
  env = await startEnv();
  const alpha = await env.adapter("omp", "jump-paste-alpha", "alpha");
  const reviewer = await env.adapter("omp", "jump-paste-reviewer", "reviewer");
  await alpha.client.request("send", { to: "human", text: "paste-alpha-history" });
  await reviewer.client.request("send", { to: "human", text: "paste-reviewer-history" });
  const ui = await startConsole(120, 32);
  await quickJump(ui, "alpha", "paste-alpha-history");
  await ui.press("c");
  await ui.type("paste-safe draft");
  await ui.press("CTRL_K");
  await ui.paste("RvW");
  assert.ok(ui.rows().some((row) => row.includes("reviewer")), "paste updates the finder query");
  assert.ok(!ui.rows().some((row) => row.includes("alpha")), "pasted query filters out other identities");
  await ui.press("ESCAPE");
  await ui.press("ENTER");
  assert.equal((await alpha.nextDelivery()).msg.text, "paste-safe draft", "pasted finder text does not enter the saved draft");
  assert.equal(reviewer.deliveries.length, 0, "filtering does not send to a result");
});

test("quick jump keeps the highlighted identity through live result reordering", async () => {
  env = await startEnv();
  const human = env.human();
  const alpha = await env.adapter("omp", "jump-churn-alpha", "alpha");
  const bravo = await env.adapter("omp", "jump-churn-bravo", "bravo");
  await env.adapter("omp", "jump-churn-charlie", "charlie");
  await bravo.client.request("send", { to: "human", text: "stable-bravo-history" });
  const ui = await startConsole(120, 32);
  await ui.press("CTRL_K");
  await ui.press("DOWN");
  assert.ok(ui.rows().some((row) => row.includes("› bravo")), "bravo is highlighted");
  await env.adapter("omp", "jump-churn-earlier", "aardvark");
  await ui.until(() => ui.rows().some((row) => row.includes("aardvark")), "inserted earlier result");
  assert.ok(ui.rows().some((row) => row.includes("› bravo")), "insertion retains the highlighted identity");
  await alpha.client.request("unregister");
  await ui.until(() => ui.rows().some((row) => /alpha.*archived/.test(row)), "earlier result changes state");
  assert.ok(ui.rows().some((row) => row.includes("› bravo")), "state sorting retains the highlighted identity");
  await human.request("rename", { from: "bravo", name: "zz-bravo" });
  await ui.until(() => ui.rows().some((row) => row.includes("zz-bravo")), "highlighted identity renamed");
  assert.ok(ui.rows().some((row) => row.includes("› zz-bravo")), "rename retains the highlighted identity");
  await ui.press("ENTER");
  await ui.until(() => ui.rows().some((row) => row.includes("stable-bravo-history")), "Enter opens highlighted identity");

  await human.request("channel_send", { channel: "zebra", text: "stable-zebra-history" });
  await ui.press("CTRL_K");
  await ui.type("#");
  await ui.until(() => ui.rows().some((row) => row.includes("#zebra")), "channel result");
  await human.request("channel_send", { channel: "aardvark", text: "other-channel-history" });
  await ui.until(() => ui.rows().some((row) => row.includes("#aardvark")), "inserted earlier channel");
  assert.ok(ui.rows().some((row) => row.includes("› #zebra")), "channel insertion retains the highlighted channel");
  await ui.press("ENTER");
  await ui.until(() => ui.rows().some((row) => row.includes("stable-zebra-history")), "Enter opens highlighted channel");
});

test("held bar scopes to the open target and releases then drops its oldest shown messages", async () => {
  env = await startEnv();
  const human = env.human();
  const sender = await env.adapter("omp", "held-bar-sender", "orch");
  const target = await env.adapter("omp", "held-bar-target", "worker");
  const other = await env.adapter("omp", "held-bar-other", "other");
  for (const name of ["worker", "other"]) await human.request("set_inbound", { name, mode: "hold" });
  await sender.client.request("send", { to: "worker", text: "oldest-review-preview" });
  await sender.client.request("send", { to: "worker", text: "next-review-preview" });
  await sender.client.request("send", { to: "other", text: "other-target-preview" });
  const ui = await startConsole(120, 32);
  await ui.press("/");
  await ui.type("worker");
  await ui.press("ENTER");
  await ui.press("ENTER");
  const bar = () => ui.rows().find((row) => row.includes("⏸ held"));
  assert.ok(bar(), "held messages for the open target expose the bar");
  assert.ok(bar()!.includes("orch → worker") && bar()!.includes("oldest-review-preview"), "the oldest message is shown with its sender and target");
  assert.match(bar()!, /held.*2/, "multiple held messages show a count");
  assert.ok(!bar()!.includes("other-target-preview"), "another target's held messages are not mixed in");
  assert.match(ui.rows()[0], /3 held/, "header counts held messages across targets");
  await ui.press("r");
  await ui.until(() => target.deliveries.length === 1, "oldest held message released");
  assert.equal((await target.nextDelivery()).msg.text, "oldest-review-preview", "release acts on the displayed oldest message");
  await ui.until(() => bar()?.includes("next-review-preview") ?? false, "next held preview");
  assert.match(ui.rows()[0], /2 held/);
  await ui.press("x");
  await ui.until(() => bar() === undefined, "empty target hides its held bar");
  const held = (await human.request("held")).messages as { text: string }[];
  assert.deepEqual(held.map((message) => message.text), ["other-target-preview"], "drop removes only the shown target's message");
  assert.match(ui.rows()[0], /1 held/);
  assert.equal(target.deliveries.length, 1, "drop never delivers the second message");
  assert.equal(other.deliveries.length, 0);
  assertWithin(ui);
});

test("r and x remain ordinary draft characters while a held bar is visible", async () => {
  env = await startEnv();
  const human = env.human();
  const sender = await env.adapter("omp", "safe-held-sender", "orch");
  const target = await env.adapter("omp", "safe-held-target", "worker");
  await human.request("set_inbound", { name: "worker", mode: "hold" });
  await sender.client.request("send", { to: "worker", text: "held-while-typing" });
  const ui = await startConsole(120, 32);
  await ui.press("/");
  await ui.type("worker");
  await ui.press("ENTER");
  await ui.press("ENTER");
  assert.ok(ui.rows().some((row) => row.includes("⏸") && row.includes("held-while-typing")));
  await ui.press("c");
  await ui.type("rx");
  assert.equal(((await human.request("held")).messages as unknown[]).length, 1, "draft typing does not mutate held messages");
  assert.equal(target.deliveries.length, 0, "draft typing does not release");
  await ui.press("ENTER");
  await ui.until(() => target.deliveries.length === 1, "draft delivered without releasing held message");
  assert.equal((await target.nextDelivery()).msg.text, "rx", "both characters stay in the sent draft");
  assert.equal(((await human.request("held")).messages as unknown[]).length, 1, "human draft delivery bypasses hold without releasing agent messages");
  assertWithin(ui);
});

async function paletteAction(ui: Console, action: string): Promise<void> {
  await ui.press("?");
  await ui.type(action);
  await ui.press("ENTER");
}

async function selectSession(ui: Console, name: string): Promise<void> {
  await ui.press("s");
  await ui.press("/");
  await ui.type(name);
  await ui.press("ENTER");
}

test("Ctrl+X closes only a selected session row after one-key confirmation and leaves composer input alone", async () => {
  env = await startEnv();
  const human = env.human();
  const alpha = await env.adapter("omp", "close-alpha", "alpha");
  const beta = await env.adapter("omp", "close-beta", "beta");
  const ui = await startConsole(120, 24);
  await selectSession(ui, "alpha");
  assert.ok(ui.rows().at(-1)!.includes("Ctrl+X"), "close is discoverable on the selected row");
  await ui.press("CTRL_X");
  assert.ok(ui.rows().some((row) => row.includes(alpha.session.id)), "confirmation identifies the pinned target");
  assert.ok(ui.rows().at(-1)!.includes("confirm") && ui.rows().at(-1)!.includes("cancel"));
  await ui.press("ENTER");
  assert.equal((await human.sync()).sessions.find((s) => s.id === alpha.session.id)!.state, "live", "Enter cannot accidentally confirm");
  await ui.paste("y");
  assert.equal((await human.sync()).sessions.find((s) => s.id === alpha.session.id)!.state, "live", "pasted text cannot accidentally confirm");
  await ui.press("n");
  assert.equal((await human.sync()).sessions.find((s) => s.id === alpha.session.id)!.state, "live", "cancel leaves the target live");

  await ui.press("ENTER");
  await ui.press("CTRL_X");
  assert.ok(!ui.rows().some((row) => row.includes("y confirm")), "conversation focus does not close a row");
  await ui.press("c");
  await ui.type("draft");
  await ui.press("CTRL_X");
  await ui.type("y");
  await ui.press("ENTER");
  assert.equal((await alpha.nextDelivery()).msg.text, "drafty", "Ctrl+X does not intercept the composer");
  await ui.press("ESCAPE");
  await ui.press("LEFT");
  await ui.press("CTRL_X");
  await human.request("rename", { from: "alpha", name: "renamed" });
  await ui.press("y");
  await ui.until(() => ui.rows()[0].includes("1 live"), "closed target leaves live rows");
  const snapshot = await human.sync();
  assert.equal(snapshot.sessions.find((s) => s.id === alpha.session.id)!.state, "removed", "confirmation stays bound across rename");
  assert.equal(snapshot.sessions.find((s) => s.id === beta.session.id)!.state, "live", "the other row stays live");
  await ui.press("ESCAPE");
  await ui.press("END");
  await ui.press("ENTER");
  assert.ok(ui.rows().some((row) => truncateTerminalText(row, paneWidths(120)!.list).includes("renamed")), "closed conversation is reachable in the archive");
  assertWithin(ui);
});

test("close all stale probes quiet sessions and excludes responding and unknown identities", async () => {
  const pingTimeoutMs = 25;
  env = await startEnv({ pingTimeoutMs });
  const human = env.human();
  const quiet = await env.adapter("omp", "quiet-key", "quiet");
  const hung = await env.adapter("omp", "hung-key", "hung", { autoPong: false });
  const legacy = await env.adapter("omp", "legacy-key", "legacy", { pingSupport: false });
  const hookOnly = (await human.request("claude_hook", {
    event: "start", key: "sid:hook-only", sessionId: "hook-only", socket: null, name: "hook-only",
  })).session as { id: string; name: string };
  const deadSocket = join(env.home, "dead-claude.sock");
  const deadClaude = (await human.request("claude_hook", {
    event: "start", key: deadSocket, socket: deadSocket, sessionId: "dead-claude", name: "dead-claude",
  })).session as { id: string; name: string };
  env.clock.advance(6 * 3_600_000 + 1);
  const ui = await startConsole(120, 28);
  await ui.press("?");
  await ui.type("Close all stale");
  const action = ui.press("ENTER");
  await hung.nextPing();
  await quiet.nextPing();
  await quiet.client.request("list"); // round trip after its automatic pong, before expiring hung
  env.clock.advance(pingTimeoutMs);
  env.daemon.sweep();
  await action;
  const rows = ui.rows().join("\n");
  assert.match(rows, /2 conversations/, "only the hung adapter and dead Claude socket are counted");
  for (const session of [hung.session, deadClaude]) {
    assert.ok(rows.includes(`${session.name} (${session.id})`), "failed probes identify their close targets");
  }
  for (const session of [quiet.session, legacy.session, hookOnly]) {
    assert.ok(!rows.includes(session.id), "responsive or unsupported quiet sessions are not close targets");
  }
  await ui.press("y");
  const snapshot = await human.sync();
  for (const session of [hung.session, deadClaude]) {
    assert.equal(snapshot.sessions.find((s) => s.id === session.id)!.state, "removed");
  }
  for (const session of [quiet.session, legacy.session, hookOnly]) {
    assert.equal(snapshot.sessions.find((s) => s.id === session.id)!.state, "live");
  }
  assert.equal(snapshot.sessionPings[quiet.session.id], "responding", "six hours without direct messages does not make a responding session stale");
  assert.equal(snapshot.sessionPings[legacy.session.id], "unknown", "older adapters remain safe without capabilities");
  assert.equal(snapshot.sessionPings[hookOnly.id], "unknown", "hook-only Claude has no socket to probe");
  assertWithin(ui);
});

test("close all stale bounds its preview, cancels safely and submits only the confirmed identities", async () => {
  const pingTimeoutMs = 25;
  env = await startEnv({ pingTimeoutMs });
  const human = env.human();
  const hung: Adapter[] = [];
  for (let index = 0; index < 12; index++) {
    hung.push(await env.adapter("omp", `hung-${index}`, `hung-${index}`, { autoPong: false }));
  }
  const quiet = await env.adapter("omp", "snapshot-quiet", "quiet");
  const gone = await env.adapter("omp", "gone-key", "gone");
  const goneEvent = await env.watch((event) => event.type === "session" && event.action === "gone" && event.session.id === gone.session.id);
  gone.client.close();
  await goneEvent.event;
  const archived = await env.adapter("omp", "archive-key", "archived");
  await human.request("close", { identity: archived.session.id });
  const ui = await startConsole(120, 28);
  const targetIds = new Set([...hung.map((adapter) => adapter.session.id), gone.session.id]);
  const preview = async (): Promise<void> => {
    await ui.press("?");
    await ui.type("Close all stale");
    const action = ui.press("ENTER");
    await Promise.all(hung.map((adapter) => adapter.nextPing()));
    await quiet.nextPing();
    await quiet.client.request("list");
    env!.clock.advance(pingTimeoutMs);
    env!.daemon.sweep();
    await action;
    const rows = ui.rows().join("\n");
    assert.match(rows, /13 conversations/, "all twelve hung sessions and the disconnected session are counted");
    const targets = (await human.sync()).sessions.filter((session) => targetIds.has(session.id));
    for (const session of targets.slice(0, 10)) {
      assert.ok(rows.includes(`${session.name} (${session.id})`), "preview names the first ten exact targets");
    }
    for (const session of targets.slice(10)) {
      assert.ok(!rows.includes(session.id), "remaining targets are counted instead of expanding the preview");
    }
    assert.ok(rows.includes("and 3 more"), "the preview reports its omitted target count");
    assert.ok(!rows.includes(quiet.session.id) && !rows.includes(archived.session.id), "responding and archived identities are excluded");
  };
  await preview();
  await ui.press("n");
  assert.equal((await human.sync()).sessions.filter((s) => targetIds.has(s.id) && s.state === "removed").length, 0, "cancel closes no targets");
  await preview();
  const later = await env.adapter("omp", "later-key", "later");
  for (const adapter of [quiet, later]) {
    const disconnected = await env.watch((event) => event.type === "session" && event.action === "gone" && event.session.id === adapter.session.id);
    adapter.client.close();
    await disconnected.event;
  }
  await ui.press("y");
  const snapshot = await human.sync();
  for (const id of targetIds) assert.equal(snapshot.sessions.find((session) => session.id === id)!.state, "removed");
  for (const adapter of [quiet, later]) {
    assert.equal(snapshot.sessions.find((session) => session.id === adapter.session.id)!.state, "gone", "newly disconnected and newly arrived identities are not silently added");
  }
  assertWithin(ui);
});

test("Ping sessions refreshes rows and external pongs and disconnection update an already open console", async () => {
  const pingTimeoutMs = 25;
  env = await startEnv({ pingTimeoutMs });
  const human = env.human();
  const hung = await env.adapter("omp", "ping-status-key", "worker", { autoPong: false });
  await human.request("set_role", { name: "worker", role: "worker" });
  await human.request("set_inbound", { name: "worker", mode: "hold" });
  const ui = await startConsole(120, 24);
  const list = (): string[] => ui.rows().map((row) => truncateTerminalText(row, paneWidths(ui.size.columns)!.list));
  await ui.press("?");
  await ui.type("Ping sessions");
  const action = ui.press("ENTER");
  await hung.nextPing();
  env.clock.advance(pingTimeoutMs);
  env.daemon.sweep();
  await action;
  await ui.resize(80, 24);
  const failedRow = list().findIndex((row) => row.includes("not_responding"));
  assert.ok(failedRow >= 0 && list().some((row) => row.includes("worker") && row.includes("●")), "failed ping stays visible with the live identity at 80 columns");
  assert.ok(list().some((row) => row.includes("omp") && row.includes("wrk") && row.includes("⏸")), "ping metadata never displaces harness, role or inbound policy");
  await ui.click(5, failedRow);
  await ui.press("CTRL_X");
  assert.ok(ui.rows().some((row) => row.includes(hung.session.id)), "ping detail row targets its stable identity");
  await ui.press("n");
  assert.equal((await human.sync()).sessions.find((session) => session.id === hung.session.id)!.state, "live", "ping failure does not disconnect or close the session");
  assert.ok(!ui.rows().some((row) => row.includes("y confirm")), "Ping sessions never opens a destructive confirmation");

  const external = human.request("ping", { sessionId: hung.session.id });
  const probe = await hung.nextPing();
  await hung.client.request("pong", { pingId: probe.pingId });
  await external;
  await ui.until(() => list().some((row) => row.includes("worker") && row.includes("●")) && !list().some((row) => row.includes("not_responding")), "external response replaces cached failed status");

  const failedAgain = human.request("ping", { sessionId: hung.session.id });
  await hung.nextPing();
  env.clock.advance(pingTimeoutMs);
  env.daemon.sweep();
  await failedAgain;
  await ui.until(() => list().some((row) => row.includes("not_responding")), "external failed ping updates the connected console");
  const gone = await env.watch((event) => event.type === "session" && event.action === "gone" && event.session.id === hung.session.id);
  hung.client.close();
  await gone.event;
  await ui.until(() => list().some((row) => row.includes("worker") && row.includes("◌")) && !list().some((row) => row.includes("not_responding")), "disconnection clears cached ping");
  const revived = await env.adapter("omp", "ping-status-key", "worker");
  assert.equal(revived.session.id, hung.session.id);
  await ui.until(() => list().some((row) => row.includes("worker") && row.includes("●")) && !list().some((row) => row.includes("not_responding")), "revival does not inherit a failed ping");
  assertWithin(ui);
});

test("archive purge conversation cancels safely then removes cached direct content from every surface without deleting channel posts", async () => {
  env = await startEnv();
  const human = env.human();
  const retired = await env.adapter("omp", "retired-key", "retired");
  const live = await env.adapter("omp", "survivor-key", "survivor");
  await retired.client.request("send", { to: "human", text: "purged-private-marker" });
  await retired.client.request("channel_send", { channel: "updates", text: "retained-channel-marker" });
  await live.client.request("send", { to: "human", text: "retained-private-marker" });
  await human.request("close", { identity: retired.session.id });
  const ui = await startConsole(120, 30);
  await ui.press("i");
  await ui.press("v");
  await ui.press("#");
  await ui.press("a");
  await selectSession(ui, "retired");
  assert.ok(ui.rows().some((row) => row.includes("purged-private-marker")), "archived conversation is loaded");
  assert.ok(ui.rows().at(-1)!.includes("purge"), "archive surface advertises purge");
  await paletteAction(ui, "Purge conversation");
  assert.ok(ui.rows().some((row) => row.includes(retired.session.id)), "confirmation pins the selected archive");
  await ui.press("n");
  assert.ok((await human.sync()).sessions.some((s) => s.id === retired.session.id));
  assert.ok(ui.rows().some((row) => row.includes("purged-private-marker")), "cancel preserves the conversation");
  await paletteAction(ui, "Purge conversation");
  await ui.press("y");
  await ui.until(async () => !(await human.sync()).sessions.some((s) => s.id === retired.session.id)
    && !ui.rows().some((row) => row.includes("purged-private-marker")), "purge resets the open conversation");
  assert.ok(ui.rows()[0].includes("2 unread"), "purge clears only the archived identity's unread marker");
  await ui.press("ESCAPE");
  await ui.press("END");
  await ui.press("ENTER");
  assert.ok(!ui.rows().some((row) => row.includes("retired") || row.includes("purged-private-marker")), "archive no longer lists the purged identity");
  await ui.press("i");
  await ui.press("v");
  assert.ok(!ui.rows().some((row) => row.includes("purged-private-marker") || row.includes("retired")), "grouped inbox no longer leaks purged content");
  await ui.press("v");
  assert.ok(!ui.rows().some((row) => row.includes("purged-private-marker")), "cached chronological inbox is refreshed");
  assert.ok(ui.rows().some((row) => row.includes("retained-private-marker")), "unrelated direct content survives");
  await ui.press("a");
  assert.ok(!ui.rows().some((row) => row.includes("purged-private-marker")), "retained activity no longer leaks purged direct content");
  assert.ok(ui.rows().some((row) => row.includes("retained-channel-marker")), "channel activity remains");
  await ui.press("#");
  assert.ok(ui.rows().some((row) => row.includes("retained-channel-marker")), "purged author's channel post remains");
  assert.equal((await human.sync()).sessions.find((s) => s.id === live.session.id)!.state, "live");
  assertWithin(ui);
});

test("purge all archives cancels safely and never enlarges the confirmed archive snapshot", async () => {
  env = await startEnv();
  const human = env.human();
  const alpha = await env.adapter("omp", "purge-alpha", "alpha");
  const beta = await env.adapter("omp", "purge-beta", "beta");
  const later = await env.adapter("omp", "purge-later", "later");
  for (const adapter of [alpha, beta]) await human.request("close", { identity: adapter.session.id });
  const ui = await startConsole(120, 24);
  await ui.press("END");
  assert.ok(ui.rows().at(-1)!.includes("purge"), "collapsed archive offers purge actions");
  await paletteAction(ui, "Purge all archives");
  for (const adapter of [alpha, beta]) assert.ok(ui.rows().some((row) => row.includes(adapter.session.id)));
  assert.ok(!ui.rows().some((row) => row.includes(later.session.id)));
  await ui.press("n");
  let snapshot = await human.sync();
  for (const adapter of [alpha, beta]) assert.ok(snapshot.sessions.some((s) => s.id === adapter.session.id), "cancel preserves each archive");
  await paletteAction(ui, "Purge all archives");
  await human.request("close", { identity: later.session.id });
  await ui.press("y");
  await ui.until(async () => {
    snapshot = await human.sync();
    return [alpha, beta].every((adapter) => !snapshot.sessions.some((s) => s.id === adapter.session.id));
  }, "confirmed archives purged");
  assert.ok(snapshot.sessions.some((s) => s.id === later.session.id && s.state === "removed"), "archive created after preview is not deleted");
  await ui.press("ENTER");
  assert.ok(ui.rows().some((row) => truncateTerminalText(row, paneWidths(120)!.list).includes("later")), "unconfirmed archive remains visible");
  assert.ok(!ui.rows().some((row) => /\b(alpha|beta)\b/.test(row)), "confirmed archive rows disappear");
  assertWithin(ui);
});

test("retained sender notices show the original reply identity as a purged message in rendered details", async () => {
  env = await startEnv();
  const human = env.human();
  const sender = await env.adapter("omp", "notice-sender", "sender");
  const target = await env.adapter("omp", "notice-target", "target");
  await human.request("set_inbound", { name: "target", mode: "hold" });
  const held = await sender.client.request("send", { to: "target", text: "held-private-marker" });
  const original = (held.results as { msgId: string }[])[0].msgId;
  await human.request("close", { identity: target.session.id });
  const notice = (await sender.nextDelivery()).msg;
  assert.equal(notice.replyTo, original);
  const ui = await startConsole(120, 30);
  await selectSession(ui, "sender");
  await ui.press("ENTER");
  await ui.press("END");
  await ui.press("UP");
  await ui.press("ENTER");
  assert.ok(ui.rows().some((row) => row.includes(`reply to ${original}`)), "notice details retain the original message identity");
  await human.request("purge", { identity: target.session.id });
  await ui.until(() => !ui.rows().some((row) => row.includes("held-private-marker")), "purge refreshes cached sender conversation");
  await ui.press("END");
  await ui.press("DOWN");
  await ui.press("ENTER");
  await ui.until(() => ui.rows().some((row) => row.includes("(purged message)")), "missing reply reference has a visible label");
  assert.ok(ui.rows().some((row) => row.includes(`reply to ${original}`)), "purge does not discard the reference");
  assert.ok(ui.rows().some((row) => row.includes("not delivered")), "independent sender notice remains visible");
  assertWithin(ui);
});

test("Home and End reach list boundaries after a selected archive is hidden", async () => {
  env = await startEnv();
  const alpha = await env.adapter("omp", "boundary-alpha", "alpha");
  const beta = await env.adapter("omp", "boundary-beta", "beta");
  await alpha.client.request("send", { to: "human", text: "Archived boundary conversation" });
  await beta.client.request("send", { to: "human", text: "Live boundary conversation" });
  const ui = await startConsole(120, 28);
  const listWidth = paneWidths(120)!.list;
  const list = (): string[] => ui.rows().map((row) => truncateTerminalText(row, listWidth));
  await ui.press("/");
  await ui.type("alpha");
  await ui.press("ENTER");
  await alpha.client.request("unregister");
  await ui.until(() => list().some((row) => row.includes("alpha") && !row.includes("●") && !row.includes("◌") && !row.includes("/ alpha")), "selected identity archived");
  await ui.press("ESCAPE");
  await ui.press("END");
  await ui.press("ENTER");
  assert.ok(list().some((row) => row.includes("alpha") && !row.includes("/ alpha")), "End reaches the collapsed archive heading");

  await ui.press("DOWN");
  await ui.press("?");
  await ui.type("Toggle archive");
  await ui.press("ENTER");
  assert.ok(!list().some((row) => row.includes("alpha")), "selected archive is hidden again");
  await ui.press("HOME");
  await ui.press("ENTER");
  await ui.until(() => ui.rows().some((row) => row.includes("Live boundary conversation")), "Home opens the first live session");
  assertWithin(ui);
});

test("channel composer mention picker filters members and inserts a token without submitting", async () => {
  env = await startEnv();
  const human = env.human();
  await env.adapter("omp", "picker-alpha", "alpha");
  await env.adapter("omp", "picker-beta", "beta");
  await human.request("channel_create", { channel: "work" });
  for (const name of ["alpha", "beta"]) await human.request("channel_add", { channel: "work", name });
  const ui = await startConsole(80, 24);
  await ui.press("#");
  await ui.press("c");
  await ui.type("Need ");
  await ui.press("@");
  assert.ok(ui.rows().some((row) => row.includes("@all")), "picker offers the all keyword");
  await ui.type("alp");
  assert.ok(ui.rows().some((row) => row.includes("@alpha")), "member choice follows the typed prefix");
  assert.ok(!ui.rows().some((row) => row.includes("@beta")), "nonmatching member choices disappear");
  await ui.press("ENTER");
  assert.ok(ui.rows().some((row) => row.includes("Need @alpha")), "acceptance inserts into the existing draft");
  assert.deepEqual((await human.request("channel_read", { channel: "work" })).messages, [], "picker Enter never sends");
  assertWithin(ui);
});

test("mention arrows choose members and every keyword, and only the next Enter posts", async () => {
  env = await startEnv();
  const human = env.human();
  await env.adapter("omp", "mention-arrows-alpha", "alpha");
  await env.adapter("omp", "mention-arrows-beta", "beta");
  await human.request("channel_create", { channel: "work" });
  for (const name of ["alpha", "beta"]) await human.request("channel_add", { channel: "work", name });
  const ui = await startConsole(80, 24);
  await ui.press("#");
  await ui.press("c");
  await ui.type("@");
  await ui.press("DOWN"); // @all -> @alpha
  await ui.press("DOWN"); // @alpha -> @beta
  await ui.press("UP");
  await ui.press("ENTER");
  assert.ok(ui.rows().some((row) => row.includes("@alpha")));
  assert.deepEqual((await human.request("channel_read", { channel: "work" })).messages, []);
  await ui.press("ENTER");
  for (const keyword of ["all", "orch", "orchestrator", "orchestrators", "wrk", "worker", "workers"]) {
    await ui.type(`@${keyword}`);
    assert.ok(ui.rows().some((row) => row.includes(`@${keyword}`)));
    await ui.press("ENTER");
    const before = (await human.request("channel_read", { channel: "work" })).messages as StoredMessage[];
    assert.ok(!before.some((post) => post.text === `@${keyword}`), "selection cannot post");
    await ui.press("ENTER");
  }
  const posts = (await human.request("channel_read", { channel: "work" })).messages as StoredMessage[];
  assert.deepEqual(posts.map((post) => post.text), ["@alpha", "@all", "@orch", "@orchestrator", "@orchestrators", "@wrk", "@worker", "@workers"]);
  assertWithin(ui);
});

test("mention completion edits an existing token while preserving its suffix and cursor", async () => {
  env = await startEnv();
  const human = env.human();
  await env.adapter("omp", "mention-edit-alpha", "alpha");
  await human.request("channel_create", { channel: "work" });
  await human.request("channel_add", { channel: "work", name: "alpha" });
  const ui = await startConsole(80, 24);
  await ui.press("#");
  await ui.press("c");
  await ui.paste("Need @al tail");
  for (let index = 0; index < 5; index++) await ui.press("LEFT");
  await ui.press("p");
  assert.ok(ui.rows().some((row) => row.includes("@alpha")));
  await ui.press("ENTER");
  await ui.press("!");
  assert.ok(ui.rows().some((row) => row.includes("Need @alpha! tail")));
  await ui.press("ENTER");
  const posts = (await human.request("channel_read", { channel: "work" })).messages as StoredMessage[];
  assert.deepEqual(posts.map((post) => post.text), ["Need @alpha! tail"]);
});

test("mention dismissal keeps composer focus and normal delimiters and cursor controls", async () => {
  env = await startEnv();
  const human = env.human();
  await human.request("channel_create", { channel: "work" });
  const ui = await startConsole(80, 24);
  await ui.press("#");
  await ui.press("c");
  await ui.type("@all");
  await ui.press("ESCAPE");
  await ui.press("!");
  await ui.press("ENTER");
  await ui.paste("@all");
  await ui.press("LEFT");
  await ui.press("RIGHT");
  await ui.press("ENTER"); // cursor movement closed the picker
  await ui.paste("@all");
  await ui.press("CTRL_J");
  await ui.type("next");
  await ui.press("ENTER");
  await ui.type("@all");
  await ui.press("TAB"); // ordinary composer focus cycling, not completion
  await ui.press("c");
  await ui.press("ENTER");
  const posts = (await human.request("channel_read", { channel: "work" })).messages as StoredMessage[];
  assert.deepEqual(posts.map((post) => post.text), ["@all!", "@all", "@all\nnext", "@all"]);
});

test("mention picker stays channel scoped through quick jump, literal emails and burst input", async () => {
  env = await startEnv();
  const human = env.human();
  const alpha = await env.adapter("omp", "mention-burst-alpha", "alpha");
  await human.request("channel_create", { channel: "one" });
  await human.request("channel_create", { channel: "two" });
  await human.request("channel_add", { channel: "one", name: "alpha" });
  const ui = await startConsole(80, 24);
  await ui.press("#");
  await ui.press("c");
  await ui.burst(["@", "a", "l", "p", "ENTER"]);
  assert.deepEqual((await human.request("channel_read", { channel: "one" })).messages, []);
  assert.equal(alpha.deliveries.length, 0);
  await ui.press("CTRL_U");
  await ui.type("@");
  await ui.press("CTRL_K");
  await ui.type("#two");
  await ui.press("ENTER");
  await ui.press("c");
  await ui.burst([..."plain", "ENTER"]);
  assert.deepEqual(((await human.request("channel_read", { channel: "two" })).messages as StoredMessage[]).map((post) => post.text), ["plain"]);
  await ui.press("CTRL_K");
  await ui.type("#one");
  await ui.press("ENTER");
  await ui.press("c");
  await ui.press("CTRL_U");
  await ui.type("mail alpha@example.com");
  assert.ok(!ui.rows().some((row) => row.includes("@all")));
  await ui.press("ENTER");
  await ui.press("CTRL_K");
  await ui.type("alpha");
  await ui.press("ENTER");
  await ui.press("c");
  await ui.type("literal @all alpha@example.com");
  assert.ok(!ui.rows().some((row) => row.includes("@workers")));
  await ui.press("ENTER");
  await ui.until(() => alpha.deliveries.length === 1, "literal direct draft delivered");
  assert.equal(alpha.deliveries[0].msg.text, "literal @all alpha@example.com");
});

test("mention choices follow current channel identities and keep input visible at narrow and short sizes", async () => {
  env = await startEnv();
  const human = env.human();
  await env.adapter("omp", "mention-snapshot-alpha", "alpha");
  await env.adapter("omp", "mention-collision-worker", "worker");
  await human.request("channel_create", { channel: "work" });
  for (const name of ["alpha", "worker"]) await human.request("channel_add", { channel: "work", name });
  const ui = await startConsole(80, 24);
  await ui.press("#");
  await ui.press("c");
  await ui.type("@alp");
  await human.request("rename", { from: "alpha", name: "renamed" });
  await ui.until(() => ui.rows().some((row) => row.includes("@renamed")), "former-name filter inserts the current name");
  await ui.press("ENTER");
  await ui.press("CTRL_U");
  await ui.type("@worker");
  await ui.press("DOWN");
  await ui.press("DOWN"); // clamps at @workers: the colliding member is not a third choice
  await ui.press("ENTER");
  await ui.press("ENTER");
  await ui.press("CTRL_U");
  await ui.type("@");
  for (const [columns, rows] of [[79, 16], [80, 8], [20, 6], [10, 4], [2, 2], [1, 1]]) {
    await ui.resize(columns, rows);
    assertWithin(ui);
    const cursor = ui.frame().cursor;
    assert.ok(cursor && cursor.row >= 0 && cursor.row < rows && cursor.column >= 0 && cursor.column < columns, "cursor stays in the visible input");
  }
  await ui.resize(20, 6);
  await ui.type("alp");
  await ui.press("ENTER");
  await ui.press("ENTER");
  const posts = (await human.request("channel_read", { channel: "work" })).messages as StoredMessage[];
  assert.deepEqual(posts.map((post) => post.text), ["@workers", "@renamed"]);
});

test("pushed channel mention stays in the direct conversation and names its channel and poster", async () => {
  env = await startEnv();
  const human = env.human();
  await env.adapter("omp", "mention-header-alpha", "alpha");
  const beta = await env.adapter("omp", "mention-header-beta", "beta");
  await human.request("channel_create", { channel: "work" });
  for (const name of ["alpha", "beta"]) await human.request("channel_add", { channel: "work", name });
  await beta.client.request("channel_send", { channel: "work", text: "Review @alpha\nbody stays intact" });
  const ui = await startConsole(120, 24);
  await ui.press("CTRL_K");
  await ui.type("alpha");
  await ui.press("ENTER");
  assert.ok(ui.rows().some((row) => row.includes("beta") && row.includes("#work")), "direct header identifies the poster and source channel");
  assert.ok(ui.rows().some((row) => row.includes("Review @alpha")));
  assert.ok(ui.rows().some((row) => row.includes("body stays intact")));
  assertWithin(ui);
});

test("channel mention picker uses the pinned opening boundary for typing and paste", async () => {
  env = await startEnv();
  const human = env.human();
  await env.adapter("omp", "mention-boundary-alpha", "alpha");
  await human.request("channel_create", { channel: "work" });
  await human.request("channel_add", { channel: "work", name: "alpha" });
  const ui = await startConsole(80, 24);
  await ui.press("#");
  await ui.press("c");
  const expected: string[] = [];
  const composerRows = (): string[] => {
    const rows = ui.rows();
    const top = rows.findIndex((row) => row.includes("to #work"));
    assert.ok(top >= 0, "channel composer remains visible");
    return rows.slice(top + 1, -1);
  };
  for (const mode of ["typing", "paste"]) {
    const insert = async (text: string): Promise<void> => {
      if (mode === "typing") await ui.type(text);
      else await ui.paste(text);
    };
    for (const literal of ["foo@alpha", "foo+@alpha.example", "foo-@alpha.example", "foo.@alpha", "foo_@alpha", "foo,@alpha"]) {
      const split = literal.indexOf("@") + 3;
      await insert(`${mode}: ${literal.slice(0, split)}`);
      assert.ok(!composerRows().some((row) => row.includes("@alpha")), "a blocked opening cannot offer a completed member");
      await insert(literal.slice(split));
      await ui.press("ENTER"); // literal input sends, rather than accepting a picker
      expected.push(`${mode}: ${literal}`);
    }
    for (const opening of ["", " ", "\n", "(", "[", "{", "<", "\"", "'", "`"]) {
      await insert(`${opening}@alp`);
      assert.ok(composerRows().some((row) => row.includes("@alpha")), "allowed opening offers the member");
      await ui.press("ENTER");
      const closing = opening === "(" ? ")" : opening === "\"" || opening === "'" || opening === "`" ? opening : "";
      if (closing) await insert(closing);
      await ui.press("ENTER");
      expected.push(`${opening}@alpha${closing}`);
    }
  }
  const posts = (await human.request("channel_read", { channel: "work", limit: 100 })).messages as StoredMessage[];
  assert.deepEqual(posts.map((post) => post.text), expected);
  assertWithin(ui);
});

test("design A session sections expose state, harness, roles, policy and focused identity", async () => {
  env = await startEnv();
  const human = env.human();
  const alpha = await env.adapter("omp", "restyle-alpha", "alpha");
  const beta = await env.adapter("opencode", "restyle-beta", "beta");
  const retired = await env.adapter("claude", "restyle-retired", "retired");
  await human.request("set_role", { name: "alpha", role: "orchestrator" });
  await human.request("set_role", { name: "beta", role: "worker" });
  await retired.client.request("send", { to: "human", text: "retained archive" });
  await retired.client.request("unregister");
  await alpha.client.request("send", { to: "human", text: "unread live message" });
  await human.request("set_inbound", { name: "alpha", mode: "hold" });
  const gone = await env.watch((event) => event.type === "session" && event.action === "gone" && event.name === "beta");
  beta.client.close();
  await gone.event;
  const ui = await startConsole(120, 32);
  const listWidth = paneWidths(120)!.list;
  const list = ui.rows().map((row) => truncateTerminalText(row, listWidth));
  assert.ok(list.some((row) => row.includes("LIVE")));
  assert.ok(list.some((row) => row.includes("RECONNECTING")));
  assert.ok(list.some((row) => /▸ archive\s+1/.test(row)));
  const alphaRow = list.findIndex((row) => row.includes("alpha"));
  assert.ok(list[alphaRow].includes("▌") && list[alphaRow].includes("●") && list[alphaRow].includes("⏸"));
  assert.match(list[alphaRow], /omp.*orch/);
  assert.ok(list.some((row) => row.includes("◌") && row.includes("beta") && row.includes("oc") && row.includes("wrk")));
  const alphaSpans = normalizeTerminalLine(ui.frame().lines[alphaRow], ui.size.columns);
  assert.ok(alphaSpans.some((span) => span.text.includes("alpha") && span.style?.foreground === "brightCyan" && span.style.bold));
  assert.ok(alphaSpans.some((span) => span.text.includes("orch") && span.style?.inverse));
  assert.ok(list.some((row) => row.includes("/ filter sessions")));
  assert.equal(await unread(human, alpha.session.id), 1, "styling a selected list row never marks it read");
  await ui.press("ENTER");
  await ui.press("c");
  const composerList = ui.rows().map((row) => truncateTerminalText(row, listWidth));
  const composerAlpha = composerList.findIndex((row) => row.includes("alpha"));
  assert.ok(composerList[composerAlpha].includes("▌"), "selected identity stays marked while writing");
  assert.ok(normalizeTerminalLine(ui.frame().lines[composerAlpha], ui.size.columns).some((span) => span.text.includes("alpha") && span.style?.foreground === "brightCyan"));
  await ui.press("ESCAPE");
  await ui.press("u");
  await ui.resize(80, 20);
  const narrowList = ui.rows().map((row) => truncateTerminalText(row, paneWidths(80)!.list));
  assert.ok(narrowList.some((row) => row.includes("alpha")));
  assert.ok(narrowList.some((row) => row.includes("omp") && row.includes("orch") && row.includes("+1")));
  assertWithin(ui);
  await ui.press("CTRL_K");
  await ui.type("retired");
  await ui.press("ENTER");
  const archivedList = ui.rows().map((row) => truncateTerminalText(row, paneWidths(80)!.list));
  const archivedRow = archivedList.find((row) => row.includes("retired"))!;
  assert.ok(archivedRow.includes("cc") && !archivedRow.includes("●") && !archivedRow.includes("◌"), "archived row retains harness without a live-state dot");
  assertWithin(ui);
});

test("design A transcript separates status and kind, counts unread and compacts only agent exchanges", async () => {
  env = await startEnv();
  const human = env.human();
  const alpha = await env.adapter("omp", "restyle-chat-alpha", "alpha");
  const peer = await env.adapter("omp", "restyle-chat-beta", "beta");
  await human.sendToSession(alpha.session.id, "human-out-full");
  await alpha.client.request("send", { to: "human", text: "human-in-first" });
  await alpha.client.request("send", { to: "human", text: "human-in-full" });
  await alpha.client.request("send", { to: "beta", text: "compact-first", kind: "task" });
  await peer.client.request("send", { to: "alpha", text: "compact-second", kind: "result" });
  const ui = await startConsole(120, 32);
  await ui.press("/");
  await ui.type("alpha");
  await ui.press("ENTER");
  const rows = ui.rows();
  assert.ok(rows.some((row) => /you → alpha\s{2,}✓ delivered/.test(row)));
  assert.ok(rows.some((row) => row.includes("alpha → you")));
  const divider = rows.findIndex((row) => row.includes("2 new") && row.includes("┄"));
  assert.ok(divider >= 0);
  const firstBody = rows.findIndex((row) => row.includes("compact-first"));
  const secondHeader = rows.findIndex((row) => row.includes("beta → alpha"));
  assert.equal(secondHeader, firstBody + 1, "adjacent agent exchanges have no blank spacer");
  for (const text of ["compact-first", "compact-second"]) {
    const row = rows.findIndex((value) => value.includes(text));
    assert.ok(normalizeTerminalLine(ui.frame().lines[row], ui.size.columns).some((span) => span.text.includes(text) && span.style?.dim));
  }
  for (const text of ["human-out-full", "human-in-full"]) {
    const row = rows.findIndex((value) => value.includes(text));
    assert.ok(normalizeTerminalLine(ui.frame().lines[row], ui.size.columns).some((span) => span.text.includes(text) && !span.style?.dim));
  }
  const taskHeader = rows.findIndex((row) => row.includes("alpha → beta"));
  assert.ok(normalizeTerminalLine(ui.frame().lines[taskHeader], ui.size.columns).some((span) => span.text.includes("task") && span.style?.inverse && span.style.foreground === "yellow"));
  assert.equal(await unread(human, alpha.session.id), 2, "visible list preview and new-divider preserve unread");
  await ui.press("ENTER");
  assert.equal(await unread(human, alpha.session.id), 0);
  await ui.press("u");
  assert.equal(await unread(human, alpha.session.id), 1, "explicit unread reminder survives the restyle");
  assertWithin(ui);
});

test("compact agent bodies remain fully reachable and latest hint never reads the hidden human tail", async () => {
  env = await startEnv();
  const human = env.human();
  const alpha = await env.adapter("omp", "restyle-long-alpha", "alpha");
  const beta = await env.adapter("omp", "restyle-long-beta", "beta");
  const agentText = [...Array.from({ length: 18 }, (_, index) => `agent paragraph ${index} retains its complete wrapped words`), "last-agent-body-row"].join("\n");
  await beta.client.request("send", { to: "alpha", text: agentText, kind: "result" });
  await alpha.client.request("send", { to: "human", text: `${"human paragraph keeps scrolling\n".repeat(22)}last-human-body-row` });
  const ui = await startConsole(80, 10);
  await ui.press("CTRL_K");
  await ui.type("alpha");
  await ui.press("ENTER");
  await ui.until(() => ui.rows().some((row) => row.includes("last-human-body-row")), "human tail initially visible");
  await ui.press("u");
  await ui.press("HOME");
  assert.ok(ui.rows().some((row) => row.includes("End ↓ latest")));
  assert.ok(!ui.rows().some((row) => row.includes("last-human-body-row")));
  const seen = new Set<string>();
  const inset = paneWidths(80)!.list + 2;
  for (let step = 0; step < 100; step++) {
    const rows = ui.rows();
    for (const row of rows) {
      const text = row.slice(inset, -1).trim();
      if (text.startsWith("agent paragraph") || text.includes("last-agent-body-row")) seen.add(text);
    }
    assert.equal(await unread(human, alpha.session.id), 1, "agent rows and navigation hint never clear the hidden human reminder");
    if (rows.some((row) => row.includes("last-agent-body-row"))) break;
    await ui.press("PAGE_DOWN");
  }
  for (const row of wrapTerminalText(agentText, paneWidths(80)!.conversation - 4)) {
    assert.ok(seen.has(row.trim()), `agent body row remains reachable: ${row}`);
  }
  await ui.press("END");
  assert.ok(ui.rows().some((row) => row.includes("last-human-body-row")));
  assert.ok(!ui.rows().some((row) => row.includes("End ↓ latest")));
  assert.equal(await unread(human, alpha.session.id), 0, "only reaching the actual human tail clears its reminder");
  assertWithin(ui);
});

async function startReplace(ui: Console, source: string, destination: string): Promise<void> {
  await paletteAction(ui, "Replace session");
  await ui.type(source);
  await ui.press("ENTER");
  await ui.type(destination);
  await ui.press("ENTER");
}

test("replace picker offers non-closed sources and live-only destinations, and can replace an archive", async () => {
  env = await startEnv();
  const human = env.human();
  const source = await env.adapter("omp", "replace-source-key", "old-orch");
  await env.adapter("omp", "replace-dest-key", "new-live");
  await env.adapter("omp", "replace-peer-key", "peer");
  const gone = await env.adapter("omp", "replace-gone-key", "offline-one");
  const goneEvent = await env.watch((event) => event.type === "session" && event.action === "gone" && event.session.id === gone.session.id);
  gone.client.close();
  await goneEvent.event;
  const archived = await env.adapter("omp", "replace-archive-key", "old-archive");
  await archived.client.request("unregister");
  const closed = await env.adapter("omp", "replace-closed-key", "old-closed");
  await human.request("close", { identity: closed.session.id });

  const ui = await startConsole(120, 34);
  const picker = (): string => ui.rows().join("\n");
  await ui.press("?");
  assert.ok(ui.rows().some((row) => row.includes("Replace session")), "the action label remains Replace session");
  await ui.type("Replace session");
  await ui.press("ENTER");
  assert.ok(picker().includes("old-orch") && picker().includes("new-live"), "live sessions are offered as sources");
  assert.ok(picker().includes("old-archive"), "a non-closed archive can be the source");
  assert.ok(!picker().includes("old-closed"), "an explicitly closed identity is not offered");
  await ui.press("ESCAPE");

  await paletteAction(ui, "Replace session");
  await ui.type("old-orch");
  await ui.press("ENTER");
  assert.ok(picker().includes("new-live"), "a live destination is offered");
  assert.ok(!picker().includes("old-orch"), "the captured source is not a destination");
  assert.ok(!picker().includes("offline-one"), "a disconnected session is not a live destination");
  assert.ok(!picker().includes("old-archive") && !picker().includes("old-closed"), "archived and closed identities are not destinations");
  await ui.press("ESCAPE");

  await startReplace(ui, "old-orch", "new-live");
  assert.ok(ui.rows().some((row) => row.includes("Replace old-orch with new-live? old-orch will be closed.")), "the confirmation states exactly what happens");
  await ui.press("ENTER");
  await ui.paste("y");
  await ui.press(" ");
  assert.equal((await human.sync()).sessions.find((session) => session.id === source.session.id)!.closedAt, undefined, "Enter, paste and other keys cannot confirm");
  await ui.press("n");
  const snapshot = await human.sync();
  assert.equal(snapshot.sessions.find((session) => session.id === source.session.id)!.closedAt, undefined, "cancel leaves the source open");
  assert.notEqual(snapshot.sessions.find((session) => session.id === closed.session.id)!.closedAt, undefined, "cancel leaves the closed identity closed");
  assert.equal(snapshot.sessions.find((session) => session.id === archived.session.id)!.closedAt, undefined, "cancel leaves the archive unclosed");
  await startReplace(ui, "old-archive", "new-live");
  await ui.press("y");
  await ui.until(async () => (await human.sync()).sessions.find((session) => session.id === archived.session.id)!.closedAt !== undefined, "automatically removed source is replaced");
  assert.equal((await human.sync()).sessions.find((session) => session.id === source.session.id)!.closedAt, undefined, "the cancelled live source remains open");
  assertWithin(ui);
});

test("replace session moves role, channel membership and held messages onto the live target and archives the source", async () => {
  env = await startEnv();
  const human = env.human();
  const source = await env.adapter("omp", "move-source-key", "old-orch");
  const dest = await env.adapter("omp", "move-dest-key", "new-live");
  const peer = await env.adapter("omp", "move-peer-key", "peer");
  await human.request("set_role", { name: "old-orch", role: "orchestrator" });
  await human.request("channel_create", { channel: "work" });
  await human.request("channel_add", { channel: "work", name: "old-orch" });
  const [history] = ((await peer.client.request("send", { to: "old-orch", text: "src-history-marker" })).results as SendResult[]);
  assert.equal(history.status, "delivered");
  await human.request("set_inbound", { name: "old-orch", mode: "hold" });
  const [heldSend] = ((await peer.client.request("send", { to: "old-orch", text: "held-moved-marker" })).results as SendResult[]);
  assert.equal(heldSend.status, "held");

  const ui = await startConsole(120, 34);
  await startReplace(ui, "old-orch", "new-live");
  await ui.press("y");
  await ui.until(async () => (await human.sync()).sessions.find((session) => session.id === source.session.id)!.closedAt !== undefined, "source archived");
  const snapshot = await human.sync();
  assert.equal(snapshot.sessions.find((session) => session.id === dest.session.id)!.role, "orchestrator", "the source role moves to the destination");
  const members = (await human.request("channel_members", { channel: "work" })).members as SessionIdentity[];
  assert.deepEqual(members.map((member) => member.id), [dest.session.id], "channel membership moves and the closed source leaves the roster");
  const held = (await human.request("held")).messages as StoredMessage[];
  assert.deepEqual(held.map((message) => [message.id, message.toSessionId, message.status]), [[heldSend.msgId, dest.session.id, "held"]], "the held message moves to the destination identity");

  await selectSession(ui, "new-live");
  await ui.press("ENTER");
  assert.ok(ui.rows().some((row) => row.includes("held-moved-marker")), "the destination shows its moved held message");
  assert.ok(!ui.rows().some((row) => row.includes("src-history-marker")), "the destination conversation does not gain the source's delivered history");
  await ui.press("r");
  await ui.until(() => dest.deliveries.length === 1, "release delivers the moved message to the destination");
  assert.equal((await dest.nextDelivery()).msg.text, "held-moved-marker");
  assert.deepEqual((await human.request("held")).messages, [], "release removes the moved message from the held set");
  assertWithin(ui);
});

test("external replacement reconciles loaded source and destination conversations without losing their UI state", async () => {
  env = await startEnv();
  const human = env.human();
  const source = await env.adapter("omp", "external-replace-source-key", "cache-old-source");
  const dest = await env.adapter("omp", "external-replace-dest-key", "cache-new-dest");
  const peer = await env.adapter("omp", "external-replace-peer-key", "cache-peer");
  const sourceBody = [
    "source-anchor-first-row",
    ...Array.from({ length: 36 }, (_, index) => `source-history-row-${index + 1}`),
    "source-outbound-archive",
  ].join("\n");
  const [sourceHistory] = (await source.client.request("send", { to: "cache-peer", text: sourceBody })).results as SendResult[];
  await source.client.request("send", { to: "human", text: "source-read-history" });
  const [destinationOriginal] = (await dest.client.request("send", { to: "human", text: "destination-history" })).results as SendResult[];
  await human.request("set_inbound", { name: "cache-old-source", mode: "hold" });
  const [moved] = (await peer.client.request("send", { to: "cache-old-source", text: "moved-held-ownership" })).results as SendResult[];
  assert.equal(moved.status, "held");

  const ui = await startConsole(120, 32);
  await quickJump(ui, "cache-old-source", "source-outbound-archive");
  await ui.press("HOME");
  const firstRow = ui.rows().findIndex((row) => row.includes("source-anchor-first-row"));
  assert.ok(firstRow >= 0, "the source viewport can be positioned on its archived history");
  const conversationX = (paneWidths(ui.size.columns)?.list ?? 0) + 2;
  await ui.click(conversationX, firstRow);
  const sourceHistorySelected = (): boolean => {
    const row = ui.rows().findIndex((line) => line.includes("cache-old-source") && line.includes("cache-peer"));
    return row >= 0 && normalizeTerminalLine(ui.frame().lines[row], ui.size.columns).some((span) => span.style?.inverse);
  };
  assert.ok(sourceHistorySelected(), "the selected source history remains selected");
  await ui.press("c");
  await ui.type("source-only-draft");
  await ui.press("ESCAPE");
  await ui.until(async () => await unread(human, source.session.id) === 0, "source read marker reaches its history");

  await quickJump(ui, "cache-new-dest", "destination-history");
  await ui.until(async () => await unread(human, dest.session.id) === 0, "destination read marker reaches its history");
  await ui.press("c");
  await ui.type("destination-only-draft");
  await ui.press("ESCAPE");
  await source.client.request("send", { to: "human", text: "source-unread-history" });
  await ui.until(async () => await unread(human, source.session.id) === 1, "source receives a separate unread message");

  await human.request("replace", { fromId: source.session.id, toId: dest.session.id });
  await ui.until(() => ui.rows().some((row) => row.includes("moved-held-ownership")), "the loaded destination receives the moved message event");
  const destHistory = await human.historyPage({ scope: "session", sessionId: dest.session.id });
  assert.deepEqual(
    destHistory.messages.filter((message) => message.id === moved.msgId).map(({ id, toSessionId, text, status }) => ({ id, toSessionId, text, status })),
    [{ id: moved.msgId, toSessionId: dest.session.id, text: "moved-held-ownership", status: "held" }],
    "the destination history contains the original moved message",
  );
  const archived = await human.historyPage({ scope: "session", sessionId: source.session.id });
  assert.ok(archived.messages.some((message) => message.id === sourceHistory.msgId), "genuine outgoing source history stays archived");
  assert.ok(!archived.messages.some((message) => message.id === moved.msgId), "the moved incoming message leaves the old owner history");
  assert.ok(ui.rows().some((row) => row.includes("destination-only-draft")), "the destination draft remains in its own composer");
  assert.ok(!ui.rows().some((row) => row.includes("source-only-draft")), "the archived source draft is not adopted by the destination");
  assert.equal(await unread(human, source.session.id), 1, "replacement preserves the source read marker without reading it");
  assert.equal(await unread(human, dest.session.id), 0, "replacement leaves the destination read marker unchanged");

  const openArchivedSource = async (visible: string): Promise<void> => {
    await ui.press("CTRL_K");
    await ui.type("cache-old-source");
    await ui.press("DOWN");
    await ui.press("ENTER");
    await ui.until(() => ui.rows().some((row) => row.includes(visible)), "the cached source archive retains its previous viewport");
  };
  await openArchivedSource("source-anchor-first-row");
  assert.ok(sourceHistorySelected(), "replacement keeps the selected source message and cached viewport");
  await ui.press("END");
  await ui.until(() => ui.rows().some((row) => row.includes("source-unread-history")), "the archived source still has its own later history");
  assert.ok(!ui.rows().some((row) => row.includes("moved-held-ownership")), "replacement immediately removes the moved message from the old source view");

  const destinationAfterReplacement = await human.historyPage({ scope: "session", sessionId: dest.session.id });
  assert.ok(destinationAfterReplacement.messages.some((message) => message.id === destinationOriginal.msgId), "the destination keeps its own history");
  await quickJump(ui, "cache-new-dest", "destination-history");
  await ui.until(() => ui.rows().some((row) => row.includes("moved-held-ownership")), "the destination still displays the moved message");
  assert.ok(ui.rows().some((row) => row.includes("destination-only-draft")), "the destination draft survives switching cached conversations");

  const delivered = await env.watch((event) => event.type === "message" && event.msg.id === moved.msgId && event.status === "delivered");
  await ui.press("r");
  await delivered.event;
  const released = await human.historyPage({ scope: "session", sessionId: dest.session.id });
  assert.equal(released.messages.find((message) => message.id === moved.msgId)?.status, "delivered", "release updates the destination's original message");

  await openArchivedSource("source-unread-history");
  assert.ok(!ui.rows().some((row) => row.includes("moved-held-ownership")), "delivering at the destination does not resurrect the message in the source archive");
  assertWithin(ui);
});

test("external replacement refreshes archive order even when the old source conversation was not loaded", async () => {
  env = await startEnv();
  const human = env.human();
  const source = await env.adapter("omp", "order-source-key", "order-source");
  const target = await env.adapter("omp", "order-target-key", "order-target");
  const middle = await env.adapter("omp", "order-middle-key", "order-middle");
  const peer = await env.adapter("omp", "order-peer-key", "order-peer");
  await source.client.request("send", { to: "human", text: "source retained oldest" });
  await middle.client.request("send", { to: "human", text: "middle retained newer" });
  await middle.client.request("unregister");
  await target.client.request("send", { to: "human", text: "target retained latest" });
  await human.request("set_inbound", { name: "order-source", mode: "hold" });
  const ui = await startConsole(120, 32);
  await ui.until(() => ui.rows().some((row) => row.includes("target retained latest")), "the destination conversation is loaded");
  const sidebar = (): string[] => ui.rows().map((row) => truncateTerminalText(row, paneWidths(ui.size.columns)!.list));
  const indexOf = (name: string): number => sidebar().findIndex((row) => row.includes(name));
  await peer.client.request("send", { to: "order-source", text: "moved newest inbound" });
  await ui.until(() => indexOf("order-source") >= 0 && indexOf("order-source") < indexOf("order-target"), "the source's incoming message advances its cached order");
  await paletteAction(ui, "Toggle archive");
  await ui.until(() => indexOf("order-middle") >= 0, "the existing archive is visible");

  await human.request("replace", { fromId: source.session.id, toId: target.session.id });
  await ui.until(() => {
    const archive = sidebar().findIndex((row) => /\barchive\b/i.test(row));
    return archive >= 0 && indexOf("order-source") > archive && indexOf("order-middle") > archive;
  }, "the source has joined the archived conversations");
  const snapshot = await human.sync();
  assert.ok(snapshot.sessionLastOrders[middle.session.id] > snapshot.sessionLastOrders[source.session.id], "the source's remaining history is older than the other archive");
  assert.ok(indexOf("order-middle") < indexOf("order-source"), "an already-open console uses authoritative archive order after ownership moves");
  assertWithin(ui);
});


test("replace session binds captured identities across destination rename and source name reuse", async () => {
  env = await startEnv();
  const human = env.human();
  const source = await env.adapter("omp", "bind-source-key", "bind-src");
  const dest = await env.adapter("omp", "bind-dest-key", "bind-dst");
  const ui = await startConsole(120, 32);

  await paletteAction(ui, "Replace session");
  await ui.type("bind-src");
  await ui.press("ENTER");
  await ui.type("bind-dst");
  await human.request("rename", { from: "bind-dst", name: "bind-dst-renamed" });
  await ui.until(() => ui.rows().some((row) => row.includes("bind-dst-renamed")), "the rename refreshes the highlighted destination");
  await source.client.request("unregister");
  await ui.until(async () => (await human.sync()).sessions.find((session) => session.id === source.session.id)!.state === "removed", "the captured source leaves the live list");
  const reused = await env.adapter("omp", "bind-reuse-key", "bind-src");
  assert.notEqual(reused.session.id, source.session.id, "a fresh identity reuses the removed name");

  await ui.press("ENTER");
  assert.ok(ui.rows().some((row) => row.includes("Replace bind-src with bind-dst-renamed? bind-src will be closed.")), "the confirmation keeps the captured identities and current names");
  await ui.press("y");
  await ui.until(async () => (await human.sync()).sessions.find((session) => session.id === source.session.id)!.closedAt !== undefined, "the captured source is closed");
  const snapshot = await human.sync();
  assert.equal(snapshot.sessions.find((session) => session.id === dest.session.id)!.state, "live", "the renamed destination stays live");
  assert.equal(snapshot.sessions.find((session) => session.id === dest.session.id)!.name, "bind-dst-renamed");
  assert.equal(snapshot.sessions.find((session) => session.id === reused.session.id)!.state, "live", "the identity reusing the source's name is untouched");
  assert.equal(snapshot.sessions.find((session) => session.id === reused.session.id)!.closedAt, undefined);
  assertWithin(ui);
});

test("replace session refuses when the captured destination stops being live", async () => {
  env = await startEnv();
  const human = env.human();
  const source = await env.adapter("omp", "stale-source-key", "stale-src");
  const dest = await env.adapter("omp", "stale-dest-key", "stale-dst");
  const ui = await startConsole(120, 32);
  await startReplace(ui, "stale-src", "stale-dst");
  await human.request("close", { identity: dest.session.id });
  await ui.press("y");
  const snapshot = await human.sync();
  assert.equal(snapshot.sessions.find((session) => session.id === source.session.id)!.closedAt, undefined, "no replacement happens for a stale destination");
  assert.equal(snapshot.sessions.find((session) => session.id === dest.session.id)!.state, "removed");
  assertWithin(ui);
});

test("replace destination picker does not silently choose another identity when its selection goes offline", async () => {
  env = await startEnv();
  const human = env.human();
  const source = await env.adapter("omp", "picker-source-key", "picker-source");
  const offline = await env.adapter("omp", "picker-offline-key", "picker-offline");
  await env.adapter("omp", "picker-live-key", "picker-live");
  const ui = await startConsole(120, 32);
  const destinationRows = () => ui.rows().filter((row) => row.includes("picker-live") || row.includes("picker-offline"));
  const selectedDestination = (): string | undefined => {
    const rows = ui.rows();
    const selectedIndex = rows.findIndex((row, index) =>
      (row.includes("picker-live") || row.includes("picker-offline"))
      && normalizeTerminalLine(ui.frame().lines[index], ui.size.columns).some((span) => span.style?.inverse));
    const row = rows[selectedIndex];
    return row?.includes("picker-live") ? "picker-live" : row?.includes("picker-offline") ? "picker-offline" : undefined;
  };

  await paletteAction(ui, "Replace session");
  await ui.type("picker-source");
  await ui.press("ENTER");
  await ui.type("picker");
  await ui.press("DOWN");
  assert.equal(selectedDestination(), "picker-offline", "the rendered selection identifies the offline destination");
  const removed = await env.watch((event) => event.type === "session" && event.action === "removed" && event.session.id === offline.session.id);
  await offline.client.request("unregister");
  await removed.event;
  await ui.until(() => destinationRows().length === 1 && destinationRows()[0].includes("picker-live"), "the other live destination remains available");
  assert.equal(selectedDestination(), undefined, "the removed selection does not move to the other result");

  await ui.press("ENTER");
  assert.equal(selectedDestination(), undefined, "Enter does not redirect the removed selection");
  assert.ok(!ui.rows().some((row) => row.includes("Replace picker-source with picker-live? picker-source will be closed.")), "Enter does not open confirmation for the other identity");
  assert.equal(destinationRows().length, 1, "the remaining result stays available");
  assert.ok(destinationRows()[0].includes("picker-live"));
  assert.equal((await human.sync()).sessions.find((session) => session.id === source.session.id)!.closedAt, undefined, "the source remains open");

  assertWithin(ui);
});

test("replace session reports skipped names without claiming they forward", async () => {
  env = await startEnv();
  const human = env.human();
  const third = await env.adapter("omp", "skip-third-key", "foo");
  await third.client.request("unregister");
  const source = await env.adapter("omp", "skip-source-key", "foo");
  await human.request("rename", { from: "foo", name: "src-main" });
  const revived = await env.adapter("omp", "skip-third-key", "ignored");
  assert.deepEqual([revived.session.name, revived.session.id], ["foo-2", third.session.id], "the third identity revives behind the source's former name");
  const dest = await env.adapter("omp", "skip-dest-key", "skip-dest");

  const ui = await startConsole(80, 32);
  const listWidth = paneWidths(80)!.list;
  await startReplace(ui, "src-main", "skip-dest");
  await ui.press("y");
  await ui.until(() => ui.rows().some((row) =>
    /^foo$/.test(row.slice(truncateTerminalText(row, listWidth).length + 2, -1).trim())), "the complete skipped address is visible in the result panel");
  const snapshot = await human.sync();
  assert.equal(snapshot.sessions.find((session) => session.id === source.session.id)!.closedAt !== undefined, true, "the source still closes on partial success");
  assert.deepEqual(snapshot.sessions.find((session) => session.id === dest.session.id)!.previousNames, ["src-main"], "the destination inherits only unreserved names");
  assert.ok(snapshot.sessions.find((session) => session.id === third.session.id)!.previousNames.includes("foo"), "the third identity keeps the reserved name");
  const [routed] = ((await human.request("send", { to: "foo", text: "reserved-address-delivery" })).results as SendResult[]);
  assert.equal(routed.status, "delivered");
  const received = await revived.nextDelivery();
  assert.equal(received.session, third.session.id, "the reserved address still routes to the original identity");
  assert.equal(received.msg.text, "reserved-address-delivery");
  assert.equal(dest.deliveries.length, 0, "the skipped address does not forward to the replacement destination");
  assertWithin(ui);
});

test("replace session keeps the destination's history, drafts and read marker separate from the archived source", async () => {
  env = await startEnv();
  const human = env.human();
  const source = await env.adapter("omp", "iso-source-key", "iso-src");
  const dest = await env.adapter("omp", "iso-dest-key", "iso-dst");
  await source.client.request("send", { to: "human", text: "src-history-marker" });
  await dest.client.request("send", { to: "human", text: "dst-history-marker" });

  const ui = await startConsole(120, 32);
  await quickJump(ui, "iso-src", "src-history-marker");
  await ui.press("c");
  await ui.type("source-draft");
  await ui.press("ESCAPE");
  await quickJump(ui, "iso-dst", "dst-history-marker");
  await ui.press("c");
  await ui.type("dest-draft");
  await ui.press("ESCAPE");
  await source.client.request("send", { to: "human", text: "src-unread-marker" });
  assert.equal((await human.readState({ scope: "session", sessionId: source.session.id })).unread, 1, "the source holds one unread marker");

  await startReplace(ui, "iso-src", "iso-dst");
  await ui.press("y");
  await ui.until(async () => (await human.sync()).sessions.find((session) => session.id === source.session.id)!.closedAt !== undefined, "source archived");
  assert.equal((await human.readState({ scope: "session", sessionId: source.session.id })).unread, 1, "the archived source keeps its own read marker");

  await ui.press("ESCAPE");
  await quickJump(ui, "iso-dst", "dst-history-marker");
  assert.ok(!ui.rows().some((row) => row.includes("src-history-marker")), "the destination conversation does not gain the source's history");
  assert.ok(ui.rows().some((row) => row.includes("dest-draft")), "the destination keeps its own draft");
  assert.ok(!ui.rows().some((row) => row.includes("source-draft")), "the source draft is not adopted by the destination");
  assert.equal((await human.readState({ scope: "session", sessionId: source.session.id })).unread, 1, "opening the destination does not clear the source's marker");
  assertWithin(ui);
});

// ---------------------------------------------------------------- Map tab

/** Injected Map-tab timer: `tick` plays what the 100ms interval would, and the counters expose its lifecycle. */
function mapTimer() {
  const state = { running: 0, started: 0, cancelled: 0, fn: undefined as (() => void) | undefined };
  return {
    state,
    schedule(fn: () => void): () => void {
      state.running++;
      state.started++;
      state.fn = fn;
      return () => {
        state.running--;
        state.cancelled++;
      };
    },
    /** Runs the last scheduled callback `count` times, even after it was cancelled (a stale timer must be inert). */
    tick(count = 1): void {
      for (let i = 0; i < count; i++) state.fn?.();
    },
  };
}

/** Yields event-loop turns (no wall-clock wait) until `predicate` holds, for conditions that only need pending promises to run. */
async function turns(predicate: () => boolean, what: string): Promise<void> {
  for (let turn = 0; turn < 1000; turn++) {
    if (predicate()) return;
    await nextTurn();
  }
  assert.fail(`never reached: ${what}`);
}

type MapFleet = { boss: Adapter; alpha: Adapter };

/** claude orchestrator `boss-queen` leading omp worker `wrk-alpha`. */
async function mapFleet(e: TestEnv): Promise<MapFleet> {
  const human = e.human();
  const boss = await e.adapter("claude", "map-boss", "boss-queen", { cwd: "/work/boss" });
  const alpha = await e.adapter("omp", "map-alpha", "wrk-alpha", { cwd: "/work/alpha" });
  await human.request("set_role", { name: "boss-queen", role: "orchestrator" });
  await human.request("set_role", { name: "wrk-alpha", role: "worker" });
  await human.request("channel_create", { channel: "ops" });
  for (const name of ["boss-queen", "wrk-alpha"]) await human.request("channel_add", { channel: "ops", name });
  return { boss, alpha };
}

const hasRow = (ui: Console, text: string): boolean => ui.rows().some((row) => row.includes(text));
const noDaemon = (options: ClientOpts): AsenqClient => new AsenqClient({ ...options, autoStart: false });
/** The row under the TARGET header: names the selected bug, or a hint when none is selected. */
const mapTarget = (ui: Console): string => {
  const rows = ui.rows();
  const header = rows.findIndex((row) => row.includes("TARGET"));
  return header < 0 ? "" : rows[header + 1] ?? "";
};

async function openMap(columns = 160, rows = 48, deps: Pick<ConsoleDeps, "scan" | "now" | "schedule"> = {}): Promise<Console> {
  const ui = await startConsole(columns, rows, undefined, { scan: async () => [], ...deps });
  await ui.press("m");
  return ui;
}

test("the tab bar has a Map tab and m opens the bug-map with its panels and the console footer hints", async () => {
  env = await startEnv();
  await mapFleet(env);
  const timer = mapTimer();
  const ui = await startConsole(160, 48, undefined, { scan: async () => [], schedule: timer.schedule });
  assert.ok(ui.rows()[0].includes("Map"), ui.rows()[0]);
  await ui.press("m");
  await ui.until(() => hasRow(ui, "boss-queen") && hasRow(ui, "wrk-alpha"), "sessions drawn on the map");
  assert.ok(hasRow(ui, "TARGET") && hasRow(ui, "NETWATCH"), ui.rows().join("\n"));
  assert.ok(!hasRow(ui, "SIGNAL LOST"));
  assert.ok(ui.rows()[0].includes("Map"), "the console tab bar stays above the scene");
  assert.equal(ui.rows().length, ui.size.rows, "the scene fills the body and the console footer");
  const footer = ui.rows().at(-1)!;
  assert.ok(footer.includes("select") && footer.includes("rescan"), `console footer carries the map hints: ${footer}`);
  assert.ok(!ui.rows().slice(0, -1).some((row) => row.includes("rescan")), "the scene's own key-hint row is dropped");
  assertWithin(ui);
});

test("Left/Right switch tabs from the tab bar into and out of the Map tab", async () => {
  env = await startEnv();
  await mapFleet(env);
  const ui = await openMap();
  await ui.until(() => hasRow(ui, "NETWATCH"), "map shown");
  await ui.press("s");
  assert.ok(!hasRow(ui, "NETWATCH"));
  await ui.press("SHIFT_TAB"); // list → tab bar
  for (let i = 0; i < 4; i++) await ui.press("RIGHT");
  await ui.until(() => hasRow(ui, "NETWATCH"), "four Right presses reach the Map tab");
  await ui.press("RIGHT");
  await ui.until(() => !hasRow(ui, "NETWATCH"), "Right from the Map tab wraps to Sessions");
  await ui.press("LEFT");
  await ui.until(() => hasRow(ui, "NETWATCH"), "Left from Sessions wraps back to Map");
});

test("clicking the Map tab opens it and Esc returns to Sessions", async () => {
  env = await startEnv();
  await mapFleet(env);
  const ui = await startConsole(160, 48, undefined, { scan: async () => [] });
  await ui.click(ui.rows()[0].indexOf("Map") + 1, 0);
  await ui.until(() => hasRow(ui, "NETWATCH") && hasRow(ui, "wrk-alpha"), "map opened by mouse");
  await ui.press("ESCAPE");
  assert.ok(!hasRow(ui, "NETWATCH"), "Esc keeps its console meaning: back to Sessions");
});

test("Tab selects bugs on the map instead of moving console focus, and f filters by harness", async () => {
  env = await startEnv();
  await mapFleet(env);
  const ui = await openMap();
  await ui.until(() => hasRow(ui, "wrk-alpha"), "initial world");
  const names = ["boss-queen", "wrk-alpha"];
  const selected = (): string[] => names.filter((n) => mapTarget(ui).includes(n));
  assert.deepEqual(selected(), [], "nothing is selected initially");
  await ui.press("TAB");
  assert.equal(selected().length, 1, `Tab selects one bug: ${mapTarget(ui)}`);
  const first = mapTarget(ui);
  await ui.press("TAB");
  assert.notEqual(mapTarget(ui), first, "a second Tab selects another bug");
  await ui.press("SHIFT_TAB");
  assert.equal(mapTarget(ui), first, "Shift-Tab goes back");
  assert.ok(ui.rows().at(-1)!.includes("select"), "console focus did not move to another region");
  await ui.press("f"); // claude: the orchestrator remains, the omp worker is hidden
  // the selected orchestrator's TARGET panel still lists its drone, so look for the worker's own plate only
  assert.ok(hasRow(ui, "boss-queen") && !ui.rows().some((row) => row.includes("wrk-alpha") && !row.includes("DRONES")), ui.rows().join("\n"));
  await ui.press("f"); // omp: the worker and the orchestrator leading it
  assert.ok(hasRow(ui, "wrk-alpha") && hasRow(ui, "boss-queen"));
  assert.ok(hasRow(ui, "NETWATCH"), "f never reached the console's activity filter");
});

test("a mouse press on a bug selects it, offset by the tab bar row", async () => {
  env = await startEnv();
  await mapFleet(env);
  const ui = await openMap();
  await ui.until(() => hasRow(ui, "wrk-alpha"), "initial world");
  const row = ui.rows().findIndex((r) => r.includes("wrk-alpha"));
  assert.ok(row > 0, "the bug is drawn below the tab bar");
  await ui.click(ui.rows()[row].indexOf("wrk-alpha") + 2, row);
  assert.ok(mapTarget(ui).includes("wrk-alpha"), `TARGET shows the clicked bug: ${mapTarget(ui)}`);
  assert.ok(!mapTarget(ui).includes("boss-queen"));
});

test("messages produce NETWATCH feed rows, including ones sent before the tab was opened", async () => {
  env = await startEnv();
  const { boss, alpha } = await mapFleet(env);
  const ui = await startConsole(160, 48, undefined, { scan: async () => [] });
  await boss.client.request("send", { to: "wrk-alpha", text: "ship ledger", kind: "task" });
  await alpha.nextDelivery();
  await ui.until(() => ui.app.idle().then(() => true), "console processed the message event");
  await ui.press("m");
  await ui.until(() => hasRow(ui, "ship ledger"), "feed row present on opening");
  await boss.client.request("channel_send", { channel: "ops", text: "standup in five" });
  await ui.until(() => hasRow(ui, "standup in five"), "live feed row");
  assert.equal(ui.rows().join("\n").split("ship ledger").length - 1, 1, "status updates do not duplicate the row");
});

test("the animation timer and list polling run only while the Map tab is shown", async () => {
  env = await startEnv();
  await mapFleet(env);
  const timer = mapTimer();
  let lists = 0;
  let scans = 0;
  const counting = (options: ClientOpts): AsenqClient => {
    const client = new AsenqClient(options);
    const request = client.request.bind(client);
    client.request = async (op, params) => {
      if (op === "list") lists++;
      return request(op, params);
    };
    return client;
  };
  const ui = await startConsole(160, 48, counting, { scan: async () => (scans++, []), schedule: timer.schedule });
  await ui.press("a");
  timer.tick(60);
  assert.deepEqual([lists, scans, timer.state.started], [0, 0, 0], "no timer, list or scan on other tabs");
  await ui.press("m");
  await ui.until(() => hasRow(ui, "wrk-alpha"), "map loaded");
  assert.deepEqual([timer.state.running, lists, scans], [1, 1, 1], "entering fetches once and starts one timer");
  timer.tick(19);
  await ui.app.idle();
  assert.equal(lists, 1, "no relist before 2s");
  timer.tick(1);
  await ui.until(() => lists === 2, "relist at 2s");
  timer.tick(30);
  await ui.until(() => scans === 2, "rescan at 5s");
  await ui.press("s");
  assert.deepEqual([timer.state.running, timer.state.cancelled], [0, 1], "leaving cancels the timer");
  const [before, scanned] = [lists, scans];
  timer.tick(100); // a stale tick must be inert
  await ui.app.idle();
  assert.deepEqual([lists, scans], [before, scanned], "nothing polls while another tab is shown");
  await ui.press("m");
  assert.equal(timer.state.running, 1, "re-entering starts a fresh timer");
  ui.close();
  assert.equal(timer.state.running, 0, "quitting cancels the timer");
});

test("the Map tab marks nothing read and opens no composer or conversation", async () => {
  env = await startEnv();
  const { alpha } = await mapFleet(env);
  await alpha.client.request("send", { to: "human", text: "please read me" });
  const human = env.human();
  const ui = await startConsole(160, 48, undefined, { scan: async () => [] });
  await ui.press("m");
  await ui.until(() => hasRow(ui, "wrk-alpha"), "map loaded");
  for (const key of ["TAB", "ENTER", "TAB", "ENTER", "r", "DOWN", "RIGHT", "u"]) await ui.press(key);
  assert.equal((await human.readState({ scope: "session", sessionId: alpha.session.id })).unread, 1, "unread marker untouched");
  assert.ok(!hasRow(ui, "Enter send") && !hasRow(ui, "please read me"), ui.rows().join("\n"));
  await alpha.client.request("send", { to: "human", text: "second note" });
  await ui.until(() => ui.app.idle().then(() => true), "event applied");
  assert.equal((await human.readState({ scope: "session", sessionId: alpha.session.id })).unread, 2, "new arrivals stay unread");
});

test("the palette lists Map under Navigate with its shortcut and opens it", async () => {
  env = await startEnv();
  await mapFleet(env);
  const ui = await startConsole(160, 48, undefined, { scan: async () => [] });
  await ui.press("?");
  const row = ui.rows().find((r) => /\bMap\b/.test(r) && r.includes("m"));
  assert.ok(row, ui.rows().join("\n"));
  await ui.type("Map");
  await ui.press("ENTER");
  await ui.until(() => hasRow(ui, "NETWATCH"), "palette action opened the map");
  await ui.press("?");
  assert.ok(hasRow(ui, "type to filter"), "console keys still work on the Map tab");
  assert.ok(!hasRow(ui, "NETWATCH"), "overlays replace the map");
  await ui.press("f");
  assert.ok(ui.rows().some((row) => row.startsWith("? f")), "keys go to the palette filter while it is open");
  await ui.press("ESCAPE");
  assert.ok(hasRow(ui, "NETWATCH"), "closing the palette returns to the map");
});

test("an unreachable daemon shows SIGNAL LOST on the map and it recovers when the daemon returns", async () => {
  env = await startEnv();
  await mapFleet(env);
  const timer = mapTimer();
  const ui = await startConsole(160, 48, noDaemon, { scan: async () => [], schedule: timer.schedule });
  await ui.press("m");
  await ui.until(() => hasRow(ui, "wrk-alpha"), "map loaded");
  await env.daemon.close();
  timer.tick(20);
  await ui.until(() => hasRow(ui, "SIGNAL LOST"), "SIGNAL LOST after the daemon goes away");
  assert.ok(hasRow(ui, "netrunner"), "the netrunner survives a lost signal");
  await env.restart();
  await ui.until(async () => {
    timer.tick(20);
    await ui.app.idle();
    return hasRow(ui, "LINK ESTABLISHED") && !hasRow(ui, "SIGNAL LOST");
  }, "recovery on a later poll");
});

test("the Map tab survives tiny terminals without throwing", async () => {
  env = await startEnv();
  await mapFleet(env);
  const ui = await openMap();
  await ui.until(() => hasRow(ui, "wrk-alpha"), "map loaded");
  for (const [columns, rows] of [[1, 1], [5, 3], [10, 4], [30, 8], [59, 19], [60, 22], [80, 5]]) {
    await ui.resize(columns, rows);
    assertWithin(ui);
    await ui.press("TAB");
    await ui.click(0, Math.min(rows - 1, 2));
  }
  await ui.resize(160, 48);
  await ui.until(() => hasRow(ui, "NETWATCH"), "recovers at full size");
});

test("only traffic seen while the Map is on screen spawns packets; earlier traffic fills the feed without replaying", async () => {
  env = await startEnv();
  const { boss, alpha } = await mapFleet(env);
  const ui = await startConsole(160, 48, undefined, { scan: async () => [] });
  // Packets are a few animated glyphs on a link, which a text frame cannot tell apart from the link art reliably,
  // so the in-flight count (and the console's received events) are read from the controller instead.
  const inner = ui.app as unknown as { map: { packetCount: number }; activity: PositionedEvent[] };
  const received = (text: string): boolean => inner.activity.some((item) => item.event.type === "message" && item.event.msg.text === text);
  await boss.client.request("send", { to: "wrk-alpha", text: "unseen traffic", kind: "task" });
  await alpha.nextDelivery();
  await ui.until(() => received("unseen traffic"), "console applied the hidden-tab message");
  await ui.press("m");
  await ui.until(() => hasRow(ui, "unseen traffic") && hasRow(ui, "wrk-alpha"), "feed row and sessions on opening");
  assert.equal(inner.map.packetCount, 0, "no packet for a message that arrived while another tab was shown");
  await boss.client.request("send", { to: "wrk-alpha", text: "live traffic", kind: "task" });
  await ui.until(() => hasRow(ui, "live traffic"), "live feed row");
  assert.equal(inner.map.packetCount, 1, "a message seen while the map is shown spawns one packet");
  await ui.press("s");
  assert.equal(inner.map.packetCount, 0, "leaving the tab drops in-flight packets");
  await ui.press("m");
  assert.equal(inner.map.packetCount, 0, "re-entering does not replay old packets");
  assert.ok(hasRow(ui, "live traffic") && hasRow(ui, "unseen traffic"), "the feed keeps both lines");
});

test("an overlay over the Map stops its timer and polling, and closing it resumes with an immediate refresh", async () => {
  env = await startEnv();
  await mapFleet(env);
  const timer = mapTimer();
  let lists = 0;
  let scans = 0;
  const counting = (options: ClientOpts): AsenqClient => {
    const client = new AsenqClient(options);
    const request = client.request.bind(client);
    client.request = async (op, params) => {
      if (op === "list") lists++;
      return request(op, params);
    };
    return client;
  };
  const ui = await startConsole(160, 48, counting, { scan: async () => (scans++, []), schedule: timer.schedule });
  await ui.press("m");
  await ui.until(() => hasRow(ui, "wrk-alpha"), "map loaded");
  for (const [open, close] of [["?", "ESCAPE"], ["CTRL_K", "ESCAPE"], ["CTRL_E", "ESCAPE"]]) {
    const [list, scan, cancelled] = [lists, scans, timer.state.cancelled];
    await ui.press(open);
    assert.ok(!hasRow(ui, "NETWATCH"), `${open} covers the map`);
    assert.deepEqual([timer.state.running, timer.state.cancelled], [0, cancelled + 1], `${open} stops the animation timer`);
    timer.tick(100); // a stale tick (and a 2s/5s poll worth of them) must stay inert under the overlay
    await ui.app.idle();
    assert.deepEqual([lists, scans], [list, scan], `no polling under ${open}`);
    await ui.press(close);
    await ui.until(() => hasRow(ui, "NETWATCH") && lists === list + 1 && scans === scan + 1, `${open} closed: map resumes with a refresh`);
    assert.equal(timer.state.running, 1, "one timer again");
  }
});

test("a process scan requested during a scan runs right after it instead of being dropped", async () => {
  env = await startEnv();
  await mapFleet(env);
  const timer = mapTimer();
  const pending: PromiseWithResolvers<ProcInfo[]>[] = [];
  let scans = 0;
  const scan = (): Promise<ProcInfo[]> => {
    scans++;
    if (scans === 1) return Promise.resolve([]);
    pending.push(Promise.withResolvers<ProcInfo[]>());
    return pending.at(-1)!.promise;
  };
  const ui = await startConsole(160, 48, undefined, { scan, schedule: timer.schedule });
  await ui.press("m");
  await ui.until(() => hasRow(ui, "wrk-alpha") && scans === 1, "initial scan done");
  timer.tick(50); // the 5s poll starts scan #2, which stays in flight
  assert.equal(scans, 2);
  void ui.press("r"); // asks for a rescan while #2 is still running
  assert.equal(scans, 2, "the request waits for the running scan");
  pending[0].resolve([{ pid: 4242, harness: "codex", command: "codex", elapsedSec: 1, cpu: 0 }]);
  await turns(() => scans === 3, "the requested scan to follow immediately");
  pending[1].resolve([]);
  await ui.app.idle();
  assert.equal(scans, 3, "and nothing more is queued");
  assert.ok(!hasRow(ui, "codex-4242"), "the newest result wins");
});

test("a list that fails after leaving the Map is discarded rather than painting SIGNAL LOST on re-entry", async () => {
  env = await startEnv();
  await mapFleet(env);
  const timer = mapTimer();
  const gate: { hold?: PromiseWithResolvers<void>; lists: number } = { lists: 0 };
  const gated = (options: ClientOpts): AsenqClient => {
    const client = new AsenqClient(options);
    const request = client.request.bind(client);
    client.request = async (op, params) => {
      if (op === "list") {
        gate.lists++;
        if (gate.hold) await gate.hold.promise;
      }
      return request(op, params);
    };
    return client;
  };
  const ui = await startConsole(160, 48, gated, { scan: async () => [], schedule: timer.schedule });
  await ui.press("m");
  await ui.until(() => hasRow(ui, "wrk-alpha") && hasRow(ui, "LINK ESTABLISHED"), "map loaded");
  const first = Promise.withResolvers<void>();
  first.promise.catch(() => {});
  gate.hold = first;
  const before = gate.lists;
  timer.tick(20); // the 2s poll's list is now in flight
  assert.equal(gate.lists, before + 1);
  void ui.press("s"); // leave while it is pending
  first.reject(new Error("daemon went away"));
  await ui.app.idle(); // the failed list settles and must be discarded
  const second = Promise.withResolvers<void>();
  gate.hold = second;
  void ui.press("m"); // re-enter; its own list is held, so only the retained state can be on screen
  assert.ok(hasRow(ui, "wrk-alpha") && !hasRow(ui, "SIGNAL LOST"), `stale failure discarded:\n${ui.rows().join("\n")}`);
  second.resolve();
  await ui.app.idle();
  assert.ok(hasRow(ui, "LINK ESTABLISHED"));
});

test("a reconnect while the Map shows SIGNAL LOST refreshes it without waiting for the next poll", async () => {
  env = await startEnv();
  await mapFleet(env);
  const timer = mapTimer();
  let reconnect: (() => void) | undefined;
  let outage = false;
  const manual = (options: ClientOpts): AsenqClient => {
    const client = new AsenqClient({ ...options, autoStart: false, schedule: (fn) => { reconnect = fn; } });
    const request = client.request.bind(client);
    client.request = async (op, params) => {
      if (op === "list" && outage) throw new Error("daemon unreachable");
      return request(op, params);
    };
    return client;
  };
  const ui = await startConsole(160, 48, manual, { scan: async () => [], schedule: timer.schedule });
  await ui.press("m");
  await ui.until(() => hasRow(ui, "wrk-alpha"), "map loaded");
  outage = true;
  timer.tick(20);
  await ui.until(() => hasRow(ui, "SIGNAL LOST"), "SIGNAL LOST during the outage");
  await env.restart();
  await ui.until(() => reconnect !== undefined, "console client noticed the lost connection");
  outage = false;
  reconnect!(); // no timer tick: only hydrate-on-reconnect can refresh the map
  await ui.until(() => !hasRow(ui, "SIGNAL LOST") && hasRow(ui, "LINK ESTABLISHED"), "map refreshed by the reconnect");
});

test("the Map frames at exactly the body height: 60x20 is too small, 60x21 shows the scene", async () => {
  env = await startEnv();
  await mapFleet(env);
  const ui = await openMap(60, 20);
  await ui.until(() => hasRow(ui, "TOO SMALL"), "notice at 60x20");
  assert.ok(hasRow(ui, "need 60x19") && hasRow(ui, "have 60x18"), `the notice names the map region:\n${ui.rows().join("\n")}`);
  assertWithin(ui);
  await ui.resize(60, 21);
  await ui.until(() => hasRow(ui, "NETWATCH") && hasRow(ui, "wrk-alpha") && hasRow(ui, "boss-queen"), "scene at 60x21");
  assert.equal(ui.rows().length, 21, "tab bar + 19-row scene + footer");
  assert.ok(!hasRow(ui, "TOO SMALL"));
  assertWithin(ui);
});

test("clicking bugs selects them at small map heights, below the tab bar", async () => {
  env = await startEnv();
  await mapFleet(env);
  const ui = await openMap(100, 40);
  await ui.until(() => hasRow(ui, "wrk-alpha"), "map loaded");
  for (const [columns, rows] of [[60, 21], [80, 24], [100, 30]]) {
    await ui.resize(columns, rows);
    for (const name of ["boss-queen", "wrk-alpha", "boss-queen"]) {
      const row = ui.rows().findIndex((r) => r.includes(name)); // the plate sits above the HUD, which repeats the name
      assert.ok(row > 0, `${name} drawn at ${columns}x${rows}`);
      await ui.click(ui.rows()[row].indexOf(name) + 1, row);
      assert.ok(mapTarget(ui).includes(name), `TARGET names ${name} at ${columns}x${rows}: ${mapTarget(ui)}`);
    }
  }
});

test("the console footer carries the Map's filter, focus and feral flags", async () => {
  env = await startEnv();
  await mapFleet(env);
  const ui = await openMap();
  await ui.until(() => hasRow(ui, "wrk-alpha"), "map loaded");
  const footer = (): string => ui.rows().at(-1)!;
  assert.ok(!/FILTER|FOCUS|FERAL OFF/.test(footer()), footer());
  await ui.press("f");
  assert.ok(footer().includes("FILTER:claude") && footer().includes("rescan"), footer());
  await ui.press("u");
  assert.ok(footer().includes("FERAL OFF"), footer());
  await ui.press("TAB");
  await ui.press("ENTER");
  assert.ok(footer().includes("FOCUS"), footer());
  await ui.press("c");
  await ui.press("ENTER");
  await ui.press("ESCAPE");
  assert.ok(footer().includes("Message text is empty") && footer().includes("FOCUS") && footer().includes("FERAL OFF"), `flags survive an error notice: ${footer()}`);
  await ui.press("s");
  assert.ok(!/FILTER|FOCUS|FERAL OFF/.test(footer()), "other tabs show no map flags");
});
