import { AsenqClient, type ClientOpts } from "../shared/client.js";
import type { ListedSession, Push, StoredMessage } from "../shared/protocol.js";
import type { Screen } from "../tui/app.js";
import {
  sanitizeTerminalText, TerminalAdapter, TerminalUnavailableError,
  type KeyInput, type MouseInput, type TerminalAdapterOptions,
} from "../tui/terminal.js";
import { buildWorld } from "./model.js";
import { scanProcesses, type ProcInfo } from "./scan.js";
import { navigate, renderScene, visibleBugs } from "./scene.js";
import { VIZ_HARNESSES, type Bug, type Direction, type FeedLine, type Hit, type Packet, type VizUi, type World } from "./types.js";

export type VizDeps = {
  client?(options: ClientOpts): AsenqClient;
  screen?(options: TerminalAdapterOptions): Screen;
  /** Process detection; defaults to `ps`. */
  scan?(): Promise<ProcInfo[]>;
  /** Epoch ms for relative times; defaults to Date.now. */
  now?(): number;
  /** Repeating timer driving `step`; returns its canceller. Defaults to a single setInterval. */
  schedule?(fn: () => void, ms: number): () => void;
};

/** Animation frame length; one setInterval runs at this period and everything else is counted off it. */
const TICK_MS = 100;
const LIST_MS = 2000;
const SCAN_MS = 5000;
const PACKET_MS = 1400;
const FEED_MAX = 50;
const PACKET_MAX = 100;
const SEEN_MAX = 500;
/** A daemon that does not answer within this long is treated as lost (a reconnecting client otherwise waits indefinitely). */
const REQUEST_TIMEOUT_MS = 4000;
const TEXT_MAX = 200;

type LivePacket = Omit<Packet, "ageMs"> & { born: number };

/** Rejects if `task` takes longer than `ms`; the late result is discarded. */
function within<T>(task: Promise<T>, ms: number): Promise<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  const timer = setTimeout(() => reject(new Error("asenq daemon timed out")), ms);
  timer.unref?.();
  task.then(resolve, reject).finally(() => clearTimeout(timer));
  return promise;
}

const clean = (text: string): string => sanitizeTerminalText(text).slice(0, TEXT_MAX);

export class VizApp {
  private readonly screen: Screen;
  private readonly client: AsenqClient;
  private readonly scan: () => Promise<ProcInfo[]>;
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => () => void;
  private sessions: ListedSession[] = [];
  private procs: ProcInfo[] = [];
  private feed: FeedLine[] = [];
  private connection: World["connection"] = "offline";
  private world: World;
  private readonly ui: VizUi = { selectedId: null, filter: null, focus: false, feral: true };
  private packets: LivePacket[] = [];
  private hits: Hit[] = [];
  private readonly seen = new Set<string>();
  private feedSeq = 0;
  private clock = 0;
  private tick = 0;
  private lastList = 0;
  private lastScan = 0;
  private subscribed = false;
  private refreshing = false;
  private refreshAgain = false;
  private scanning = false;
  private closed = false;
  private readonly tasks = new Set<Promise<unknown>>();
  private stopTicks?: () => void;
  private readonly done = Promise.withResolvers<number>();

  constructor(deps: VizDeps = {}) {
    const clientOptions: ClientOpts = {
      autoStart: true,
      onPush: (p) => this.push(p),
      onReconnect: async () => {
        this.subscribed = false;
        await this.refresh();
      },
    };
    this.client = deps.client ? deps.client(clientOptions) : new AsenqClient(clientOptions);
    const screenOptions: TerminalAdapterOptions = {
      onKey: (k) => this.key(k),
      onMouse: (m) => this.mouse(m),
      onResize: () => this.render(),
      onInterrupt: () => this.quit(),
      mouse: "button",
    };
    this.screen = deps.screen ? deps.screen(screenOptions) : new TerminalAdapter(screenOptions);
    this.scan = deps.scan ?? (() => scanProcesses());
    this.now = deps.now ?? Date.now;
    this.schedule = deps.schedule ?? ((fn, ms) => {
      const timer = setInterval(fn, ms);
      return () => clearInterval(timer);
    });
    this.world = this.build();
  }

  async run(): Promise<number> {
    try {
      this.screen.start();
    } catch (e) {
      if (!(e instanceof TerminalUnavailableError)) throw e;
      process.stderr.write("asenq viz requires a usable terminal (TTY)\n");
      return 1;
    }
    this.stopTicks = this.schedule(() => this.step(TICK_MS), TICK_MS);
    this.render();
    this.track(this.refresh());
    this.track(this.rescan());
    return this.done.promise;
  }

  /** Resolves once every in-flight refresh and scan has settled (test seam). */
  async idle(): Promise<void> {
    while (this.tasks.size) await Promise.allSettled([...this.tasks]);
  }

  /**
   * Advances animation, packet lifetimes and the 2s/5s poll clocks by `ms`, then draws a frame.
   * The scheduled timer calls this every 100ms; tests call it directly instead of waiting.
   */
  step(ms: number): void {
    if (this.closed) return;
    this.clock += ms;
    this.tick = Math.floor(this.clock / TICK_MS);
    this.packets = this.packets.filter((p) => this.clock - p.born < PACKET_MS);
    if (this.clock - this.lastList >= LIST_MS) {
      this.lastList = this.clock;
      this.track(this.refresh());
    }
    if (this.clock - this.lastScan >= SCAN_MS) {
      this.lastScan = this.clock;
      this.track(this.rescan());
    }
    this.render();
  }

  private track(task: Promise<unknown>): void {
    const tracked = task.catch(() => {}).finally(() => this.tasks.delete(tracked));
    this.tasks.add(tracked);
  }

  private quit(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopTicks?.();
    this.client.close();
    this.screen.cleanup();
    this.done.resolve(0);
  }

  // ------------------------------------------------------------------ data

  private build(): World {
    return buildWorld({
      sessions: this.sessions, procs: this.procs, feed: this.feed, connection: this.connection, now: this.now(),
    });
  }

  /** Rebuilds the world from current inputs, drops a selection/filter-hidden bug and redraws. */
  private rebuild(): void {
    this.world = this.build();
    this.reconcile();
    this.render();
  }

  private reconcile(): void {
    const { selectedId } = this.ui;
    if (selectedId !== null && !visibleBugs(this.world, this.ui).some((b) => b.id === selectedId)) this.ui.selectedId = null;
  }

  /** Coalesces concurrent requests: a request during a refresh schedules exactly one more pass. */
  private async refresh(): Promise<void> {
    if (this.closed) return;
    if (this.refreshing) {
      this.refreshAgain = true;
      return;
    }
    this.refreshing = true;
    try {
      do {
        this.refreshAgain = false;
        await this.load();
      } while (this.refreshAgain && !this.closed);
    } finally {
      this.refreshing = false;
    }
  }

  /** Subscribes (once per connection) then lists; any failure shows the SIGNAL LOST world and retries on the next poll. */
  private async load(): Promise<void> {
    try {
      const reply = await within((async () => {
        if (!this.subscribed) {
          await this.client.sync();
          this.subscribed = true;
        }
        return this.client.request("list");
      })(), REQUEST_TIMEOUT_MS);
      this.sessions = reply.sessions as ListedSession[];
      this.connection = "connected";
    } catch {
      this.subscribed = false;
      this.sessions = [];
      this.connection = "offline";
    }
    if (!this.closed) this.rebuild();
  }

  private async rescan(): Promise<void> {
    if (this.scanning || this.closed) return;
    this.scanning = true;
    try {
      this.procs = await this.scan();
      if (!this.closed) this.rebuild();
    } finally {
      this.scanning = false;
    }
  }

  private push(p: Push): void {
    if (p.push !== "event" || this.closed) return;
    const event = p.event;
    if (event.type === "message") this.message(event.msg);
    else if (event.type === "session" || event.type === "channel" || event.type === "ping") this.track(this.refresh());
  }

  /** Resolves a message endpoint to a bug by stable session id, else by current or former name. */
  private endpoint(sessionId: string | undefined, name: string): Bug | undefined {
    const bugs = this.world.bugs;
    if (name === "human") return bugs.find((b) => b.id === "human");
    if (sessionId) return bugs.find((b) => b.id === sessionId);
    return bugs.find((b) => b.kind !== "human" && b.name === name)
      ?? bugs.find((b) => b.kind !== "human" && b.previousNames.includes(name));
  }

  private message(msg: StoredMessage): void {
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

  // ------------------------------------------------------------------ input

  private go(dir: Direction): void {
    const next = navigate(this.world, this.ui, this.screen.size, dir);
    if (next !== null) this.ui.selectedId = next;
    this.render();
  }

  private key(k: KeyInput): void {
    if (this.closed) return;
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
        return this.render();
      case "ESCAPE": return this.quit();
    }
    if (k.ctrl || k.alt) return;
    switch ((k.text ?? k.name).toLowerCase()) {
      case "h": return this.go("left");
      case "j": return this.go("down");
      case "k": return this.go("up");
      case "l": return this.go("right");
      case "f":
        this.ui.filter = VIZ_HARNESSES[(this.ui.filter === null ? 0 : VIZ_HARNESSES.indexOf(this.ui.filter) + 1)] ?? null;
        return this.rebuild();
      case "u":
        this.ui.feral = !this.ui.feral;
        return this.rebuild();
      case "r":
        this.lastList = this.clock;
        this.lastScan = this.clock;
        this.track(this.refresh());
        this.track(this.rescan());
        return;
      case "q": return this.quit();
    }
  }

  private mouse(m: MouseInput): void {
    if (this.closed || m.action !== "press" || m.button !== "left") return;
    for (let i = this.hits.length - 1; i >= 0; i--) {
      const h = this.hits[i];
      if (m.column >= h.column && m.column < h.column + h.width && m.row >= h.row && m.row < h.row + h.height) {
        this.ui.selectedId = h.id;
        return this.render();
      }
    }
  }

  // ------------------------------------------------------------------ output

  private render(): void {
    if (this.closed) return;
    const packets: Packet[] = this.packets.map(({ born, ...p }) => ({ ...p, ageMs: this.clock - born }));
    try {
      const scene = renderScene(this.world, packets, this.ui, this.tick, this.screen.size, this.now());
      this.hits = scene.hits;
      this.screen.render(scene.frame);
    } catch (e) {
      this.hits = [];
      this.screen.render({ lines: [[{ text: clean(`VIZ RENDER FAULT: ${e instanceof Error ? e.message : String(e)}`), style: { foreground: "red" } }]] });
    }
  }
}

export async function runViz(): Promise<number> {
  return new VizApp().run();
}
