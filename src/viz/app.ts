import type { AsenqClient, ClientOpts } from "../shared/client.js";
import type { Screen } from "../tui/app.js";
import { TerminalAdapter, TerminalUnavailableError } from "../tui/terminal.js";
import type { KeyInput, MouseInput, TerminalAdapterOptions } from "../tui/terminal.js";
import { TICK_MS, VizMap } from "./map.js";
import type { ProcInfo } from "./scan.js";
import { CitySource } from "./source.js";
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
  private readonly source: CitySource;
  private readonly schedule: (fn: () => void, ms: number) => () => void;
  private readonly map: VizMap;
  private closed = false;
  private stopTicks?: () => void;
  private readonly done = Promise.withResolvers<number>();

  constructor(deps: VizDeps = {}) {
    const screenOptions: TerminalAdapterOptions = {
      onKey: (k) => this.key(k),
      onMouse: (m) => this.mouse(m),
      onResize: () => this.render(),
      onInterrupt: () => this.quit(),
      mouse: "drag",
    };
    this.screen = deps.screen ? deps.screen(screenOptions) : new TerminalAdapter(screenOptions);
    const { settings, warning } = (deps.settings ?? readVizSettings)();
    this.map = new VizMap({ now: deps.now, settings, settingsWarning: warning, reducedMotion: deps.reducedMotion });
    this.source = new CitySource(this.map, { changed: () => this.render() }, deps);
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
    this.source.start();
    return this.done.promise;
  }

  /** Resolves once every in-flight refresh and scan has settled (test seam). */
  idle(): Promise<void> {
    return this.source.idle();
  }

  /**
   * Advances animation, packet lifetimes and the 2s/5s poll clocks by `ms`, then draws a frame.
   * The scheduled timer calls this every 100ms; tests call it directly instead of waiting.
   */
  step(ms: number): void {
    if (this.closed) return;
    this.source.fetch(this.map.step(ms));
    this.render();
  }

  private quit(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopTicks?.();
    this.source.close();
    this.screen.cleanup();
    this.done.resolve(0);
  }

  // ------------------------------------------------------------------ input

  private key(k: KeyInput): void {
    if (this.closed) return;
    if (k.name === "CTRL_C") return this.quit();
    if (this.map.key(k)) {
      this.source.fetch(this.map.take());
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
