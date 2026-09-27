import { StringDecoder } from "node:string_decoder";
import terminalKit from "terminal-kit";

export type TerminalColor =
  | "black"
  | "red"
  | "green"
  | "yellow"
  | "blue"
  | "magenta"
  | "cyan"
  | "white"
  | "brightBlack"
  | "brightRed"
  | "brightGreen"
  | "brightYellow"
  | "brightBlue"
  | "brightMagenta"
  | "brightCyan"
  | "brightWhite";

export interface TerminalStyle {
  foreground?: TerminalColor;
  background?: TerminalColor;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
}

export interface TerminalSpan {
  text: string;
  style?: TerminalStyle;
}

export type TerminalLine = string | readonly TerminalSpan[];

export interface TerminalCursor {
  /** Zero-based column. */
  column: number;
  /** Zero-based row. */
  row: number;
  /** Defaults to true when a cursor is supplied. */
  visible?: boolean;
}

export interface TerminalFrame {
  lines: readonly TerminalLine[];
  cursor?: TerminalCursor;
}

export interface TerminalSize {
  columns: number;
  rows: number;
}

export interface KeyInput {
  name: string;
  matches: readonly string[];
  text?: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

export type MouseAction = "press" | "release" | "drag" | "move" | "wheel-up" | "wheel-down";
export type MouseButton = "left" | "middle" | "right" | "other";

export interface MouseInput {
  name: string;
  /** Zero-based column. */
  column: number;
  /** Zero-based row. */
  row: number;
  action: MouseAction;
  button?: MouseButton;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  from?: { column: number; row: number };
}

export interface TerminalAdapterOptions {
  onKey?: (input: KeyInput) => void;
  onMouse?: (input: MouseInput) => void;
  onResize?: (size: TerminalSize) => void;
  onPaste?: (text: string) => void;
  /** Called after terminal state has been restored. */
  onInterrupt?: () => void;
  mouse?: "button" | "drag" | "motion";
}

export interface SanitizeTerminalTextOptions {
  /** Preserve line feeds. Other layout-affecting controls are always removed. */
  multiline?: boolean;
}

const BRACKETED_PASTE_START = "\u001b[200~";
const BRACKETED_PASTE_END = "\u001b[201~";
const ENABLE_BRACKETED_PASTE = "\u001b[?2004h";
const DISABLE_BRACKETED_PASTE = "\u001b[?2004l";
const BIDI_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const SINGLE_LINE_CONTROLS = /[\u0000-\u001f\u007f-\u009f]/g;
const MULTILINE_CONTROLS = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g;
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const EXTENDED_PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const EMOJI_VARIATION_OR_MODIFIER = /[\ufe0f\p{Emoji_Modifier}]/u;

export class TerminalUnavailableError extends Error {
  constructor() {
    super("A usable input and output TTY is required for the full-screen interface.");
    this.name = "TerminalUnavailableError";
  }
}

/** Remove terminal escape/control sequences from text before displaying it. */
export function sanitizeTerminalText(
  text: string,
  options: SanitizeTerminalTextOptions = {},
): string {
  const normalized = terminalKit
    .stripEscapeSequences(text)
    .replace(/\r\n?|\u2028|\u2029/g, "\n")
    .replaceAll("\t", "    ")
    .replace(BIDI_CONTROLS, "");

  if (options.multiline) return normalized.replace(MULTILINE_CONTROLS, "");
  return normalized.replaceAll("\n", " ").replace(SINGLE_LINE_CONTROLS, "");
}

function graphemeWidth(segment: string): number {
  const measured = terminalKit.stringWidth(segment);
  if (
    EXTENDED_PICTOGRAPHIC.test(segment) &&
    (measured > 2 || (measured < 2 && EMOJI_VARIATION_OR_MODIFIER.test(segment)))
  ) {
    return 2;
  }
  return measured;
}

function displayWidth(text: string): number {
  let width = 0;
  for (const { segment } of GRAPHEMES.segment(text)) {
    width += graphemeWidth(segment);
  }
  return width;
}

/** Display width after removing unsafe terminal controls. */
export function terminalTextWidth(text: string): number {
  return displayWidth(sanitizeTerminalText(text));
}

/** Safely truncate text at a grapheme and terminal-cell boundary. */
export function truncateTerminalText(text: string, width: number): string {
  if (!Number.isFinite(width) || width <= 0) return "";

  const safeText = sanitizeTerminalText(text);
  const maxWidth = Math.floor(width);
  let result = "";
  let resultWidth = 0;
  for (const { segment } of GRAPHEMES.segment(safeText)) {
    const segmentWidth = graphemeWidth(segment);
    if (resultWidth + segmentWidth > maxWidth) break;
    result += segment;
    resultWidth += segmentWidth;
  }
  return result;
}

type KeyDetails = { isCharacter?: boolean; meta?: string };
type MouseDetails = {
  x?: number;
  y?: number;
  xFrom?: number;
  yFrom?: number;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
};

/**
 * Small full-screen terminal-kit adapter. Coordinates exposed to callers are
 * zero-based; conversion to terminal-kit's one-based coordinates stays here.
 */
export class TerminalAdapter {
  readonly #options: TerminalAdapterOptions;
  readonly #terminal = terminalKit.terminal;
  readonly #decoder = new StringDecoder("utf8");
  #state: "idle" | "running" | "closed" = "idle";
  #bracketCandidate = "";
  #pasteEndCandidate = "";
  #pasteText = "";
  #pasting = false;
  #suppressKeys = false;
  #standaloneEscape = false;
  #keysBeforePaste = 0;
  #pendingEscape?: KeyInput;
  #escapeTimer?: NodeJS.Timeout;
  #candidateTimer?: NodeJS.Timeout;
  #clearSuppressionQueued = false;

  constructor(options: TerminalAdapterOptions = {}) {
    this.#options = options;
  }

  get size(): TerminalSize {
    return {
      columns: Math.max(1, this.#terminal.width || process.stdout.columns || 1),
      rows: Math.max(1, this.#terminal.height || process.stdout.rows || 1),
    };
  }

  start(): void {
    if (this.#state === "running") return;
    if (this.#state === "closed") throw new Error("TerminalAdapter cannot be restarted after cleanup.");
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new TerminalUnavailableError();

    this.#state = "running";
    process.stdin.prependListener("data", this.#onRawData);
    this.#terminal.on("key", this.#onKey);
    this.#terminal.on("mouse", this.#onMouse);
    this.#terminal.on("resize", this.#onResize);
    process.on("SIGINT", this.#onSigint);
    process.on("uncaughtExceptionMonitor", this.#onFatalException);

    this.#terminal.fullscreen(true);
    this.#terminal.hideCursor();
    process.stdout.write(ENABLE_BRACKETED_PASTE);
    this.#terminal.grabInput({ mouse: this.#options.mouse ?? "button", safe: true });
  }

  render(frame: TerminalFrame): void {
    if (this.#state !== "running") throw new Error("TerminalAdapter.start() must be called before render().");

    const { columns, rows } = this.size;
    this.#terminal.styleReset();
    this.#terminal.moveTo(1, 1);
    this.#terminal.eraseDisplay();

    for (let row = 0; row < Math.min(rows, frame.lines.length); row += 1) {
      const line = frame.lines[row];
      const spans: readonly TerminalSpan[] = typeof line === "string" ? [{ text: line }] : line;
      let column = 0;

      for (const span of spans) {
        if (column >= columns) break;
        const text = truncateTerminalText(span.text, columns - column);
        if (!text) continue;
        this.#terminal.moveTo(column + 1, row + 1);
        this.#applyStyle(span.style);
        this.#terminal.noFormat(text);
        this.#terminal.styleReset();
        column += displayWidth(text);
      }
    }

    const cursor = frame.cursor;
    if (!cursor || cursor.visible === false) {
      this.#terminal.hideCursor();
      return;
    }

    const column = Math.min(columns - 1, Math.max(0, Math.floor(cursor.column)));
    const row = Math.min(rows - 1, Math.max(0, Math.floor(cursor.row)));
    this.#terminal.moveTo(column + 1, row + 1);
    this.#terminal.hideCursor(false);
  }

  cleanup(): void {
    if (this.#state !== "running") return;
    this.#cancelEscape();
    clearTimeout(this.#candidateTimer);
    this.#state = "closed";

    process.stdin.removeListener("data", this.#onRawData);
    this.#terminal.off("key", this.#onKey);
    this.#terminal.off("mouse", this.#onMouse);
    this.#terminal.off("resize", this.#onResize);
    process.removeListener("SIGINT", this.#onSigint);
    process.removeListener("uncaughtExceptionMonitor", this.#onFatalException);

    this.#terminal.grabInput(false);
    process.stdout.write(DISABLE_BRACKETED_PASTE);
    this.#terminal.styleReset();
    this.#terminal.hideCursor(false);
    this.#terminal.fullscreen(false);
  }

  #applyStyle(style: TerminalStyle | undefined): void {
    if (!style) return;
    if (style.foreground) this.#terminal.color(style.foreground);
    if (style.background) this.#terminal.bgColor(style.background);
    if (style.bold) this.#terminal.bold();
    if (style.dim) this.#terminal.dim();
    if (style.italic) this.#terminal.italic();
    if (style.underline) this.#terminal.underline();
    if (style.inverse) this.#terminal.inverse();
  }

  #cancelEscape(): void {
    clearTimeout(this.#escapeTimer);
    this.#escapeTimer = undefined;
    this.#pendingEscape = undefined;
    this.#standaloneEscape = false;
  }

  #deliverEscape(): void {
    const pending = this.#pendingEscape;
    this.#cancelEscape();
    this.#bracketCandidate = "";
    if (!this.#pasting) this.#suppressKeys = false;
    if (pending && this.#state === "running") this.#options.onKey?.(pending);
  }

  readonly #onKey = (name: string, matches: string[], details: KeyDetails): void => {
    if (this.#suppressKeys) {
      if (this.#keysBeforePaste && details.isCharacter) this.#keysBeforePaste--;
      else if (!(name === "ESCAPE" && this.#standaloneEscape && !this.#pasting)) return;
    }
    if (name === "ESCAPE" && this.#standaloneEscape) {
      this.#pendingEscape = {
        name, matches, ctrl: false, alt: false, shift: false,
      };
      this.#escapeTimer = setTimeout(() => this.#deliverEscape(), 80);
      return;
    }
    if (name === "CTRL_C") {
      this.cleanup();
      this.#options.onInterrupt?.();
      return;
    }

    this.#options.onKey?.({
      name,
      matches,
      ...(details.isCharacter ? { text: name } : {}),
      ctrl: name.startsWith("CTRL_") || name.includes("_CTRL_"),
      alt: name.startsWith("ALT_") || name.includes("_ALT_") || details.meta === "ALT",
      shift: name.startsWith("SHIFT_") || name.includes("_SHIFT_"),
    });
  };

  readonly #onMouse = (name: string, details: MouseDetails): void => {
    if (details.x === undefined || details.y === undefined) return;
    const button = mouseButton(name);
    const from =
      details.xFrom === undefined || details.yFrom === undefined
        ? undefined
        : { column: details.xFrom - 1, row: details.yFrom - 1 };

    this.#options.onMouse?.({
      name,
      column: details.x - 1,
      row: details.y - 1,
      action: mouseAction(name),
      ...(button ? { button } : {}),
      ctrl: details.ctrl ?? false,
      alt: details.alt ?? false,
      shift: details.shift ?? false,
      ...(from ? { from } : {}),
    });
  };

  readonly #onResize = (columns: number, rows: number): void => {
    this.#options.onResize?.({ columns, rows });
  };

  readonly #onSigint = (): void => {
    this.cleanup();
    this.#options.onInterrupt?.();
  };

  readonly #onFatalException = (): void => {
    this.cleanup();
  };

  readonly #onRawData = (chunk: Buffer | string): void => {
    const text = typeof chunk === "string" ? chunk : this.#decoder.write(chunk);
    const pasteStart = text.indexOf(BRACKETED_PASTE_START);
    const lastEscape = text.lastIndexOf("\u001b");
    const candidateStart = pasteStart >= 0 ? pasteStart
      : lastEscape >= 0 && BRACKETED_PASTE_START.startsWith(text.slice(lastEscape)) ? lastEscape : -1;
    if (candidateStart > 0 && !this.#pasting) {
      // Preserve typed keys coalesced with a complete or fragmented paste marker.
      const before = text.slice(0, candidateStart)
        .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
        .replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
      for (const _ of before) this.#keysBeforePaste++;
    }
    let pasteTraffic = this.#pasting;

    for (const character of text) {
      if (this.#pasting) {
        pasteTraffic = true;
        const candidate = this.#pasteEndCandidate + character;
        if (BRACKETED_PASTE_END.startsWith(candidate)) {
          this.#pasteEndCandidate = candidate;
          if (candidate === BRACKETED_PASTE_END) {
            const pasted = this.#pasteText;
            this.#pasting = false;
            this.#pasteEndCandidate = "";
            this.#pasteText = "";
            this.#options.onPaste?.(pasted);
          }
        } else {
          this.#pasteText += candidate;
          this.#pasteEndCandidate = "";
        }
        continue;
      }

      if (this.#bracketCandidate || character === "\u001b") {
        const candidate = this.#bracketCandidate + character;
        if (BRACKETED_PASTE_START.startsWith(candidate)) {
          this.#bracketCandidate = candidate;
          if (candidate === BRACKETED_PASTE_START) {
            pasteTraffic = true;
            this.#pasting = true;
            this.#cancelEscape();
            clearTimeout(this.#candidateTimer);
            this.#bracketCandidate = "";
          } else if (candidate.length > 1) {
            // Once ESC continues as CSI it is not a standalone key. Bound a stalled prefix.
            this.#cancelEscape();
            clearTimeout(this.#candidateTimer);
            this.#candidateTimer = setTimeout(() => {
              this.#candidateTimer = undefined;
              this.#bracketCandidate = "";
              this.#suppressKeys = false;
            }, 1000);
          }
        } else {
          clearTimeout(this.#candidateTimer);
          this.#candidateTimer = undefined;
          if (this.#pendingEscape) {
            if (candidate.startsWith("\u001b[")) this.#cancelEscape();
            else this.#deliverEscape();
          }
          this.#bracketCandidate = character === "\u001b" ? character : "";
        }
      }
    }

    this.#standaloneEscape = this.#bracketCandidate === "\u001b" && !this.#pasting;
    this.#suppressKeys = pasteTraffic || this.#pasting || this.#bracketCandidate.length > 0;
    if (this.#suppressKeys && !this.#clearSuppressionQueued) {
      this.#clearSuppressionQueued = true;
      queueMicrotask(() => {
        this.#clearSuppressionQueued = false;
        if (!this.#pasting && !this.#bracketCandidate) this.#suppressKeys = false;
      });
    }
  };
}

function mouseButton(name: string): MouseButton | undefined {
  if (name.includes("LEFT_BUTTON")) return "left";
  if (name.includes("MIDDLE_BUTTON")) return "middle";
  if (name.includes("RIGHT_BUTTON")) return "right";
  if (name.includes("OTHER_BUTTON")) return "other";
  return undefined;
}

function mouseAction(name: string): MouseAction {
  if (name.includes("WHEEL_UP")) return "wheel-up";
  if (name.includes("WHEEL_DOWN")) return "wheel-down";
  if (name.includes("DRAG")) return "drag";
  if (name.includes("MOTION")) return "move";
  if (name.includes("RELEASED")) return "release";
  return "press";
}
