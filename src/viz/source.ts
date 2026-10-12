import { AsenqClient } from "../shared/client.js";
import type { ClientOpts } from "../shared/client.js";
import type { ChannelSummary, ListedSession, PositionedEvent, Push, SessionIdentity, TailEvent } from "../shared/protocol.js";
import { REQUEST_TIMEOUT_MS, within } from "./map.js";
import type { MapDue, VizMap } from "./map.js";
import { rebaseCitySnapshot } from "./model.js";
import { scanProcesses } from "./scan.js";
import type { ProcInfo } from "./scan.js";

export type CitySink = Pick<VizMap, "setSnapshot" | "setConnection" | "setProcs" | "renameChannel" | "onMessage" | "setNotice" | "suspend">;
export type CitySourceHooks = { changed(): void; event?(event: TailEvent, fresh: boolean): void };
export type CitySourceDeps = { client?(options: ClientOpts): AsenqClient; scan?(): Promise<ProcInfo[]> };

/** Shared daemon snapshot/replay loop, independent of the terminal or browser host. */
export class CitySource {
  readonly client: AsenqClient;
  private readonly scan: () => Promise<ProcInfo[]>;
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

  constructor(private readonly sink: CitySink, private readonly hooks: CitySourceHooks, deps: CitySourceDeps = {}) {
    const clientOptions: ClientOpts = {
      autoStart: true,
      onPush: (p) => this.push(p),
      onReconnect: async () => {
        this.loadSeq++;
        this.sink.setConnection("offline");
        this.sink.suspend();
        this.hooks.changed();
        this.subscribed = false;
        await this.refresh();
      },
    };
    // An unregistered client is the human, as in the terminal console and CLI.
    this.client = deps.client ? deps.client(clientOptions) : new AsenqClient(clientOptions);
    this.scan = deps.scan ?? (() => scanProcesses());
  }

  start(): void {
    this.track(this.refresh());
    this.track(this.rescan());
  }

  fetch(due: MapDue): void {
    if (this.closed) return;
    if (due.list) this.track(this.refresh());
    if (due.scan) this.track(this.rescan());
  }

  async idle(): Promise<void> {
    while (this.tasks.size) await Promise.allSettled([...this.tasks]);
  }

  close(): void {
    this.closed = true;
    this.client.close();
  }

  private track(task: Promise<unknown>): void {
    const tracked = task.catch(() => {}).finally(() => this.tasks.delete(tracked));
    this.tasks.add(tracked);
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

  /** Publish a complete city bundle only; failed requests leave the last successful snapshot intact. */
  private async load(): Promise<void> {
    const attempt = ++this.loadSeq;
    try {
      const bundle = await within(this.snapshot(), REQUEST_TIMEOUT_MS);
      if (this.closed || attempt !== this.loadSeq) return;
      for (const item of bundle.events) this.applyEvent(item, false);
      this.watermark = Math.max(this.watermark, bundle.watermark);
      const pending = [...this.pending.values()].filter((item) => item.position > this.watermark).sort((a, b) => a.position - b.position);
      rebaseCitySnapshot(bundle, pending);
      this.identities = bundle.identities;
      for (const item of pending) this.applyEvent(item, item.animate);
      this.pending.clear();
      if (bundle.gap) this.sink.setNotice("HISTORY GAP · missing channel renames cannot be recovered");
      this.sink.setSnapshot(bundle.sessions, bundle.channels, bundle.identities);
      this.sink.setConnection("connected");
      this.subscribed = true;
      this.hydrated = true;
      if (pending.some((item) => item.event.type === "session" || item.event.type === "channel" || item.event.type === "ping")) this.refreshAgain = true;
    } catch {
      if (this.closed || attempt !== this.loadSeq) return;
      this.subscribed = false;
      this.sink.setConnection("offline");
    }
    this.hooks.changed();
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
      this.sink.setProcs(procs);
      this.hooks.changed();
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
    this.hooks.changed();
  }

  private applyEvent(item: PositionedEvent, animate: boolean): void {
    if (item.position <= this.watermark) return;
    this.watermark = item.position;
    const event = item.event;
    this.hooks.event?.(event, animate);
    if (event.type === "message") this.sink.onMessage(event.msg, animate);
    else if (event.type === "channel" && event.action === "renamed" && event.oldName) this.sink.renameChannel(event.oldName, event.channel.name);
    else if (event.type === "session") {
      const at = this.identities.findIndex((identity) => identity.id === event.session.id);
      if (at < 0) this.identities.push(event.session);
      else this.identities[at] = event.session;
    }
  }
}
