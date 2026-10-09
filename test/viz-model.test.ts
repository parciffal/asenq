import assert from "node:assert/strict";
import { test } from "node:test";
import type { ListedSession } from "../src/shared/protocol.js";
import { buildWorld } from "../src/viz/model.js";
import { classify, parsePs, scanProcesses } from "../src/viz/scan.js";
import type { ProcInfo } from "../src/viz/scan.js";
import type { VizHarness } from "../src/viz/types.js";

const NOW = 1_700_000_000_000;
const MIN = 60_000;

function session(o: Partial<ListedSession> & { id: string; name: string }): ListedSession {
  return {
    previousNames: [], harness: "omp", cwd: "/work", state: "live", stale: false, ping: null, inbound: "accept",
    role: null, channels: [], lastSeen: NOW, busy: null, harnessSessionId: null, you: false, ...o,
  };
}

const proc = (o: Partial<ProcInfo> & { pid: number }): ProcInfo => ({
  harness: "omp", command: "omp", elapsedSec: 100, cpu: 0, ...o,
});

const world = (sessions: ListedSession[], procs: ProcInfo[] = []) =>
  buildWorld({ sessions, procs, feed: [], connection: "connected", now: NOW });

test("the netrunner is always present, even in an empty or offline world", () => {
  for (const connection of ["connected", "offline"] as const) {
    const w = buildWorld({ sessions: [], procs: [], feed: [], connection, now: NOW });
    assert.deepEqual(w.bugs.map((b) => [b.id, b.name, b.kind, b.harness, b.state]), [["human", "netrunner", "human", null, "idle"]]);
    assert.deepEqual(w.edges, []);
    assert.equal(w.connection, connection);
  }
});

test("edges link the human to orchestrators and each orchestrator to the workers it shares a channel with", () => {
  const w = world([
    session({ id: "w1", name: "wrk-b", role: "worker", channels: ["a"] }),
    session({ id: "o2", name: "orch-b", role: "orchestrator", channels: ["b"] }),
    session({ id: "w2", name: "wrk-a", role: "worker", channels: ["a", "b"] }),
    session({ id: "o1", name: "orch-a", role: "orchestrator", channels: ["a"] }),
    session({ id: "w3", name: "wrk-solo", role: "worker", channels: ["unrelated"] }),
    session({ id: "w4", name: "wrk-unset", role: null }),
  ]);
  assert.deepEqual(w.edges.map((e) => `${e.from}>${e.to}:${e.via}`), [
    "human>o1:human", "human>o2:human",
    "o1>w2:channel", "o2>w2:channel", // wrk-a answers to both
    "o1>w1:channel",
    "human>w3:human", "human>w4:human", // no orchestrator link: hangs off the human
  ]);
  assert.equal(w.bugs.find((b) => b.id === "w4")?.unassigned, true, "a role-less session is flagged unassigned, not claimed as a worker");
  assert.equal(w.bugs.find((b) => b.id === "w3")?.unassigned, undefined, "assigned workers carry no flag");
});

test("bugs are ordered human, orchestrators, workers, feral, each group by name", () => {
  const w = world(
    [
      session({ id: "w1", name: "zed", role: "worker" }),
      session({ id: "o1", name: "queen-b", role: "orchestrator" }),
      session({ id: "w2", name: "amy", role: "worker" }),
      session({ id: "o2", name: "queen-a", role: "orchestrator" }),
    ],
    [proc({ pid: 20, harness: "codex" }), proc({ pid: 100, harness: "codex" }), proc({ pid: 3, harness: "claude" })],
  );
  assert.deepEqual(w.bugs.map((b) => b.name), [
    "netrunner", "queen-a", "queen-b", "amy", "zed", "claude-3", "codex-100", "codex-20",
  ]);
  assert.deepEqual(w.bugs.map((b) => b.kind), [
    "human", "orchestrator", "orchestrator", "worker", "worker", "feral", "feral", "feral",
  ]);
});

test("state: gone is dead, stale or unresponsive is lost, busy is working, otherwise idle", () => {
  const w = world([
    session({ id: "a", name: "gone-one", state: "gone", busy: true }),
    session({ id: "b", name: "stale-one", state: "stale", stale: true, busy: true }),
    session({ id: "c", name: "mute-one", ping: "not_responding", busy: true }),
    session({ id: "d", name: "busy-one", busy: true }),
    session({ id: "e", name: "calm-one", busy: false }),
    session({ id: "f", name: "unknown-one", busy: null, ping: "responding" }),
  ]);
  const states = Object.fromEntries(w.bugs.map((b) => [b.name, b.state]));
  assert.deepEqual(states, {
    netrunner: "idle", "gone-one": "dead", "stale-one": "lost", "mute-one": "lost", "busy-one": "working",
    "calm-one": "idle", "unknown-one": "idle",
  });
});

test("gone sessions stay for 30 minutes after last contact and are then omitted", () => {
  const w = world([
    session({ id: "a", name: "fresh", state: "gone", lastSeen: NOW - 29 * MIN }),
    session({ id: "b", name: "edge", state: "gone", lastSeen: NOW - 30 * MIN }),
    session({ id: "c", name: "old", state: "gone", lastSeen: NOW - 30 * MIN - 1 }),
    session({ id: "d", name: "never", state: "gone", lastSeen: null }),
    session({ id: "e", name: "live-old", state: "live", lastSeen: NOW - 3600 * MIN }),
  ]);
  assert.deepEqual(w.bugs.map((b) => b.name).sort(), ["edge", "fresh", "live-old", "netrunner"]);
});

test("bugs keep former names, channels and cwd so messages to old names can be resolved", () => {
  const w = world([session({ id: "a", name: "renamed", previousNames: ["first", "second"], channels: ["x"], cwd: "/proj", harness: "claude" })]);
  const bug = w.bugs.find((b) => b.id === "a");
  assert.deepEqual(
    [bug?.name, bug?.previousNames, bug?.channels, bug?.cwd, bug?.harness, bug?.lastSeen],
    ["renamed", ["first", "second"], ["x"], "/proj", "claude", NOW],
  );
});

test("a process carrying a registered session's full id is that session, not a feral bug", () => {
  const id = "01a11b61-135f-7000-b698-ba442c194c0c";
  const w = world(
    [session({ id: "s1", name: "known", harness: "omp", harnessSessionId: id })],
    [proc({ pid: 10, command: `bun /x/omp -r ${id}`, elapsedSec: 5 })],
  );
  assert.deepEqual(w.bugs.map((b) => b.id), ["human", "s1"]);
});

test("per harness, processes beyond the live registered sessions become feral, newest first", () => {
  const w = world(
    [
      session({ id: "s1", name: "omp-reg", harness: "omp" }),
      session({ id: "s2", name: "omp-gone", harness: "omp", state: "gone" }),
      session({ id: "s3", name: "cc-reg", harness: "claude" }),
    ],
    [
      proc({ pid: 1, harness: "omp", elapsedSec: 9000 }),
      proc({ pid: 2, harness: "omp", elapsedSec: 10 }),
      proc({ pid: 3, harness: "omp", elapsedSec: 500, cpu: 42 }),
      proc({ pid: 4, harness: "claude", elapsedSec: 700 }),
    ],
  );
  const feral = w.bugs.filter((b) => b.kind === "feral");
  // three omp processes, one live omp session (the gone one does not count): the two newest are feral
  assert.deepEqual(feral.map((b) => [b.id, b.name, b.harness, b.state, b.pid]), [
    ["proc:2", "omp-2", "omp", "idle", 2],
    ["proc:3", "omp-3", "omp", "working", 3],
  ]);
  assert.ok(feral.every((b) => b.channels.length === 0 && b.cwd === null));
  assert.ok(!w.edges.some((e) => e.from.startsWith("proc:") || e.to.startsWith("proc:")), "feral bugs have no links");
});

test("id-matched sessions are subtracted before the per-harness count, and stale sessions still count as live", () => {
  const id = "cafebabe-0000-4000-8000-000000000001";
  const w = world(
    [
      session({ id: "s1", name: "matched", harness: "omp", harnessSessionId: id }),
      session({ id: "s2", name: "silent", harness: "omp", state: "stale", stale: true }),
    ],
    [
      proc({ pid: 1, command: `omp -r ${id}`, elapsedSec: 800 }),
      proc({ pid: 2, command: "omp", elapsedSec: 600 }),
      proc({ pid: 3, command: "omp", elapsedSec: 5 }),
    ],
  );
  // pid 1 belongs to "matched"; pids 2 and 3 compete for the one remaining live session ("silent"): newest is feral
  assert.deepEqual(w.bugs.filter((b) => b.kind === "feral").map((b) => b.id), ["proc:3"]);
});

test("an aged-out gone session no longer claims a process carrying its id", () => {
  const id = "deadbeef-0000-4000-8000-000000000002";
  const w = world(
    [session({ id: "old", name: "old-one", harness: "omp", harnessSessionId: id, state: "gone", lastSeen: NOW - 31 * MIN })],
    [proc({ pid: 21, command: `omp -r ${id}` })],
  );
  assert.deepEqual(w.bugs.filter((b) => b.kind === "feral").map((b) => b.id), ["proc:21"]);
});

test("short or missing harness session ids never match process command lines", () => {
  const w = world(
    [session({ id: "s1", name: "tiny", harness: "omp", harnessSessionId: "omp", state: "gone", lastSeen: NOW })],
    [proc({ pid: 7, command: "omp -r whatever" })],
  );
  assert.deepEqual(w.bugs.filter((b) => b.kind === "feral").map((b) => b.id), ["proc:7"]);
});

test("codex has no registrations: every codex process is feral and cpu decides working", () => {
  const w = world(
    [session({ id: "s1", name: "omp-only", harness: "omp" })],
    [proc({ pid: 5, harness: "codex", cpu: 4.9 }), proc({ pid: 6, harness: "codex", cpu: 5 })],
  );
  assert.deepEqual(w.bugs.filter((b) => b.kind === "feral").map((b) => [b.name, b.state]), [
    ["codex-5", "idle"], ["codex-6", "working"],
  ]);
});

test("the feed and connection state pass through unchanged", () => {
  const feed = [{ seq: 1, at: NOW, fromId: "human", toId: null, from: "human", to: "#ops", kind: "chat" as const, text: "hi" }];
  const w = buildWorld({ sessions: [], procs: [], feed, connection: "offline", now: NOW });
  assert.deepEqual(w.feed, feed);
  assert.equal(w.connection, "offline");
});

// ---------------------------------------------------------------- scan: classify / parsePs

test("classify recognises interactive agents by executable or script, not by substring", () => {
  const agents: [string, VizHarness | null][] = [
    ["bun /Users/parciffal/.bun/bin/omp -r 01a11b61-135f-7000-b698-ba442c194c0c", "omp"],
    ["claude", "claude"],
    ["/Users/parciffal/.local/share/claude/versions/2.1.295 --resume /x.jsonl", "claude"],
    ["opencode", "opencode"],
    ["codex --model x", "codex"],
    ["/usr/local/bin/codex", "codex"],
    ["node /usr/lib/node_modules/@openai/codex/bin/codex.js --yolo", "codex"],
    ["node --max-old-space-size=4096 /opt/opencode/bin/opencode", "opencode"],
    ["bun run /home/me/.bun/bin/omp", "omp"],
    ["deno run -A /opt/claude/versions/9.9.9", "claude"],
  ];
  for (const [command, harness] of agents) assert.equal(classify(command), harness, command);
});

test("classify rejects helpers, wrappers and look-alikes seen in real process tables", () => {
  const rejects = [
    "bun /Users/parciffal/.bun/bin/omp __omp_worker_text_predict",
    "claude bg-spare --bg-spare /tmp/x.sock",
    "/Users/parciffal/.local/share/claude/versions/2.1.295 --bg-spare /tmp/x.sock",
    "npm exec opencode-codebase-index-mcp --host claude",
    "node /Users/parciffal/.npm/_npx/x/node_modules/.bin/opencode-codebase-index-mcp --host claude",
    "node /Users/p/Workdir/chatgpt-codex-proxy/node_modules/.bin/tsx watch src/index.ts",
    "node /Users/p/.npm/_npx/y/node_modules/.bin/codebase-index-mcp",
    "vim omp",
    "grep -r claude src",
    "tail -f /var/log/opencode.log",
    "claude mcp serve",
    "node",
    "bun",
    "",
    "   ",
  ];
  for (const command of rejects) assert.equal(classify(command), null, command);
});

test("parsePs decodes ps columns, etime formats, and keeps only classified TTY processes", () => {
  const output = [
    "  101 ttys003       01:02:03   1.5 bun /Users/parciffal/.bun/bin/omp -r 01a11b61-135f-7000-b698-ba442c194c0c",
    "  102 ??               10:00   0.0 claude",
    "  103 ttys004    2-03:04:05  97.2 /Users/parciffal/.local/share/claude/versions/2.1.295 --resume /x.jsonl",
    "  104 ttys005          00:09   0.3 codex --model x",
    "  105 ttys006          00:09   0.3 bun /Users/parciffal/.bun/bin/omp __omp_worker_text_predict",
    "  106 ?                00:30   0.0 opencode",
    "  107 -                00:30   0.0 opencode",
    "  108 pts/3            59:59  12.5 opencode",
    "  109 ttys007       garbage   0.0 claude",
    "not a ps line",
    "",
  ].join("\n");
  assert.deepEqual(parsePs(output), [
    { pid: 101, harness: "omp", command: "bun /Users/parciffal/.bun/bin/omp -r 01a11b61-135f-7000-b698-ba442c194c0c", elapsedSec: 3723, cpu: 1.5 },
    { pid: 103, harness: "claude", command: "/Users/parciffal/.local/share/claude/versions/2.1.295 --resume /x.jsonl", elapsedSec: 183845, cpu: 97.2 },
    { pid: 104, harness: "codex", command: "codex --model x", elapsedSec: 9, cpu: 0.3 },
    { pid: 108, harness: "opencode", command: "opencode", elapsedSec: 3599, cpu: 12.5 },
  ]);
});

test("scanProcesses parses the runner's output and degrades to an empty list on failure", async () => {
  const found = await scanProcesses(async () => "  7 ttys001  00:05  0.0 codex\n");
  assert.deepEqual(found.map((p) => [p.pid, p.harness]), process.platform === "win32" ? [] : [[7, "codex"]]);
  assert.deepEqual(await scanProcesses(async () => { throw new Error("ps missing"); }), []);
});
