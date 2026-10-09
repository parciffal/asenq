import { AsenqClient } from "../shared/client.js";
import type { ClientOpts } from "../shared/client.js";
import type { ListedSession, Push } from "../shared/protocol.js";
import type { Screen } from "../tui/app.js";
import { TerminalAdapter, TerminalUnavailableError } from "../tui/terminal.js";
import type { KeyInput, MouseInput, TerminalAdapterOptions } from "../tui/terminal.js";
import { REQUEST_TIMEOUT_MS, TICK_MS, VizMap, within } from "./map.js";
import type { MapDue } from "./map.js";
import { scanProcesses } from "./scan.js";
import type { ProcInfo } from "./scan.js";

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

/** Standalone full-screen `asenq viz`: a client, a timer and a screen around a `VizMap`. */
export class VizApp {
  private readonly screen: Screen;
  private readonly client: AsenqClient;
  private readonly scan: () => Promise<ProcInfo[]>;
  private readonly schedule: (fn: () => void, ms: number) => () => void;
  private readonly map: VizMap;
  private subscribed = false;
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
    this.map = new VizMap(deps.now);
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

  /** Subscribes (once per connection) then lists; any failure shows the SIGNAL LOST world and retries on the next poll. */
  private async load(): Promise<void> {
    const attempt = ++this.loadSeq;
    let sessions: ListedSession[] = [];
    let connection: "connected" | "offline" = "offline";
    try {
      await this.client.connect();
      if (!this.subscribed) {
        await within(this.client.sync(), REQUEST_TIMEOUT_MS);
        if (attempt === this.loadSeq) this.subscribed = true;
      }
      const reply = await within(this.client.request("list"), REQUEST_TIMEOUT_MS);
      sessions = reply.sessions as ListedSession[];
      connection = "connected";
    } catch {
      this.subscribed = false;
    }
    if (this.closed) return;
    this.map.setSessions(sessions, connection);
    this.render();
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
    if (p.push !== "event" || this.closed) return;
    const event = p.event;
    if (event.type === "message") {
      this.map.onMessage(event.msg, true);
      this.render();
    } else if (event.type === "session" || event.type === "channel" || event.type === "ping") this.track(this.refresh());
  }

  // ------------------------------------------------------------------ input

  private key(k: KeyInput): void {
    if (this.closed) return;
    if (this.map.key(k)) {
      this.fetch(this.map.take());
      return this.render();
    }
    if (k.name === "ESCAPE" || (!k.ctrl && !k.alt && (k.text ?? k.name).toLowerCase() === "q")) this.quit();
  }

  private mouse(m: MouseInput): void {
    if (this.closed || m.action !== "press" || m.button !== "left") return;
    if (this.map.click(m.column, m.row)) this.render();
  }

  private render(): void {
    if (this.closed) return;
    this.screen.render({ lines: this.map.frame(this.screen.size) });
  }
}

export async function runViz(): Promise<number> {
  return new VizApp().run();
}
