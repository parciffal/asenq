import assert from "node:assert/strict";
import { test } from "node:test";
import { sanitizeTerminalText, terminalTextWidth, truncateTerminalText } from "../src/tui/terminal.js";
import type { TerminalLine, TerminalSize } from "../src/tui/terminal.js";
import { CharacterAnimator } from "../src/viz/animate.js";
import { appearanceOf } from "../src/viz/appearance.js";
import { CityPlacement, matchingTargets, routePoints, targetKey } from "../src/viz/place.js";
import { mapRegion, renderScene } from "../src/viz/scene.js";
import { DEFAULT_VIZ_SETTINGS } from "../src/viz/settings.js";
import type { CityCharacter, CityLayout, CityRenderContext, CityTarget, CityVenue, FeedLine, Packet, VizUi, World } from "../src/viz/types.js";

const SIZES: TerminalSize[] = [{ columns: 160, rows: 48 }, { columns: 80, rows: 24 }, { columns: 40, rows: 16 }, { columns: 1, rows: 1 }];
const lineText = (line: TerminalLine): string => typeof line === "string" ? line : line.map((span) => span.text).join("");
function character(id: string, patch: Partial<CityCharacter> = {}): CityCharacter {
  return { id, name: id, source: "registered", harness: "omp", role: null, previousNames: [], memberships: [], state: "live", ping: null, stale: false, busy: null, cpu: null, cwd: "/work/project", lastSeen: null, ...patch };
}
function venue(name: string, roster: CityCharacter[] = []): CityVenue {
  return { key: name, name, appearance: "office", roster, postCount: 0 };
}
function fixture(): { world: World; layout: CityLayout; placement: CityPlacement } {
  const human = character("human", { name: "operator", source: "human", harness: null, busy: false });
  const alpha = character("alpha", { name: "alpha-unset", harness: "claude", memberships: ["ops", "release"] });
  const worker = character("worker", { role: "worker", name: "street-worker" });
  const proc = character("proc:99", { name: "codex-99", source: "process", harness: "codex", pid: 99, state: null, stale: null, cpu: 7 });
  const world: World = { characters: [human, alpha, worker, proc], venues: [venue("empty"), venue("ops", [alpha]), venue("release", [alpha])], connection: "connected", feed: [] };
  const placement = new CityPlacement();
  return { world, layout: placement.update(world), placement };
}
function ui(patch: Partial<VizUi> = {}): VizUi {
  return { selected: null, filter: null, focus: false, processes: true, viewport: { x: 0, y: -16, zoom: 1 }, search: false, query: "", results: [], searchCursor: 0, inspector: "normal", inspectorScroll: 0, follow: false, notice: null, ...patch };
}
function context(world: World, patch: Partial<CityRenderContext> = {}): CityRenderContext {
  return { appearances: new Map(world.characters.map((c) => [c.id, appearanceOf(c, DEFAULT_VIZ_SETTINGS)])), animator: new CharacterAnimator(), clock: 0, reducedMotion: false, color: true, settingsWarning: null, ...patch };
}
function render(world: World, layout: CityLayout, view = ui(), size = SIZES[0], ctx = context(world), packets: Packet[] = [], embedded = false) {
  return renderScene(world, layout, packets, view, 0, size, 1_000_000, embedded, ctx);
}
function rows(world: World, layout: CityLayout, view = ui(), size = SIZES[0], ctx = context(world)): string[] {
  return render(world, layout, view, size, ctx).frame.lines.map(lineText);
}
function cityText(world: World, layout: CityLayout, view = ui(), size = SIZES[0]): string {
  const region = mapRegion(size);
  return rows(world, layout, view, size).slice(region.y, region.y + region.height).map((row) => truncateTerminalText(row, region.width)).join("\n");
}
function allInspectorText(world: World, layout: CityLayout, selected: CityTarget, patch: Partial<VizUi> = {}, size = SIZES[2]): string {
  const first = render(world, layout, ui({ selected, inspector: "focused", ...patch }), size);
  const pages: string[] = [];
  for (let scroll = 0; scroll <= (first.inspectorLength ?? 0); scroll++) pages.push(rows(world, layout, ui({ selected, inspector: "focused", ...patch, inspectorScroll: scroll }), size).join("\n"));
  return pages.join("\n");
}

test("named empty venues and one canonical character with secondary membership are visible", () => {
  const { world, layout } = fixture();
  const scene = render(world, layout);
  const text = scene.frame.lines.map(lineText).join("\n");
  assert.ok(text.includes("#empty") && text.includes("EMPTY"));
  assert.ok(text.includes("alpha-unset") && text.includes("@"));
  assert.ok(text.includes("2 SESSIONS"), "markers and processes do not increase the registered identity count");
  assert.ok(scene.hits.some((h) => h.target.kind === "character" && h.target.id === "alpha"));
  assert.ok(scene.hits.some((h) => h.target.kind === "membership" && h.target.id === "alpha"));
  assert.ok(text.includes("CC [-] UNKNOWN"));
  assert.ok(text.includes("street-worker"));
  const empty = world.venues.find((v) => v.name === "empty")!;
  const inspector = allInspectorText(world, layout, { kind: "venue", venueKey: empty.key });
  assert.ok(inspector.includes("0 MEMBERS") && inspector.includes("POSTS 0"));
});

test("every layout including 1x1 emits bounded rows and clipped target hits", () => {
  const { world, layout } = fixture();
  for (const size of [...SIZES, { columns: 60, rows: 20 }, { columns: 109, rows: 26 }, { columns: 110, rows: 26 }]) {
    for (const embedded of [false, true]) for (const inspector of ["normal", "focused"] as const) {
      const scene = render(world, layout, ui({ selected: { kind: "character", id: "alpha" }, inspector }), size, context(world), [], embedded);
      assert.equal(scene.frame.lines.length, size.rows);
      for (const row of scene.frame.lines) assert.ok(terminalTextWidth(lineText(row)) <= size.columns);
      for (const h of scene.hits) {
        assert.ok(h.column >= 0 && h.row >= 0 && h.width > 0 && h.height > 0);
        assert.ok(h.column + h.width <= size.columns && h.row + h.height <= size.rows);
      }
      assert.ok(!scene.frame.lines.map(lineText).join("\n").includes("TOO SMALL"));
    }
  }
});

test("narrow inspection reaches every target instead of silently dropping offscreen identities", () => {
  const { world, placement } = fixture();
  for (let i = 0; i < 100; i++) {
    const c = character(`far-${i}`, { memberships: [`channel-${i}`] });
    world.characters.push(c); world.venues.push(venue(`channel-${i}`, [c]));
  }
  const layout = placement.update(world);
  for (const size of [SIZES[2], SIZES[3]]) {
    for (const { target } of matchingTargets(world, layout, ui())) {
      const scene = render(world, layout, ui({ selected: target }), size);
      const text = scene.frame.lines.map(lineText).join("\n");
      if (size.columns > 1) {
        const name = target.kind === "venue" ? world.venues.find((v) => v.key === target.venueKey)!.name : world.characters.find((c) => c.id === target.id)!.name;
        assert.ok(text.includes(name), `selected ${targetKey(target)} remains inspectable`);
        assert.ok(text.includes(`${layout.targets.length} TOTAL`));
      } else assert.ok(scene.hits.some((h) => targetKey(h.target) === targetKey(target)));
    }
  }
});

test("filtering preserves venue anchors while inspector exposes filtered roster identities", () => {
  const { world, placement } = fixture();
  const other = character("other", { harness: "opencode", memberships: ["ops"], role: "orchestrator" });
  world.characters.push(other); world.venues.find((v) => v.name === "ops")!.roster.push(other);
  const layout = placement.update(world);
  const scene = render(world, layout, ui({ filter: "claude", processes: false }));
  assert.ok(scene.hits.some((h) => h.target.kind === "character" && h.target.id === "alpha"));
  assert.ok(!scene.hits.some((h) => h.target.kind !== "venue" && h.target.id === "other"));
  for (const venue of world.venues) {
    assert.ok(scene.hits.some((h) => h.target.kind === "venue" && h.target.venueKey === venue.key));
    assert.ok(cityText(world, layout, ui({ filter: "claude", processes: false })).includes(`#${venue.name}`));
  }
  const ops = world.venues.find((v) => v.name === "ops")!;
  const text = allInspectorText(world, layout, { kind: "venue", venueKey: ops.key }, { filter: "claude" });
  assert.ok(text.includes("other") && text.includes("FILTERED") && text.includes("[O]"));
  const retained = allInspectorText(world, layout, { kind: "character", id: "other" }, { filter: "claude" });
  assert.ok(retained.includes("SOURCE REGISTERED · FILTERED"));
});

test("membership inspection uses the same identity metadata and all canonical home information", () => {
  const { world, layout } = fixture();
  const release = world.venues.find((v) => v.name === "release")!;
  const text = allInspectorText(world, layout, { kind: "membership", id: "alpha", venueKey: release.key });
  assert.ok(text.includes("alpha-unset") && text.includes("ROLE unset"));
  assert.ok(text.includes("#ops · HOME") && text.includes("#release · secondary"));
  assert.ok(text.includes("CONTACT unknown") && text.includes("BUSY UNKNOWN ?"));
  assert.ok(text.includes("MODEL unknown (not reported)"));
  assert.ok(text.includes("no model metadata"));
});

test("large venue roster pagination and roster hits retain every member", () => {
  const members = Array.from({ length: 27 }, (_, i) => character(`member-${i.toString().padStart(2, "0")}`, { memberships: ["tower"] }));
  const world: World = { characters: members, venues: [venue("tower", members)], feed: [], connection: "connected" };
  const layout = new CityPlacement().update(world);
  const selected: CityTarget = { kind: "venue", venueKey: world.venues[0].key };
  const text = allInspectorText(world, layout, selected);
  assert.ok(text.includes("27 MEMBERS"));
  for (const member of members) assert.ok(text.includes(member.name), member.name);
  const last = render(world, layout, ui({ selected, inspector: "focused", inspectorScroll: 30 }), SIZES[2]);
  assert.ok(last.hits.some((h) => h.priority === 10 && h.target.kind === "membership" && h.target.id === "member-26"));
});

test("resize filter and zoom only change the view; stable room coordinates stay visible after returning", () => {
  const { world, layout, placement } = fixture();
  const before = render(world, layout);
  for (const size of SIZES) for (const zoom of [1, 2, 4] as const) render(world, layout, ui({ filter: "omp", viewport: { x: 30, y: -10, zoom } }), size);
  assert.deepEqual(render(world, layout).frame, before.frame);
  const old = before.hits.find((h) => h.target.kind === "character" && h.target.id === "alpha")!;
  world.characters.push(character("new-street"));
  const after = render(world, placement.update(world));
  assert.deepEqual(after.hits.find((h) => h.target.kind === "character" && h.target.id === "alpha"), old);
});

test("top floors of expanding towers are renderable by panning without relocating the ground room", () => {
  const members = Array.from({ length: 27 }, (_, i) => character(`m${i.toString().padStart(2, "0")}`, { memberships: ["tower"] }));
  const world: World = { characters: members, venues: [venue("tower", members)], feed: [], connection: "connected" };
  const layout = new CityPlacement().update(world);
  const top = cityText(world, layout, ui({ viewport: { x: 0, y: -146, zoom: 1 } }));
  assert.ok(top.includes("m26"));
  const ground = cityText(world, layout);
  assert.ok(ground.includes("m00") && !ground.includes("m26"));
});

test("mini and no-color sprites remain silhouettes with explicit bracketed selection", () => {
  const { world, layout } = fixture();
  for (const zoom of [1, 2] as const) {
    const view = ui({ selected: { kind: "character", id: "alpha" }, viewport: { x: 40, y: -16, zoom } });
    const scene = render(world, layout, view, SIZES[0], context(world, { color: false }));
    const city = scene.frame.lines.map(lineText).slice(2, 2 + mapRegion(SIZES[0]).height).map((s) => s.slice(0, 128)).join("\n");
    assert.match(city, /[█▀▄]/);
    assert.match(city, /\[[a-z][^\]\n]*\]/, "the selected name has complete brackets at either sprite scale");
  }
});

test("walking sprite and selection hit follow the same interpolated position", () => {
  const { world, layout } = fixture();
  const animator = new CharacterAnimator();
  animator.walk("alpha", routePoints([{ x: 54, y: -12 }, { x: 54, y: 0 }, { x: 102, y: 0 }, { x: 102, y: -12 }]), 0);
  const a = render(world, layout, ui(), SIZES[0], context(world, { animator, clock: 500 }));
  const b = render(world, layout, ui(), SIZES[0], context(world, { animator, clock: 1000 }));
  const alphaHit = (scene: typeof a) => scene.hits.find((h) => h.target.kind === "character" && h.target.id === "alpha")!;
  assert.notEqual(alphaHit(a).column, alphaHit(b).column);
  assert.ok(b.frame.lines.map(lineText).join("\n").includes("MOVING"));
  const reduced = render(world, layout, ui(), SIZES[0], context(world, { animator, clock: 1000, reducedMotion: true }));
  const stationary = render(world, layout);
  assert.equal(alphaHit(reduced).column, alphaHit(stationary).column);
});

test("offline frames are static and show stale snapshot instead of inferred live animation", () => {
  const { world, layout } = fixture();
  world.connection = "offline";
  const animator = new CharacterAnimator(); animator.send("alpha", 0);
  const a = render(world, layout, ui({ selected: { kind: "character", id: "alpha" } }), SIZES[0], context(world, { animator, clock: 0 }));
  const b = render(world, layout, ui({ selected: { kind: "character", id: "alpha" } }), SIZES[0], context(world, { animator, clock: 700 }));
  assert.deepEqual(a.frame, b.frame);
  const text = a.frame.lines.map(lineText).join("\n");
  assert.ok(text.includes("SIGNAL LOST / STALE SNAPSHOT") && text.includes("OFFLINE"));
});

test("notices warn about history gaps invalid settings and reduced motion", () => {
  const { world, layout } = fixture();
  const text = rows(world, layout, ui({ notice: "HISTORY GAP" }), SIZES[0], context(world, { reducedMotion: true, settingsWarning: "viz.json: appearance.sessions.alpha: invalid outfit" })).join("\n");
  assert.ok(text.includes("HISTORY GAP") && text.includes("REDUCED MOTION") && text.includes("viz.json:"));
});

test("observed feed distinguishes channel posts from direct messages and renders newest kinds", () => {
  const { world, layout } = fixture();
  const feed: FeedLine[] = Array.from({ length: 50 }, (_, i) => ({ seq: i, at: i, fromId: "alpha", toId: "worker", from: "alpha-unset", to: "street-worker", kind: "chat", text: `record-${i}` }));
  feed[48] = { ...feed[48], channel: "ops", toId: null, kind: "task" };
  feed[49] = { ...feed[49], kind: "control" };
  world.feed = feed;
  const text = rows(world, layout).join("\n");
  assert.ok(text.includes("[TASK] POST #ops") && text.includes("[CTRL] DM"));
  assert.ok(text.includes("record-49") && !text.includes("record-0 "));
});

test("actual packet paths render braille traffic only while connected and alive", () => {
  const { world, layout } = fixture();
  const packet: Packet = { seq: 1, from: { kind: "character", id: "human" }, to: { kind: "venue", venueKey: world.venues[0].key }, kind: "task", ageMs: 700, path: routePoints([{ x: 4, y: 0 }, { x: 20, y: 0 }]) };
  const text = render(world, layout, ui(), SIZES[0], context(world), [packet]).frame.lines.map(lineText).join("\n");
  assert.match(text, /[⠁⠂⠄⡀]/);
  packet.ageMs = 1400;
  assert.doesNotMatch(render(world, layout, ui(), SIZES[0], context(world), [packet]).frame.lines.map(lineText).join("\n"), /[⠁⠂⠄⡀]/);
  world.connection = "offline"; packet.ageMs = 700;
  assert.doesNotMatch(render(world, layout, ui(), SIZES[0], context(world), [packet]).frame.lines.map(lineText).join("\n"), /[⠁⠂⠄⡀]/);
});

test("hostile Unicode labels messages and paths remain safe at both viewport edges", () => {
  const { world, placement } = fixture();
  const hostile = "\u001b[31m漢字\u001b[0m\u001b]0;bad\u0007\u202e\u009b\n🙂e\u0301";
  world.characters[1].name = hostile.repeat(10);
  world.characters[1].cwd = hostile.repeat(20);
  world.characters[1].previousNames = [hostile];
  world.feed = [{ seq: 1, at: 0, fromId: "alpha", toId: "worker", from: hostile, to: hostile, kind: "control", text: hostile }];
  const layout = placement.update(world);
  for (const size of SIZES) for (const x of [0, 54, 55, 56]) {
    const scene = render(world, layout, ui({ selected: { kind: "character", id: "alpha" }, viewport: { x, y: -16, zoom: 1 } }), size);
    for (const line of scene.frame.lines) {
      const text = lineText(line);
      assert.equal(sanitizeTerminalText(text), text);
      assert.doesNotMatch(text, /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/);
      assert.ok(terminalTextWidth(text) <= size.columns);
      if (typeof line !== "string") for (const span of line) assert.doesNotMatch(span.text, /^\p{Mark}/u, "no orphan combining mark in styled spans");
    }
  }
});

test("search lists wrap long real names and show explicit no match without losing selection", () => {
  const { world, layout } = fixture();
  const targets = matchingTargets(world, layout, ui()).map((p) => p.target);
  const view = ui({ search: true, query: "alpha", results: targets, searchCursor: targets.length - 1 });
  const scene = render(world, layout, view, SIZES[2]);
  assert.ok(scene.hits.some((h) => targetKey(h.target) === targetKey(targets.at(-1)!)));
  const none = rows(world, layout, ui({ search: true, query: "missing", results: [], selected: { kind: "character", id: "alpha" } }), SIZES[2]).join("\n");
  assert.ok(none.includes("NO MATCH") && none.includes("selection retained"));
});

test("venue inspection retains full real names and an offscreen selection has a minimap direction", () => {
  const world: World = { characters: [], venues: ["channel-alpha", "channel-beta", "channel-gamma", "channel-omega"].map((name) => venue(name)), feed: [], connection: "connected" };
  const layout = new CityPlacement().update(world);
  for (const channel of world.venues) {
    const text = allInspectorText(world, layout, { kind: "venue", venueKey: channel.key });
    assert.ok(text.includes(channel.name));
  }
  const far = world.venues.find((v) => v.name === "channel-omega")!;
  const inspected = rows(world, layout, ui({ selected: { kind: "venue", venueKey: far.key } }));
  const region = mapRegion(SIZES[0]);
  const inspector = inspected.slice(region.y, region.y + region.height).map((row) => row.slice(region.width)).join("\n");
  assert.ok(inspector.includes("[#channel-omega]"));
  assert.ok(inspector.includes("→"), "the actual offscreen venue is indicated in the minimap");
});

test("removed roster identities retain honest unknown contact and busy metadata", () => {
  const removed = character("archived", { name: "former-member", state: "removed", stale: null, busy: null, lastSeen: null, cwd: null, memberships: ["archive"] });
  const world: World = { characters: [removed], venues: [venue("archive", [removed])], feed: [], connection: "connected" };
  const layout = new CityPlacement().update(world);
  const text = allInspectorText(world, layout, { kind: "character", id: removed.id });
  assert.ok(text.includes("REMOVED"));
  assert.ok(text.includes("BUSY UNKNOWN ?") && text.includes("CONTACT unknown") && text.includes("CWD unknown"));
});

test("process inspection identifies detection and CPU inference, never membership or registration", () => {
  const { world, layout } = fixture();
  const text = allInspectorText(world, layout, { kind: "character", id: "proc:99" });
  assert.ok(text.includes("SOURCE PROCESS") && text.includes("PID 99") && text.includes("CPU 7% (inferred)"));
  assert.ok(text.includes("No registered memberships") && text.includes("not registration"));
});

test("reduced motion busy and unknown city sprites do not vary with clock steps", () => {
  const { world, layout } = fixture();
  world.characters[1].busy = true;
  const a = render(world, layout, ui(), SIZES[0], context(world, { reducedMotion: true, clock: 0 }));
  const b = render(world, layout, ui(), SIZES[0], context(world, { reducedMotion: true, clock: 550 }));
  assert.deepEqual(a.frame, b.frame);
  assert.ok(a.frame.lines.map(lineText).join("\n").includes("BUSY"));
});


test("compressed rooms keep neighboring glyphs and labels separate across floor and viewport boundaries", () => {
  const members = ["a", "b", "c", "d"].map((id) => character(id, { name: id.repeat(18), memberships: ["venue-long-real-name", "secondary-real-name"] }));
  const world: World = { characters: members, venues: [venue("venue-long-real-name", members), venue("secondary-real-name", members)], feed: [], connection: "connected" };
  const layout = new CityPlacement().update(world);
  for (const zoom of [1, 2, 4] as const) for (const x of [0, 1, 2, 3]) {
    const scene = render(world, layout, ui({ viewport: { x, y: -36, zoom } }));
    const region = mapRegion(SIZES[0]);
    const filtered = render(world, layout, ui({ filter: "codex", viewport: { x, y: -36, zoom } }));
    for (let row = region.y; row < region.y + region.height; row++) {
      const sign = truncateTerminalText(lineText(filtered.frame.lines[row]), region.width);
      if (sign.includes("#")) assert.equal(truncateTerminalText(lineText(scene.frame.lines[row]), region.width), sign, "canonical sprites and secondary markers never overwrite venue names or cues");
    }
    const local = scene.hits.filter((h) => h.priority !== 10 && h.target.kind !== "venue");
    for (const member of members) {
      assert.ok(local.some((h) => h.target.kind === "character" && h.target.id === member.id), `canonical ${member.id} at zoom ${zoom}`);
      assert.ok(local.some((h) => h.target.kind === "membership" && h.target.id === member.id), `secondary ${member.id} at zoom ${zoom}`);
    }
    for (let i = 0; i < local.length; i++) for (let j = i + 1; j < local.length; j++) {
      const a = local[i], b = local[j];
      if (targetKey(a.target) === targetKey(b.target)) continue;
      assert.ok(a.column + a.width <= b.column || b.column + b.width <= a.column || a.row + a.height <= b.row || b.row + b.height <= a.row, "different targets never overwrite one another's drawn glyph/label cells");
    }
    const text = scene.frame.lines.slice(region.y, region.y + region.height).map((row) => truncateTerminalText(lineText(row), region.width)).join("\n");
    for (const id of ["a", "b", "c", "d"]) assert.ok(text.includes(id.repeat(2)), `readable name prefix for ${id}`);
    assert.ok(text.includes("@"), "secondary membership stays visibly distinct from a canonical character");
    for (const row of scene.frame.lines) assert.ok(terminalTextWidth(lineText(row)) <= SIZES[0].columns);
  }
});

test("selected Unicode names keep whole brackets without painting over neighboring glyphs", () => {
  const { world, placement } = fixture();
  world.characters[1].name = "\u001b[31m漢字🙂e\u0301\u001b[0m\u202e-long-name";
  const layout = placement.update(world);
  for (const zoom of [1, 2, 4] as const) for (const x of [40, 48, 50, 51, 52, 53, 54]) {
    const scene = render(world, layout, ui({ selected: { kind: "character", id: "alpha" }, viewport: { x, y: -16, zoom } }));
    const region = mapRegion(SIZES[0]);
    const selectedText = scene.frame.lines.slice(region.y, region.y + region.height).map((row) => {
      if (typeof row === "string") return "";
      let column = 0, text = "";
      for (const span of row) {
        const available = Math.max(0, region.width - column);
        if (span.style?.foreground === "#f4e45a") text += truncateTerminalText(span.text, available);
        column += terminalTextWidth(span.text);
      }
      return text;
    }).join("\n");
    assert.match(selectedText, /\[[^\]\n]+\]/u, "selection remains a complete bracketed, possibly ellipsized name");
    for (const line of scene.frame.lines) {
      const text = lineText(line);
      assert.equal(sanitizeTerminalText(text), text);
      assert.ok(terminalTextWidth(text) <= SIZES[0].columns);
    }
  }
});

test("compact and focused headers retain target counts without inventing an offscreen number", () => {
  const { world, layout } = fixture();
  for (const size of [SIZES[0], SIZES[2]]) {
    const scene = render(world, layout, ui({ selected: { kind: "character", id: "alpha" }, inspector: "focused" }), size);
    const header = lineText(scene.frame.lines[0]);
    assert.ok(header.includes(`${layout.targets.length} TOTAL`));
    assert.ok(header.includes(`${matchingTargets(world, layout, ui()).length} MATCH`));
    assert.doesNotMatch(header, /\d+ OFF(?:SCREEN)?/);
  }
});

test("every compressed empty venue retains zero occupancy, an entrance and its appearance cue after rename and selection", () => {
  const initialNames = new Map<CityVenue["appearance"], string>();
  for (let i = 0; i < 100 && initialNames.size < 5; i++) {
    const world: World = { characters: [], venues: [venue(`theme-${i}`)], feed: [], connection: "connected" };
    new CityPlacement().update(world);
    initialNames.set(world.venues[0].appearance, world.venues[0].name);
  }
  assert.equal(initialNames.size, 5, "fixtures include all five real allocated venue types");
  for (const zoom of [1, 2, 4] as const) for (const selected of [false, true]) {
    const cues: string[] = [];
    for (const initialName of initialNames.values()) {
      const world: World = { characters: [], venues: [venue(initialName)], feed: [], connection: "connected" };
      const placement = new CityPlacement();
      placement.update(world);
      placement.renameChannel(initialName, "operations-control-plane-with-a-very-long-real-name");
      world.venues[0].name = "operations-control-plane-with-a-very-long-real-name";
      const layout = placement.update(world);
      const view = ui({ selected: selected ? { kind: "venue", venueKey: world.venues[0].key } : null, viewport: { x: 0, y: -16, zoom } });
      const text = cityText(world, layout, view);
      assert.match(text, /(?:EMPTY|∅).*0/);
      assert.ok(text.includes("╥"), "the real entrance remains available at every zoom");
      if (selected) assert.match(text, /\[#[^\]\n]+\]/);
      cues.push(text);
    }
    assert.equal(new Set(cues).size, 5, "identical long names cannot erase distinct venue appearances");
  }
});
