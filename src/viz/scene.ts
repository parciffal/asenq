import { sanitizeTerminalText, terminalTextWidth, truncateTerminalText, wrapTerminalText } from "../tui/terminal.js";
import type { TerminalSize, TerminalSpan, TerminalStyle } from "../tui/terminal.js";
import { poseFor } from "./animate.js";
import { compactPixels, detailedPixels } from "./cast.js";
import { matchingTargets, sampleRoute, targetKey } from "./place.js";
import { rasterize, shade } from "./sprites.js";
import type { SpriteCell, SpriteTone } from "./sprites.js";
import type { CityCharacter, CityLayout, CityRenderContext, CityTarget, CityVenue, FeedLine, Hit, Packet, PlacedVenue, Point, Rect, SceneResult, VizUi, World } from "./types.js";

const PAL = { void: "#100609", room: "#281018", border: "#a52b3a", cream: "#e8dec8", cyan: "#55ced1", yellow: "#f4e45a", alert: "#ff4355", muted: "#887780" } as const;
const KIND_COLOR: Record<FeedLine["kind"], string> = { chat: PAL.cream, task: PAL.yellow, result: PAL.cyan, status: PAL.cyan, control: PAL.alert };
const KIND_TAG: Record<FeedLine["kind"], string> = { chat: "CHAT", task: "TASK", result: "RESULT", status: "STATUS", control: "CTRL" };
const HARNESS: Record<NonNullable<CityCharacter["harness"]>, string> = { claude: "CC", codex: "CX", omp: "OMP", opencode: "OC" };
/** Venue appearance cues: a full sign for wide facades, a fixed-width glyph row otherwise. The cue never shares its budget with the name. */
const VENUE_SIGN: Record<CityVenue["appearance"], string> = { office: "OFFICE", bar: "BAR", garage: "GARAGE", arcade: "ARCADE", communications: "COMMS" };
const VENUE_GLYPH: Record<CityVenue["appearance"], string> = { office: "⌂", bar: "▦", garage: "⌷", arcade: "◉", communications: "≋" };
/** Minimum name cells kept before the reserved cue so a selected bracketed name never erases the venue identity. */
const VENUE_NAME_MIN = 6;
const TONE: Record<SpriteTone, number> = { live: 1, lost: 0.6, gone: 0.4, offline: 0.55, dim: 0.3 };
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const PACKET_MS = 1400;
const ASCII = /^[\x20-\x7e]*$/;
const safe = (s: string): string => sanitizeTerminalText(s);
const fit = (s: string, width: number): string => {
  const text = safe(s);
  return width <= 0 ? "" : terminalTextWidth(text) <= width ? text : truncateTerminalText(text, width - 1) + "…";
};
const same = (a: CityTarget | null, b: CityTarget): boolean => a !== null && targetKey(a) === targetKey(b);
const inside = (p: Point, r: Rect): boolean => p.x >= r.x && p.y >= r.y && p.x < r.x + r.width && p.y < r.y + r.height;
const intersects = (a: Rect, b: Rect): boolean => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

/** Screen-space city region. Camera geometry never changes world placement. */
export function mapRegion(size: TerminalSize, embedded = false): Rect {
  const width = Math.max(0, Math.floor(size.columns));
  const height = Math.max(0, Math.floor(size.rows));
  if (width < 60 || height < 20) return { x: 0, y: Math.min(2, height), width, height: Math.max(0, height - 2 - (embedded ? 0 : 1)) };
  const wide = width >= 110 && height >= 26;
  const hints = embedded ? 0 : 1;
  return { x: 0, y: 2, width: width - (wide ? 32 : 0), height: Math.max(0, height - 2 - hints - (wide ? 4 : 9)) };
}

// One screen-sized pooled canvas. Styles are interned per frame, never per clock phase.
interface Canvas {
  cols: number; rows: number; ch: string[]; styles: number[]; owners: Int32Array; widths: Uint8Array; occupied: Uint8Array;
  palette: TerminalStyle[]; styleIds: Map<string, number>;
}
let pool: Canvas | null = null;
function acquire(cols: number, rows: number): Canvas {
  const n = cols * rows;
  if (!pool || pool.cols !== cols || pool.rows !== rows) pool = {
    cols, rows, ch: new Array<string>(n), styles: new Array<number>(n), owners: new Int32Array(n), widths: new Uint8Array(n), occupied: new Uint8Array(n), palette: [], styleIds: new Map(),
  };
  pool.palette.length = 0;
  pool.styleIds.clear();
  style(pool, PAL.cream);
  pool.ch.fill(" "); pool.styles.fill(0); pool.owners.fill(-1); pool.widths.fill(0);
  pool.occupied.fill(0);
  return pool;
}
function style(c: Canvas, fg: string = PAL.cream, bg: string = PAL.void, dim = false): number {
  const key = `${fg}/${bg}/${dim}`;
  const old = c.styleIds.get(key);
  if (old !== undefined) return old;
  const id = c.palette.length;
  c.palette.push({ foreground: fg as `#${string}`, background: bg as `#${string}`, ...(dim ? { dim: true } : {}) });
  c.styleIds.set(key, id);
  return id;
}
function eraseGlyph(c: Canvas, at: number): void {
  const owner = c.owners[at];
  if (owner < 0) return;
  const width = c.widths[owner];
  for (let k = 0; k < width; k++) {
    c.ch[owner + k] = " "; c.owners[owner + k] = -1; c.widths[owner + k] = 0;
  }
}
function glyph(c: Canvas, x: number, y: number, ch: string, sid: number, clip: Rect, protectSign = false): void {
  const w = ch.length === 1 && ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) <= 126 ? 1 : terminalTextWidth(ch);
  if (w < 1 || !inside({ x, y }, clip) || x + w > clip.x + clip.width || x < 0 || y < 0 || x + w > c.cols || y >= c.rows) return;
  const at = y * c.cols + x;
  if (protectSign && c.occupied[at] === 2) return;
  for (let k = 0; k < w; k++) eraseGlyph(c, at + k);
  c.ch[at] = ch; c.widths[at] = w;
  for (let k = 0; k < w; k++) { c.styles[at + k] = sid; c.owners[at + k] = at; if (k) c.ch[at + k] = ""; }
}
function text(c: Canvas, x: number, y: number, raw: string, sid: number, clip: Rect, width = clip.x + clip.width - x): void {
  let used = 0;
  const value = safe(raw);
  if (ASCII.test(value)) {
    for (let i = Math.max(0, clip.x - x); i < Math.min(value.length, width, clip.x + clip.width - x); i++) glyph(c, x + i, y, value[i], sid, clip);
    return;
  }
  for (const { segment } of GRAPHEMES.segment(value)) {
    const w = terminalTextWidth(segment);
    if (!w) continue;
    if (used + w > width) break;
    glyph(c, x + used, y, segment, sid, clip);
    used += w;
  }
}
function fill(c: Canvas, rect: Rect, sid: number, clip: Rect): void {
  for (let y = Math.max(rect.y, clip.y, 0); y < Math.min(rect.y + rect.height, clip.y + clip.height, c.rows); y++)
    for (let x = Math.max(rect.x, clip.x, 0); x < Math.min(rect.x + rect.width, clip.x + clip.width, c.cols); x++) glyph(c, x, y, " ", sid, clip);
}
function box(c: Canvas, r: Rect, sid: number, clip: Rect, dashed = false): void {
  if (r.width < 1 || r.height < 1) return;
  const right = r.x + r.width - 1, bottom = r.y + r.height - 1;
  for (let x = Math.max(r.x + 1, clip.x); x < Math.min(right, clip.x + clip.width); x++) {
    glyph(c, x, r.y, dashed ? "╌" : "─", sid, clip); glyph(c, x, bottom, dashed ? "╌" : "─", sid, clip);
  }
  for (let y = Math.max(r.y + 1, clip.y); y < Math.min(bottom, clip.y + clip.height); y++) {
    glyph(c, r.x, y, dashed ? "┊" : "│", sid, clip); glyph(c, right, y, dashed ? "┊" : "│", sid, clip);
  }
  glyph(c, r.x, r.y, "/", sid, clip); glyph(c, right, r.y, "\\", sid, clip);
  glyph(c, r.x, bottom, "└", sid, clip); glyph(c, right, bottom, "┘", sid, clip);
}
function hit(hits: Hit[], target: CityTarget, r: Rect, clip: Rect, priority = 0): void {
  const x = Math.max(r.x, clip.x), y = Math.max(r.y, clip.y);
  const width = Math.min(r.x + r.width, clip.x + clip.width) - x;
  const height = Math.min(r.y + r.height, clip.y + clip.height) - y;
  if (width > 0 && height > 0) hits.push({ target, column: x, row: y, width, height, priority });
}
function reserve(c: Canvas, r: Rect, clip: Rect, priority: number): void {
  for (let y = Math.max(0, r.y, clip.y); y < Math.min(c.rows, r.y + r.height, clip.y + clip.height); y++)
    for (let x = Math.max(0, r.x, clip.x); x < Math.min(c.cols, r.x + r.width, clip.x + clip.width); x++) c.occupied[y * c.cols + x] = priority;
}
function screen(p: Point, ui: VizUi, region: Rect): Point {
  return { x: region.x + Math.floor((p.x - ui.viewport.x) / ui.viewport.zoom), y: region.y + Math.floor((p.y - ui.viewport.y) / ui.viewport.zoom) };
}
function screenRect(r: Rect, ui: VizUi, region: Rect): Rect {
  const p = screen(r, ui, region);
  const end = screen({ x: r.x + r.width - 1, y: r.y + r.height - 1 }, ui, region);
  return { ...p, width: end.x - p.x + 1, height: end.y - p.y + 1 };
}
function viewWorld(ui: VizUi, region: Rect): Rect {
  return { x: ui.viewport.x, y: ui.viewport.y, width: region.width * ui.viewport.zoom, height: region.height * ui.viewport.zoom };
}
function line(c: Canvas, a: Point, b: Point, sid: number, clip: Rect, ch?: string): void {
  if (a.y === b.y) {
    for (let x = Math.max(Math.min(a.x, b.x), clip.x); x <= Math.min(Math.max(a.x, b.x), clip.x + clip.width - 1); x++) glyph(c, x, a.y, ch ?? "─", sid, clip);
  } else if (a.x === b.x) {
    for (let y = Math.max(Math.min(a.y, b.y), clip.y); y <= Math.min(Math.max(a.y, b.y), clip.y + clip.height - 1); y++) glyph(c, a.x, y, ch ?? "│", sid, clip);
  }
}
function sprite(c: Canvas, cells: readonly (readonly SpriteCell[])[], x: number, y: number, clip: Rect, dim = false): void {
  for (let row = 0; row < cells.length; row++) for (let col = 0; col < cells[row].length; col++) {
    const cell = cells[row][col];
    if (cell) glyph(c, x + col, y + row, cell.ch, style(c, cell.fg ?? PAL.cream, cell.bg ?? PAL.room, dim), clip);
  }
}
function matches(c: CityCharacter, ui: VizUi): boolean {
  return c.source === "human" || ((c.source !== "process" || ui.processes) && (ui.filter === null || c.harness === ui.filter));
}
function badge(c: CityCharacter): string {
  return c.source === "human" ? "[H]" : `${c.harness === null ? "?" : HARNESS[c.harness]} ${c.role === "orchestrator" ? "[O]" : c.role === "worker" ? "[W]" : "[-]"}`;
}
function drawVenue(c: Canvas, placed: PlacedVenue, ui: VizUi, region: Rect, hits: Hit[]): void {
  const r = screenRect(placed.rect, ui, region);
  if (!intersects(r, region)) return;
  const dim = ui.focus && ui.selected !== null && !(ui.selected.kind === "venue" && ui.selected.venueKey === placed.venue.key);
  const sid = style(c, PAL.border, PAL.room, dim), detail = style(c, PAL.muted, PAL.room, dim);
  fill(c, r, style(c, PAL.cream, PAL.room, dim), region);
  box(c, r, sid, region);
  const target: CityTarget = { kind: "venue", venueKey: placed.venue.key };
  hit(hits, target, r, region);
  const selected = ui.selected?.kind === "venue" && ui.selected.venueKey === placed.venue.key;
  // The appearance cue owns a reserved band that the name can never consume, at every zoom and selection state.
  const name = `#${placed.venue.name}`;
  const sign = VENUE_SIGN[placed.venue.appearance];
  const glyphCue = VENUE_GLYPH[placed.venue.appearance];
  const inner = r.width - 2;
  // A screen-space sign band sits above the floors, or at the viewport edge when the roof is offscreen.
  const titleY = Math.max(region.y, r.y - 1);
  const titleClip = { x: Math.max(r.x + 1, region.x), y: titleY, width: Math.max(0, Math.min(r.x + r.width - 1, region.x + region.width) - Math.max(r.x + 1, region.x)), height: 1 };
  const roof = placed.venue.appearance === "communications" ? "/|\\ /|\\" : placed.venue.appearance === "garage" ? "╤══════╤" : placed.venue.appearance === "arcade" ? "/ ▣ ▣ \\" : placed.venue.appearance === "bar" ? "/── BAR ──\\" : "┌─┬─┬─┐";
  if (ui.viewport.zoom === 1) text(c, r.x + 2, r.y, roof, detail, region, r.width - 4);
  if (ui.viewport.zoom < 4) {
    // Compute only the intersecting floor range; an enormous tower costs only visible screen rows.
    const view = viewWorld(ui, region);
    const ground = placed.rect.y + placed.rect.height - 10;
    const first = Math.max(0, Math.floor((ground - (view.y + view.height)) / 10));
    const last = Math.min(placed.floors - 1, Math.ceil((ground + 10 - view.y) / 10));
    for (let floor = first; floor <= last; floor++) {
      const y = ground - floor * 10;
      const fr = screenRect({ x: placed.rect.x + 1, y, width: placed.rect.width - 2, height: 10 }, ui, region);
      if (!intersects(fr, region)) continue;
      line(c, { x: fr.x, y: fr.y + fr.height - 1 }, { x: fr.x + fr.width - 1, y: fr.y + fr.height - 1 }, sid, region);
      const mid = screen({ x: placed.entrance.x, y }, ui, region);
      // Keep the screen-space venue sign clear, including at compressed zoom.
      line(c, { x: mid.x, y: Math.max(mid.y, r.y + 2) }, { x: mid.x, y: fr.y + fr.height - 2 }, detail, region);
      const decor = placed.venue.appearance === "bar" ? "┬──┬  BAR" : placed.venue.appearance === "garage" ? "▤ ▤ GARAGE" : placed.venue.appearance === "arcade" ? "▣ ▣ ARCADE" : placed.venue.appearance === "communications" ? "┴ /\\ COMMS" : "┬ ┬ OFFICE";
      if (ui.viewport.zoom === 1) text(c, fr.x + 1, fr.y + fr.height - 2, decor, detail, region, fr.width - 2);
    }
  }
  const entrance = screen(placed.entrance, ui, region);
  glyph(c, entrance.x, entrance.y, "╥", style(c, PAL.cyan, PAL.room, dim), region);
  if (!placed.venue.roster.length) {
    // Emptiness stays truthful and readable at every zoom, including the compressed facade.
    const caption = inner >= 7 ? "EMPTY 0" : "∅ 0";
    text(c, r.x + 1, r.y + r.height - 1, fit(caption, Math.max(0, inner)), style(c, PAL.muted, PAL.room, dim), region, Math.max(0, inner));
  }
  fill(c, titleClip, style(c, PAL.cream, PAL.room, dim), region);
  reserve(c, titleClip, region, 2);
  hit(hits, target, titleClip, region);
  const wideFacade = inner >= VENUE_NAME_MIN + 3 + sign.length + 2;
  const titleSid = style(c, selected ? PAL.yellow : PAL.cream, PAL.room, dim);
  if (wideFacade) {
    const nameBudget = inner - sign.length - 3;
    text(c, r.x + 1, titleY, selected ? `[${fit(name, nameBudget - 2)}]` : fit(name, nameBudget), titleSid, region, nameBudget);
    text(c, r.x + 1 + nameBudget + 1, titleY, `· ${sign}`, detail, region, sign.length + 2);
  } else if (inner >= VENUE_NAME_MIN + 2) {
    const nameBudget = inner - 2;
    text(c, r.x + 1, titleY, selected ? `[${fit(name, nameBudget - 2)}]` : fit(name, nameBudget), titleSid, region, nameBudget);
    glyph(c, r.x + r.width - 2, titleY, glyphCue, detail, region);
  } else {
    text(c, r.x + 1, titleY, fit(name, Math.max(0, inner - 2)), titleSid, region, Math.max(0, inner - 2));
    glyph(c, r.x + r.width - 2, titleY, glyphCue, detail, region);
  }
}

interface Label { target: CityTarget; slot: Rect; y: number; name: string; detail: string; selected: boolean; dim: boolean; }

function drawCharacters(c: Canvas, world: World, layout: CityLayout, ui: VizUi, region: Rect, ctx: CityRenderContext, hits: Hit[]): Label[] {
  const labels: Label[] = [];
  const byId = new Map(world.characters.map((ch) => [ch.id, ch]));
  const draw = (ch: CityCharacter, target: CityTarget, worldRect: Rect, anchor: Point, membership: boolean): void => {
    if (!matches(ch, ui)) return;
    const info = poseFor(ch, ctx.animator, ctx.clock, world.connection, ctx.reducedMotion);
    const appearance = ctx.appearances.get(ch.id);
    if (!appearance) return;
    const a = screen(worldRect, ui, region);
    const end = screen({ x: worldRect.x + worldRect.width, y: worldRect.y + worldRect.height }, ui, region);
    // Half-open projected slots have the actual alternating 4/5-cell pitch at zoom 4, without shared boundary cells.
    const slot: Rect = { x: Math.max(a.x, region.x), y: Math.max(a.y, region.y), width: Math.max(0, Math.min(end.x, region.x + region.width) - Math.max(a.x, region.x)), height: Math.max(0, Math.min(end.y, region.y + region.height) - Math.max(a.y, region.y)) };
    if (slot.width < 1 || slot.height < 1) return;
    while (slot.height > 0) {
      let signRow = false;
      for (let col = slot.x; col < slot.x + slot.width; col++) if (c.occupied[slot.y * c.cols + col] === 2) { signRow = true; break; }
      if (!signRow) break;
      slot.y++; slot.height--;
    }
    if (!slot.height) return;
    const selected = same(ui.selected, target) || (!membership && ui.selected?.kind === "membership" && ui.selected.id === ch.id);
    const dim = ui.focus && ui.selected !== null && !selected;
    const compact = !membership && ui.viewport.zoom === 1 && slot.width >= 7 && slot.height >= 6;
    const mini = !membership && !compact && ui.viewport.zoom <= 2 && slot.width >= 3 && slot.height >= 4;
    let artWidth = compact ? 7 : mini ? 3 : 1, artHeight = compact ? 4 : mini ? 2 : 1;
    const pos = screen(anchor, ui, region);
    let x = artWidth === 1 ? slot.x : Math.max(slot.x, Math.min(pos.x, slot.x + slot.width - artWidth));
    const labelRows = Math.min(2, slot.height - artHeight);
    let y = Math.max(slot.y, Math.min(pos.y, slot.y + slot.height - artHeight - labelRows));
    let blocked = false;
    for (let row = y; row < y + artHeight; row++) for (let col = x; col < x + artWidth; col++) if (c.occupied[row * c.cols + col]) blocked = true;
    if (blocked) {
      // A real moving character may enter another occupied slot. Retain a separate glyph, never erase its neighbor.
      artWidth = 1; artHeight = 1;
      let found = false;
      for (let row = slot.y; row < slot.y + slot.height && !found; row++) for (let col = slot.x; col < slot.x + slot.width; col++) {
        if (!c.occupied[row * c.cols + col]) { x = col; y = row; found = true; break; }
      }
      if (!found) return;
    }
    if (artWidth > 1) {
      const cells = rasterize(compactPixels(appearance, info.pose, compact ? "compact" : "mini"), dim ? "dim" : info.tone, ctx.color);
      for (let row = 0; row < cells.length; row++) for (let col = 0; col < cells[row].length; col++) {
        const cell = cells[row][col], at = (y + row) * c.cols + x + col;
        if (cell && !c.occupied[at]) {
          glyph(c, x + col, y + row, cell.ch, style(c, cell.fg ?? PAL.cream, cell.bg ?? PAL.room, dim), slot);
          c.occupied[at] = 1;
        }
      }
    } else {
      const color = compactPixels(appearance, "idle_a", "mini")[2][0] ?? PAL.cream;
      glyph(c, x, y, membership ? "@" : ch.source === "human" ? "◆" : ch.source === "process" ? "○" : "●", style(c, selected ? PAL.yellow : ctx.color ? shade(color, TONE[dim ? "dim" : info.tone]) : PAL.cream, PAL.room, dim), slot);
      c.occupied[y * c.cols + x] = 1;
    }
    reserve(c, { x, y, width: artWidth, height: artHeight }, slot, 1);
    hit(hits, target, { x, y, width: artWidth, height: artHeight }, region, selected ? 3 : 1);
    labels.push({ target, slot, y: y + artHeight, name: ch.name, detail: membership ? `${badge(ch)} MEMBER` : ch.source === "process" ? `${ch.harness === null ? "?" : HARNESS[ch.harness]} PID ${ch.pid ?? "?"} CPU${ch.cpu ?? "?"}%*` : `${badge(ch)} ${info.label}`, selected, dim });
  };
  for (const placed of layout.characters) {
    const ch = placed.character;
    if (!matches(ch, ui)) continue;
    const info = poseFor(ch, ctx.animator, ctx.clock, world.connection, ctx.reducedMotion);
    const anchor = info.label === "MOVING" ? ctx.animator.position(ch.id, ctx.clock) ?? placed.anchor : placed.anchor;
    const r = { ...placed.rect, x: placed.rect.x + anchor.x - placed.anchor.x, y: placed.rect.y + anchor.y - placed.anchor.y };
    if (placed.home === null && info.label !== "MOVING") {
      const station = screenRect(r, ui, region);
      box(c, station, style(c, ch.source === "process" ? PAL.muted : PAL.border), region, ch.source === "process");
      if (ch.source === "process" && ui.viewport.zoom === 1) text(c, station.x + 1, station.y, " PROCESS ", style(c, PAL.muted), region, station.width - 2);
    }
    draw(ch, { kind: "character", id: ch.id }, r, anchor, false);
  }
  for (const placed of layout.venues) for (const room of placed.rooms) {
    if (room.canonical) continue;
    const ch = byId.get(room.id);
    if (ch) draw(ch, { kind: "membership", id: ch.id, venueKey: placed.venue.key }, room.rect, room.anchor, true);
  }
  return labels;
}

/** Find the widest unoccupied run inside a target's slot, never expanding into a neighbor's allocation. */
function labelRun(c: Canvas, label: Label, start: number, minimum: number): Rect | null {
  const slot = label.slot;
  for (let y = Math.max(slot.y, start); y < slot.y + slot.height; y++) {
    let best: Rect | null = null;
    for (let x = slot.x; x < slot.x + slot.width;) {
      if (c.occupied[y * c.cols + x]) { x++; continue; }
      const left = x;
      while (x < slot.x + slot.width && !c.occupied[y * c.cols + x]) x++;
      if (x - left >= minimum && (!best || x - left > best.width)) best = { x: left, y, width: x - left, height: 1 };
    }
    if (best) return best;
  }
  return null;
}
function targetName(target: CityTarget, world: World): string {
  if (target.kind === "venue") return "#" + (world.venues.find((v) => v.key === target.venueKey)?.name ?? "unknown channel");
  return world.characters.find((c) => c.id === target.id)?.name ?? "unknown identity";
}
interface InspectorRow { text: string; target?: CityTarget; }
function inspectorRows(world: World, layout: CityLayout, ui: VizUi, ctx: CityRenderContext, now: number): InspectorRow[] {
  const selected = ui.selected;
  const rows: InspectorRow[] = [];
  if (!selected) return [
    { text: "Tab / hjkl · / search · I inspect" },
    ...matchingTargets(world, layout, ui).map(({ target }) => ({ text: targetName(target, world), target })),
  ];
  const add = (text: string, target?: CityTarget): void => { rows.push({ text, ...(target ? { target } : {}) }); };
  add(`[${targetName(selected, world)}]`);
  if (selected.kind === "venue") {
    const venue = world.venues.find((v) => v.key === selected.venueKey);
    if (!venue) return rows;
    add(`VENUE ${venue.appearance} · ${venue.roster.length} MEMBERS`);
    add(`POSTS ${venue.postCount} (not members)`);
    add("ROSTER");
    for (const member of venue.roster) {
      const state = poseFor(member, ctx.animator, ctx.clock, world.connection, ctx.reducedMotion).label;
      add(`${member.name} · ${badge(member)} ${state}${matches(member, ui) ? "" : " · FILTERED"}`, { kind: "membership", id: member.id, venueKey: venue.key });
    }
    if (!venue.roster.length) add("EMPTY · no registered members");
  } else {
    const ch = world.characters.find((v) => v.id === selected.id);
    if (!ch) return rows;
    const appearance = ctx.appearances.get(ch.id);
    add(`SOURCE ${ch.source.toUpperCase()}${matches(ch, ui) ? "" : " · FILTERED"}`);
    add(`${badge(ch)} · ${poseFor(ch, ctx.animator, ctx.clock, world.connection, ctx.reducedMotion).label}`);
    if (ch.source === "process") {
      add(`PID ${ch.pid ?? "unknown"} · CPU ${ch.cpu ?? "unknown"}% (inferred)`);
      add("Detected process, not registration");
      add("Detection uses process-surplus heuristic");
      add("No registered memberships");
    } else if (ch.source === "registered") {
      add(`HARNESS ${ch.harness ?? "unknown"} · ROLE ${ch.role ?? "unset"}`);
      add(`RAW ${ch.state ?? "unknown"} · PING ${ch.ping ?? "unknown"}`);
      add(`STALE ${ch.stale === null ? "unknown" : ch.stale} · BUSY ${ch.busy === null ? "UNKNOWN ?" : ch.busy}`);
      add(`CONTACT ${ch.lastSeen === null ? "unknown" : `${Math.max(0, Math.floor((now - ch.lastSeen) / 1000))}s ago`}`);
    } else add("OPERATOR · local human console");
    if (appearance) {
      const reason = appearance.reason === "no-model-metadata" ? "no model metadata" : appearance.reason === "session-mapping" ? "viz.json session" : appearance.reason === "harness-mapping" ? `viz.json harness ${ch.harness}` : appearance.reason === "detected-process" ? "detected process" : "operator";
      add(`OUTFIT ${appearance.outfit} v${appearance.variant + 1} · ${reason}`);
    }
    if (ch.source !== "human") add("MODEL unknown (not reported)");
    add(`CWD ${ch.cwd ?? "unknown"}`);
    for (const name of ch.previousNames) add(`FORMER ${name}`);
    if (ch.source === "registered") {
      add(`MEMBERSHIPS ${ch.memberships.length}`);
      const home = layout.byCharacter.get(ch.id)?.home;
      for (const name of ch.memberships) {
        const venue = world.venues.find((v) => v.name === name);
        add(`#${name}${venue?.key === home ? " · HOME" : " · secondary"}`, venue ? { kind: "membership", id: ch.id, venueKey: venue.key } : undefined);
      }
      if (!ch.memberships.length) add("Public street workstation");
    }
  }
  if (ui.notice) add(ui.notice);
  if (ctx.settingsWarning) add(ctx.settingsWarning);
  if (ctx.reducedMotion) add("REDUCED MOTION");
  add("OBSERVED EXCHANGES");
  const channelName = selected.kind === "venue" ? world.venues.find((v) => v.key === selected.venueKey)?.name : undefined;
  const exchanges = world.feed.filter((f) => selected.kind === "venue" ? f.channelTarget?.venueKey === selected.venueKey || f.channel !== undefined && f.channel === channelName : f.fromId === selected.id || f.toId === selected.id);
  for (const f of exchanges.slice(-50)) add(`[${KIND_TAG[f.kind]}] ${f.channel !== undefined ? "POST #" + f.channel : `DM ${f.from} → ${f.to}`} ${f.text}`);
  if (!exchanges.length) add("No observed traffic");
  return rows;
}
function drawInspector(c: Canvas, world: World, layout: CityLayout, ui: VizUi, ctx: CityRenderContext, now: number, r: Rect, hits: Hit[], focused: boolean): { length: number; used: number } {
  if (r.width < 1 || r.height < 1) return { length: 0, used: 0 };
  const full = { x: 0, y: 0, width: c.cols, height: c.rows };
  fill(c, r, style(c, PAL.cream), full);
  const framed = r.width >= 4 && r.height >= 3;
  if (framed) box(c, r, style(c, PAL.border), full);
  const body = { x: r.x + (framed ? 1 : 0), y: r.y + (framed ? 1 : 0), width: Math.max(1, r.width - (framed ? 2 : 0)), height: Math.max(0, r.height - (framed ? 2 : 0)) };
  if (framed) text(c, r.x + 2, r.y, " INSPECT / PgUp PgDn ", style(c, PAL.cyan), full, r.width - 4);
  let top = body.y;
  const selected = ui.selected;
  const ch = selected && selected.kind !== "venue" ? world.characters.find((ch) => ch.id === selected.id) : undefined;
  const app = ch ? ctx.appearances.get(ch.id) : undefined;
  if (selected && !ui.search && body.height > 0) {
    text(c, body.x, top++, fit(`[${targetName(selected, world)}]`, body.width), style(c, PAL.yellow), body);
  }
  // Art is fixed above paginated metadata; changing scroll never hides the selected identity.
  if (ch && app && !ui.search) {
    const detailed = focused ? r.width >= 24 && r.height >= 18 : body.width >= 22 && body.height >= 22;
    const art = detailed ? detailedPixels(app, poseFor(ch, ctx.animator, ctx.clock, world.connection, ctx.reducedMotion).pose) : focused && r.width >= 8 && r.height >= 6 || !focused && body.height >= 10 ? compactPixels(app, poseFor(ch, ctx.animator, ctx.clock, world.connection, ctx.reducedMotion).pose, "compact") : null;
    if (art) {
      const cells = rasterize(art, poseFor(ch, ctx.animator, ctx.clock, world.connection, ctx.reducedMotion).tone, ctx.color);
      sprite(c, cells, body.x + Math.max(0, Math.floor((body.width - cells[0].length) / 2)), top, body);
      top += cells.length + 1;
    }
  }
  let source = inspectorRows(world, layout, ui, ctx, now);
  if (ui.search) source = [{ text: `SEARCH /${ui.query}` }, ...(ui.results.length ? ui.results.map((target, i) => ({ text: `${i === ui.searchCursor ? ">" : " "} ${targetName(target, world)}`, target })) : [{ text: "NO MATCH · selection retained" }])];
  const wrapped: InspectorRow[] = [];
  const searchStarts: number[] = [];
  for (const row of source) {
    if (ui.search && row.target) searchStarts.push(wrapped.length);
    for (const part of wrapTerminalText(row.text, body.width)) wrapped.push({ ...row, text: part });
  }
  const available = Math.max(0, body.y + body.height - top);
  const desired = ui.search ? searchStarts[ui.searchCursor] ?? 0 : ui.inspectorScroll;
  const scroll = Math.min(Math.max(0, desired), Math.max(0, wrapped.length - Math.max(1, available)));
  for (let i = 0; i < available && scroll + i < wrapped.length; i++) {
    const row = wrapped[scroll + i];
    text(c, body.x, top + i, row.text, style(c, i === 0 && scroll === 0 ? PAL.yellow : PAL.cream), body);
    if (row.target) hit(hits, row.target, { x: body.x, y: top + i, width: body.width, height: 1 }, body, 10);
  }
  if (framed && wrapped.length > available) text(c, r.x + 2, r.y + r.height - 1, fit(` ${scroll + 1}-${Math.min(scroll + available, wrapped.length)}/${wrapped.length} PgUp/PgDn `, r.width - 4), style(c, PAL.cyan), full);
  return { length: wrapped.length, used: top - body.y + Math.min(available, wrapped.length) + 2 };
}
function drawMinimap(c: Canvas, layout: CityLayout, ui: VizUi, region: Rect, r: Rect): void {
  if (r.height < 8 || r.width < 8) return;
  const full = { x: 0, y: 0, width: c.cols, height: c.rows };
  box(c, r, style(c, PAL.border), full);
  text(c, r.x + 2, r.y, " REAL CITY ", style(c, PAL.cyan), full, r.width - 4);
  const inner = { x: r.x + 1, y: r.y + 1, width: r.width - 2, height: r.height - 2 };
  const b = layout.bounds;
  const project = (p: Point): Point => ({ x: inner.x + Math.min(inner.width - 1, Math.max(0, Math.floor((p.x - b.x) / Math.max(1, b.width) * inner.width))), y: inner.y + Math.min(inner.height - 1, Math.max(0, Math.floor((p.y - b.y) / Math.max(1, b.height) * inner.height))) });
  line(c, project({ x: b.x, y: 0 }), project({ x: b.x + b.width, y: 0 }), style(c, PAL.cyan), inner);
  for (const v of layout.venues) {
    const a = project(v.rect), z = project({ x: v.rect.x + v.rect.width, y: v.rect.y + v.rect.height });
    box(c, { ...a, width: Math.max(1, z.x - a.x + 1), height: Math.max(1, z.y - a.y + 1) }, style(c, PAL.muted), inner);
  }
  const view = viewWorld(ui, region), a = project(view), z = project({ x: view.x + view.width, y: view.y + view.height });
  box(c, { ...a, width: Math.max(1, z.x - a.x + 1), height: Math.max(1, z.y - a.y + 1) }, style(c, PAL.yellow), inner);
  const selected = ui.selected && layout.targets.find((t) => same(ui.selected, t.target));
  if (selected) {
    const p = project(selected.anchor);
    const direction = inside(selected.anchor, view) ? "◆" : selected.anchor.x < view.x ? "←" : selected.anchor.x >= view.x + view.width ? "→" : selected.anchor.y < view.y ? "↑" : "↓";
    glyph(c, p.x, p.y, direction, style(c, PAL.yellow), inner);
  }
}
function feedText(f: FeedLine): string {
  return `[${KIND_TAG[f.kind]}] ${f.channel !== undefined ? `POST #${f.channel} ${f.from}` : `DM ${f.from} → ${f.to}`} · ${f.text}`;
}

export function renderScene(world: World, layout: CityLayout, packets: readonly Packet[], ui: VizUi, tick: number, size: TerminalSize, now: number, embedded: boolean, context: CityRenderContext): SceneResult {
  const cols = Math.max(0, Math.floor(size.columns)), rows = Math.max(0, Math.floor(size.rows));
  const c = acquire(cols, rows), hits: Hit[] = [];
  const full: Rect = { x: 0, y: 0, width: cols, height: rows };
  const region = mapRegion(size, embedded);
  const candidates = matchingTargets(world, layout, ui);
  const view = viewWorld(ui, region);
  const onScreen = candidates.filter((p) => inside(world.connection === "connected" && !context.reducedMotion ? context.animator.position(p.target.kind === "character" ? p.target.id : "", context.clock) ?? p.anchor : p.anchor, view)).length;
  const registered = world.characters.filter((ch) => ch.source === "registered").length;
  const narrow = cols < 60 || rows < 20;
  const focused = narrow || ui.inspector === "focused" || ui.search;
  const wide = cols >= 110 && rows >= 26;
  const hints = embedded ? 0 : 1;
  // The OFFSCREEN count only exists when a city viewport is on screen; inspection modes list targets instead of inventing a count.
  const offscreen = focused ? null : candidates.length - onScreen;
  const header = cols < 60 ? `${layout.targets.length} TOTAL/${candidates.length} MATCH${offscreen === null ? "/INSPECT" : `/${offscreen} OFF`} · ${registered} SESSIONS` : `CITY · ${layout.targets.length} TOTAL · ${candidates.length} MATCH${offscreen === null ? " · INSPECT" : ` · ${offscreen} OFFSCREEN`} · ${registered} SESSIONS · ${world.venues.length} VENUES`;
  text(c, 0, 0, fit(header, cols), style(c, PAL.cream), full);
  const notice = [world.connection === "offline" ? "SIGNAL LOST / STALE SNAPSHOT" : "LINK ESTABLISHED", context.reducedMotion ? "REDUCED MOTION" : "", ui.notice ?? "", context.settingsWarning ?? ""].filter(Boolean).join(" · ");
  text(c, 0, 1, fit(notice, cols), style(c, world.connection === "offline" ? PAL.alert : PAL.cyan), full);
  let inspectorLength = 0;
  if (focused) {
    const ir = { x: 0, y: Math.min(rows - hints, rows >= 4 ? 2 : 0), width: cols, height: Math.max(0, rows - hints - (rows >= 4 ? 2 : 0)) };
    const rendered = drawInspector(c, world, layout, ui, context, now, ir, hits, true);
    inspectorLength = rendered.length;
    if (cols > 0 && rows === 1) {
      const target = ui.selected ?? candidates[0]?.target;
      if (target) { text(c, 0, 0, fit(targetName(target, world), cols), style(c, PAL.yellow), full); hit(hits, target, full, full, 10); }
    }
  } else {
    for (const route of layout.routes.values()) for (const seg of route.segments) line(c, screen(seg.from, ui, region), screen(seg.to, ui, region), style(c, PAL.cyan, PAL.void, true), region);
    const street = screen({ x: ui.viewport.x, y: 0 }, ui, region);
    line(c, street, { x: region.x + region.width - 1, y: street.y }, style(c, PAL.cyan), region, "═");
    for (const venue of layout.venues) drawVenue(c, venue, ui, region, hits);
    // Packets are real observed traffic only, and their path is sampled without expanding it into cells.
    if (world.connection === "connected") for (const p of packets.slice(-100)) {
      if (p.ageMs < 0 || p.ageMs >= PACKET_MS) continue;
      const dist = p.path.length * p.ageMs / PACKET_MS;
      const at = sampleRoute(p.path, dist);
      if (at) { const point = screen(at, ui, region); glyph(c, point.x, point.y, ["⠁", "⠂", "⠄", "⡀"][Math.floor(p.ageMs / 100) % 4], style(c, KIND_COLOR[p.kind]), region, true); }
      const tail = sampleRoute(p.path, Math.max(0, dist - 3 * ui.viewport.zoom));
      if (tail) { const point = screen(tail, ui, region); glyph(c, point.x, point.y, "⠒", style(c, KIND_COLOR[p.kind]), region, true); }
    }
    const labels = drawCharacters(c, world, layout, ui, region, context, hits);
    // Geometry bounds ordinary labels; occupancy protects every glyph and sign. Selected names paint last.
    labels.sort((a, b) => Number(a.selected) - Number(b.selected));
    for (const label of labels) {
      const sid = style(c, label.selected ? PAL.yellow : PAL.cream, PAL.room, label.dim);
      let run = labelRun(c, label, label.y, label.selected ? 3 : 1) ?? labelRun(c, label, label.slot.y, label.selected ? 3 : 1);
      if (!run && label.selected) {
        const floating = { ...label, slot: region };
        run = labelRun(c, floating, label.y, 3) ?? labelRun(c, floating, region.y, 3);
      }
      if (!run) continue;
      const name = label.selected ? `[${fit(label.name, run.width - 2)}]` : fit(label.name, run.width);
      fill(c, run, sid, region);
      text(c, run.x, run.y, name, sid, region, run.width);
      reserve(c, run, region, 1);
      hit(hits, label.target, run, region, label.selected ? 4 : 1);
      const detail = labelRun(c, label, run.y + 1, 1);
      if (detail && ui.viewport.zoom < 4) {
        fill(c, detail, sid, region);
        text(c, detail.x, detail.y, fit(label.detail, detail.width), sid, region, detail.width);
        reserve(c, detail, region, 1);
        hit(hits, label.target, detail, region, 1);
      }
    }
    const inspector = wide ? { x: region.width, y: 2, width: 32, height: region.height } : { x: 0, y: region.y + region.height, width: cols, height: 7 };
    const info = drawInspector(c, world, layout, ui, context, now, inspector, hits, false);
    inspectorLength = info.length;
    if (wide && inspector.height - info.used >= 8) drawMinimap(c, layout, ui, region, { x: inspector.x + 1, y: inspector.y + info.used, width: inspector.width - 2, height: inspector.height - info.used });
    const feedRows = wide ? 4 : 2;
    const feedTop = rows - hints - feedRows;
    const feed = world.feed.slice(-Math.min(50, feedRows));
    for (let i = 0; i < feed.length; i++) text(c, 0, feedTop + i, fit(feedText(feed[i]), cols), style(c, KIND_COLOR[feed[i].kind]), full);
    if (!feed.length) text(c, 0, feedTop, "OBSERVED TRAFFIC · no messages", style(c, PAL.muted), full);
  }
  if (!embedded && rows > 1) {
    const hintsText = ui.search ? "Type to search · ↑↓ results · Enter select · Esc cancel · Ctrl-K finder" : focused ? "Tab targets · / search · I/Esc city · PgUp/PgDn scroll · q quit" : "←↑↓→ pan · hjkl/Tab select · +/- zoom · 0 fit · / search · I inspect · Enter open · Space focus · f filter · u processes · F/T follow · r refresh · q quit";
    text(c, 0, rows - 1, fit(hintsText, cols), style(c, PAL.cyan), full);
  }
  const lines: TerminalSpan[][] = [];
  for (let y = 0; y < rows; y++) {
    const spans: TerminalSpan[] = [];
    let sid = -1, content = "";
    for (let x = 0; x < cols; x++) {
      const at = y * cols + x;
      if (c.styles[at] !== sid) { if (content) spans.push({ text: content, style: c.palette[sid] }); sid = c.styles[at]; content = ""; }
      content += c.ch[at];
    }
    if (content) spans.push({ text: content, style: c.palette[sid] });
    lines.push(spans);
  }
  return { frame: { lines }, hits, cityRegion: region, inspectorLength };
}
