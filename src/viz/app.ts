import { AsenqClient } from "../shared/client.js";
import type { ClientOpts } from "../shared/client.js";
import type { ChannelSummary, ListedSession, PositionedEvent, Push, SessionIdentity } from "../shared/protocol.js";
import type { Screen } from "../tui/app.js";
import { TerminalAdapter, TerminalUnavailableError } from "../tui/terminal.js";
import type { KeyInput, MouseInput, TerminalAdapterOptions } from "../tui/terminal.js";
import { REQUEST_TIMEOUT_MS, TICK_MS, VizMap, within } from "./map.js";
import type { MapDue } from "./map.js";
import { scanProcesses } from "./scan.js";
import type { ProcInfo } from "./scan.js";
import { readVizSettings } from "./settings.js";
import type { VizSettings } from "./settings.js";

export type VizDeps = {
  client?(options: ClientOpts): AsenqClient;
  screen?(options: TerminalAdapterOptions): Screen;
  /** Process detection; defaults to `ps`. */
  scan?(): Promise<ProcInfo[]>;
  /** Epoch ms for relative times; defaults to Date.now. */
  now?(): number;
  /** Repeating timer driving `step`; returns its canceller. Defaults to a single setInterval. */
  schedule?(fn: () => void, ms: number): () => void;
  settings?(): { settings: VizSettings; warning: string | null };
  reducedMotion?: boolean;
};

/** Standalone full-screen `asenq viz`: a client, a timer and a screen around a `VizMap`. */
export class VizApp {
  private readonly screen: Screen;
  private readonly client: AsenqClient;
  private readonly scan: () => Promise<ProcInfo[]>;
  private readonly schedule: (fn: () => void, ms: number) => () => void;
  private readonly map: VizMap;
  private subscribed = false;
  private hydrated = false;
  private watermark = 0;
  private identities: SessionIdentity[] = [];
  private readonly pending = new Map<number, PositionedEvent & { animate: boolean }>();
  private refreshing = false;
  private loadSeq = 0;
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
        this.loadSeq++;
        this.map.setConnection("offline");
        this.map.suspend();
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
      mouse: "drag",
    };
    this.screen = deps.screen ? deps.screen(screenOptions) : new TerminalAdapter(screenOptions);
    this.scan = deps.scan ?? (() => scanProcesses());
    const { settings, warning } = (deps.settings ?? readVizSettings)();
    this.map = new VizMap({ now: deps.now, settings, settingsWarning: warning, reducedMotion: deps.reducedMotion });
    this.schedule = deps.schedule ?? ((fn, ms) => {
      const timer = setInterval(fn, ms);
      return () => clearInterval(timer);
    });
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
    this.fetch(this.map.step(ms));
    this.render();
  }

  private fetch(due: MapDue): void {
    if (due.list) this.track(this.refresh());
    if (due.scan) this.track(this.rescan());
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

  /** Publish a complete city bundle only; failed requests leave the last successful snapshot intact. */
  private async load(): Promise<void> {
    const attempt = ++this.loadSeq;
    try {
      const bundle = await within(this.snapshot(), REQUEST_TIMEOUT_MS);
      if (this.closed || attempt !== this.loadSeq) return;
      for (const item of bundle.events) this.applyEvent(item, false);
      this.watermark = Math.max(this.watermark, bundle.watermark);
      this.identities = bundle.identities;
      let changed = false;
      for (const item of [...this.pending.values()].sort((a, b) => a.position - b.position)) {
        if (item.position <= this.watermark) continue;
        this.applyEvent(item, item.animate);
        changed ||= item.event.type !== "message";
      }
      this.pending.clear();
      if (bundle.gap) this.map.setNotice("HISTORY GAP · missing channel renames cannot be recovered");
      if (!changed) {
        this.map.setSnapshot(bundle.sessions, bundle.channels, bundle.identities);
        this.map.setConnection("connected");
        this.subscribed = true;
        this.hydrated = true;
      }
      if (changed) this.refreshAgain = true;
    } catch {
      if (this.closed || attempt !== this.loadSeq) return;
      this.subscribed = false;
      this.map.setConnection("offline");
    }
    this.render();
  }

  private async snapshot(): Promise<{
    sessions: ListedSession[]; channels: ChannelSummary[]; identities: SessionIdentity[];
    events: PositionedEvent[]; watermark: number; gap: boolean;
  }> {
    await this.client.connect();
    let identities = [...this.identities];
    const events: PositionedEvent[] = [];
    let watermark = this.watermark;
    let gap = false;
    if (!this.subscribed) {
      const snapshot = await this.client.sync();
      identities = snapshot.sessions;
      if (this.hydrated) {
        for (;;) {
          const replay = await this.client.replay(watermark);
          if (replay.gap) { gap = true; break; }
          for (const item of replay.events) {
            if (item.position <= watermark) continue;
            watermark = item.position;
            events.push(item);
            if (item.event.type === "session") {
              const session = item.event.session;
              const at = identities.findIndex((identity) => identity.id === session.id);
              if (at < 0) identities.push(session);
              else identities[at] = session;
            }
          }
          if (!replay.hasMore) break;
        }
      }
      watermark = Math.max(watermark, snapshot.watermark);
    }
    const [list, channelList] = await Promise.all([this.client.request("list"), this.client.request("channel_list")]);
    const sessions = list.sessions as ListedSession[];
    const channels = (channelList.channels as ChannelSummary[]).map((channel) => ({ ...channel }));
    const known = new Set([...sessions, ...identities].map((session) => session.id));
    await Promise.all(channels.map(async (channel) => {
      if (channel.memberIds !== undefined && channel.memberIds.every((id) => known.has(id))) return;
      const reply = await this.client.request("channel_members", { channel: channel.name });
      const members = reply.members as SessionIdentity[];
      if (channel.memberIds === undefined) channel.memberIds = members.map((member) => member.id);
      for (const member of members) if (!identities.some((identity) => identity.id === member.id)) identities.push(member);
    }));
    return { sessions, channels, identities, events, watermark, gap };
  }

  private async rescan(): Promise<void> {
    if (this.scanning || this.closed) return;
    this.scanning = true;
    try {
      const procs = await this.scan();
      if (this.closed) return;
      this.map.setProcs(procs);
      this.render();
    } finally {
      this.scanning = false;
    }
  }

  private push(p: Push): void {
    if (p.push !== "event" || this.closed || p.position <= this.watermark) return;
    if (!this.subscribed || this.refreshing) {
      this.pending.set(p.position, { position: p.position, event: p.event, animate: this.subscribed });
      return;
    }
    this.applyEvent(p, true);
    if (p.event.type === "session" || p.event.type === "channel" || p.event.type === "ping") this.track(this.refresh());
    this.render();
  }

  private applyEvent(item: PositionedEvent, animate: boolean): void {
    if (item.position <= this.watermark) return;
    this.watermark = item.position;
    const event = item.event;
    if (event.type === "message") this.map.onMessage(event.msg, animate);
    else if (event.type === "channel" && event.action === "renamed" && event.oldName) this.map.renameChannel(event.oldName, event.channel.name);
    else if (event.type === "session") {
      const at = this.identities.findIndex((identity) => identity.id === event.session.id);
      if (at < 0) this.identities.push(event.session);
      else this.identities[at] = event.session;
    }
  }

  // ------------------------------------------------------------------ input

  private key(k: KeyInput): void {
    if (this.closed) return;
    if (k.name === "CTRL_C") return this.quit();
    if (this.map.key(k)) {
      this.fetch(this.map.take());
      return this.render();
    }
    if (k.name === "ESCAPE" || (!k.ctrl && !k.alt && (k.text ?? k.name).toLowerCase() === "q")) this.quit();
  }

  private mouse(m: MouseInput): void {
    if (this.closed) return;
    if (this.map.mouse(m)) this.render();
  }

  private render(): void {
    if (this.closed) return;
    this.screen.render({ lines: this.map.frame(this.screen.size) });
  }
}

export async function runViz(args: string[]): Promise<number> {
  if (args.length > 1 || (args.length === 1 && args[0] !== "--reduced-motion")) {
    process.stderr.write("usage: asenq viz [--reduced-motion]\n");
    return 1;
  }
  return new VizApp({ reducedMotion: args.length === 1 }).run();
}
