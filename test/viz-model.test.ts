import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChannelSummary, ListedSession, SessionIdentity, StoredMessage } from "../src/shared/protocol.js";
import type { KeyInput, TerminalLine } from "../src/tui/terminal.js";
import { VizMap } from "../src/viz/map.js";
import { buildWorld } from "../src/viz/model.js";
import { CityPlacement, matchingTargets, routeBetween, sampleRoute, targetKey } from "../src/viz/place.js";
import { classify, parsePs, scanProcesses } from "../src/viz/scan.js";
import type { ProcInfo } from "../src/viz/scan.js";
import type { VizHarness, VizUi } from "../src/viz/types.js";

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
const channel = (name: string, memberIds: string[] = []): ChannelSummary => ({ name, memberIds, count: 0, lastAt: 0, lastOrder: 0 });
const world = (sessions: ListedSession[] = [], channels: ChannelSummary[] = [], identities: SessionIdentity[] = [], procs: ProcInfo[] = []) =>
  buildWorld({ sessions, channels, identities, procs, feed: [], connection: "connected", now: NOW });
const key = (name: string, text?: string): KeyInput => ({ name, text, matches: [], ctrl: false, alt: false, shift: false });
const message = (id: string, overrides: Partial<StoredMessage> = {}): StoredMessage => ({
  id, from: "alpha", fromSessionId: "a", to: "beta", toSessionId: "b", text: "observed", order: 1, createdAt: NOW,
  status: "delivered", ...overrides,
});
const rows = (lines: readonly TerminalLine[]): string => lines.map((l) => typeof l === "string" ? l : l.map((s) => s.text).join("")).join("\n");
const CITY_SIZE = { columns: 160, rows: 48 } as const;
const plainLine = (line: TerminalLine): string => typeof line === "string" ? line : line.map((span) => span.text).join("");
function screenPosition(lines: readonly TerminalLine[], text: string, cityWidth = 128): { column: number; row: number } | undefined {
  for (let row = 0; row < lines.length; row++) {
    const line = plainLine(lines[row]!);
    let column = line.indexOf(text);
    while (column >= 0) {
      if (column < cityWidth) return { column, row };
      column = line.indexOf(text, column + 1);
    }
  }
  return undefined;
}
function cityHas(lines: readonly TerminalLine[], text: string, cityWidth = 128): boolean {
  return lines.some((line) => plainLine(line).slice(0, cityWidth).includes(text));
}
function packetCells(lines: readonly TerminalLine[], cityWidth = 128): { column: number; row: number }[] {
  const found: { column: number; row: number }[] = [];
  for (let row = 0; row < lines.length; row++) {
    for (const match of plainLine(lines[row]!).slice(0, cityWidth).matchAll(/[⠁⠂⠄⡀⠒]/gu)) {
      if (match.index !== undefined) found.push({ column: match.index, row });
    }
  }
  return found;
}

function search(map: VizMap, query: string): void {
  map.key(key("/", "/"));
  map.key(key(query, query));
  map.key(key("ENTER"));
}

test("empty channels and identity-keyed rosters exist without any posts or inferred edges", () => {
  const w = world([session({ id: "a", name: "alpha", channels: ["invented"], role: null })],
    [channel("empty"), channel("ops", ["a", "a"]), channel("other", ["a"])]);
  assert.deepEqual(w.venues.map((v) => [v.name, v.roster.length]), [["empty", 0], ["ops", 1], ["other", 1]]);
  assert.equal(w.characters.filter((c) => c.id === "a").length, 1);
  assert.deepEqual(w.characters.find((c) => c.id === "a")!.memberships, ["ops", "other"]);
  assert.equal(w.characters.find((c) => c.id === "a")!.role, null);
  assert.equal("edges" in w, false);
  const layout = new CityPlacement().update(w);
  assert.equal(layout.characters.filter((c) => c.character.id === "a").length, 1);
  assert.equal(layout.targets.filter((p) => p.target.kind === "membership").length, 1);
});

test("roster identities remain inspectable after removal with honest missing availability", () => {
  const identity: SessionIdentity = {
    id: "old", name: "archived", previousNames: ["original"], harness: "claude", state: "removed", inbound: "accept",
    role: "worker", createdAt: NOW - MIN,
  };
  const w = world([], [channel("archive", ["old", "unresolved"])], [identity]);
  const c = w.characters.find((c) => c.id === "old")!;
  assert.deepEqual([c.name, c.state, c.busy, c.ping, c.stale, c.lastSeen], ["archived", "removed", null, null, null, null]);
  assert.equal(w.venues[0]!.roster.length, 2);
  assert.equal(w.characters.find((c) => c.id === "unresolved")!.state, null);
});

test("raw state and unknown busy survive projection and current null values beat older identity metadata", () => {
  const identity: SessionIdentity = { id: "a", name: "alpha", previousNames: [], harness: "omp", cwd: "/old", state: "live", inbound: "accept", role: "worker", createdAt: NOW };
  const w = world([session({ id: "a", name: "alpha", cwd: null }), session({ id: "b", name: "beta", busy: false }),
    session({ id: "c", name: "gamma", state: "stale", stale: true, busy: true })], [], [identity]);
  const a = w.characters.find((c) => c.id === "a")!;
  assert.deepEqual([a.busy, a.role, a.cwd], [null, null, null]);
  assert.deepEqual(w.characters.filter((c) => c.source === "registered").map((c) => [c.state, c.busy]), [["live", null], ["live", false], ["stale", true]]);
});

test("gone nonmembers age out at thirty minutes, but roster members remain", () => {
  const w = world([
    session({ id: "edge", name: "edge", state: "gone", lastSeen: NOW - 30 * MIN }),
    session({ id: "old", name: "old", state: "gone", lastSeen: NOW - 31 * MIN }),
    session({ id: "member", name: "member", state: "gone", lastSeen: null }),
  ], [channel("ops", ["member"])]);
  assert.deepEqual(w.characters.map((c) => c.id), ["human", "edge", "member"]);
});

test("unchanged process surplus heuristic distinguishes detection from reported session state", () => {
  const resume = "cafebabe-0000-4000-8000-000000000001";
  const w = world([
    session({ id: "a", name: "matched", harnessSessionId: resume }),
    session({ id: "b", name: "stale", state: "stale" }),
  ], [], [], [
    proc({ pid: 1, command: `omp -r ${resume}`, elapsedSec: 800 }), proc({ pid: 2, elapsedSec: 600 }),
    proc({ pid: 3, elapsedSec: 5, cpu: 42 }), proc({ pid: 4, harness: "codex", cpu: 0 }),
  ]);
  assert.deepEqual(w.characters.filter((c) => c.source === "process").map((c) => [c.id, c.state, c.busy, c.cpu]), [["proc:3", null, null, 42], ["proc:4", null, null, 0]]);
  assert.ok(w.characters.filter((c) => c.source === "process").every((c) => c.memberships.length === 0));
});

test("aged-out gone registrations and short resume ids never hide a detected process", () => {
  const resume = "deadbeef-0000-4000-8000-000000000002";
  const old = world([session({ id: "a", name: "old", state: "gone", lastSeen: NOW - 31 * MIN, harnessSessionId: resume })],
    [], [], [proc({ pid: 7, command: `omp -r ${resume}` })]);
  assert.ok(old.characters.some((c) => c.id === "proc:7"));
  const short = world([session({ id: "a", name: "short", state: "gone", harnessSessionId: "omp" })], [], [], [proc({ pid: 8 })]);
  assert.ok(short.characters.some((c) => c.id === "proc:8"));
});

test("expanding streets and floors preserve surviving coordinates; removed channels release their space", () => {
  const place = new CityPlacement();
  const a = session({ id: "a", name: "alpha" });
  const b = session({ id: "b", name: "street", role: "worker" });
  const first = place.update(world([a, b], [channel("ops", ["a"]), channel("empty")]));
  const pos = first.byCharacter.get("a")!.anchor;
  const street = first.byCharacter.get("b")!.anchor;
  const empty = first.venues.find((v) => v.venue.name === "empty")!.rect;
  const members = Array.from({ length: 26 }, (_, i) => session({ id: `x${i}`, name: `extra-${i}` }));
  const grown = place.update(world([{ ...a, name: "renamed", busy: true }, b, ...members],
    [channel("ops", ["a", ...members.map((c) => c.id)]), channel("empty"), ...Array.from({ length: 40 }, (_, i) => channel(`new-${i}`))]));
  assert.deepEqual(grown.byCharacter.get("a")!.anchor, pos);
  assert.deepEqual(grown.byCharacter.get("b")!.anchor, street);
  assert.deepEqual(grown.venues.find((v) => v.venue.name === "empty")!.rect, empty);
  assert.equal(grown.venues.find((v) => v.venue.name === "ops")!.floors, 14);
  assert.equal(grown.targets.length, 42 + 29);
  place.update(world([], []));
  const rejoined = place.update(world([a, b], [channel("ops", ["a"]), channel("empty")]));
  assert.deepEqual(rejoined.byCharacter.get("a")!.anchor, pos);
  assert.deepEqual(rejoined.byCharacter.get("b")!.anchor, street);
  assert.equal(rejoined.venues.find((v) => v.venue.name === "ops")!.floors, 1);
});

test("removing channels compacts the city and deleting the last returns the baseline", () => {
  const place = new CityPlacement();
  const x = session({ id: "x", name: "x" });
  const first = place.update(world([x], [channel("a"), channel("b"), channel("c", ["x"])]));
  const originalB = first.venues.find((v) => v.venue.name === "b")!;
  const originalC = first.venues.find((v) => v.venue.name === "c")!;
  assert.deepEqual(first.venues.map((v) => v.rect.x), [0, 48, 96]);
  assert.equal(first.bounds.width, 136);
  const cut = place.update(world([x], [channel("a"), channel("c", ["x"])]));
  const compactedC = cut.venues.find((v) => v.venue.name === "c")!;
  assert.equal(compactedC.rect.x, 48);
  assert.equal(compactedC.venue.key, originalC.venue.key);
  assert.deepEqual(cut.venues[0]!.rect, first.venues[0]!.rect);
  assert.ok(cut.moved.some((m) => m.id === "x"));
  assert.equal(cut.bounds.width, 88);
  const grown = place.update(world([x], [channel("a"), channel("c", ["x"]), channel("d")]));
  assert.equal(grown.venues.find((v) => v.venue.name === "d")!.rect.x, 96);
  assert.equal(grown.venues.find((v) => v.venue.name === "c")!.rect.x, 48);
  const back = place.update(world([x], [channel("a"), channel("b"), channel("c", ["x"]), channel("d")]));
  const newB = back.venues.find((v) => v.venue.name === "b")!;
  assert.equal(newB.rect.x, 144);
  assert.notEqual(newB.venue.key, originalB.venue.key);
  assert.deepEqual(place.update(world([], [])).bounds, { x: 0, y: -14, width: 40, height: 30 });
});

test("a channel's floors follow its live roster", () => {
  const place = new CityPlacement();
  const people = ["s1", "s2", "s3"].map((id) => session({ id, name: id }));
  const full = place.update(world(people, [channel("ops", ["s1", "s2", "s3"])]));
  assert.equal(full.venues[0]!.floors, 2);
  const small = place.update(world(people, [channel("ops", ["s1"])]));
  assert.equal(small.venues[0]!.floors, 1);
});

test("canonical membership changes alone move a home and observed renames retain keys and appearance", () => {
  const place = new CityPlacement();
  const a = session({ id: "a", name: "alpha" });
  const first = place.update(world([a], [channel("b", ["a"]), channel("c", ["a"])]));
  const b = first.venues.find((v) => v.venue.name === "b")!;
  const old = first.byCharacter.get("a")!.anchor;
  const added = place.update(world([a], [channel("a", ["a"]), channel("b", ["a"]), channel("c", ["a"])]));
  assert.deepEqual(added.byCharacter.get("a")!.anchor, old);
  place.renameChannel("b", "z");
  const renamed = place.update(world([a], [channel("a", ["a"]), channel("z", ["a"]), channel("c", ["a"])]));
  const z = renamed.venues.find((v) => v.venue.name === "z")!;
  assert.deepEqual([z.venue.key, z.rect, z.venue.appearance], [b.venue.key, b.rect, b.venue.appearance]);
  assert.deepEqual(renamed.byCharacter.get("a")!.anchor, old);
  const removed = place.update(world([a], [channel("a", ["a"]), channel("z"), channel("c", ["a"])]));
  assert.equal(removed.moved.length, 1);
  assert.equal(removed.byCharacter.get("a")!.home, removed.venues.find((v) => v.venue.name === "a")!.venue.key);
  const street = place.update(world([a], [channel("a"), channel("z"), channel("c")]));
  assert.equal(street.byCharacter.get("a")!.home, null);
  assert.ok(street.byCharacter.get("a")!.rect.y >= 6);
});

test("orthogonal packet paths sample shared street geometry without allocating invisible cells", () => {
  const place = new CityPlacement();
  const layout = place.update(world([session({ id: "a", name: "a" }), session({ id: "b", name: "b" })],
    [channel("a", ["a"]), ...Array.from({ length: 200 }, (_, i) => channel(`middle-${i}`)), channel("z", ["b"])]));
  const path = routeBetween(layout, { kind: "character", id: "a" }, { kind: "character", id: "b" })!;
  assert.ok(path.length > 9000);
  assert.ok(path.segments.length < 12);
  assert.ok(path.segments.every((s) => s.from.x === s.to.x || s.from.y === s.to.y));
  assert.deepEqual(sampleRoute(path, 0), layout.byCharacter.get("a")!.anchor);
  assert.deepEqual(sampleRoute(path, path.length), layout.byCharacter.get("b")!.anchor);
});

test("filtering retains geometry and all venue anchors, including empty venues", () => {
  const w = world([session({ id: "a", name: "alpha", harness: "claude" }), session({ id: "b", name: "beta" })],
    [channel("ops", ["a", "b"]), channel("empty")]);
  const layout = new CityPlacement().update(w);
  const ui: VizUi = { selected: null, filter: "omp", focus: false, processes: false, viewport: { x: 0, y: 0, zoom: 4 },
    search: false, query: "", results: [], searchCursor: 0, inspector: "normal", inspectorScroll: 0, follow: false, notice: null };
  const targets = matchingTargets(w, layout, ui);
  assert.equal(targets.filter((p) => p.target.kind === "venue").length, 2);
  assert.ok(!targets.some((p) => p.target.kind !== "venue" && p.target.id === "a"));
  assert.ok(layout.byCharacter.has("a"));
});

test("channel posts spawn one venue packet, mentions remain separate DMs, and repeats never animate twice", () => {
  const map = new VizMap({ now: () => NOW });
  map.setSnapshot([session({ id: "a", name: "alpha" }), session({ id: "b", name: "beta" })], [channel("ops", ["a", "b"])], []);
  map.onMessage(message("post", { channel: "ops", to: "#ops", toSessionId: undefined, status: "posted" }), true);
  assert.equal(map.packetCount, 1);
  map.onMessage(message("mention", { sourceChannel: "ops" }), true);
  assert.equal(map.packetCount, 2);
  map.onMessage(message("mention", { status: "replied" }), true);
  assert.equal(map.packetCount, 2);
  map.step(1400);
  assert.equal(map.packetCount, 0);
  map.onMessage(message("hidden"), false);
  assert.equal(map.packetCount, 0);
  map.suspend();
  assert.equal(map.animationCount, 0);
});

test("explicit missing session IDs cannot alias a new identity reusing an old name", () => {
  const map = new VizMap({ now: () => NOW });
  map.setSnapshot([session({ id: "replacement", name: "alpha" }), session({ id: "b", name: "beta" })], [], []);
  map.onMessage(message("old"), true);
  assert.equal(map.packetCount, 0);
  assert.equal(map.animationCount, 0);
  map.onMessage(message("legacy", { fromSessionId: undefined }), true);
  assert.equal(map.packetCount, 1);
});

test("offline retains the last city, drops animation, and ignores traffic until successful snapshot", () => {
  const map = new VizMap({ now: () => NOW });
  const sessions = [session({ id: "a", name: "alpha" }), session({ id: "b", name: "beta" })];
  map.setSnapshot(sessions, [channel("empty")], []);
  map.onMessage(message("live"), true);
  map.setConnection("offline");
  assert.equal(map.packetCount, 0);
  assert.equal(map.animationCount, 0);
  map.onMessage(message("offline"), true);
  assert.equal(map.packetCount, 0);
  search(map, "alpha");
  assert.deepEqual(map.conversation(), { scope: "session", sessionId: "a" });
  assert.match(rows(map.frame({ columns: 80, rows: 24 })), /OFFLINE|SIGNAL LOST|STALE SNAPSHOT/);
  map.setSnapshot(sessions, [channel("empty")], []);
  map.onMessage(message("restored"), true);
  assert.equal(map.packetCount, 1);
});

test("search consumes host letters, preserves selection on no match and targets former names and venues", () => {
  const map = new VizMap({ now: () => NOW });
  map.setSnapshot([session({ id: "a", name: "alpha", previousNames: ["以前"] })], [channel("empty")], []);
  search(map, "以前");
  assert.deepEqual(map.selected, { kind: "character", id: "a" });
  const old = map.selected;
  map.key(key("/", "/"));
  assert.equal(map.key(key("q", "q")), true);
  assert.equal(map.key({ ...key("CTRL_K"), ctrl: true }), false);
  assert.equal(map.searching, true);
  map.key(key("ENTER"));
  assert.deepEqual(map.selected, old);
  assert.equal(map.searching, false);
  search(map, "empty");
  assert.deepEqual(map.conversation(), { scope: "channel", channel: "empty" });
  map.renameChannel("empty", "renamed");
  assert.deepEqual(map.conversation(), { scope: "channel", channel: "renamed" });
});

test("Tab reaches every offscreen character, venue and secondary membership without shedding", () => {
  const map = new VizMap({ now: () => NOW });
  const sessions = Array.from({ length: 100 }, (_, i) => session({ id: `s${i}`, name: `session-${i}` }));
  map.setSnapshot(sessions, [channel("a", sessions.map((s) => s.id)), channel("b", sessions.map((s) => s.id))], []);
  const visited = new Set<string>();
  for (let i = 0; i < 203; i++) {
    map.key(key("TAB"));
    visited.add(targetKey(map.selected!));
  }
  assert.equal(visited.size, 203);
  assert.equal([...visited].filter((k) => k.startsWith("m:")).length, 100);
  assert.equal(map.key(key("q", "q")), false);
  assert.equal(map.key(key("I", "I")), true);
  assert.equal(map.key(key("ESCAPE")), true);
  assert.equal(map.key(key("ESCAPE")), false);
});

test("packets and feeds stay bounded and late unknown endpoints never replay historical packets", () => {
  const map = new VizMap({ now: () => NOW });
  map.onMessage(message("unknown"), true);
  const sessions = [session({ id: "a", name: "alpha" }), session({ id: "b", name: "beta" })];
  map.setSnapshot(sessions, [], []);
  assert.equal(map.packetCount, 0);
  for (let i = 0; i < 130; i++) map.onMessage(message(`fresh-${i}`), true);
  assert.equal(map.packetCount, 100);
  map.suspend();
  assert.equal(map.packetCount, 0);
  assert.equal(map.animationCount, 0);
});

test("fresh canonical moves animate only within snapshot recency and never after suspend or reduced motion", () => {
  const a = session({ id: "a", name: "alpha" });
  for (const reducedMotion of [false, true]) {
    const map = new VizMap({ now: () => NOW, reducedMotion });
    map.setSnapshot([a], [channel("a", ["a"]), channel("b", ["a"])], []);
    map.step(2000);
    map.setSnapshot([a], [channel("a"), channel("b", ["a"])], []);
    assert.equal(map.animationCount, reducedMotion ? 0 : 1);
    map.step(3000);
    assert.equal(map.animationCount, 0);
    map.suspend();
    map.setSnapshot([a], [channel("a", ["a"]), channel("b")], []);
    assert.equal(map.animationCount, 0);
    map.step(5001);
    map.setSnapshot([a], [channel("a"), channel("b", ["a"])], []);
    assert.equal(map.animationCount, 0);
  }
});

test("poll requests coalesce at the public manual-clock seam without allocating on messages", () => {
  const map = new VizMap({ now: () => NOW });
  assert.deepEqual(map.step(1999), { list: false, scan: false });
  assert.deepEqual(map.step(1), { list: true, scan: false });
  assert.deepEqual(map.step(3000), { list: true, scan: true });
  map.refresh();
  assert.deepEqual(map.take(), { list: true, scan: true });
  assert.deepEqual(map.take(), { list: false, scan: false });
});

test("membership targets open the same identity and process targets never expose a conversation", () => {
  const map = new VizMap({ now: () => NOW });
  map.setSnapshot([session({ id: "a", name: "alpha" })], [channel("a", ["a"]), channel("b", ["a"])], []);
  for (let i = 0; i < 5 && map.selected?.kind !== "membership"; i++) map.key(key("TAB"));
  assert.equal(map.selected?.kind, "membership");
  assert.deepEqual(map.conversation(), { scope: "session", sessionId: "a" });
  map.setProcs([proc({ pid: 17, harness: "codex" })]);
  search(map, "codex-17");
  assert.deepEqual(map.selected, { kind: "character", id: "proc:17" });
  assert.equal(map.conversation(), undefined);
  map.key(key("ENTER"));
  assert.equal(map.key(key("ESCAPE")), true);
});

test("traffic follow centers a relevant route packet, ignores unrelated traffic, then returns to the selected identity", () => {
  const channels = Array.from({ length: 101 }, (_, i) => channel(`venue-${String(i).padStart(3, "0")}`,
    i === 0 ? ["a"] : i === 100 ? ["b", "c"] : []));
  const map = new VizMap({ now: () => NOW });
  map.setSnapshot([session({ id: "a", name: "alpha" }), session({ id: "b", name: "beta" }), session({ id: "c", name: "gamma" })], channels, []);
  map.frame(CITY_SIZE);
  search(map, "alpha");
  map.key(key("T", "T"));
  assert.deepEqual(map.selected, { kind: "character", id: "a" });
  map.onMessage(message("relevant"), true);
  map.step(700);
  const traveling = map.frame(CITY_SIZE);
  const relevantDots = packetCells(traveling);
  assert.ok(relevantDots.some((p) => Math.abs(p.column - 64) <= 1 && Math.abs(p.row - 22) <= 1),
    "the followed packet should render at the camera center along the long city route");
  assert.equal(screenPosition(traveling, "[alpha]"), undefined, "the camera should leave the selected endpoint while following its packet");

  map.onMessage(message("unrelated", { from: "beta", fromSessionId: "b", to: "gamma", toSessionId: "c" }), true);
  const withUnrelated = map.frame(CITY_SIZE);
  assert.deepEqual(packetCells(withUnrelated), relevantDots, "traffic unrelated to the selection must not move the camera");

  map.step(800);
  const returned = map.frame(CITY_SIZE);
  const alpha = screenPosition(returned, "[alpha]");
  assert.ok(alpha && alpha.column >= 55 && alpha.column <= 65, "after its packet expires, follow returns to the selected canonical character");
  assert.deepEqual(packetCells(returned), [], "the unrelated packet remains outside the selected character's view");
});

test("manual mouse pan releases traffic follow while the packet is still moving", () => {
  const map = new VizMap({ now: () => NOW });
  map.setSnapshot([session({ id: "a", name: "alpha" }), session({ id: "b", name: "beta" })], [], []);
  map.frame(CITY_SIZE);
  search(map, "alpha");
  map.key(key("T", "T"));
  map.onMessage(message("pan-live"), true);
  const beforePan = screenPosition(map.frame(CITY_SIZE), "[alpha]")!;

  assert.equal(map.mouse({ name: "wheel-up", column: 0, row: 10, action: "wheel-up", ctrl: false, alt: false, shift: false }), true);
  const panned = screenPosition(map.frame(CITY_SIZE), "[alpha]")!;
  assert.equal(panned.row, beforePan.row + 3, "manual wheel pan changes the rendered character position");

  map.step(500);
  const activePacket = map.frame(CITY_SIZE);
  assert.deepEqual(screenPosition(activePacket, "[alpha]"), panned, "later packet progress must not reclaim a manually panned camera");
  assert.ok(packetCells(activePacket).length > 0, "the packet must still be visible while the camera stays panned");
});

test("following a selected membership marker centers its canonical registered character", () => {
  const channels = [channel("home", ["a"]), ...Array.from({ length: 4 }, (_, i) => channel(`middle-${i}`)), channel("secondary", ["a"])];
  const map = new VizMap({ now: () => NOW });
  map.setSnapshot([session({ id: "a", name: "alpha" })], channels, []);
  map.frame(CITY_SIZE);
  search(map, "alpha");
  const marker = map.selected;
  assert.deepEqual(marker && { kind: marker.kind, id: marker.kind === "venue" ? undefined : marker.id },
    { kind: "membership", id: "a" });
  const localMarker = map.frame(CITY_SIZE);
  const markerPosition = screenPosition(localMarker, "[alpha]");
  assert.ok(markerPosition, "the secondary marker name is visible in the city region, not just the inspector");
  assert.equal(map.mouse({ name: "press", column: markerPosition.column, row: markerPosition.row, action: "press", button: "left", ctrl: false, alt: false, shift: false }), true);
  assert.deepEqual(map.selected, marker, "the rendered secondary marker hit selects that membership identity");

  map.key(key("F", "F"));
  const canonicalView = map.frame(CITY_SIZE);
  assert.deepEqual(map.selected, marker, "following changes only the camera, not the selected membership anchor");
  const canonicalPosition = screenPosition(canonicalView, "[alpha]");
  assert.ok(canonicalPosition, "the canonical character name is visible in the city region, not just the inspector");
  assert.equal(map.mouse({ name: "press", column: canonicalPosition.column, row: canonicalPosition.row, action: "press", button: "left", ctrl: false, alt: false, shift: false }), true);
  assert.deepEqual(map.selected, { kind: "character", id: "a" }, "the rendered canonical hit selects the same registered identity");
});

test("session follow tracks the drawn walk during movement and settles at the canonical home", () => {
  const alpha = session({ id: "a", name: "alpha" });
  const map = new VizMap({ now: () => NOW });
  map.setSnapshot([alpha], [channel("a", ["a"]), channel("z")], []);
  map.frame(CITY_SIZE);
  search(map, "alpha");
  map.key(key("F", "F"));
  const before = map.frame(CITY_SIZE);
  const oldVenue = screenPosition(before, "#a")!;
  assert.ok(oldVenue);

  map.setSnapshot([alpha], [channel("a"), channel("z", ["a"])], []);
  const movementStart = map.frame(CITY_SIZE);
  assert.ok(cityHas(movementStart, "MOVING"));
  assert.ok(screenPosition(movementStart, "[alpha]"), "follow stays on the actually drawn character at movement start");
  assert.deepEqual(screenPosition(movementStart, "#a"), oldVenue, "the walk begins from its prior visible home");

  map.step(250);
  const inMotion = map.frame(CITY_SIZE);
  assert.ok(cityHas(inMotion, "MOVING"), "the snapshot-driven walk remains active before its minimum duration");
  assert.ok(screenPosition(inMotion, "[alpha]"), "the followed character remains in view during movement");
  assert.notDeepEqual(screenPosition(inMotion, "#a"), oldVenue, "the surrounding city moves as the camera follows the interpolated position");

  map.step(4000);
  const settled = map.frame(CITY_SIZE);
  assert.equal(cityHas(settled, "MOVING"), false, "the movement label ends after the walk");
  assert.ok(screenPosition(settled, "[alpha]"), "follow settles on the character's canonical home");
});

test("suspending the map prevents hidden traffic from replaying when the map returns", () => {
  const channels = Array.from({ length: 101 }, (_, i) => channel(`venue-${String(i).padStart(3, "0")}`,
    i === 0 ? ["a"] : i === 100 ? ["b"] : []));
  const sessions = [session({ id: "a", name: "alpha" }), session({ id: "b", name: "beta" })];
  const map = new VizMap({ now: () => NOW });
  map.setSnapshot(sessions, channels, []);
  map.frame(CITY_SIZE);
  search(map, "alpha");
  map.key(key("T", "T"));
  map.onMessage(message("before-suspend"), true);
  map.step(700);
  assert.ok(packetCells(map.frame(CITY_SIZE)).length > 0, "the visible city has a live observed packet before suspension");

  map.suspend();
  const hidden = message("hidden-while-suspended");
  map.onMessage(hidden, false);
  map.setSnapshot(sessions, channels, []);
  assert.deepEqual(packetCells(map.frame(CITY_SIZE)), [], "returning to the map does not resurrect packets from before or during suspension");
  map.onMessage(hidden, true);
  assert.deepEqual(packetCells(map.frame(CITY_SIZE)), [], "re-delivering the hidden event after return does not animate history");

  map.onMessage(message("fresh-after-return"), true);
  map.step(700);
  const fresh = map.frame(CITY_SIZE);
  assert.ok(packetCells(fresh).some((p) => Math.abs(p.column - 64) <= 1 && Math.abs(p.row - 22) <= 1),
    "fresh traffic after return is followed normally");
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
