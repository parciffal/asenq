import { sanitizeTerminalText, terminalTextWidth, truncateTerminalText, wrapTerminalText } from "../tui/terminal.js";
import type { TerminalSize, TerminalSpan, TerminalStyle } from "../tui/terminal.js";
import { poseFor } from "./animate.js";
import { compactPixels, detailedPixels } from "./cast.js";
import { matchingTargets, sampleRoute, targetKey } from "./place.js";
import { rasterize, shade } from "./sprites.js";
import type { SpriteCell, SpriteTone } from "./sprites.js";
import type { CityCharacter, CityLayout, CityRenderContext, CityTarget, FeedLine, Hit, Packet, PlacedVenue, Point, Rect, SceneResult, VizUi, World } from "./types.js";

const PAL = { void: "#100609", room: "#281018", border: "#a52b3a", cream: "#e8dec8", cyan: "#55ced1", yellow: "#f4e45a", alert: "#ff4355", muted: "#887780" } as const;
const KIND_COLOR: Record<FeedLine["kind"], string> = { chat: PAL.cream, task: PAL.yellow, result: PAL.cyan, status: PAL.cyan, control: PAL.alert };
const KIND_TAG: Record<FeedLine["kind"], string> = { chat: "CHAT", task: "TASK", result: "RESULT", status: "STATUS", control: "CTRL" };
const HARNESS: Record<NonNullable<CityCharacter["harness"]>, string> = { claude: "CC", codex: "CX", omp: "OMP", opencode: "OC" };
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
  cols: number; rows: number; ch: string[]; styles: number[]; owners: Int32Array; widths: Uint8Array;
  palette: TerminalStyle[]; styleIds: Map<string, number>;
}
let pool: Canvas | null = null;
function acquire(cols: number, rows: number): Canvas {
  const n = cols * rows;
  if (!pool || pool.cols !== cols || pool.rows !== rows) pool = {
    cols, rows, ch: new Array<string>(n), styles: new Array<number>(n), owners: new Int32Array(n), widths: new Uint8Array(n), palette: [], styleIds: new Map(),
  };
  pool.palette.length = 0;
  pool.styleIds.clear();
  style(pool, PAL.cream);
  pool.ch.fill(" "); pool.styles.fill(0); pool.owners.fill(-1); pool.widths.fill(0);
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
function glyph(c: Canvas, x: number, y: number, ch: string, sid: number, clip: Rect): void {
  const w = ch.length === 1 && ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) <= 126 ? 1 : terminalTextWidth(ch);
  if (w < 1 || !inside({ x, y }, clip) || x + w > clip.x + clip.width || x < 0 || y < 0 || x + w > c.cols || y >= c.rows) return;
  const at = y * c.cols + x;
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
  const label = `#${placed.venue.name}`;
  const sign = placed.venue.appearance === "communications" ? "COMMS /\\" : placed.venue.appearance.toUpperCase();
  text(c, r.x + 1, r.y + 1, fit(`${label} · ${sign}`, r.width - 2), style(c, PAL.cream, PAL.room, dim), region);
  const roof = placed.venue.appearance === "communications" ? "/|\\ /|\\" : placed.venue.appearance === "garage" ? "╤══════╤" : placed.venue.appearance === "arcade" ? "/ ▣ ▣ \\" : placed.venue.appearance === "bar" ? "/── BAR ──\\" : "┌─┬─┬─┐";
  if (ui.viewport.zoom === 1) text(c, r.x + 2, r.y, roof, detail, region, r.width - 4);
  if (ui.viewport.zoom === 4) return;
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
    line(c, mid, { x: mid.x, y: fr.y + fr.height - 2 }, detail, region);
    const decor = placed.venue.appearance === "bar" ? "┬──┬  BAR" : placed.venue.appearance === "garage" ? "▤ ▤ GARAGE" : placed.venue.appearance === "arcade" ? "▣ ▣ ARCADE" : placed.venue.appearance === "communications" ? "┴ /\\ COMMS" : "┬ ┬ OFFICE";
    if (ui.viewport.zoom === 1) text(c, fr.x + 1, fr.y + fr.height - 2, decor, detail, region, fr.width - 2);
  }
  const entrance = screen(placed.entrance, ui, region);
  glyph(c, entrance.x, entrance.y, "╥", style(c, PAL.cyan, PAL.room, dim), region);
  if (!placed.venue.roster.length) text(c, r.x + 2, r.y + Math.min(3, r.height - 2), "EMPTY · 0 MEMBERS", style(c, PAL.muted, PAL.room, dim), region, r.width - 4);
}

interface Label { target: CityTarget; x: number; y: number; width: number; name: string; detail: string; selected: boolean; dim: boolean; }
function drawCharacters(c: Canvas, world: World, layout: CityLayout, ui: VizUi, region: Rect, ctx: CityRenderContext, hits: Hit[]): Label[] {
  const labels: Label[] = [];
  const byId = new Map(world.characters.map((ch) => [ch.id, ch]));
  for (const placed of layout.characters) {
    const ch = placed.character;
    if (!matches(ch, ui)) continue;
    const info = poseFor(ch, ctx.animator, ctx.clock, world.connection, ctx.reducedMotion);
    const animated = info.label === "MOVING" ? ctx.animator.position(ch.id, ctx.clock) : null;
    const anchor = animated ?? placed.anchor;
    const pos = screen(anchor, ui, region);
    const appearance = ctx.appearances.get(ch.id);
    if (!appearance) continue;
    const target: CityTarget = { kind: "character", id: ch.id };
    const selected = same(ui.selected, target) || (ui.selected?.kind === "membership" && ui.selected.id === ch.id);
    const dim = ui.focus && ui.selected !== null && !selected;
    const compact = ui.viewport.zoom === 1;
    const artHeight = compact ? 4 : ui.viewport.zoom === 2 ? 2 : 1;
    const x = pos.x, y = pos.y;
    const rect = { x: pos.x - (compact ? 4 : 2), y, width: compact ? 16 : 8, height: artHeight + 2 };
    if (!intersects(rect, region)) continue;
    if (placed.home === null && !animated) {
      const station = screenRect(placed.rect, ui, region);
      box(c, station, style(c, ch.source === "process" ? PAL.muted : PAL.border), region, ch.source === "process");
      if (ch.source === "process") text(c, station.x + 1, station.y, " PROCESS ", style(c, PAL.muted), region, station.width - 2);
    }
    if (ui.viewport.zoom === 4) {
      const color = compactPixels(appearance, "idle_a", "mini")[2][0] ?? PAL.cream;
      glyph(c, x, y, ch.source === "human" ? "◆" : ch.source === "process" ? "○" : "●", style(c, ctx.color ? shade(color, TONE[dim ? "dim" : info.tone]) : PAL.cream, PAL.room, dim), region);
    } else sprite(c, rasterize(compactPixels(appearance, info.pose, compact ? "compact" : "mini"), dim ? "dim" : info.tone, ctx.color), x, y, region, dim);
    labels.push({ target, x: rect.x, y: pos.y + artHeight, width: rect.width, name: ch.name, detail: ch.source === "process" ? `${ch.harness === null ? "?" : HARNESS[ch.harness]} PID ${ch.pid ?? "?"} CPU${ch.cpu ?? "?"}%*` : `${badge(ch)} ${info.label}`, selected, dim });
    hit(hits, target, rect, region, selected ? 2 : 1);
  }
  for (const placed of layout.venues) for (const room of placed.rooms) {
    if (room.canonical) continue;
    const ch = byId.get(room.id);
    if (!ch || !matches(ch, ui)) continue;
    const pos = screen(room.anchor, ui, region);
    const target: CityTarget = { kind: "membership", id: ch.id, venueKey: placed.venue.key };
    const selected = same(ui.selected, target);
    const rect = { x: pos.x - (ui.viewport.zoom === 1 ? 4 : 2), y: pos.y, width: ui.viewport.zoom === 1 ? 16 : 8, height: 3 };
    if (!intersects(rect, region)) continue;
    glyph(c, pos.x, pos.y, "@", style(c, selected ? PAL.yellow : PAL.cyan, PAL.room, ui.focus && ui.selected !== null && !selected), region);
    labels.push({ target, x: rect.x, y: pos.y + 1, width: rect.width, name: ch.name, detail: `${badge(ch)} MEMBER`, selected, dim: ui.focus && ui.selected !== null && !selected });
    hit(hits, target, rect, region, selected ? 3 : 1);
  }
  return labels;
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
  const offscreen = focused ? candidates.length : candidates.length - onScreen;
  const header = cols < 60 ? `${layout.targets.length} TOTAL/${candidates.length} MATCH/${offscreen} OFF · ${registered} SESSIONS` : `CITY · ${layout.targets.length} TOTAL · ${candidates.length} MATCH · ${offscreen} OFFSCREEN · ${registered} SESSIONS · ${world.venues.length} VENUES`;
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
      if (at) { const point = screen(at, ui, region); glyph(c, point.x, point.y, ["⠁", "⠂", "⠄", "⡀"][Math.floor(p.ageMs / 100) % 4], style(c, KIND_COLOR[p.kind]), region); }
      const tail = sampleRoute(p.path, Math.max(0, dist - 3 * ui.viewport.zoom));
      if (tail) { const point = screen(tail, ui, region); glyph(c, point.x, point.y, "⠒", style(c, KIND_COLOR[p.kind]), region); }
    }
    const labels = drawCharacters(c, world, layout, ui, region, context, hits);
    // All labels after all sprites; selected labels last. No sprite can erase a name.
    labels.sort((a, b) => Number(a.selected) - Number(b.selected));
    for (const label of labels) {
      const sid = style(c, label.selected ? PAL.yellow : PAL.cream, PAL.room, label.dim);
      const name = label.selected ? `[${fit(label.name, label.width - 2)}]` : fit(label.name, label.width);
      fill(c, { x: label.x, y: label.y, width: label.width, height: 2 }, sid, region);
      text(c, label.x, label.y, name, sid, region, label.width);
      text(c, label.x, label.y + 1, fit(label.detail, label.width), sid, region, label.width);
    }
    if (ui.selected?.kind === "venue") {
      const placed = layout.byVenue.get(ui.selected.venueKey);
      if (placed) { const r = screenRect(placed.rect, ui, region); text(c, r.x + 1, r.y + 1, `[${fit("#" + placed.venue.name, r.width - 4)}]`, style(c, PAL.yellow, PAL.room), region, r.width - 2); }
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
