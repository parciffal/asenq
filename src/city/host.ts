import type { HistoryPage, HistoryScope, StoredMessage } from "../shared/protocol.js";
import { TICK_MS, VizMap } from "../viz/map.js";
import { readVizSettings } from "../viz/settings.js";
import type { VizSettings } from "../viz/settings.js";
import { CitySource } from "../viz/source.js";
import type { CitySourceDeps } from "../viz/source.js";
import type { CityPacket } from "../viz/types.js";
import { toWire } from "./wire.js";
import type { CityWire } from "./wire.js";

export type CityDeps = CitySourceDeps & {
  schedule?(fn: () => void, ms: number): () => void;
  settings?(): { settings: VizSettings; warning: string | null };
  reducedMotion?: boolean;
};
export type CityEvent =
  | { event: "state"; data: CityWire }
  | { event: "packet"; data: CityPacket }
  | { event: "message"; data: { msg: StoredMessage } };

/** A headless city projection; browser reads never advance the human read markers. */
export class CityHost {
  private readonly map: VizMap;
  private readonly source: CitySource;
  private readonly warning: string | null;
  private readonly reducedMotion: boolean;
  private readonly listeners = new Set<(event: CityEvent) => void>();
  private readonly schedule: (fn: () => void, ms: number) => () => void;
  private lastState: string;
  private stopTicks?: () => void;
  private started = false;
  private closed = false;

  constructor(deps: CityDeps = {}) {
    const { settings, warning } = (deps.settings ?? readVizSettings)();
    this.warning = warning;
    this.reducedMotion = (deps.reducedMotion ?? false) || settings.reducedMotion;
    this.map = new VizMap({
      settings, settingsWarning: warning, reducedMotion: this.reducedMotion, color: false,
      onPacket: (data) => this.broadcast({ event: "packet", data }),
    });
    this.lastState = JSON.stringify(this.current());
    this.source = new CitySource(this.map, {
      changed: () => this.changed(),
      event: (event) => { if (event.type === "message") this.broadcast({ event: "message", data: { msg: event.msg } }); },
    }, deps);
    this.schedule = deps.schedule ?? ((fn, ms) => {
      const timer = setInterval(fn, ms);
      return () => clearInterval(timer);
    });
  }

  start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    this.source.start();
    this.stopTicks = this.schedule(() => {
      this.source.fetch(this.map.step(TICK_MS));
      this.changed();
    }, TICK_MS);
  }

  subscribe(listener: (event: CityEvent) => void): () => void {
    this.listeners.add(listener);
    listener({ event: "state", data: this.current() });
    return () => { this.listeners.delete(listener); };
  }

  current(): CityWire { return toWire(this.map.view(), this.warning, this.reducedMotion); }

  history(scope: HistoryScope, before?: number): Promise<HistoryPage> {
    return this.source.client.historyPage({ ...scope, ...(before === undefined ? {} : { before }), limit: 60 });
  }

  async send(target: { kind: "session"; id: string } | { kind: "channel"; name: string }, text: string): Promise<unknown> {
    if (target.kind === "session") return { result: await this.source.client.sendToSession(target.id, text) };
    const { msgId, results } = await this.source.client.request("channel_send", { channel: target.name, text });
    return { msgId, results };
  }

  idle(): Promise<void> { return this.source.idle(); }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopTicks?.();
    this.source.close();
    this.listeners.clear();
  }

  private changed(): void {
    if (this.closed) return;
    const data = this.current();
    const serialized = JSON.stringify(data);
    if (serialized === this.lastState) return;
    this.lastState = serialized;
    this.broadcast({ event: "state", data });
  }

  private broadcast(event: CityEvent): void {
    if (this.closed) return;
    for (const listener of this.listeners) listener(event);
  }
}
