import type { ListedSession, StoredMessage } from "../shared/protocol.js";
import { sanitizeTerminalText } from "../tui/terminal.js";
import type { KeyInput, TerminalLine, TerminalSize } from "../tui/terminal.js";
import { buildWorld } from "./model.js";
import type { ProcInfo } from "./scan.js";
import { navigate, renderScene, visibleBugs } from "./scene.js";
import { VIZ_HARNESSES } from "./types.js";
import type { Bug, Direction, FeedLine, Hit, Packet, VizUi, World } from "./types.js";

/** Animation frame length; the host calls `step` at this period. */
export const TICK_MS = 100;
/** A daemon that does not answer within this long is treated as lost (a reconnecting client otherwise waits indefinitely). */
export const REQUEST_TIMEOUT_MS = 4000;
const LIST_MS = 2000;
const SCAN_MS = 5000;
const PACKET_MS = 1400;
const FEED_MAX = 50;
const PACKET_MAX = 100;
const SEEN_MAX = 500;
const TEXT_MAX = 200;

/** Which data the host should fetch now: a fresh session list and/or a process scan. */
export type MapDue = { list: boolean; scan: boolean };

type LivePacket = Omit<Packet, "ageMs"> & { born: number };

/** Rejects if `task` takes longer than `ms`; the late result is discarded. */
export function within<T>(task: Promise<T>, ms: number): Promise<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  const timer = setTimeout(() => reject(new Error("asenq daemon timed out")), ms);
  timer.unref?.();
  task.then(resolve, reject).finally(() => clearTimeout(timer));
  return promise;
}

const clean = (text: string): string => sanitizeTerminalText(text).slice(0, TEXT_MAX);

/**
 * The bug-map without a screen, client or timers: hosts feed it sessions, processes and messages, advance it with
 * `step`, route keys and clicks to it, and draw `frame` into a region of their choice.
 */
export class VizMap {
  private sessions: ListedSession[] = [];
  private procs: ProcInfo[] = [];
  private feed: FeedLine[] = [];
  private connection: World["connection"] = "offline";
  private world: World;
  private readonly ui: VizUi = { selectedId: null, filter: null, focus: false, feral: true };
  private packets: LivePacket[] = [];
  private hits: Hit[] = [];
  private size: TerminalSize = { columns: 0, rows: 0 };
  private readonly seen = new Set<string>();
  private feedSeq = 0;
  private clock = 0;
  private tick = 0;
  private lastList = 0;
  private lastScan = 0;
  private pending: MapDue = { list: false, scan: false };

  /** `now` supplies epoch ms for relative times and gone-session ageing. */
  constructor(private readonly now: () => number = Date.now) {
    this.world = this.build();
  }

  setSessions(sessions: ListedSession[], connection: World["connection"]): void {
    this.sessions = sessions;
    this.connection = connection;
    this.rebuild();
  }

  setProcs(procs: ProcInfo[]): void {
    this.procs = procs;
    this.rebuild();
  }

  /** Adds a feed line (and a packet when both endpoints are known); a message already seen is ignored. */
  onMessage(msg: StoredMessage): void {
    if (this.seen.has(msg.id)) return;
    this.seen.add(msg.id);
    if (this.seen.size > SEEN_MAX) this.seen.delete(this.seen.values().next().value as string);
    const channelPost = msg.to.startsWith("#");
    const from = this.endpoint(msg.fromSessionId, msg.from);
    const to = channelPost ? undefined : this.endpoint(msg.toSessionId, msg.to);
    const kind = msg.kind ?? "chat";
    const line: FeedLine = {
      seq: ++this.feedSeq, at: msg.createdAt, fromId: from?.id ?? null, toId: to?.id ?? null,
      from: from?.name ?? clean(msg.from), to: to?.name ?? clean(msg.to), kind,
      text: clean(msg.text || msg.file?.summary || ""),
    };
    this.feed = [...this.feed, line].slice(-FEED_MAX);
    if (from && to) {
      this.packets = [...this.packets, { seq: line.seq, fromId: from.id, toId: to.id, kind, born: this.clock }].slice(-PACKET_MAX);
    }
    this.rebuild();
  }

  /** Advances animation, packet lifetimes and the 2s/5s poll clocks by `ms`; returns what the host should fetch now. */
  step(ms: number): MapDue {
    this.clock += ms;
    this.tick = Math.floor(this.clock / TICK_MS);
    this.packets = this.packets.filter((p) => this.clock - p.born < PACKET_MS);
    if (this.clock - this.lastList >= LIST_MS) {
      this.lastList = this.clock;
      this.pending.list = true;
    }
    if (this.clock - this.lastScan >= SCAN_MS) {
      this.lastScan = this.clock;
      this.pending.scan = true;
    }
    return this.take();
  }

  /** Requests an immediate list and scan and restarts both poll clocks. */
  refresh(): void {
    this.lastList = this.clock;
    this.lastScan = this.clock;
    this.pending = { list: true, scan: true };
  }

  /** Returns and clears what is due; hosts call this after `key` (the `r` key requests a refresh). */
  take(): MapDue {
    const due = this.pending;
    this.pending = { list: false, scan: false };
    return due;
  }

  /** Handles a map key; false means the host should treat it as its own. */
  key(k: KeyInput): boolean {
    switch (k.name) {
      case "UP": return this.go("up");
      case "DOWN": return this.go("down");
      case "LEFT": return this.go("left");
      case "RIGHT": return this.go("right");
      case "TAB": return this.go("next");
      case "SHIFT_TAB": return this.go("prev");
      case "ENTER":
      case "KP_ENTER":
        this.ui.focus = !this.ui.focus;
        return true;
    }
    if (k.ctrl || k.alt) return false;
    switch ((k.text ?? k.name).toLowerCase()) {
      case "h": return this.go("left");
      case "j": return this.go("down");
      case "k": return this.go("up");
      case "l": return this.go("right");
      case "f":
        this.ui.filter = VIZ_HARNESSES[(this.ui.filter === null ? 0 : VIZ_HARNESSES.indexOf(this.ui.filter) + 1)] ?? null;
        this.rebuild();
        return true;
      case "u":
        this.ui.feral = !this.ui.feral;
        this.rebuild();
        return true;
      case "r":
        this.refresh();
        return true;
    }
    return false;
  }

  /** Selects the bug under a cell given relative to the region of the last `frame`; true when one was hit. */
  click(column: number, row: number): boolean {
    for (let i = this.hits.length - 1; i >= 0; i--) {
      const h = this.hits[i];
      if (column >= h.column && column < h.column + h.width && row >= h.row && row < h.row + h.height) {
        this.ui.selectedId = h.id;
        return true;
      }
    }
    return false;
  }

  /** Draws the scene for a region of `size`, remembering that size for navigation and click hits. */
  frame(size: TerminalSize): readonly TerminalLine[] {
    this.size = size;
    const packets: Packet[] = this.packets.map(({ born, ...p }) => ({ ...p, ageMs: this.clock - born }));
    try {
      const scene = renderScene(this.world, packets, this.ui, this.tick, size, this.now());
      this.hits = scene.hits;
      return scene.frame.lines;
    } catch (e) {
      this.hits = [];
      return [[{ text: clean(`VIZ RENDER FAULT: ${e instanceof Error ? e.message : String(e)}`), style: { foreground: "red" } }]];
    }
  }

  private build(): World {
    return buildWorld({
      sessions: this.sessions, procs: this.procs, feed: this.feed, connection: this.connection, now: this.now(),
    });
  }

  /** Rebuilds the world from current inputs and drops a selection that is no longer visible. */
  private rebuild(): void {
    this.world = this.build();
    this.reresolveFeed();
    this.world = this.build();
    const { selectedId } = this.ui;
    if (selectedId !== null && !visibleBugs(this.world, this.ui).some((b) => b.id === selectedId)) this.ui.selectedId = null;
  }

  /** Resolves a message endpoint to a bug by stable session id, else by current or former name. */
  private endpoint(sessionId: string | undefined, name: string): Bug | undefined {
    const bugs = this.world.bugs;
    if (name === "human") return bugs.find((b) => b.id === "human");
    return (sessionId ? bugs.find((b) => b.id === sessionId) : undefined)
      ?? bugs.find((b) => b.kind !== "human" && b.name === name)
      ?? bugs.find((b) => b.kind !== "human" && b.previousNames.includes(name));
  }

  /** Resolves feed lines whose endpoint could not be found when they arrived (world not yet loaded). */
  private reresolveFeed(): void {
    if (!this.feed.some((l) => l.fromId === null || l.toId === null)) return;
    this.feed = this.feed.map((l) => {
      const from = l.fromId === null ? this.endpoint(undefined, l.from) : undefined;
      const to = l.toId === null && !l.to.startsWith("#") ? this.endpoint(undefined, l.to) : undefined;
      return from || to
        ? { ...l, fromId: from?.id ?? l.fromId, toId: to?.id ?? l.toId, from: from?.name ?? l.from, to: to?.name ?? l.to }
        : l;
    });
  }

  private go(dir: Direction): boolean {
    const next = navigate(this.world, this.ui, this.size, dir);
    if (next !== null) this.ui.selectedId = next;
    return true;
  }
}
