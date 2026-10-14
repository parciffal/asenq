import type { ChannelSummary, HistoryScope, ListedSession, SessionIdentity, StoredMessage } from "../shared/protocol.js";
import { sanitizeTerminalText, terminalSupportsColor } from "../tui/terminal.js";
import type { KeyInput, MouseInput, TerminalLine, TerminalSize } from "../tui/terminal.js";
import { CharacterAnimator } from "./animate.js";
import { appearanceOf } from "./appearance.js";
import type { Appearance } from "./appearance.js";
import { buildWorld } from "./model.js";
import { CityPlacement, matchingTargets, routeBetween, routePoints, sampleRoute, targetKey } from "./place.js";
import type { ProcInfo } from "./scan.js";
import { mapRegion, renderScene } from "./scene.js";
import { DEFAULT_VIZ_SETTINGS } from "./settings.js";
import type { VizSettings } from "./settings.js";
import { VIZ_HARNESSES } from "./types.js";
import type { CityCharacter, CityLayout, CityPacket, CityTarget, CityView, FeedLine, Hit, Packet, Point, Rect, TargetPosition, VizUi, World } from "./types.js";

export const TICK_MS = 100;
export const REQUEST_TIMEOUT_MS = 4000;
const LIST_MS = 2000;
const SCAN_MS = 5000;
const PACKET_MS = 1400;
const FEED_MAX = 50;
const PACKET_MAX = 100;
const SEEN_MAX = 500;
export type MapDue = { list: boolean; scan: boolean };
export type VizMapOptions = {
  now?: () => number;
  embedded?: boolean;
  settings?: VizSettings;
  reducedMotion?: boolean;
  color?: boolean;
  settingsWarning?: string | null;
  onPacket?: (packet: CityPacket) => void;
};
type LivePacket = Omit<Packet, "ageMs"> & { born: number };

export function within<T>(task: Promise<T>, ms: number): Promise<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  const timer = setTimeout(() => reject(new Error("asenq daemon timed out")), ms);
  timer.unref?.();
  task.then(resolve, reject).finally(() => clearTimeout(timer));
  return promise;
}
const same = (a: CityTarget | null, b: CityTarget): boolean => a !== null && targetKey(a) === targetKey(b);

/** Screen/client/timer-free city controller. The host alone advances its visible clock. */
export class VizMap {
  private sessions: ListedSession[] = [];
  private channels: ChannelSummary[] = [];
  private identities: SessionIdentity[] = [];
  private procs: ProcInfo[] = [];
  private feed: FeedLine[] = [];
  private connection: World["connection"] = "offline";
  private world: World;
  private layout: CityLayout;
  private readonly placement = new CityPlacement();
  private readonly animator = new CharacterAnimator();
  private readonly appearances = new Map<string, Appearance>();
  private readonly ui: VizUi = {
    selected: null, filter: null, focus: false, processes: true, viewport: { x: -4, y: -18, zoom: 1 },
    search: false, query: "", results: [], searchCursor: 0, inspector: "normal", inspectorScroll: 0, follow: false, notice: null,
  };
  private packets: LivePacket[] = [];
  private hits: Hit[] = [];
  private size: TerminalSize = { columns: 0, rows: 0 };
  private region: Rect | null = null;
  private inspectorLength = 0;
  private readonly seen = new Set<string>();
  private feedSeq = 0;
  private clock = 0;
  private lastList = 0;
  private lastScan = 0;
  private snapshotClock: number | null = null;
  private pending: MapDue = { list: false, scan: false };
  private drag: Point | null = null;
  private readonly now: () => number;
  private readonly embedded: boolean;
  private readonly settings: VizSettings;
  private readonly reducedMotion: boolean;
  private readonly color: boolean;
  private readonly settingsWarning: string | null;
  private readonly onPacket?: (packet: CityPacket) => void;

  constructor(options: VizMapOptions = {}) {
    this.now = options.now ?? Date.now;
    this.embedded = options.embedded ?? false;
    this.settings = options.settings ?? DEFAULT_VIZ_SETTINGS;
    this.reducedMotion = (options.reducedMotion ?? false) || this.settings.reducedMotion;
    this.color = options.color ?? terminalSupportsColor();
    this.settingsWarning = options.settingsWarning ?? null;
    this.onPacket = options.onPacket;
    this.world = this.build();
    this.layout = this.placement.update(this.world);
    this.cacheAppearance();
  }
  get selected(): CityTarget | null { return this.ui.selected; }
  get searching(): boolean { return this.ui.search; }
  get packetCount(): number { return this.packets.length; }
  get animationCount(): number { return this.animator.size; }
  get flags(): string {
    return [this.ui.filter ? `FILTER:${this.ui.filter}` : "", this.ui.focus ? "FOCUS" : "", this.ui.processes ? "" : "PROCESS OFF",
      this.ui.follow ? `FOLLOW:${this.ui.follow}` : "", this.reducedMotion ? "REDUCED MOTION" : ""].filter(Boolean).join(" ");
  }
  setNotice(notice: string | null): void { this.ui.notice = notice === null ? null : sanitizeTerminalText(notice); }
  view(): CityView { return { world: this.world, layout: this.layout, appearances: this.appearances, notice: this.ui.notice }; }

  /** Publish a complete successful bundle; failed fetches must call setConnection only. */
  setSnapshot(sessions: ListedSession[], channels: ChannelSummary[], identities: SessionIdentity[]): void {
    const previous = this.layout;
    this.sessions = sessions;
    this.channels = channels;
    this.identities = identities;
    this.connection = "connected";
    this.rebuild();
    if (!this.reducedMotion && this.snapshotClock !== null && this.clock - this.snapshotClock <= 5000) {
      for (const move of this.layout.moved) {
        const key = targetKey({ kind: "character", id: move.id });
        const a = previous.routes.get(key);
        const b = this.layout.routes.get(key);
        if (!a || !b) continue;
        const points = [move.from, ...a.segments.map((s) => s.to)];
        const end = b.segments[b.segments.length - 1]?.to ?? move.to;
        points.push({ x: end.x, y: 0 });
        for (let i = b.segments.length - 1; i >= 0; i--) points.push(b.segments[i]!.from);
        points.push(move.to);
        this.animator.walk(move.id, routePoints(points), this.clock);
      }
    }
    this.snapshotClock = this.clock;
    this.follow();
  }
  setConnection(connection: World["connection"]): void {
    this.connection = connection;
    this.world.connection = connection;
    if (connection === "offline") this.suspend();
  }
  setProcs(procs: ProcInfo[]): void { this.procs = procs; this.rebuild(); }

  renameChannel(oldName: string, name: string): void {
    if (oldName === name) return;
    this.placement.renameChannel(oldName, name);
    this.channels = this.channels.map((c) => c.name === oldName ? { ...c, name } : c);
    this.sessions = this.sessions.map((s) => ({ ...s, channels: s.channels.map((c) => c === oldName ? name : c) }));
    this.feed = this.feed.map((line) => line.channel === oldName ? { ...line, channel: name, to: `#${name}` } : line);
    this.rebuild();
  }
  conversation(): HistoryScope | undefined {
    const target = this.ui.selected;
    if (!target) return undefined;
    if (target.kind === "venue") {
      const venue = this.layout.byVenue.get(target.venueKey);
      return venue ? { scope: "channel", channel: venue.venue.name } : undefined;
    }
    const c = this.world.characters.find((c) => c.id === target.id);
    return c?.source === "registered" ? { scope: "session", sessionId: c.id } : undefined;
  }
  suspend(): void {
    this.packets = [];
    this.animator.clear();
    this.snapshotClock = null;
    this.drag = null;
  }
  onMessage(msg: StoredMessage, animate: boolean): void {
    if (this.seen.has(msg.id)) return;
    this.seen.add(msg.id);
    if (this.seen.size > SEEN_MAX) this.seen.delete(this.seen.values().next().value as string);
    const channel = msg.channel ?? (msg.to.startsWith("#") ? msg.to.slice(1) : undefined);
    const from = this.endpoint(msg.fromSessionId, msg.from);
    const to = channel === undefined ? this.endpoint(msg.toSessionId, msg.to) : undefined;
    const venue = channel === undefined ? undefined : this.world.venues.find((v) => v.name === channel);
    const channelTarget = venue ? { kind: "venue" as const, venueKey: venue.key } : undefined;
    const line: FeedLine = {
      seq: ++this.feedSeq, at: msg.createdAt, fromId: msg.fromSessionId ?? from?.id ?? null,
      toId: channel === undefined ? msg.toSessionId ?? to?.id ?? null : null,
      from: from?.name ?? msg.from, to: channel !== undefined ? `#${channel}` : to?.name ?? msg.to,
      kind: msg.kind ?? "chat", text: msg.text || msg.file?.summary || "",
      ...(channel !== undefined ? { channel, channelTarget } : {}),
    };
    this.feed.push(line);
    if (this.feed.length > FEED_MAX) this.feed.shift();
    this.world.feed = this.feed;
    const destination: CityTarget | undefined = channelTarget ?? (to ? { kind: "character", id: to.id } : undefined);
    if (animate && this.connection === "connected" && from && destination) {
      const source: CityTarget = { kind: "character", id: from.id };
      const path = routeBetween(this.layout, source, destination);
      if (path) {
        this.packets.push({ seq: line.seq, from: source, to: destination, kind: line.kind, born: this.clock, path });
        this.onPacket?.({ seq: line.seq, from: source, to: destination, kind: line.kind, path, senderId: from.id });
        if (this.packets.length > PACKET_MAX) this.packets.shift();
        this.animator.send(from.id, this.clock);
      }
    }
    this.follow();
  }
  step(ms: number): MapDue {
    this.clock += Math.max(0, ms);
    this.animator.advance(this.clock);
    this.packets = this.packets.filter((p) => this.clock - p.born < PACKET_MS);
    if (this.clock - this.lastList >= LIST_MS) { this.lastList = this.clock; this.pending.list = true; }
    if (this.clock - this.lastScan >= SCAN_MS) { this.lastScan = this.clock; this.pending.scan = true; }
    this.follow();
    return this.take();
  }
  refresh(): void { this.lastList = this.clock; this.lastScan = this.clock; this.pending = { list: true, scan: true }; }
  take(): MapDue { const due = this.pending; this.pending = { list: false, scan: false }; return due; }

  key(k: KeyInput): boolean {
    if (k.ctrl || k.alt || k.name === "CTRL_C" || k.name === "CTRL_K") return false;
    if (this.ui.search) return this.searchKey(k);
    switch (k.name) {
      case "UP": this.pan(0, -8); return true;
      case "DOWN": this.pan(0, 8); return true;
      case "LEFT": this.pan(-8, 0); return true;
      case "RIGHT": this.pan(8, 0); return true;
      case "TAB": return this.go("next");
      case "SHIFT_TAB": return this.go("prev");
      case "ESCAPE":
        if (this.ui.inspector === "focused") { this.ui.inspector = "normal"; return true; }
        return false;
      case "PAGE_UP": this.scrollInspector(-6); return true;
      case "PAGE_DOWN": this.scrollInspector(6); return true;
      case "ENTER": case "KP_ENTER": this.ui.inspector = "focused"; return true;
      case "SPACE": this.ui.focus = !this.ui.focus; return true;
    }
    switch (k.text ?? k.name) {
      case "h": return this.go("left");
      case "j": return this.go("down");
      case "k": return this.go("up");
      case "l": return this.go("right");
      case "+": case "=": this.zoom(-1); return true;
      case "-": this.zoom(1); return true;
      case "0": this.fit(); return true;
      case " ": this.ui.focus = !this.ui.focus; return true;
      case "f":
        this.ui.filter = VIZ_HARNESSES[this.ui.filter === null ? 0 : VIZ_HARNESSES.indexOf(this.ui.filter) + 1] ?? null;
        this.updateSearch(); return true;
      case "u": this.ui.processes = !this.ui.processes; this.updateSearch(); return true;
      case "r": this.refresh(); return true;
      case "F": this.toggleFollow("session"); return true;
      case "T": this.toggleFollow("traffic"); return true;
      case "I": this.ui.inspector = this.ui.inspector === "focused" ? "normal" : "focused"; return true;
      case "/": this.ui.search = true; this.ui.query = ""; this.ui.searchCursor = 0; this.updateSearch(); return true;
    }
    return false;
  }
  click(column: number, row: number): boolean {
    let hit: Hit | undefined;
    for (const h of this.hits) {
      if (column >= h.column && column < h.column + h.width && row >= h.row && row < h.row + h.height && (!hit || (h.priority ?? 0) >= (hit.priority ?? 0))) hit = h;
    }
    if (!hit) return false;
    this.select(hit.target, false);
    return true;
  }
  mouse(m: MouseInput): boolean {
    if (m.action === "wheel-up" || m.action === "wheel-down") {
      const delta = m.action === "wheel-up" ? -3 : 3;
      const region = this.cityRegion();
      if (this.ui.inspector === "focused" || m.column < region.x || m.column >= region.x + region.width || m.row < region.y || m.row >= region.y + region.height) this.scrollInspector(delta);
      else this.pan(0, delta);
      return true;
    }
    if (m.action === "press" && m.button === "left") {
      this.drag = { x: m.column, y: m.row };
      return this.click(m.column, m.row);
    }
    if (m.action === "release") { this.drag = null; return false; }
    if (m.action === "drag" && m.button === "left") {
      const from = this.drag ?? (m.from ? { x: m.from.column, y: m.from.row } : null);
      if (from) this.pan(from.x - m.column, from.y - m.row);
      this.drag = { x: m.column, y: m.row };
      return from !== null;
    }
    return false;
  }
  frame(size: TerminalSize): readonly TerminalLine[] {
    this.size = size;
    const packets: Packet[] = this.packets.map(({ born, ...p }) => ({ ...p, ageMs: this.clock - born }));
    const scene = renderScene(this.world, this.layout, packets, this.ui, Math.floor(this.clock / TICK_MS), size, this.now(), this.embedded,
      { appearances: this.appearances, animator: this.animator, clock: this.clock, reducedMotion: this.reducedMotion, color: this.color, settingsWarning: this.settingsWarning });
    this.hits = scene.hits;
    this.region = scene.cityRegion ?? null;
    this.inspectorLength = scene.inspectorLength ?? 0;
    return scene.frame.lines;
  }

  private build(): World {
    return buildWorld({ sessions: this.sessions, channels: this.channels, identities: this.identities, procs: this.procs,
      feed: this.feed, connection: this.connection, now: this.now() });
  }
  private rebuild(): void {
    this.world = this.build();
    this.layout = this.placement.update(this.world);
    this.cacheAppearance();
    this.animator.prune(new Set(this.world.characters.map((c) => c.id)));
    if (this.ui.selected && !this.layout.targets.some((p) => same(this.ui.selected, p.target))) {
      const selected = this.ui.selected;
      const character = selected.kind !== "venue" && this.layout.byCharacter.has(selected.id) ? { kind: "character" as const, id: selected.id } : null;
      this.ui.selected = character;
      if (!character) this.ui.follow = false;
    }
    for (const line of this.feed) {
      // Retain explicit IDs even when absent; only legacy name-only endpoints can resolve late.
      if (line.fromId === null) line.fromId = this.endpoint(undefined, line.from)?.id ?? null;
      if (line.toId === null && line.channel === undefined) line.toId = this.endpoint(undefined, line.to)?.id ?? null;
      if (line.channel !== undefined) {
        const v = this.world.venues.find((v) => v.name === line.channel);
        line.channelTarget = v ? { kind: "venue", venueKey: v.key } : undefined;
      }
    }
    this.updateSearch();
  }
  private cacheAppearance(): void {
    const ids = new Set(this.world.characters.map((c) => c.id));
    for (const id of this.appearances.keys()) if (!ids.has(id)) this.appearances.delete(id);
    for (const c of this.world.characters) if (!this.appearances.has(c.id)) this.appearances.set(c.id, appearanceOf(c, this.settings));
  }
  private endpoint(sessionId: string | undefined, name: string): CityCharacter | undefined {
    // An explicit absent ID may not fall back to a replacement reusing its name.
    if (sessionId !== undefined) return this.world.characters.find((c) => c.source === "registered" && c.id === sessionId);
    if (name === "human") return this.world.characters.find((c) => c.source === "human");
    return this.world.characters.find((c) => c.source === "registered" && c.name === name)
      ?? this.world.characters.find((c) => c.source === "registered" && c.previousNames.includes(name));
  }
  private selectedPosition(): TargetPosition | undefined { return this.layout.targets.find((p) => same(this.ui.selected, p.target)); }
  private cityRegion(): Rect {
    const r = this.region ?? mapRegion(this.size, this.embedded);
    return { ...r, width: Math.max(1, r.width), height: Math.max(1, r.height) };
  }
  private center(point: Point): void {
    const r = this.cityRegion();
    this.ui.viewport.x = point.x - Math.floor(r.width * this.ui.viewport.zoom / 2);
    this.ui.viewport.y = point.y - Math.floor(r.height * this.ui.viewport.zoom / 2);
  }
  private select(target: CityTarget, center: boolean): void {
    if (!same(this.ui.selected, target)) { this.ui.inspectorScroll = 0; this.ui.follow = false; }
    this.ui.selected = target;
    if (center) { const p = this.selectedPosition(); if (p) this.center(p.anchor); }
  }
  private pan(x: number, y: number): void {
    this.ui.viewport.x += x * this.ui.viewport.zoom;
    this.ui.viewport.y += y * this.ui.viewport.zoom;
    this.ui.follow = false;
  }
  private zoom(direction: -1 | 1): void {
    const zooms = [1, 2, 4] as const;
    const old = this.ui.viewport.zoom;
    const next = zooms[Math.max(0, Math.min(2, zooms.indexOf(old) + direction))]!;
    if (next === old) return;
    const r = this.cityRegion();
    const selected = this.selectedPosition()?.anchor;
    const visible = selected && selected.x >= this.ui.viewport.x && selected.y >= this.ui.viewport.y
      && selected.x < this.ui.viewport.x + r.width * old && selected.y < this.ui.viewport.y + r.height * old;
    const point = visible ? selected : { x: this.ui.viewport.x + r.width * old / 2, y: this.ui.viewport.y + r.height * old / 2 };
    const sx = (point.x - this.ui.viewport.x) / old;
    const sy = (point.y - this.ui.viewport.y) / old;
    this.ui.viewport.zoom = next;
    this.ui.viewport.x = point.x - sx * next;
    this.ui.viewport.y = point.y - sy * next;
  }
  private fit(): void {
    const p = this.selectedPosition();
    if (!p) return;
    const r = this.cityRegion();
    const rect = p.target.kind === "membership" ? this.layout.byCharacter.get(p.target.id)?.rect ?? p.rect : p.rect;
    this.ui.viewport.zoom = ([1, 2, 4] as const).find((z) => rect.width + 2 <= r.width * z && rect.height + 2 <= r.height * z) ?? 4;
    this.center({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
  }
  private go(direction: "next" | "prev" | "left" | "right" | "up" | "down"): boolean {
    const candidates = matchingTargets(this.world, this.layout, this.ui);
    if (!candidates.length) return true;
    const current = this.selectedPosition();
    let next: TargetPosition | undefined;
    if (direction === "next" || direction === "prev") {
      const index = candidates.findIndex((p) => same(this.ui.selected, p.target));
      const offset = direction === "next" ? 1 : -1;
      next = candidates[index < 0 ? (offset === 1 ? 0 : candidates.length - 1) : (index + offset + candidates.length) % candidates.length];
    } else if (!current) next = candidates[0];
    else {
      let distance = Infinity;
      for (const p of candidates) {
        const dx = p.anchor.x - current.anchor.x;
        const dy = p.anchor.y - current.anchor.y;
        if (!(direction === "left" ? dx < 0 : direction === "right" ? dx > 0 : direction === "up" ? dy < 0 : dy > 0)) continue;
        const d = dx * dx + dy * dy;
        if (d < distance || (d === distance && next && targetKey(p.target) < targetKey(next.target))) { next = p; distance = d; }
      }
    }
    if (next) this.select(next.target, true);
    return true;
  }
  private updateSearch(): void {
    if (!this.ui.search) return;
    const query = sanitizeTerminalText(this.ui.query).toLocaleLowerCase();
    this.ui.results = matchingTargets(this.world, this.layout, this.ui).filter(({ target }) => {
      if (target.kind === "venue") return sanitizeTerminalText(this.layout.byVenue.get(target.venueKey)!.venue.name).toLocaleLowerCase().includes(query);
      const c = this.layout.byCharacter.get(target.id)!.character;
      return [c.name, ...c.previousNames].some((n) => sanitizeTerminalText(n).toLocaleLowerCase().includes(query));
    }).map((p) => p.target);
    this.ui.searchCursor = Math.max(0, Math.min(this.ui.searchCursor, this.ui.results.length - 1));
  }
  private searchKey(k: KeyInput): boolean {
    switch (k.name) {
      case "ESCAPE": this.ui.search = false; return true;
      case "UP": this.ui.searchCursor = Math.max(0, this.ui.searchCursor - 1); return true;
      case "DOWN": this.ui.searchCursor = Math.min(Math.max(0, this.ui.results.length - 1), this.ui.searchCursor + 1); return true;
      case "ENTER": case "KP_ENTER": {
        const result = this.ui.results[this.ui.searchCursor];
        if (result) this.select(result, true);
        this.ui.search = false;
        return true;
      }
      case "BACKSPACE": this.ui.query = [...this.ui.query].slice(0, -1).join(""); this.updateSearch(); return true;
    }
    const text = k.text ?? (k.name.length === 1 ? k.name : k.name === "SPACE" ? " " : "");
    if (text) { this.ui.query += sanitizeTerminalText(text); this.updateSearch(); }
    return true;
  }
  private scrollInspector(delta: number): void { this.ui.inspectorScroll = Math.max(0, Math.min(Math.max(0, this.inspectorLength - 1), this.ui.inspectorScroll + delta)); }
  private toggleFollow(mode: "session" | "traffic"): void {
    const target = this.ui.selected;
    if (!target || target.kind === "venue" || this.layout.byCharacter.get(target.id)?.character.source !== "registered") return;
    this.ui.follow = this.ui.follow === mode ? false : mode;
    this.follow();
  }
  private follow(): void {
    const target = this.ui.selected;
    if (!this.ui.follow || !target || target.kind === "venue") return;
    if (this.ui.follow === "traffic") {
      for (let i = this.packets.length - 1; i >= 0; i--) {
        const packet = this.packets[i]!;
        if ((packet.from.kind !== "venue" && packet.from.id === target.id) || (packet.to.kind !== "venue" && packet.to.id === target.id)) {
          this.center(sampleRoute(packet.path, packet.path.length * (this.clock - packet.born) / PACKET_MS));
          return;
        }
      }
    }
    const p = this.layout.byCharacter.get(target.id);
    if (p) this.center(this.animator.position(target.id, this.clock) ?? p.anchor);
  }
}
