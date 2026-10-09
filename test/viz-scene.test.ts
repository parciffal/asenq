import assert from "node:assert/strict";
import { test } from "node:test";
import { terminalTextWidth } from "../src/tui/terminal.js";
import type { TerminalLine, TerminalSize } from "../src/tui/terminal.js";
import { navigate, renderScene, visibleBugs } from "../src/viz/scene.js";
import { ORCH_ART, ORCH_W, WORKER_ART, WORKER_W } from "../src/viz/sprites.js";
import type { Bug, BugState, Edge, FeedLine, Hit, Packet, VizHarness, VizUi, World } from "../src/viz/types.js";

const lineText = (line: TerminalLine | undefined): string =>
  line === undefined ? "" : typeof line === "string" ? line : line.map((span) => span.text).join("");

const bug = (id: string, name: string, kind: Bug["kind"], harness: VizHarness | null, state: BugState = "idle"): Bug => ({
  id, name, kind, harness, state, cwd: "/work/project", channels: [], previousNames: [], lastSeen: null,
});
const human = (): Bug => bug("human", "netrunner", "human", null);
const link = (from: string, to: string): Edge => ({ from, to, via: from === "human" ? "human" : "channel" });
const world = (bugs: Bug[], edges: Edge[], feed: FeedLine[] = []): World => ({ bugs, edges, feed, connection: "connected" });
const ui = (patch: Partial<VizUi> = {}): VizUi => ({ selectedId: null, filter: null, focus: false, feral: true, ...patch });
const SIZES: TerminalSize[] = [{ columns: 80, rows: 24 }, { columns: 120, rows: 40 }, { columns: 200, rows: 50 }];

/** One orchestrator with three workers under the human. */
function small(): World {
  const bugs = [
    human(), bug("o1", "alpha-lead", "orchestrator", "omp", "working"),
    bug("w1", "scout-one", "worker", "omp", "working"), bug("w2", "scout-two", "worker", "claude"), bug("w3", "scout-three", "worker", "opencode", "lost"),
  ];
  return world(bugs, [link("human", "o1"), link("o1", "w1"), link("o1", "w2"), link("o1", "w3")]);
}

/** Two orchestrators, six workers and one feral bug. */
function big(): World {
  const bugs = [
    human(), bug("o1", "queen-claude", "orchestrator", "claude", "working"), bug("o2", "queen-omp", "orchestrator", "omp"),
    bug("a1", "alpha-1", "worker", "omp", "working"), bug("a2", "alpha-2", "worker", "claude"), bug("a3", "alpha-3", "worker", "codex", "dead"),
    bug("b1", "bravo-1", "worker", "opencode"), bug("b2", "bravo-2", "worker", "omp", "lost"), bug("b3", "bravo-3", "worker", "claude", "working"),
    { ...bug("proc:99", "claude-99", "feral", "claude", "working"), pid: 99 },
  ];
  const edges = [link("human", "o1"), link("human", "o2"), ...["a1", "a2", "a3"].map((w) => link("o1", w)), ...["b1", "b2", "b3"].map((w) => link("o2", w))];
  return world(bugs, edges);
}

const frameRows = (w: World, view: VizUi, size: TerminalSize, tick = 0, packets: Packet[] = []): string[] =>
  renderScene(w, packets, view, tick, size, 1_000_000).frame.lines.map(lineText);

const region = (rows: string[], hit: Hit): string =>
  rows.slice(hit.row, hit.row + hit.height).map((row) => [...row].slice(hit.column, hit.column + hit.width).join("")).join("\n");

test("every visible bug name appears at every common terminal size", () => {
  for (const w of [small(), big()]) {
    for (const size of SIZES) {
      const text = frameRows(w, ui(), size).join("\n");
      for (const b of w.bugs) assert.ok(text.includes(b.name), `${b.name} missing at ${size.columns}x${size.rows}`);
    }
  }
});

test("frames fill the terminal exactly", () => {
  for (const w of [small(), big(), world([], [])]) {
    for (const size of [...SIZES, { columns: 60, rows: 20 }, { columns: 97, rows: 31 }]) {
      const lines = renderScene(w, [], ui(), 7, size, 5).frame.lines;
      assert.equal(lines.length, size.rows);
      for (const line of lines) assert.ok(terminalTextWidth(lineText(line)) <= size.columns, `row wider than ${size.columns}`);
    }
  }
});

test("a terminal below 60x20 gets a too-small notice", () => {
  const { frame, hits } = renderScene(small(), [], ui(), 0, { columns: 50, rows: 15 }, 0);
  assert.equal(frame.lines.length, 15);
  assert.ok(frame.lines.map(lineText).some((row) => row.includes("TERMINAL TOO SMALL // need 60x20")));
  assert.deepEqual(hits, []);
  assert.equal(navigate(small(), ui(), { columns: 50, rows: 15 }, "next"), null);
});

test("too many bugs for the smallest level show a +N more marker", () => {
  const bugs = [human()];
  const edges: Edge[] = [];
  for (let o = 0; o < 6; o++) {
    bugs.push(bug(`o${o}`, `orch-${o}`, "orchestrator", "omp"));
    edges.push(link("human", `o${o}`));
    for (let k = 0; k < 8; k++) {
      bugs.push(bug(`w${o}-${k}`, `worker-${o}-${k}`, "worker", "claude"));
      edges.push(link(`o${o}`, `w${o}-${k}`));
    }
  }
  const size = { columns: 60, rows: 20 };
  const result = renderScene(world(bugs, edges), [], ui(), 0, size, 0);
  const rows = result.frame.lines.map(lineText);
  assert.equal(rows.length, size.rows);
  assert.ok(rows.some((row) => /\+\d+ more/.test(row)), "marker shown");
  assert.ok(result.hits.length > 1 && result.hits.length < bugs.length, "some bugs shown, not all");
  for (const hit of result.hits) assert.ok(region(rows, hit).includes(bugs.find((b) => b.id === hit.id)!.name.slice(0, 3)));
});

test("harness filter hides other harnesses but keeps the human and needed orchestrators", () => {
  const bugs = [
    human(), bug("oa", "lead-a", "orchestrator", "claude"), bug("ob", "lead-b", "orchestrator", "opencode"),
    bug("wo", "omp-worker", "worker", "omp"), bug("wc", "claude-worker", "worker", "claude"), bug("wx", "opencode-worker", "worker", "opencode"),
  ];
  const w = world(bugs, [link("human", "oa"), link("human", "ob"), link("oa", "wo"), link("oa", "wc"), link("ob", "wx")]);
  const omp = frameRows(w, ui({ filter: "omp" }), SIZES[1]).join("\n");
  assert.ok(omp.includes("omp-worker") && omp.includes("lead-a") && omp.includes("netrunner"));
  for (const hidden of ["claude-worker", "lead-b", "opencode-worker"]) assert.ok(!omp.includes(hidden), `${hidden} should be hidden`);
  assert.deepEqual(visibleBugs(w, ui({ filter: "omp" })).map((b) => b.id), ["human", "oa", "wo"]);
  // An orchestrator that matches stays even if only some workers do; unrelated trees go.
  assert.deepEqual(visibleBugs(w, ui({ filter: "claude" })).map((b) => b.id), ["human", "oa", "wc"]);
  assert.deepEqual(visibleBugs(w, ui({ filter: "opencode" })).map((b) => b.id), ["human", "ob", "wx"]);
});

test("the feral toggle shows or hides process-detected bugs", () => {
  const w = big();
  const on = frameRows(w, ui({ feral: true }), SIZES[1]).join("\n");
  assert.ok(on.includes("claude-99") && on.includes("WILDLINE // UNLINKED"));
  const off = frameRows(w, ui({ feral: false }), SIZES[1]).join("\n");
  assert.ok(!off.includes("claude-99") && !off.includes("WILDLINE"));
  assert.ok(!visibleBugs(w, ui({ feral: false })).some((b) => b.kind === "feral"));
});

test("every visible bug has an in-frame hit rect containing its name", () => {
  for (const w of [small(), big()]) {
    for (const size of SIZES) {
      const { frame, hits } = renderScene(w, [], ui(), 3, size, 0);
      const rows = frame.lines.map(lineText);
      assert.deepEqual(hits.map((h) => h.id).sort(), w.bugs.map((b) => b.id).sort());
      for (const hit of hits) {
        assert.ok(hit.column >= 0 && hit.row >= 0 && hit.width > 0 && hit.height > 0);
        assert.ok(hit.column + hit.width <= size.columns && hit.row + hit.height <= size.rows);
        assert.ok(region(rows, hit).includes(w.bugs.find((b) => b.id === hit.id)!.name), `name inside hit of ${hit.id} at ${size.columns}x${size.rows}`);
      }
    }
  }
});

test("rendering is deterministic per tick and animates working bugs", () => {
  const w = small();
  const size = SIZES[1];
  const a = frameRows(w, ui(), size, 4);
  assert.deepEqual(frameRows(w, ui(), size, 4), a);
  assert.deepEqual(JSON.stringify(renderScene(w, [], ui(), 4, size, 9).frame), JSON.stringify(renderScene(w, [], ui(), 4, size, 9).frame));
  const hit = renderScene(w, [], ui(), 4, size, 0).hits.find((h) => h.id === "w1")!;
  assert.notEqual(region(frameRows(w, ui(), size, 4), hit), region(frameRows(w, ui(), size, 5), hit), "working bug moves between ticks");
  assert.notDeepEqual(frameRows(w, ui(), size, 4), frameRows(w, ui(), size, 5));
});

test("a packet in flight changes the frame and is drawn on the link", () => {
  const w = small();
  const size = SIZES[1];
  const packet: Packet = { seq: 1, fromId: "human", toId: "o1", kind: "task", ageMs: 400 };
  const plain = frameRows(w, ui(), size, 2);
  const flying = frameRows(w, ui(), size, 2, [packet]);
  assert.notDeepEqual(flying, plain);
  assert.ok(flying.join("\n").includes("◆") && !plain.join("\n").includes("◆"));
  // Child to parent runs the same link backwards, so the head sits elsewhere.
  const back = frameRows(w, ui(), size, 2, [{ ...packet, fromId: "o1", toId: "human" }]);
  assert.notDeepEqual(back, flying);
});

test("a packet between bugs without a direct edge routes through their hubs", () => {
  const w = big();
  const size = SIZES[2];
  const plain = frameRows(w, ui(), size, 2);
  for (const age of [100, 700, 1300]) {
    const flying = frameRows(w, ui(), size, 2, [{ seq: 1, fromId: "a1", toId: "b1", kind: "result", ageMs: age }]);
    assert.ok(flying.join("\n").includes("◆"), `head visible at ${age}ms`);
    assert.notDeepEqual(flying, plain);
  }
  // No route at all (a feral bug has no links): the packet is dropped, not crashed on.
  assert.doesNotThrow(() => frameRows(w, ui(), size, 2, [{ seq: 2, fromId: "proc:99", toId: "a1", kind: "chat", ageMs: 300 }]));
});

test("selection draws a bracket frame and the target panel", () => {
  const w = small();
  const none = frameRows(w, ui(), SIZES[1]).join("\n");
  assert.ok(none.includes("select a bug"));
  assert.ok(!none.includes("┏"));
  const selected = frameRows(w, ui({ selectedId: "w3" }), SIZES[1]);
  const text = selected.join("\n");
  assert.ok(text.includes("┏") && text.includes("┛"));
  assert.ok(text.includes("TARGET") && text.includes("LOST") && text.includes("/work/project"));
  assert.ok(text.includes("UPLINK alpha-lead"), "uplink named in the target panel");
  const focused = renderScene(w, [], ui({ selectedId: "w3", focus: true }), 0, SIZES[1], 0).frame;
  assert.notEqual(JSON.stringify(focused), JSON.stringify(renderScene(w, [], ui({ selectedId: "w3" }), 0, SIZES[1], 0).frame));
});

test("a role-less session is labelled UNASSIGNED and counted apart from workers", () => {
  const stray: Bug = { ...bug("u1", "stray-one", "worker", "omp"), unassigned: true };
  const w = world(
    [human(), bug("o1", "alpha-lead", "orchestrator", "claude"), stray, bug("w1", "real-worker", "worker", "omp")],
    [link("human", "o1"), link("o1", "u1"), link("o1", "w1")],
  );
  const rows = frameRows(w, ui({ selectedId: "u1" }), SIZES[1]);
  assert.ok(rows.join("\n").includes("UNASSIGNED"), "target panel says UNASSIGNED");
  assert.ok(!rows.join("\n").includes("  WORKER"), "never called a worker");
  assert.match(rows[0], /WORK 1 · UNSET 1/);
});

test("the netwatch panel lists the newest feed lines", () => {
  const feed: FeedLine[] = Array.from({ length: 12 }, (_, i) => ({
    seq: i + 1, at: 1_000_000 + i * 1000, fromId: "human", toId: "o1", from: "netrunner", to: "alpha-lead", kind: "task", text: `job number ${i}`,
  }));
  const text = frameRows(world(small().bugs, small().edges, feed), ui(), SIZES[1]).join("\n");
  assert.ok(text.includes("job number 11") && text.includes("[TASK]"));
  assert.ok(!text.includes("job number 0 "), "oldest lines scroll off");
});

test("the offline link shows SIGNAL LOST", () => {
  const w = { ...small(), connection: "offline" as const };
  assert.ok(frameRows(w, ui(), SIZES[1])[0].includes("SIGNAL LOST"));
  assert.ok(frameRows(small(), ui(), SIZES[1])[0].includes("LINK ESTABLISHED"));
});

test("navigate moves between layout neighbours", () => {
  const w = small();
  const size = SIZES[1];
  const from = (id: string | null, dir: Parameters<typeof navigate>[3]): string | null => navigate(w, ui({ selectedId: id }), size, dir);
  assert.equal(from("w1", "right"), "w2");
  assert.equal(from("w2", "right"), "w3");
  assert.equal(from("w3", "left"), "w2");
  assert.equal(from("w2", "up"), "o1");
  assert.equal(from("o1", "up"), "human");
  assert.equal(from("human", "down"), "o1");
  assert.equal(from("o1", "down"), "w2");
  // Tab order: human, orchestrator, then workers left to right, wrapping.
  assert.equal(from("human", "next"), "o1");
  assert.equal(from("o1", "next"), "w1");
  assert.equal(from("w3", "next"), "human");
  assert.equal(from("o1", "prev"), "human");
  assert.equal(from("human", "prev"), "w3");
  // Nothing further in that direction keeps the selection.
  assert.equal(from("w3", "right"), "w3");
});

test("navigate crosses between orchestrator trees", () => {
  const w = big();
  const size = SIZES[2];
  const from = (id: string, dir: Parameters<typeof navigate>[3]): string | null => navigate(w, ui({ selectedId: id }), size, dir);
  assert.equal(from("o1", "right"), "o2");
  assert.equal(from("o2", "left"), "o1");
  assert.equal(from("a3", "right"), "b1");
  assert.equal(from("b1", "left"), "a3");
  assert.equal(from("b2", "up"), "o2");
  assert.ok(["a1", "a2", "a3"].includes(from("o1", "down")!));
  assert.equal(from("a2", "down"), "proc:99");
});

test("navigate with no selection picks the first bug, not the human", () => {
  assert.equal(navigate(small(), ui(), SIZES[1], "right"), "o1");
  assert.equal(navigate(small(), ui({ selectedId: "ghost" }), SIZES[1], "next"), "o1");
  assert.equal(navigate(world([human()], []), ui(), SIZES[1], "down"), "human");
  assert.equal(navigate(world([], []), ui(), SIZES[1], "next"), null);
});

test("navigation only visits bugs that survive the filter", () => {
  const w = big();
  const view = ui({ filter: "omp", feral: false });
  const seen = new Set<string>();
  let current: string | null = null;
  for (let i = 0; i < 10; i++) {
    current = navigate(w, { ...view, selectedId: current }, SIZES[2], "next");
    seen.add(current!);
  }
  assert.deepEqual([...seen].sort(), visibleBugs(w, view).map((b) => b.id).sort());
});

test("hostile names never leak control characters", () => {
  const evil = "\u001b[31mred\u001b[0m\nsecond\u0007\u009bC\u001b]0;title\u0007";
  const bugs = [
    bug("human", "net\u001b[2Jrunner", "human", null), { ...bug("o1", evil, "orchestrator", "claude", "working"), cwd: `/tmp/${evil}`, channels: [evil], previousNames: [evil] },
    bug("w1", `${evil}\r\nw`, "worker", "omp"), bug("w2", "漢字🙂wide", "worker", "opencode", "lost"),
  ];
  const feed: FeedLine[] = [{ seq: 1, at: 0, fromId: "w1", toId: "w2", from: evil, to: evil, kind: "control", text: `${evil}\u0000x` }];
  const w = world(bugs, [link("human", "o1"), link("o1", "w1"), link("o1", "w2")], feed);
  for (const size of SIZES) {
    for (const selectedId of [null, "o1", "w1", "w2"]) {
      const { frame } = renderScene(w, [{ seq: 1, fromId: "w1", toId: "w2", kind: "chat", ageMs: 500 }], ui({ selectedId }), 2, size, 0);
      assert.equal(frame.lines.length, size.rows);
      for (const line of frame.lines) {
        const text = lineText(line);
        assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(text), `control character in ${JSON.stringify(text)}`);
        assert.ok(terminalTextWidth(text) <= size.columns);
      }
    }
  }
  assert.ok(frameRows(w, ui(), SIZES[1]).join("\n").includes("red second"));
});

test("sprite art keeps a uniform width so links and plates line up", () => {
  for (const art of Object.values(WORKER_ART)) for (const row of [...art.rows, ...art.legs]) assert.equal(row.length, WORKER_W, row);
  for (const art of Object.values(ORCH_ART)) for (const row of [...art.rows, ...art.legs]) assert.equal(row.length, ORCH_W, row);
});
