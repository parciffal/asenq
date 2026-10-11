import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appearanceOf, identityHash } from "../src/viz/appearance.js";
import type { Appearance, Pose } from "../src/viz/appearance.js";
import { CharacterAnimator, poseFor } from "../src/viz/animate.js";
import { compactPixels, detailedPixels } from "../src/viz/cast.js";
import { DEFAULT_VIZ_SETTINGS, readVizSettings } from "../src/viz/settings.js";
import { rasterize, shade } from "../src/viz/sprites.js";
import type { CityCharacter, RoutePath } from "../src/viz/types.js";

function character(overrides: Partial<CityCharacter> = {}): CityCharacter {
  return { id: "stable-session", name: "first", previousNames: [], source: "registered", harness: "claude", role: null, state: "live", stale: false, ping: null, busy: null, cpu: null, cwd: null, memberships: [], lastSeen: null, ...overrides };
}
const poses: readonly Pose[] = ["idle_a", "idle_b", "walk_a", "walk_b", "work_a", "work_b", "send_a", "send_b"];

test("appearance stays identity-stable across renames, reconnects and availability changes", () => {
  const first = character();
  const renamed = character({ name: "renamed", previousNames: ["first"], busy: true, state: "gone" });
  const reconnected = character({ name: "renamed", memberships: ["one", "two"], state: "live" });
  const expected = appearanceOf(first, DEFAULT_VIZ_SETTINGS);
  for (const c of [renamed, reconnected]) {
    assert.deepEqual(appearanceOf(c, DEFAULT_VIZ_SETTINGS), expected);
    assert.deepEqual(compactPixels(appearanceOf(c, DEFAULT_VIZ_SETTINGS), "idle_a", "compact"), compactPixels(expected, "idle_a", "compact"));
  }
  for (const harness of ["claude", "omp", "opencode"] as const) {
    const a = appearanceOf(character({ harness }), DEFAULT_VIZ_SETTINGS);
    assert.equal(a.outfit, "neutral");
    assert.equal(a.reason, "no-model-metadata");
  }
});

test("only explicit mappings choose provider costumes; session overrides harness and processes never take session mappings", () => {
  const settings = { reducedMotion: false, sessions: { "stable-session": "qwen", "proc:7": "gemini" }, harnesses: { claude: "claude", codex: "codex" } } as const;
  assert.equal(appearanceOf(character(), settings).outfit, "qwen");
  assert.equal(appearanceOf(character(), settings).reason, "session-mapping");
  assert.equal(appearanceOf(character({ id: "another" }), settings).outfit, "claude");
  assert.equal(appearanceOf(character({ id: "another", harness: "omp" }), settings).outfit, "neutral");
  assert.equal(appearanceOf(character({ id: "proc:7", source: "process", harness: "codex" }), settings).outfit, "codex");
  assert.equal(appearanceOf(character({ id: "human", source: "human", harness: null }), settings).outfit, "operator");
  assert.equal(appearanceOf(character({ id: "human", source: "human", harness: null }), settings).variant, 0);
});

test("settings skip invalid individual values while preserving good mappings and report the first JSON path", () => {
  const home = mkdtempSync(join(tmpdir(), "asenq-viz-settings-"));
  const previous = process.env.ASENQ_HOME;
  process.env.ASENQ_HOME = home;
  try {
    assert.deepEqual(readVizSettings(), { settings: DEFAULT_VIZ_SETTINGS, warning: null });
    writeFileSync(join(home, "viz.json"), "{");
    assert.deepEqual(readVizSettings(), { settings: DEFAULT_VIZ_SETTINGS, warning: "viz.json: invalid JSON" });
    writeFileSync(join(home, "viz.json"), JSON.stringify({ reducedMotion: true, ignored: true, appearance: { sessions: { bad: "invented", good: "llama" }, harnesses: { claude: "claude", omp: 8, unknown: "bad" } } }));
    const result = readVizSettings();
    assert.equal(result.settings.reducedMotion, true);
    assert.equal(result.warning, "viz.json: appearance.sessions.bad: expected outfit claude|codex|gemini|qwen|llama|mistral|neutral");
    assert.equal(appearanceOf(character({ id: "good" }), result.settings).outfit, "llama");
    assert.equal(appearanceOf(character({ id: "bad" }), result.settings).outfit, "claude");
    assert.equal(appearanceOf(character({ harness: "omp" }), result.settings).outfit, "neutral");
    writeFileSync(join(home, "viz.json"), JSON.stringify({ reducedMotion: "yes", appearance: { sessions: { "stable-session": "qwen" } } }));
    const partial = readVizSettings();
    assert.equal(partial.settings.reducedMotion, false);
    assert.equal(partial.warning, "viz.json: reducedMotion: expected boolean");
    assert.equal(appearanceOf(character(), partial.settings).outfit, "qwen");
    writeFileSync(join(home, "viz.json"), JSON.stringify({ appearance: [] }));
    assert.equal(readVizSettings().warning, "viz.json: appearance: expected object");
    writeFileSync(join(home, "viz.json"), JSON.stringify({ appearance: { sessions: null, harnesses: { omp: "mistral" } } }));
    const malformedGroup = readVizSettings();
    assert.equal(malformedGroup.warning, "viz.json: appearance.sessions: expected object");
    assert.equal(appearanceOf(character({ harness: "omp" }), malformedGroup.settings).outfit, "mistral");
  } finally {
    if (previous === undefined) delete process.env.ASENQ_HOME; else process.env.ASENQ_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

test("each outfit and variant has all poses with readable half-block silhouettes at every size", () => {
  for (const outfit of ["claude", "codex", "gemini", "qwen", "llama", "mistral", "neutral", "operator"] as const) {
    for (let variant = 0; variant < (outfit === "operator" ? 1 : 6); variant++) for (const pose of poses) {
      const a: Appearance = { outfit, variant, reason: outfit === "operator" ? "operator" : "session-mapping" };
      for (const [pixels, width, height] of [[compactPixels(a, pose, "compact"), 7, 4], [compactPixels(a, pose, "mini"), 3, 2], [detailedPixels(a, pose), 20, 12]] as const) {
        const cells = rasterize(pixels, "live", false);
        assert.equal(cells.length, height);
        assert.ok(cells.every((row) => row.length === width));
        assert.ok(cells.flat().some((cell) => cell !== null));
        assert.ok(cells.flat().every((cell) => cell === null || ["█", "▀", "▄"].includes(cell.ch)));
      }
    }
  }
});

test("compact operator retains polo, side-swept hair, stubble, yellow trim and cyan wrist terminal", () => {
  const a: Appearance = { outfit: "operator", variant: 0, reason: "operator" };
  for (const pose of poses) {
    const pixels = compactPixels(a, pose, "compact");
    const colors = new Set(pixels.flat());
    for (const color of ["#1e1a1a", "#8a6a52", "#f0eee8", "#2f3036", "#f5c518", "#2fd6e6"]) assert.ok(colors.has(color), `${pose} retains ${color}`);
  }
});

test("rasterizer preserves transparent scenery and both pixel colors, tones and NO_COLOR silhouettes", () => {
  const pixels = [[null, "#ff0000", null, "#00ff00", "#ff0000"], [null, null, "#0000ff", "#00ff00", "#0000ff"]];
  assert.deepEqual(rasterize(pixels, "live", true), [[null, { ch: "▀", fg: "#ff0000" }, { ch: "▄", fg: "#0000ff" }, { ch: "█", fg: "#00ff00" }, { ch: "▀", fg: "#ff0000", bg: "#0000ff" }]]);
  assert.deepEqual(rasterize(pixels, "live", false), [[null, { ch: "▀" }, { ch: "▄" }, { ch: "█" }, { ch: "█" }]]);
  assert.deepEqual(rasterize([["#ff0000"], [null]], "offline", true), [[{ ch: "▀", fg: shade("#ff0000", 0.55) }]]);
});

test("busy alternates, idle blinks only in its identity phase window, unknown stays static, reduced motion suppresses both", () => {
  const animator = new CharacterAnimator();
  const busy = character({ busy: true });
  assert.equal(poseFor(busy, animator, 0, "connected", false).pose, "work_a");
  assert.equal(poseFor(busy, animator, 500, "connected", false).pose, "work_b");
  const idle = character({ busy: false });
  const blinkStart = (4000 - identityHash(idle.id) % 4000) % 4000;
  assert.equal(poseFor(idle, animator, blinkStart, "connected", false).pose, "idle_b");
  assert.equal(poseFor(idle, animator, blinkStart + 199, "connected", false).pose, "idle_b");
  assert.equal(poseFor(idle, animator, blinkStart + 200, "connected", false).pose, "idle_a");
  for (const c of [character(), idle, busy]) {
    assert.deepEqual(poseFor(c, animator, 0, "connected", true), poseFor(c, animator, 4500, "connected", true));
  }
  const unknown = character();
  assert.equal(poseFor(unknown, animator, 0, "connected", false).label, "UNKNOWN ?");
  assert.deepEqual(poseFor(unknown, animator, 0, "connected", false), poseFor(unknown, animator, 12345, "connected", false));
});

const route: RoutePath = { length: 40, segments: [{ from: { x: 0, y: 0 }, to: { x: 20, y: 0 }, start: 0, length: 20 }, { from: { x: 20, y: 0 }, to: { x: 20, y: 20 }, start: 20, length: 20 }] };

test("walk follows the segmented route and overrides send/busy only until actual relocation finishes", () => {
  const animator = new CharacterAnimator();
  const c = character({ busy: true });
  animator.walk(c.id, route, 0);
  animator.send(c.id, 0);
  assert.equal(poseFor(c, animator, 0, "connected", false).pose, "walk_a");
  assert.equal(poseFor(c, animator, 250, "connected", false).pose, "walk_b");
  assert.deepEqual(animator.position(c.id, 500), { x: 10, y: 0 });
  assert.deepEqual(animator.position(c.id, 1500), { x: 20, y: 10 });
  assert.equal(animator.position(c.id, 2000), null);
  assert.equal(poseFor(c, animator, 2000, "connected", false).pose, "work_a");
  animator.advance(2000);
  assert.equal(animator.size, 0);
  animator.walk(c.id, route, 3000);
  assert.notEqual(poseFor(c, animator, 3500, "connected", true).label, "MOVING");
  animator.prune(new Set());
  assert.equal(animator.size, 0);
});

test("send lasts exactly 800 map-clock ms, reduced motion holds one gesture, prune and suspension clear state", () => {
  const animator = new CharacterAnimator();
  const c = character();
  animator.send(c.id, 1000);
  assert.equal(poseFor(c, animator, 1000, "connected", false).pose, "send_a");
  assert.equal(poseFor(c, animator, 1400, "connected", false).pose, "send_b");
  assert.equal(poseFor(c, animator, 1799, "connected", true).pose, "send_a");
  assert.equal(poseFor(c, animator, 1800, "connected", false).pose, "idle_a");
  assert.equal(poseFor(c, animator, 1800, "connected", false).label, "UNKNOWN ?");
  animator.advance(1800);
  assert.equal(animator.size, 0);
  animator.send(c.id, 2000);
  animator.walk(c.id, route, 2000);
  animator.clear();
  assert.equal(animator.size, 0);
  assert.equal(animator.position(c.id, 2050), null);
});

test("offline, gone/removed and lost take precedence; processes never animate and operator is not reported busy", () => {
  const animator = new CharacterAnimator();
  const c = character({ busy: true });
  animator.send(c.id, 0);
  animator.walk(c.id, route, 0);
  for (const clock of [0, 500, 1500]) assert.deepEqual(poseFor(c, animator, clock, "offline", false), { pose: "idle_a", tone: "offline", label: "OFFLINE" });
  for (const state of ["gone", "removed"] as const) assert.deepEqual(poseFor(character({ state, busy: true }), animator, 0, "connected", false), { pose: "idle_a", tone: "gone", label: state.toUpperCase() });
  for (const lost of [{ state: "stale" as const }, { stale: true }, { ping: "not_responding" as const }]) assert.deepEqual(poseFor(character(lost), animator, 0, "connected", false), { pose: "idle_a", tone: "lost", label: "LOST" });
  const process = character({ source: "process", cpu: 8.5 });
  assert.deepEqual(poseFor(process, animator, 0, "connected", false), { pose: "idle_a", tone: "dim", label: "CPU 8.5% (inferred)" });
  assert.equal(poseFor(character({ source: "human", id: "human", busy: true }), animator, 0, "connected", true).label, "OPERATOR");
});
