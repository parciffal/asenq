import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { AsenqClient } from "../src/shared/client.js";
import { ConsoleApp } from "../src/tui/app.js";
import { paneWidths } from "../src/tui/layout.js";
import {
  changedTerminalRows, normalizeTerminalLine, terminalTextWidth, truncateTerminalText, wrapTerminalText,
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
  press(name: string): Promise<void>;
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
    async press(name) {
      const text = [...name].length === 1 ? name : undefined;
      handlers.onKey?.({ name, matches: [name], ...(text ? { text } : {}), ctrl: name.startsWith("CTRL_"), alt: false, shift: name.startsWith("SHIFT_") });
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
  await ui.until(() => ui.rows()[0]?.includes("connected") ?? false, "connection");
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
  rows = ui.rows();
  assertWithin(ui);
  for (const row of rows.slice(1, -1)) {
    const left = truncateTerminalText(row, listWidth);
    assert.equal(terminalTextWidth(left), listWidth, `list pane is padded: ${row}`);
    assert.equal(row.slice(left.length)[0], "│", `separator stays in its column: ${row}`);
  }
  const conversation = rows.slice(1, -1).map((row) => row.slice(truncateTerminalText(row, listWidth).length + 1)).join("");
  assert.ok(conversation.replace(/\s+/g, "").includes(long.replace(/\s+/g, "")), "the whole message body is visible");

  await ui.press("/");
  await ui.type("legacy");
  await ui.until(() => ui.rows().some((row) => row.includes("retired") && row.includes("was l")), "former-name search");
  await ui.press("ESCAPE");
  assert.equal(ui.rows().findIndex((row) => row.includes("retired")), -1, "clearing search collapses the archive again");
});

test("narrow console reaches every wrapped row and marks read only when the last incoming row is shown", async () => {
  env = await startEnv();
  const human = env.human();
  const alpha = await env.adapter("omp", "alpha-key", "alpha");
  const paragraphs = Array.from({ length: 12 }, (_, index) => `paragraph ${index + 1} carries enough words to wrap twice here`);
  const text = [...paragraphs, "", "final-row-marker"].join("\n");
  await alpha.client.request("send", { to: "human", text });

  const ui = await startConsole(40, 12);
  await ui.until(() => ui.rows().some((row) => row.includes("alpha")), "picker");
  await ui.press("ENTER");
  assert.equal(await unread(human, alpha.session.id), 1, "opening a conversation does not mark it read");
  await ui.press("HOME");
  const seen = new Set<string>();
  for (let step = 0; step < 80; step++) {
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
  await ui.press("ENTER");
  await ui.type("there");
  const pending = alpha.deliveries.length;
  await ui.press("CTRL_D");
  await ui.until(() => alpha.deliveries.length > pending, "delivery");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(alpha.deliveries.length, pending + 1, "sent exactly once");
  assert.equal(alpha.deliveries.at(-1)!.msg.text, "hello\nthere");
  assert.ok(!ui.rows().some((row) => row.startsWith("› hello") || row.includes("› there")), "draft cleared after send");
});
