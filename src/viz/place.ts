import { sanitizeTerminalText, terminalTextWidth } from "../tui/terminal.js";
import type { TerminalSize } from "../tui/terminal.js";
import { EYE_ROW, SPRITE_ROWS } from "./sprites.js";
import type { SpriteClass, SpriteMode } from "./sprites.js";
import type { Bug, Edge } from "./types.js";

export const MIN_COLUMNS = 60;
export const MIN_ROWS = 20;
const HEADER_ROWS = 2;
const CLUSTER_GAP = 2;
const MAX_HUMAN_W = 30;

/** Rows reserved for the bottom HUD (two panels plus the key line). */
export function hudHeight(rows: number): number {
  return rows <= 24 ? 7 : rows <= 32 ? 8 : rows <= 44 ? 9 : 10;
}

const ASCII_ONLY = /^[\x20-\x7e]*$/;
const nameCache = new Map<string, { text: string; width: number }>();

/** Display width of untrusted text after sanitizing. */
export function textWidth(text: string): number {
  return ASCII_ONLY.test(text) ? text.length : terminalTextWidth(text);
}

/** Sanitized single-line text with its display width; never empty. */
export function cleanLabel(raw: string): { text: string; width: number } {
  let hit = nameCache.get(raw);
  if (hit === undefined) {
    if (nameCache.size > 1024) nameCache.clear();
    const text = sanitizeTerminalText(raw).trim() || "?";
    hit = { text, width: textWidth(text) };
    nameCache.set(raw, hit);
  }
  return hit;
}

/** Level of detail: sprites shrink and finally vanish so every name stays visible on small terminals. */
export interface Level {
  id: 0 | 1 | 2 | 3;
  sprite: SpriteMode;
  plateRows: 1 | 2;
  /** Rows between a parent's bottom and its children's top; the last one is the bus row. */
  gap: number;
  minWs: number;
  minOw: number;
  minHw: number;
}

const LEVELS: readonly Level[] = [
  { id: 3, sprite: "full", plateRows: 2, gap: 2, minWs: 9, minOw: 13, minHw: 15 },
  { id: 2, sprite: "mini", plateRows: 2, gap: 2, minWs: 9, minOw: 13, minHw: 15 },
  { id: 1, sprite: "none", plateRows: 2, gap: 1, minWs: 8, minOw: 10, minHw: 12 },
  { id: 0, sprite: "none", plateRows: 1, gap: 1, minWs: 8, minOw: 10, minHw: 12 },
];
const MAX_WS = 26;
const MAX_OW = 30;

export const classOf = (bug: Bug): SpriteClass =>
  bug.kind === "human" ? "human" : bug.kind === "orchestrator" ? "orch" : "worker";

const heightOf = (lv: Level, cls: SpriteClass): number => SPRITE_ROWS[lv.sprite][cls].length + lv.plateRows;

/** One bug's slot: sprite + plate cells; `lane` is the gutter column links descend through (-1: unlinked). */
export interface Placed {
  bug: Bug;
  cls: SpriteClass;
  x: number;
  y: number;
  w: number;
  h: number;
  lane: number;
  /** Row where links enter this slot (its eye row). */
  eyeY: number;
  /** Rows between this slot's bottom and its children (0 for leaves). */
  gapBelow: number;
}

export interface Route {
  edge: Edge;
  /** Flat cell indexes (y * columns + x) from the parent's stem to the child's entry arrow (last cell). */
  path: number[];
}

export interface Layout {
  level: Level;
  placed: Placed[];
  byId: Map<string, Placed>;
  /** Primary uplink of each linked bug: the id packets climb through when no direct edge exists. */
  parentOf: Map<string, string>;
  routes: Route[];
  routeByKey: Map<string, number[]>;
  /** Label anchor for the feral band. */
  feralLabel: { x: number; y: number; w: number } | null;
  dropped: number;
  sceneTop: number;
  sceneBottom: number;
  columns: number;
}

interface Cluster {
  orch: Bug | null;
  kids: Bug[];
}
interface Groups {
  human: Bug | null;
  clusters: Cluster[];
  ferals: Bug[];
}
interface Built {
  level: Level;
  items: Placed[];
  feralLabel: Layout["feralLabel"];
  /** Workers placed under an orchestrator; a human link into them would cross its sprite. */
  orchKids: Set<string>;
}

function buildGroups(bugs: Bug[], edges: Edge[]): Groups {
  const human = bugs.find((bug) => bug.kind === "human") ?? null;
  const orchs = bugs.filter((bug) => bug.kind === "orchestrator");
  const workers = bugs.filter((bug) => bug.kind === "worker");
  const workerIds = new Set(workers.map((bug) => bug.id));
  const primary = new Map<string, string>();
  for (const orch of orchs) {
    for (const edge of edges) {
      if (edge.from === orch.id && workerIds.has(edge.to) && !primary.has(edge.to)) primary.set(edge.to, orch.id);
    }
  }
  const clusters: Cluster[] = orchs.map((orch) => ({ orch, kids: workers.filter((w) => primary.get(w.id) === orch.id) }));
  const free = workers.filter((w) => !primary.has(w.id));
  if (free.length > 0) clusters.push({ orch: null, kids: free });
  return { human, clusters, ferals: bugs.filter((bug) => bug.kind === "feral") };
}

const clamp = (value: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, value));

function tryLayout(lv: Level, groups: Groups, ws: number, ow: number, hw: number, width: number, height: number, top: number): Built | null {
  const { human, clusters, ferals } = groups;
  const pitch = ws + 2;
  const avail = width - 2;
  const orchRegion = ow + 2;
  const wH = heightOf(lv, "worker");
  const oH = heightOf(lv, "orch");
  const hH = heightOf(lv, "human");
  if (human && hw > avail) return null;

  // Cluster widths: one worker column each, then widen where it saves the most rows.
  const cols = clusters.map((c) => (c.kids.length > 0 ? 1 : 0));
  const widthOf = (i: number, nc: number): number => Math.max(clusters[i].orch ? orchRegion : 0, nc * pitch);
  const widths = clusters.map((_, i) => widthOf(i, cols[i]));
  const n = clusters.length;
  const used = (): number => widths.reduce((a, b) => a + b, 0) + CLUSTER_GAP * Math.max(0, n - 1);
  if (used() > avail) return null;
  for (;;) {
    const spare = avail - used();
    let best = -1;
    let bestRows = 1;
    for (let i = 0; i < n; i++) {
      const k = clusters[i].kids.length;
      if (cols[i] >= k || cols[i] === 0) continue;
      if (widthOf(i, cols[i] + 1) - widths[i] > spare) continue;
      const rows = Math.ceil(k / cols[i]);
      if (rows > bestRows || (rows === bestRows && best >= 0 && k > clusters[best].kids.length)) {
        best = i;
        bestRows = rows;
      }
    }
    if (best < 0) break;
    cols[best]++;
    widths[best] = widthOf(best, cols[best]);
  }

  // Vertical budget.
  const hasOrch = clusters.some((c) => c.orch !== null);
  const hasOrchKids = clusters.some((c) => c.orch !== null && c.kids.length > 0);
  let tier = 0;
  clusters.forEach((c, i) => {
    const rows = c.kids.length > 0 ? Math.ceil(c.kids.length / cols[i]) : 0;
    tier = Math.max(tier, c.orch ? oH + (rows > 0 ? lv.gap + rows * wH : 0) : rows * wH);
  });
  const feralCols = Math.max(1, Math.floor(avail / pitch));
  const feralRows = Math.ceil(ferals.length / feralCols);
  const band = ferals.length > 0 ? 2 + feralRows * wH : 0;
  const humanBlock = human ? hH + (n > 0 ? lv.gap : 0) : 0;
  const total = humanBlock + tier + band;
  if (total > height) return null;
  const gapUses = (human && n > 0 ? 1 : 0) + (hasOrchKids ? 1 : 0);
  const extra = gapUses > 0 ? Math.min(2, Math.floor((height - total) / (gapUses + 1))) : 0;
  const g1 = lv.gap + extra;
  const g2 = lv.gap + extra;

  const items: Placed[] = [];
  const place = (bug: Bug, x: number, y: number, w: number, lane: number, gapBelow: number): void => {
    const cls = classOf(bug);
    items.push({ bug, cls, x, y, w, h: heightOf(lv, cls), lane, eyeY: y + EYE_ROW[lv.sprite][cls], gapBelow });
  };
  if (human) place(human, Math.floor((width - hw) / 2), top, hw, -1, n > 0 ? g1 : 0);
  const tierTop = top + humanBlock + (human && n > 0 ? extra : 0);

  const spare = avail - used();
  const gap = n > 1 ? Math.min(8, CLUSTER_GAP + Math.floor(spare / (n - 1))) : 0;
  const totalWidth = widths.reduce((a, b) => a + b, 0) + gap * Math.max(0, n - 1);
  let x0 = 1 + Math.floor((avail - totalWidth) / 2);
  clusters.forEach((c, i) => {
    const wi = widths[i];
    if (c.orch) {
      const left = x0 + Math.floor((wi - orchRegion) / 2);
      place(c.orch, left + 2, tierTop, ow, left, c.kids.length > 0 ? g2 : 0);
    }
    if (c.kids.length > 0) {
      const gl = x0 + Math.floor((wi - cols[i] * pitch) / 2);
      const kidsTop = c.orch ? tierTop + oH + g2 : tierTop;
      c.kids.forEach((kid, j) => {
        const lane = gl + (j % cols[i]) * pitch;
        place(kid, lane + 2, kidsTop + Math.floor(j / cols[i]) * wH, ws, lane, 0);
      });
    }
    x0 += wi + gap;
  });

  let feralLabel: Built["feralLabel"] = null;
  if (ferals.length > 0) {
    const bandTop = top + height - band;
    const perRow = Math.min(feralCols, ferals.length);
    const gl = 1 + Math.floor((avail - perRow * pitch) / 2);
    feralLabel = { x: gl, y: bandTop + 1, w: perRow * pitch };
    ferals.forEach((bug, j) => place(bug, gl + (j % feralCols) * pitch + 1, bandTop + 2 + Math.floor(j / feralCols) * wH, ws, -1, 0));
  }
  const orchKids = new Set(clusters.flatMap((c) => (c.orch ? c.kids.map((kid) => kid.id) : [])));
  return { level: lv, items, feralLabel, orchKids };
}

function fit(groups: Groups, width: number, height: number, top: number): Built | null {
  const kids = [...groups.clusters.flatMap((c) => c.kids), ...groups.ferals];
  const orchs = groups.clusters.flatMap((c) => (c.orch ? [c.orch] : []));
  const maxKid = kids.reduce((m, b) => Math.max(m, cleanLabel(b.name).width), 0);
  const maxOrch = orchs.reduce((m, b) => Math.max(m, cleanLabel(b.name).width), 0);
  const humanName = groups.human ? cleanLabel(groups.human.name).width : 0;
  const prefs = LEVELS.map((lv) => ({
    ws: clamp(maxKid + 4, lv.minWs, MAX_WS),
    ow: clamp(maxOrch + 4 + (lv.plateRows === 1 ? 2 : 0), lv.minOw, MAX_OW),
    hw: clamp(humanName + 4, lv.minHw, MAX_HUMAN_W),
  }));
  // Prefer showing full names at a coarser level over truncating at a richer one.
  for (let i = 0; i < LEVELS.length; i++) {
    const built = tryLayout(LEVELS[i], groups, prefs[i].ws, prefs[i].ow, prefs[i].hw, width, height, top);
    if (built) return built;
  }
  for (let i = 0; i < LEVELS.length; i++) {
    const lv = LEVELS[i];
    const { ws: wsPref, ow: owPref, hw } = prefs[i];
    for (let shrink = 1; ; shrink++) {
      const ws = Math.max(lv.minWs, wsPref - shrink);
      const ow = Math.max(lv.minOw, owPref - shrink);
      const built = tryLayout(lv, groups, ws, ow, hw, width, height, top);
      if (built) return built;
      if (ws === lv.minWs && ow === lv.minOw) break;
    }
  }
  return null;
}

const keyOf = (from: string, to: string): string => `${from}>${to}`;

function routeEdges(built: Built, edges: Edge[], columns: number): { routes: Route[]; parentOf: Map<string, string> } {
  const byId = new Map(built.items.map((item) => [item.bug.id, item]));
  const routes: Route[] = [];
  const parentOf = new Map<string, string>();
  for (const edge of edges) {
    const parent = byId.get(edge.from);
    const child = byId.get(edge.to);
    if (!parent || !child || child.lane < 0 || parent.gapBelow === 0) continue;
    const busY = parent.y + parent.h - 1 + parent.gapBelow;
    if (child.y <= busY) continue;
    // A human link into an orchestrator's worker would cross that orchestrator's sprite; packets climb through it instead.
    if (parent.cls === "human" && built.orchKids.has(child.bug.id)) continue;
    const px = parent.x + Math.floor(parent.w / 2);
    const cells: number[] = [];
    const push = (x: number, y: number): void => { cells.push(y * columns + x); };
    for (let y = parent.y + parent.h; y <= busY; y++) push(px, y);
    const dx = Math.sign(child.lane - px);
    if (dx !== 0) for (let x = px + dx; x !== child.lane + dx; x += dx) push(x, busY);
    for (let y = busY + 1; y <= child.eyeY; y++) push(child.lane, y);
    push(child.lane + 1, child.eyeY);
    routes.push({ edge, path: cells });
  }
  // Primary uplink: the first routed edge into each bug, orchestrators before the human.
  const ordered = [...routes].sort((a, b) => Number(byId.get(a.edge.from)?.cls === "human") - Number(byId.get(b.edge.from)?.cls === "human"));
  for (const { edge } of ordered) if (!parentOf.has(edge.to)) parentOf.set(edge.to, edge.from);
  return { routes, parentOf };
}

/** Place every bug and route its links. Deterministic in (bugs, edges, size); shared by rendering and navigation. */
export function layoutScene(bugs: Bug[], edges: Edge[], size: TerminalSize): Layout {
  const top = HEADER_ROWS;
  const bottom = size.rows - hudHeight(size.rows);
  const height = bottom - top;
  const groups = buildGroups(bugs, edges);
  const total = bugs.filter((bug) => bug.kind !== "human").length;
  let built = fit(groups, size.columns, height, top);
  let dropped = 0;
  if (!built) {
    // Even the smallest level overflows: shed bugs from the end (ferals, workers, then orchestrators) and keep a marker row.
    const trial: Groups = { human: groups.human, clusters: groups.clusters.map((c) => ({ orch: c.orch, kids: [...c.kids] })), ferals: [...groups.ferals] };
    while (!built) {
      if (trial.ferals.length > 0) trial.ferals.pop();
      else {
        const last = [...trial.clusters].reverse().find((c) => c.kids.length > 0);
        if (last) last.kids.pop();
        else if (trial.clusters.length > 0) trial.clusters.pop();
        else break;
      }
      trial.clusters = trial.clusters.filter((c) => c.orch !== null || c.kids.length > 0);
      built = fit(trial, size.columns, height - 1, top);
    }
    if (!built) built = { level: LEVELS[3], items: groups.human ? [{ bug: groups.human, cls: "human", x: 1, y: top, w: Math.min(MAX_HUMAN_W, size.columns - 2), h: 1, lane: -1, eyeY: top, gapBelow: 0 }] : [], feralLabel: null, orchKids: new Set() };
    dropped = total - built.items.filter((item) => item.bug.kind !== "human").length;
  }
  const { routes, parentOf } = routeEdges(built, edges, size.columns);
  return {
    level: built.level,
    placed: built.items,
    byId: new Map(built.items.map((item) => [item.bug.id, item])),
    parentOf,
    routes,
    routeByKey: new Map(routes.map((route) => [keyOf(route.edge.from, route.edge.to), route.path])),
    feralLabel: built.feralLabel,
    dropped,
    sceneTop: top,
    sceneBottom: bottom,
    columns: size.columns,
  };
}

export { keyOf as edgeKey };
