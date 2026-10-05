import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import type { AsenqClient } from "../src/shared/client.js";
import { ConsoleApp } from "../src/tui/app.js";
import { paneWidths } from "../src/tui/layout.js";
import {
  changedTerminalRows, normalizeTerminalLine, terminalTextWidth, translateKeyboardInput, truncateTerminalText, wrapTerminalText,
  type TerminalAdapterOptions, type TerminalFrame, type TerminalLine, type TerminalSize,
} from "../src/tui/terminal.js";
import { startEnv, type TestEnv } from "./helpers.js";

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
  click(column: number, row?: number): Promise<void>;
  paste(text: string): Promise<void>;
  close(): void;
  type(text: string): Promise<void>;
  until(predicate: () => boolean | Promise<boolean>, what: string): Promise<void>;
};

const lineText = (line: TerminalLine | undefined): string =>
  line === undefined ? "" : typeof line === "string" ? line : line.map((span) => span.text).join("");

/** Runs the real ui against the test daemon with a recording screen instead of a TTY. */
async function startConsole(columns: number, rows: number): Promise<Console> {
  let handlers: TerminalAdapterOptions = {};
  let frame: TerminalFrame = { lines: [] };
  const size = { columns, rows };
  const app = new ConsoleApp({
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
    async click(column, row = 0) {
      handlers.onMouse?.({ name: "MOUSE_LEFT_BUTTON_PRESSED", column, row, action: "press", button: "left", ctrl: false, alt: false, shift: false });
      await app.idle();
    },
    async paste(text) {
      handlers.onPaste?.(text);
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
  assert.ok(index("alpha") < index("Archive"), "live before archive");
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

test("session list shows short harness labels without losing state or unread badges", async () => {
  env = await startEnv();
  const cc = await env.adapter("claude", "cc-key", "reviewer");
  await env.adapter("opencode", "oc-key", "planner");
  await env.adapter("omp", "omp-key", "writer");
  await cc.client.request("send", { to: "human", text: "review is ready" });
  const ui = await startConsole(120, 20);
  const listWidth = paneWidths(120)!.list;
  await ui.until(() => ui.rows().some((row) => row.includes("writer")), "all sessions");
  const list = ui.rows().map((row) => truncateTerminalText(row, listWidth));
  assert.match(list.find((row) => row.includes("reviewer"))!, /\bcc\b.*\+1.*live/);
  assert.match(list.find((row) => row.includes("planner"))!, /\boc\b.*live/);
  assert.match(list.find((row) => row.includes("writer"))!, /\bomp\b.*live/);
  assertWithin(ui);
});

test("session roles yield to archived names, unread counts and state at 80 columns", async () => {
  env = await startEnv();
  const human = env.human();
  const alpha = await env.adapter("omp", "role-alpha", "alpha");
  const bravo = await env.adapter("claude", "role-bravo", "bravo");
  await env.adapter("opencode", "role-charlie", "charlie");
  await human.request("set_role", { name: "alpha", role: "orchestrator" });
  await human.request("set_role", { name: "bravo", role: "worker" });
  for (const session of [alpha, bravo]) {
    await session.client.request("send", { to: "human", text: "unread role conversation" });
  }
  const ui = await startConsole(80, 20);
  const listWidth = paneWidths(80)!.list;
  const list = (): string[] => ui.rows().map((row) => truncateTerminalText(row, listWidth));
  const alphaRow = list().find((row) => row.includes("al"))!;
  const bravoRow = list().find((row) => row.includes("br"))!;
  assert.match(alphaRow, /\borch\b.*\+1.*live/);
  assert.match(bravoRow, /\bwrk\b.*\+1.*live/);
  const unsetRow = list().find((row) => row.includes("charlie"))!;
  assert.match(unsetRow, /live/);
  assert.doesNotMatch(unsetRow, /\b(?:orch|wrk|unset)\b/);
  assertWithin(ui);

  await alpha.client.request("unregister");
  await bravo.client.request("unregister");
  await ui.until(() => list().some((row) => row.includes("Archive")), "archived sessions");
  await ui.press("END");
  await ui.press("ENTER");
  await ui.until(() => list().filter((row) => row.includes("archived")).length === 2, "expanded archive");
  for (const prefix of ["al", "br"]) {
    const rows = list();
    const index = rows.findIndex((row) => row.includes(prefix) && row.includes("archived"));
    assert.ok(index >= 0, `${prefix} retains a distinct visible name prefix`);
    assert.match(rows[index], /\+1.*archived/);
    assert.doesNotMatch(rows[index], /\b(?:orch|wrk)\b/, "role yields to archived identity and unread state");
  }
  assertWithin(ui);
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
  const sessionRow = (): string => ui.rows().map((row) => truncateTerminalText(row, listWidth)).find((row) => row.includes("alpha") && row.includes("live")) ?? "";

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
  const archived = ui.rows().map((row) => truncateTerminalText(row, listWidth)).filter((row) => row.includes("archived"));
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
  assert.match(ui.rows()[0], /1 live · 0 reconnecting · 0 held · 0 unread/);
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

  const control = ui.rows().find((row) => row.includes(" · control"));
  const ordinary = ui.rows().find((row) => row.includes(" · status"));
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
  const bar = () => ui.rows().find((row) => row.includes("⏸") && row.includes("held"));
  assert.ok(bar(), "held messages for the open target expose the bar");
  assert.ok(bar()!.includes("orch → worker") && bar()!.includes("oldest-review-preview"), "the oldest message is shown with its sender and target");
  assert.match(bar()!, /held.*2/, "multiple held messages show a count");
  assert.ok(!bar()!.includes("other-target-preview"), "another target's held messages are not mixed in");
  assert.match(ui.rows()[0], /3 held/, "header counts held messages across targets");
  await ui.press("r");
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
  assert.equal((await target.nextDelivery()).msg.text, "rx", "both characters stay in the sent draft");
  assert.equal(((await human.request("held")).messages as unknown[]).length, 1, "human draft delivery bypasses hold without releasing agent messages");
  assertWithin(ui);
});
