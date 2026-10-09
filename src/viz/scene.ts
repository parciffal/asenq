import { homedir } from "node:os";
import { truncateTerminalText, type TerminalFrame, type TerminalSize, type TerminalSpan, type TerminalStyle } from "../tui/terminal.js";
import { MIN_COLUMNS, MIN_ROWS, cleanLabel, edgeKey, hudHeight, layoutScene, textWidth, type Layout, type Level, type Placed } from "./place.js";
import {
  GLITCH_CHARS, ORCH_ART, PAL, SPRITE_ROWS, SPRITE_WIDTH, WORKER_ART, artRows, humanRows, mix, shade, speciesOf, type Hex,
} from "./sprites.js";
import type { Bug, Direction, Edge, FeedLine, Hit, Packet, SceneResult, VizUi, World } from "./types.js";

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const PACKET_MS = 1400;
/** Linger of the arrival flash after a packet lands. */
const FLASH_FROM_MS = 1200;
const FLASH_TO_MS = 1900;
const KIND_COLOR: Record<FeedLine["kind"], Hex> = {
  task: PAL.yellow, result: PAL.green, status: PAL.cyan, chat: PAL.white, control: PAL.alert,
};
const KIND_TAG: Record<FeedLine["kind"], string> = { task: "TASK", result: "RESULT", status: "STATUS", chat: "CHAT", control: "CTRL" };
const LINK_COLORS: Hex[] = [PAL.orange, PAL.cyan, PAL.green, PAL.magenta, PAL.cyan];
const HARNESS_INDEX: Record<string, number> = { claude: 0, omp: 1, opencode: 2, codex: 3 };
const BOX = " ╵╶└╷│┌├╴┘─┴┐┤┬┼";
const ARROW = 16;
const STATE_WORD: Record<Bug["state"], string> = { working: "WORKING", idle: "IDLE", lost: "LOST", dead: "DEAD" };
const CLASS_TAG: Record<Bug["kind"], string> = { human: "NETRUNNER", orchestrator: "HIVE QUEEN", worker: "WORKER", feral: "FERAL" };

// ---- visibility -------------------------------------------------------------------------------------------------

export function visibleBugs(world: World, ui: VizUi): Bug[] {
  const matches = (bug: Bug): boolean => ui.filter === null || bug.harness === ui.filter;
  const keep = new Set<string>();
  for (const bug of world.bugs) {
    if (bug.kind === "human" || (bug.kind === "feral" ? ui.feral && matches(bug) : matches(bug))) keep.add(bug.id);
  }
  // An orchestrator stays when any bug it links to stays (it carries the link); repeat for nested orchestrators.
  const orchestrators = new Set(world.bugs.filter((bug) => bug.kind === "orchestrator").map((bug) => bug.id));
  for (let changed = true; changed;) {
    changed = false;
    for (const edge of world.edges) {
      if (keep.has(edge.to) && orchestrators.has(edge.from) && !keep.has(edge.from)) {
        keep.add(edge.from);
        changed = true;
      }
    }
  }
  return world.bugs.filter((bug) => keep.has(bug.id));
}

function prepare(world: World, ui: VizUi, size: TerminalSize): { bugs: Bug[]; edges: Edge[]; lay: Layout } {
  const bugs = visibleBugs(world, ui);
  const ids = new Set(bugs.map((bug) => bug.id));
  const edges = world.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to));
  return { bugs, edges, lay: layoutScene(bugs, edges, size) };
}

// ---- canvas -----------------------------------------------------------------------------------------------------

const styleTable: TerminalStyle[] = [];
const styleIds = new Map<string, number>();
function sid(fg: string, bg: string = PAL.void, bold = false): number {
  const key = `${fg}${bg}${bold ? "b" : ""}`;
  let id = styleIds.get(key);
  if (id === undefined) {
    id = styleTable.length;
    styleTable.push({ foreground: fg as Hex, background: bg as Hex, ...(bold ? { bold: true } : {}) });
    styleIds.set(key, id);
  }
  return id;
}

interface Canvas {
  cols: number;
  rows: number;
  ch: string[];
  st: number[];
  occ: Uint8Array;
  mask: Uint8Array;
  act: Uint8Array;
  phase: Int16Array;
  lcol: Uint8Array;
  lfocus: Uint8Array;
  touched: number[];
}
let pool: Canvas | null = null;

function acquire(cols: number, rows: number, base: number): Canvas {
  const cells = cols * rows;
  if (!pool || pool.cols !== cols || pool.rows !== rows) {
    pool = {
      cols, rows, ch: new Array<string>(cells), st: new Array<number>(cells), occ: new Uint8Array(cells), mask: new Uint8Array(cells),
      act: new Uint8Array(cells), phase: new Int16Array(cells), lcol: new Uint8Array(cells), lfocus: new Uint8Array(cells), touched: [],
    };
  }
  pool.ch.fill(" ");
  pool.st.fill(base);
  pool.occ.fill(0);
  pool.mask.fill(0);
  pool.act.fill(0);
  pool.lfocus.fill(0);
  pool.touched.length = 0;
  return pool;
}

function put(c: Canvas, x: number, y: number, ch: string, style: number): void {
  if (x < 0 || y < 0 || x >= c.cols || y >= c.rows) return;
  const i = y * c.cols + x;
  c.ch[i] = ch;
  c.st[i] = style;
  c.occ[i] = 1;
}

const ASCII_ONLY = /^[\x20-\x7e]*$/;

/** Writes already-sanitized text, at most `maxWidth` cells; returns the cells written. */
function putText(c: Canvas, x: number, y: number, text: string, style: number, maxWidth = c.cols - x): number {
  let used = 0;
  if (ASCII_ONLY.test(text)) {
    for (let i = 0; i < text.length && used < maxWidth; i++, used++) put(c, x + used, y, text[i], style);
    return used;
  }
  for (const { segment } of GRAPHEMES.segment(text)) {
    const w = textWidth(segment);
    if (w === 0) continue;
    if (used + w > maxWidth) break;
    put(c, x + used, y, segment, style);
    for (let k = 1; k < w; k++) put(c, x + used + k, y, "", style);
    used += w;
  }
  return used;
}

type Seg = readonly [text: string, style: number];

function putSegs(c: Canvas, x: number, y: number, segs: readonly Seg[], maxWidth: number): number {
  let used = 0;
  for (const [text, style] of segs) {
    if (used >= maxWidth) break;
    used += putText(c, x + used, y, text, style, maxWidth - used);
  }
  return used;
}

function clear(c: Canvas, x: number, y: number, w: number, h: number, style: number): void {
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) put(c, xx, yy, " ", style);
}

/** Truncate sanitized text to `width` cells, ending in an ellipsis. */
function fitText(text: string, width: number): string {
  if (width <= 0) return "";
  return textWidth(text) <= width ? text : `${truncateTerminalText(text, width - 1)}…`;
}

function mixHash(a: number, b = 0, d = 0): number {
  let h = Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca6b) ^ Math.imul(d | 0, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return h >>> 1;
}
const seedCache = new Map<string, number>();
function seedOf(id: string): number {
  let seed = seedCache.get(id);
  if (seed === undefined) {
    if (seedCache.size > 1024) seedCache.clear();
    seed = 0;
    for (let i = 0; i < id.length; i++) seed = mixHash(seed, id.charCodeAt(i));
    seedCache.set(id, seed);
  }
  return seed;
}
/** Triangle wave in [0,1] with the given period. */
const tri = (t: number, period: number): number => Math.abs((((t % period) + period) % period) - period / 2) / (period / 2);

// ---- drawing ----------------------------------------------------------------------------------------------------

interface Ctx {
  tick: number;
  now: number;
  lay: Layout;
  lv: Level;
  selected: string | null;
  /** Bugs kept bright in focus mode; null when not focusing. */
  focus: Set<string> | null;
  flash: Map<string, Hex>;
}

function drawBug(c: Canvas, p: Placed, ctx: Ctx): void {
  const { bug } = p;
  const { lv, tick } = ctx;
  const isHuman = p.cls === "human";
  const seed = seedOf(bug.id);
  const dimmed = ctx.focus !== null && !ctx.focus.has(bug.id);
  const dm = (color: Hex): Hex => (dimmed ? shade(color, 0.3) : color);
  const sp = speciesOf(bug.harness);
  let base: Hex = isHuman ? PAL.yellow : sp.color;
  if (bug.kind === "feral") base = mix(base, PAL.ghost, 0.4);
  const flash = ctx.flash.get(bug.id);
  let body: Hex;
  if (flash) body = tick & 1 ? PAL.white : flash;
  else if (bug.state === "dead") body = shade(PAL.ghost, 0.9);
  else if (bug.state === "lost") body = mixHash(seed, tick >> 1) % 3 === 0 ? PAL.alert : shade(base, 0.45);
  else if (bug.state === "idle") body = shade(base, 0.55 + 0.25 * tri(tick + seed, 16));
  else body = base;
  body = dm(body);
  const bodyId = sid(body);
  clear(c, p.x, p.y, p.w, p.h, sid(PAL.white));

  let spriteRows = 0;
  if (lv.sprite !== "none") {
    const rowsSel = SPRITE_ROWS[lv.sprite][p.cls];
    spriteRows = rowsSel.length;
    const leg = bug.state === "working" ? tick & 1 : bug.state === "dead" ? 0 : bug.state === "lost" ? mixHash(seed, tick >> 1) & 1 : (tick >> 3) & 1;
    const harness = bug.harness ?? "omp";
    const art: string[] = isHuman ? humanRows(tick) : artRows((p.cls === "orch" ? ORCH_ART : WORKER_ART)[harness], leg as 0 | 1);
    const sw = SPRITE_WIDTH[p.cls];
    const sx = p.x + ((p.w - sw) >> 1);
    const eyeGlyph = bug.state === "working" ? (tick & 1 ? "◉" : "●") : bug.state === "lost" ? "?" : bug.state === "dead" ? "x" : (tick + seed) % 36 < 2 ? "─" : "●";
    const eyeId = sid(PAL.void, body);
    const stripId = sid(dm(PAL.cyan));
    rowsSel.forEach((ri, k) => {
      const row = art[ri];
      for (let i = 0; i < row.length; i++) {
        const ch = row[i];
        if (ch === " ") continue;
        if (ch === "E") put(c, sx + i, p.y + k, eyeGlyph, eyeId);
        else put(c, sx + i, p.y + k, ch, isHuman && ri === 1 && "░▒▓█".includes(ch) ? stripId : bodyId);
      }
    });
    if (bug.state === "lost" || (bug.kind === "feral" && mixHash(seed, tick) % 7 === 0)) {
      for (let k = 0; k < 2; k++) {
        const r = mixHash(seed, tick, k);
        if (r % 3 === 0) continue;
        const color = [PAL.cyan, PAL.magenta, PAL.alert][(r >> 4) % 3];
        put(c, sx + ((r >> 3) % sw), p.y + ((r >> 9) % spriteRows), GLITCH_CHARS[(r >> 6) % GLITCH_CHARS.length], sid(dm(color)));
      }
    }
    if (bug.state === "lost" && (tick & 2) === 0) put(c, sx + sw, p.y, "?", sid(dm(PAL.alert), PAL.void, true));
    if (bug.state === "working") {
      const r = mixHash(seed, tick);
      put(c, r & 1 ? sx - 1 : sx + sw, p.y + ((r >> 4) % spriteRows), "*+·'"[(r >> 8) & 3], sid(dm(r & 2 ? PAL.yellow : PAL.white)));
    }
  }

  // Plate: state glyph + name, then tag line (or one row at the smallest level).
  const inner = p.w - 2;
  const ix = p.x + 1;
  const label = cleanLabel(bug.name);
  const selected = ctx.selected === bug.id;
  const glyph = isHuman ? "◉" : bug.state === "working" ? "●" : bug.state === "idle" ? "○" : bug.state === "lost" ? "?" : "×";
  const glyphColor = isHuman ? PAL.yellow : bug.state === "lost" ? ((tick >> 1) & 1 ? PAL.alert : shade(PAL.alert, 0.4)) : bug.state === "dead" ? shade(PAL.ghost, 0.9) : bug.state === "idle" ? shade(base, 0.7) : base;
  const nameColor = selected ? PAL.yellow
    : bug.state === "working" ? PAL.white : bug.state === "idle" ? shade(PAL.white, 0.78)
    : bug.state === "lost" ? (mixHash(seed, tick >> 1) % 4 === 0 ? PAL.alert : shade(PAL.white, 0.55)) : shade(PAL.ghost, 1.1);
  const plateY = p.y + spriteRows;
  const orchMark = lv.plateRows === 1 && p.cls === "orch";
  const nameText = fitText(label.text, inner - 2 - (orchMark ? 2 : 0));
  const nameW = textWidth(nameText);
  const tagWord = isHuman ? "OPERATOR" : speciesOf(bug.harness).tag;
  const tail = lv.plateRows === 1 && inner - 2 - (orchMark ? 2 : 0) - nameW >= tagWord.length + 1 ? ` ${tagWord}` : "";
  const total = (orchMark ? 2 : 0) + 2 + nameW + tail.length;
  let at = ix + ((inner - total) >> 1);
  if (orchMark) at += putText(c, at, plateY, "◈ ", sid(dm(PAL.yellow)));
  at += putText(c, at, plateY, `${glyph} `, sid(dm(glyphColor), PAL.void, bug.state === "working"));
  at += putText(c, at, plateY, nameText, sid(dm(nameColor), PAL.void, selected));
  if (tail) putText(c, at, plateY, tail, sid(dm(shade(base, 0.65))));

  if (lv.plateRows === 2) {
    const tag = sid(dm(bug.state === "dead" ? shade(PAL.ghost, 0.9) : shade(base, 0.8)));
    const mark = sid(dm(PAL.yellow), PAL.void, true);
    const word = STATE_WORD[bug.state];
    const candidates: Seg[][] = isHuman ? [[["OPERATOR ▸ ONLINE", tag]], [["OPERATOR", tag]]]
      : p.cls === "orch" ? [[["◈ ORCH", mark], [` ${tagWord}`, tag]], [["◈ ORCH", mark]]]
      : bug.kind === "feral" ? [[[`${tagWord} ▸ FERAL`, tag]], [["FERAL", tag]]]
      : [[[`${tagWord} ▸ ${word}`, tag]], [[tagWord, tag]], [[word, tag]]];
    const widthOf = (segs: Seg[]): number => segs.reduce((n, [text]) => n + text.length, 0);
    const pick = candidates.find((segs) => widthOf(segs) <= inner) ?? [[fitText(candidates[candidates.length - 1][0][0], inner), candidates[candidates.length - 1][0][1]] as Seg];
    putSegs(c, ix + ((inner - widthOf(pick)) >> 1), plateY + 1, pick, inner);
  }

  if (selected) {
    const pulse = sid((tick & 7) < 4 ? PAL.yellow : PAL.white, PAL.void, true);
    const x2 = p.x + p.w - 1;
    const y2 = p.y + p.h - 1;
    if (p.h === 1) {
      put(c, p.x, p.y, "[", pulse);
      put(c, x2, p.y, "]", pulse);
    } else {
      put(c, p.x, p.y, "┏", pulse);
      put(c, x2, p.y, "┓", pulse);
      put(c, p.x, y2, "┗", pulse);
      put(c, x2, y2, "┛", pulse);
    }
  }
}

// ---- links and packets ------------------------------------------------------------------------------------------

const ACT: Record<Bug["state"], number> = { working: 4, lost: 3, idle: 2, dead: 1 };

function drawLinks(c: Canvas, ctx: Ctx): void {
  const { lay, tick } = ctx;
  const cols = c.cols;
  const bit = (from: number, to: number): number => {
    const d = to - from;
    return d === -cols ? 1 : d === 1 ? 2 : d === cols ? 4 : 8;
  };
  for (const route of lay.routes) {
    const child = lay.byId.get(route.edge.to)?.bug;
    if (!child) continue;
    const act = ACT[child.state];
    const colorIdx = child.harness === null ? 4 : HARNESS_INDEX[child.harness] ?? 4;
    const lit = ctx.selected !== null && (route.edge.from === ctx.selected || route.edge.to === ctx.selected);
    const path = route.path;
    const mark = (idx: number, i: number, bits: number): void => {
      if (c.mask[idx] === 0) c.touched.push(idx);
      c.mask[idx] |= bits;
      if (act > c.act[idx]) {
        c.act[idx] = act;
        c.phase[idx] = i;
        c.lcol[idx] = colorIdx;
      }
      if (lit) c.lfocus[idx] = 1;
    };
    for (let i = 0; i < path.length - 1; i++) {
      const bits = (i === 0 ? 1 : bit(path[i], path[i - 1])) | bit(path[i], path[i + 1]);
      mark(path[i], i, bits);
    }
    mark(path[path.length - 1], path.length - 1, ARROW);
  }

  for (const idx of c.touched) {
    const act = c.act[idx];
    const base = LINK_COLORS[c.lcol[idx]];
    const i = c.phase[idx];
    let color: Hex;
    let bold = false;
    let heavy = false;
    if (act === 4) {
      const head = (((i - tick) % 4) + 4) % 4;
      color = head === 0 ? shade(base, 1.45) : head === 3 ? shade(base, 0.95) : shade(base, 0.68);
      bold = head === 0;
      heavy = head === 0;
    } else if (act === 2) {
      color = (((i - (tick >> 2)) % 10) + 10) % 10 === 0 ? shade(base, 0.6) : shade(base, 0.3);
    } else if (act === 3) {
      const r = mixHash(idx, tick >> 1) % 4;
      if (r === 0) continue;
      color = shade(PAL.alert, r === 1 ? 0.9 : 0.45);
    } else {
      color = shade(PAL.ghost, 0.6);
    }
    if (ctx.focus !== null && c.lfocus[idx] === 0) color = shade(color, 0.3);
    const m = c.mask[idx];
    let ch = m & ARROW ? "▶" : BOX[m & 15];
    if (heavy && !(m & ARROW)) ch = ch === "│" ? "┃" : ch === "─" ? "━" : ch;
    put(c, idx % cols, Math.floor(idx / cols), ch, sid(color, PAL.void, bold));
  }
}

/** Cell route for a packet: a direct edge either way, else up to the common ancestor and back down. */
function packetPath(lay: Layout, fromId: string, toId: string): number[] | null {
  const direct = lay.routeByKey.get(edgeKey(fromId, toId));
  if (direct) return direct;
  const back = lay.routeByKey.get(edgeKey(toId, fromId));
  if (back) return [...back].reverse();
  const chain = (id: string): string[] => {
    const out = [id];
    for (let cur = lay.parentOf.get(id); cur !== undefined && out.length < 8 && !out.includes(cur); cur = lay.parentOf.get(cur)) out.push(cur);
    return out;
  };
  const up = chain(fromId);
  const down = chain(toId);
  const meet = up.findIndex((id) => down.includes(id));
  if (meet < 0) return null;
  const apex = down.indexOf(up[meet]);
  const cells: number[] = [];
  const add = (path: readonly number[]): void => {
    for (const cell of path) if (cells[cells.length - 1] !== cell) cells.push(cell);
  };
  for (let i = 0; i < meet; i++) {
    const hop = lay.routeByKey.get(edgeKey(up[i + 1], up[i]));
    if (!hop) return null;
    add([...hop].reverse());
  }
  for (let i = apex; i > 0; i--) {
    const hop = lay.routeByKey.get(edgeKey(down[i], down[i - 1]));
    if (!hop) return null;
    add(hop);
  }
  return cells.length > 0 ? cells : null;
}

function drawPackets(c: Canvas, ctx: Ctx, packets: readonly Packet[]): void {
  const cols = c.cols;
  for (const packet of packets) {
    if (!ctx.lay.byId.has(packet.fromId) || !ctx.lay.byId.has(packet.toId)) continue;
    const path = packetPath(ctx.lay, packet.fromId, packet.toId);
    if (!path) continue;
    const color = KIND_COLOR[packet.kind];
    const fade = ctx.focus !== null && packet.fromId !== ctx.selected && packet.toId !== ctx.selected ? 0.3 : 1;
    const head = Math.floor(Math.min(1, Math.max(0, packet.ageMs / PACKET_MS)) * (path.length - 1));
    const trail = ["▓", "▒", "░"];
    for (let k = trail.length; k >= 1; k--) {
      const idx = path[head - k];
      if (idx !== undefined && c.occ[idx]) put(c, idx % cols, Math.floor(idx / cols), trail[k - 1], sid(shade(color, fade * (0.85 - 0.2 * k))));
    }
    put(c, path[head] % cols, Math.floor(path[head] / cols), "◆", sid(shade(color, fade * 1.4), PAL.void, true));
  }
}

function arrivalFlashes(packets: readonly Packet[], lay: Layout): Map<string, Hex> {
  const flash = new Map<string, Hex>();
  for (const packet of packets) {
    if (packet.ageMs >= FLASH_FROM_MS && packet.ageMs < FLASH_TO_MS && lay.byId.has(packet.toId)) flash.set(packet.toId, KIND_COLOR[packet.kind]);
  }
  return flash;
}

// ---- background -------------------------------------------------------------------------------------------------

function drawBackground(c: Canvas, top: number, bottom: number, tick: number): void {
  const dot = sid(PAL.grid);
  const head = sid(shade(PAL.cyan, 0.26));
  const trail = sid(shade(PAL.cyan, 0.14));
  const span = bottom - top;
  for (let y = top; y < bottom; y++) {
    for (let x = 0; x < c.cols; x++) {
      const i = y * c.cols + x;
      if (c.occ[i]) continue;
      const h = mixHash(x, 0x51);
      if (h % 13 === 0) {
        const d = ((y - top - (Math.floor(tick / 6) + (h >> 8)) % (span + 10)) % (span + 10) + span + 10) % (span + 10);
        if (d === 0) { c.ch[i] = (h >> 5) & 1 ? "1" : "0"; c.st[i] = head; continue; }
        if (d >= span + 7) { c.ch[i] = "·"; c.st[i] = trail; continue; }
      }
      if (x % 8 === 3 && y % 4 === 1) { c.ch[i] = "·"; c.st[i] = dot; }
    }
  }
}

// ---- header / HUD -----------------------------------------------------------------------------------------------

const pad2 = (n: number): string => String(n).padStart(2, "0");
function clock(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function drawHeader(c: Canvas, world: World, tick: number, now: number): void {
  const cols = c.cols;
  const title = "ASENQ // NETWATCH";
  const glitch = tick % 23 < 2 || mixHash(tick) % 41 === 0;
  const bad = new Set<number>();
  if (glitch) {
    bad.add(mixHash(tick, 1) % title.length);
    bad.add(mixHash(tick, 2) % title.length);
  }
  for (let i = 0; i < title.length; i++) {
    const bg = bad.has(i) && title[i] !== " ";
    const color = bg ? PAL.alert : i < 5 ? PAL.yellow : i < 9 ? PAL.magenta : PAL.cyan;
    put(c, 1 + i, 0, bg ? GLITCH_CHARS[mixHash(tick, i) % GLITCH_CHARS.length] : title[i], sid(color, PAL.void, true));
  }
  const counts = (kind: Bug["kind"]): number => world.bugs.filter((bug) => bug.kind === kind).length;
  const orch = counts("orchestrator");
  const work = counts("worker");
  const feral = counts("feral");
  const online = world.connection === "connected";
  const blink = online || (tick % 8) < 4;
  const connColor = online ? PAL.green : blink ? PAL.alert : shade(PAL.alert, 0.35);
  const clockText = clock(now);
  const connFull = online ? "● LINK ESTABLISHED" : "◌ SIGNAL LOST";
  const connShort = online ? "● LINK OK" : "◌ NO SIGNAL";
  const titleEnd = 1 + title.length + 2;
  const label = sid(shade(PAL.cyan, 0.7));
  const value = sid(PAL.white, PAL.void, true);
  const sep = sid(PAL.ghost);
  let rightW = connFull.length + 2 + clockText.length + 1;
  let conn = connFull;
  if (titleEnd + rightW > cols) {
    conn = connShort;
    rightW = conn.length + 2 + clockText.length + 1;
  }
  const room = cols - rightW - titleEnd;
  const full: Seg[] = [["ORCH ", label], [String(orch), value], [" · ", sep], ["WORK ", label], [String(work), value], [" · ", sep], ["FERAL ", label], [String(feral), value]];
  const compact: Seg[] = [["O", label], [String(orch), value], [" W", label], [String(work), value], [" F", label], [String(feral), value]];
  const fullW = full.reduce((n, [t]) => n + t.length, 0);
  const compactW = compact.reduce((n, [t]) => n + t.length, 0);
  if (room >= fullW + 2) putSegs(c, titleEnd + 1, 0, full, fullW);
  else if (room >= compactW + 1) putSegs(c, titleEnd, 0, compact, compactW);
  putText(c, cols - rightW, 0, conn, sid(connColor, PAL.void, true));
  putText(c, cols - clockText.length - 1, 0, clockText, sid(shade(PAL.white, 0.7)));

  // Rule with a scanning highlight.
  const pos = ((tick * 2) % (cols + 12)) - 6;
  for (let x = 0; x < cols; x++) {
    const d = Math.abs(x - pos);
    const color = d < 3 ? PAL.cyan : d < 6 ? shade(PAL.magenta, 0.9) : shade(PAL.magenta, 0.4);
    put(c, x, 1, "━", sid(color));
  }
}

function ago(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 1) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function shortenPath(path: string, width: number): string {
  const home = homedir();
  const clean = cleanLabel(path).text;
  const short = home && (clean === home || clean.startsWith(`${home}/`)) ? `~${clean.slice(home.length)}` : clean;
  if (textWidth(short) <= width) return short;
  const tail = [...short].slice(-(Math.max(1, width - 1))).join("");
  return `…${tail}`;
}

function box(c: Canvas, x: number, y: number, w: number, h: number, title: string, color: Hex): void {
  const edge = sid(shade(color, 0.75));
  const head = sid(color, PAL.void, true);
  const row = (yy: number, l: string, mid: string, r: string): void => {
    put(c, x, yy, l, edge);
    for (let xx = x + 1; xx < x + w - 1; xx++) put(c, xx, yy, mid, edge);
    put(c, x + w - 1, yy, r, edge);
  };
  row(y, "┌", "─", "┐");
  row(y + h - 1, "└", "─", "┘");
  for (let yy = y + 1; yy < y + h - 1; yy++) {
    put(c, x, yy, "│", edge);
    put(c, x + w - 1, yy, "│", edge);
    clear(c, x + 1, yy, w - 2, 1, sid(PAL.white));
  }
  putText(c, x + 2, y, ` ${title} `, head, w - 4);
}

function stateBar(bug: Bug, tick: number, base: Hex): Seg[] {
  const total = 10;
  const fill = bug.state === "working" ? total : bug.state === "idle" ? 3 + Math.round(tri(tick, 24) * 2) : bug.state === "lost" ? 1 + (mixHash(tick) % 6) : 0;
  const color = bug.state === "lost" ? PAL.alert : bug.state === "dead" ? PAL.ghost : bug.state === "idle" ? PAL.cyan : base;
  const segs: Seg[] = [["[", sid(PAL.ghost)]];
  for (let i = 0; i < total; i++) {
    const hot = bug.state === "working" && i === tick % total;
    segs.push(i < fill ? ["▰", sid(hot ? PAL.white : shade(color, 1 - 0.35 * (i / total)))] : ["▱", sid(shade(PAL.ghost, 0.55))]);
  }
  segs.push(["]", sid(PAL.ghost)]);
  return segs;
}

function targetLines(world: World, bug: Bug, inner: number, count: number, tick: number, now: number): Seg[][] {
  const key = sid(shade(PAL.cyan, 0.7));
  const val = sid(PAL.white);
  const dim = sid(shade(PAL.ghost, 1.2));
  const sp = speciesOf(bug.harness);
  const color = bug.kind === "human" ? PAL.yellow : sp.color;
  const names = new Map(world.bugs.map((b) => [b.id, cleanLabel(b.name).text]));
  const up = world.edges.filter((e) => e.to === bug.id).map((e) => names.get(e.from) ?? "?");
  const down = world.edges.filter((e) => e.from === bug.id).map((e) => names.get(e.to) ?? "?");
  const label = cleanLabel(bug.name).text;
  const list = (items: string[]): string => (items.length > 0 ? items.join(", ") : "—");
  const species = bug.kind === "human" ? "deck" : sp.name;
  const lines: Seg[][] = [
    [["▌ ", sid(PAL.yellow)], [label, sid(PAL.yellow, PAL.void, true)], [`  ${CLASS_TAG[bug.kind]}`, sid(color, PAL.void, true)], [` · ${bug.harness ?? "local"} ${species}`, dim]],
    [["STATE ", key], ...stateBar(bug, tick, color), [` ${STATE_WORD[bug.state]}`, sid(bug.state === "lost" ? PAL.alert : bug.state === "dead" ? PAL.ghost : color, PAL.void, true)]],
    [["CWD ", key], [bug.cwd === null ? "—" : shortenPath(bug.cwd, inner - 4), val]],
  ];
  const seen = bug.lastSeen === null ? "n/a" : ago(now - bug.lastSeen);
  const pid = bug.pid === undefined ? null : String(bug.pid);
  if (count <= 4) {
    lines.push([["SEEN ", key], [seen, val], [" · UP ", key], [list(up), val], ...(pid ? [[" · PID ", key] as Seg, [pid, val] as Seg] : [])]);
  } else {
    lines.push([["CH ", key], [list(bug.channels.map((ch) => cleanLabel(ch).text)), val], ...(pid ? [[" · PID ", key] as Seg, [pid, val] as Seg] : []), [" · SEEN ", key], [seen, val]]);
    lines.push([["UPLINK ", key], [list(up), val]]);
    lines.push([["AKA ", key], [list(bug.previousNames.map((n) => cleanLabel(n).text)), val]]);
    lines.push([["DRONES ", key], [list(down), val]]);
  }
  return lines.slice(0, count);
}

function drawHud(c: Canvas, world: World, bugs: readonly Bug[], ui: VizUi, tick: number, now: number): void {
  const cols = c.cols;
  const hud = hudHeight(c.rows);
  const top = c.rows - hud;
  const panelH = hud - 1;
  const leftW = Math.max(30, Math.floor(cols * 0.45));
  const rightW = cols - leftW;
  box(c, 0, top, leftW, panelH, "TARGET", PAL.yellow);
  box(c, leftW, top, rightW, panelH, "NETWATCH", PAL.cyan);

  const bug = ui.selectedId === null ? undefined : bugs.find((b) => b.id === ui.selectedId);
  const lines = panelH - 2;
  const lx = 2;
  const lw = leftW - 4;
  if (!bug) {
    putSegs(c, lx, top + 1, [["select a bug (arrows/Tab)", sid(shade(PAL.ghost, 1.2))], [(tick & 4) === 0 ? " ▮" : "  ", sid(PAL.yellow)]], lw);
  } else {
    targetLines(world, bug, lw, lines, tick, now).forEach((segs, i) => putSegs(c, lx, top + 1 + i, segs, lw));
  }

  const rx = leftW + 2;
  const rw = rightW - 4;
  const feed = world.feed.slice(-lines);
  if (feed.length === 0) {
    putSegs(c, rx, top + 1, [["awaiting traffic", sid(shade(PAL.ghost, 1.2))], [(tick & 4) === 0 ? "_" : " ", sid(PAL.cyan)]], rw);
  }
  feed.forEach((line, i) => {
    const color = KIND_COLOR[line.kind];
    const withTime = rw >= 34;
    const tag = `[${KIND_TAG[line.kind]}]`;
    const room = rw - (withTime ? 9 : 0) - tag.length - 3;
    const per = Math.max(3, Math.min(14, Math.floor(room / 3)));
    const from = fitText(cleanLabel(line.from).text, per);
    const to = fitText(cleanLabel(line.to).text, per);
    const segs: Seg[] = [];
    if (withTime) segs.push([`${clock(line.at)} `, sid(shade(PAL.ghost, 1.2))]);
    segs.push([from, sid(shade(PAL.white, 0.85))], [" ▶ ", sid(shade(color, 0.8))], [to, sid(shade(PAL.white, 0.85))], [` ${tag} `, sid(color, PAL.void, true)], [cleanLabel(line.text).text, sid(shade(PAL.white, 0.6))]);
    putSegs(c, rx, top + 1 + i, segs, rw);
  });

  // Key hints.
  const keyId = sid(PAL.yellow, PAL.void, true);
  const descId = sid(shade(PAL.ghost, 1.25));
  const dotId = sid(shade(PAL.magenta, 0.6));
  const variants: [string, string][][] = [
    [["←↑↓→/Tab", "select"], ["Enter", "focus"], ["f", "filter harness"], ["u", "feral"], ["r", "rescan"], ["q", "quit"]],
    [["←↑↓→", "select"], ["Enter", "focus"], ["f", "filter"], ["u", "feral"], ["r", "rescan"], ["q", "quit"]],
    [["Tab", "select"], ["Enter", "focus"], ["f", "filter"], ["u", "feral"], ["r", "rescan"], ["q", "quit"]],
    [["Tab", "select"], ["f", "filter"], ["u", "feral"], ["q", "quit"]],
    [["q", "quit"]],
  ];
  const widthOf = (v: [string, string][]): number => v.reduce((n, [k, d]) => n + k.length + 1 + d.length, 0) + 3 * (v.length - 1);
  const flags = [ui.filter !== null ? `FILTER:${ui.filter}` : "", ui.focus ? "FOCUS" : "", ui.feral ? "" : "FERAL OFF"].filter(Boolean).join(" ");
  const chosen = variants.find((v) => 1 + widthOf(v) <= cols) ?? variants[variants.length - 1];
  let at = 1;
  chosen.forEach(([k, d], i) => {
    if (i > 0) at += putText(c, at, c.rows - 1, " · ", dotId);
    at += putText(c, at, c.rows - 1, k, keyId);
    at += putText(c, at, c.rows - 1, ` ${d}`, descId);
  });
  if (flags && at + flags.length + 3 <= cols) putText(c, cols - flags.length - 1, c.rows - 1, flags, sid(PAL.magenta, PAL.void, true));
}

// ---- frame ------------------------------------------------------------------------------------------------------

function tooSmall(size: TerminalSize): SceneResult {
  const base = sid(PAL.white);
  const rows = Math.max(0, size.rows);
  const message = truncateTerminalText("TERMINAL TOO SMALL // need 60x20", size.columns);
  const have = truncateTerminalText(`have ${size.columns}x${size.rows}`, size.columns);
  const mid = Math.floor(rows / 2);
  const lines: TerminalSpan[][] = [];
  for (let y = 0; y < rows; y++) {
    const text = y === mid ? message : y === mid + 1 ? have : "";
    const left = Math.max(0, Math.floor((size.columns - text.length) / 2));
    const spans: TerminalSpan[] = [];
    if (left > 0) spans.push({ text: " ".repeat(left), style: styleTable[base] });
    if (text) spans.push({ text, style: styleTable[sid(y === mid ? PAL.alert : shade(PAL.ghost, 1.2), PAL.void, y === mid)] });
    const rest = Math.max(0, size.columns - left - text.length);
    if (rest > 0) spans.push({ text: " ".repeat(rest), style: styleTable[base] });
    lines.push(spans);
  }
  return { frame: { lines }, hits: [] };
}

export function renderScene(world: World, packets: Packet[], ui: VizUi, tick: number, size: TerminalSize, now: number): SceneResult {
  if (size.columns < MIN_COLUMNS || size.rows < MIN_ROWS) return tooSmall(size);
  tick = Math.floor(tick);
  const { bugs, edges, lay } = prepare(world, ui, size);
  const c = acquire(size.columns, size.rows, sid(PAL.white));
  const selected = ui.selectedId !== null && lay.byId.has(ui.selectedId) ? ui.selectedId : null;
  let focus: Set<string> | null = null;
  if (ui.focus && selected !== null) {
    focus = new Set([selected]);
    for (const edge of edges) {
      if (edge.from === selected) focus.add(edge.to);
      else if (edge.to === selected) focus.add(edge.from);
    }
  }
  const ctx: Ctx = { tick, now, lay, lv: lay.level, selected, focus, flash: arrivalFlashes(packets, lay) };

  drawLinks(c, ctx);
  drawPackets(c, ctx, packets);
  for (const placed of lay.placed) drawBug(c, placed, ctx);
  if (lay.feralLabel) {
    const { x, y, w } = lay.feralLabel;
    const text = " WILDLINE // UNLINKED ";
    const line = sid(shade(PAL.alert, 0.35));
    const lead = Math.max(0, (w - text.length) >> 1);
    for (let i = 0; i < w; i++) put(c, x + i, y, "╌", line);
    putText(c, x + lead, y, text, sid(shade(PAL.alert, 0.9), PAL.void, true));
  }
  if (lay.dropped > 0) {
    const text = `+${lay.dropped} more`;
    putText(c, size.columns - text.length - 1, lay.sceneBottom - 1, text, sid(PAL.yellow, PAL.void, true));
  }
  drawBackground(c, lay.sceneTop, lay.sceneBottom, tick);
  drawHeader(c, world, tick, now);
  drawHud(c, world, bugs, ui, tick, now);

  const lines: TerminalSpan[][] = [];
  for (let y = 0; y < c.rows; y++) {
    const spans: TerminalSpan[] = [];
    let start = y * c.cols;
    let cur = c.st[start];
    let text = "";
    for (let i = start; i < (y + 1) * c.cols; i++) {
      if (c.st[i] !== cur) {
        spans.push({ text, style: styleTable[cur] });
        cur = c.st[i];
        text = "";
        start = i;
      }
      text += c.ch[i];
    }
    spans.push({ text, style: styleTable[cur] });
    lines.push(spans);
  }
  const hits: Hit[] = lay.placed.map((p) => ({ id: p.bug.id, column: p.x, row: p.y, width: p.w, height: p.h }));
  const frame: TerminalFrame = { lines };
  return { frame, hits };
}

// ---- navigation -------------------------------------------------------------------------------------------------

const rangeGap = (aLo: number, aHi: number, bLo: number, bHi: number): number => Math.max(0, Math.max(aLo, bLo) - Math.min(aHi, bHi));

export function navigate(world: World, ui: VizUi, size: TerminalSize, dir: Direction): string | null {
  if (size.columns < MIN_COLUMNS || size.rows < MIN_ROWS) return null;
  const { lay } = prepare(world, ui, size);
  if (lay.placed.length === 0) return null;
  const reading = [...lay.placed].sort((a, b) => a.y - b.y || a.x - b.x);
  const cur = ui.selectedId === null ? undefined : lay.byId.get(ui.selectedId);
  if (!cur) return (reading.find((p) => p.cls !== "human") ?? reading[0]).bug.id;
  if (dir === "next" || dir === "prev") {
    const n = reading.length;
    return reading[(reading.indexOf(cur) + (dir === "next" ? 1 : n - 1)) % n].bug.id;
  }
  if (dir === "up") {
    const parent = lay.parentOf.get(cur.bug.id);
    if (parent !== undefined && lay.byId.has(parent)) return parent;
  }
  const horizontal = dir === "left" || dir === "right";
  const sign = dir === "right" || dir === "down" ? 1 : -1;
  const mx = cur.x * 2 + cur.w;
  const my = cur.y * 2 + cur.h;
  let best: Placed | null = null;
  let bestScore = Infinity;
  for (const o of reading) {
    if (o === cur) continue;
    const ox = o.x * 2 + o.w;
    const oy = o.y * 2 + o.h;
    const primary = ((horizontal ? ox - mx : oy - my)) * sign;
    if (primary <= 0) continue;
    const gap = horizontal ? rangeGap(cur.y, cur.y + cur.h, o.y, o.y + o.h) : rangeGap(cur.x, cur.x + cur.w, o.x, o.x + o.w);
    const score = primary + 100 * gap + Math.abs(horizontal ? oy - my : ox - mx) / 2;
    if (score < bestScore) {
      bestScore = score;
      best = o;
    }
  }
  return (best ?? cur).bug.id;
}
