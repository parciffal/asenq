import { StringDecoder } from "node:string_decoder";
import terminalKit from "terminal-kit";

export type NamedColor =
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

/** A named 16-color or a `#rrggbb` color; hex degrades to the terminal's color depth. */
export type TerminalColor = NamedColor | `#${string}`;

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
  /** Overrides color detection (`NO_COLOR`, `TERM=dumb`, stdout color depth). */
  color?: boolean;
}

export interface SanitizeTerminalTextOptions {
  /** Preserve line feeds. Other layout-affecting controls are always removed. */
  multiline?: boolean;
}

const BRACKETED_PASTE_START = "\u001b[200~";
const BRACKETED_PASTE_END = "\u001b[201~";
const ENABLE_BRACKETED_PASTE = "\u001b[?2004h";
const DISABLE_BRACKETED_PASTE = "\u001b[?2004l";
/** Kitty keyboard protocol, "disambiguate" flag: lets Shift+Enter differ from Enter. Pop restores the prior mode. */
const ENABLE_KEYBOARD_PROTOCOL = "\u001b[>1u";
const DISABLE_KEYBOARD_PROTOCOL = "\u001b[<u";
/** Kitty `CSI code[;mods]u` and xterm modifyOtherKeys `CSI 27;mods;code~` key reports. */
const KEY_REPORT = /\u001b\[(?:(\d+)(?:;(\d+))?u|27;(\d+);(\d+)~)/g;
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

/**
 * Wrap text into rows no wider than `width` cells. Explicit newlines and blank lines are
 * kept; words longer than a row split at grapheme boundaries, so no text is lost.
 */
export function wrapTerminalText(text: string, width: number): string[] {
  if (!Number.isFinite(width) || width < 1) return [];
  const maxWidth = Math.floor(width);
  const rows: string[] = [];
  for (const paragraph of sanitizeTerminalText(text, { multiline: true }).split("\n")) {
    let line = "";
    let lineWidth = 0;
    let wrapped = false;
    const flush = (): void => {
      rows.push(line.trimEnd());
      line = "";
      lineWidth = 0;
      wrapped = true;
    };
    for (const token of paragraph.split(/( +)/)) {
      if (!token) continue;
      const tokenWidth = displayWidth(token);
      if (token.startsWith(" ")) {
        // Leading indentation survives on a paragraph's first row; spaces at a wrap point do not.
        if (line === "" && wrapped) continue;
        if (lineWidth + tokenWidth > maxWidth) {
          if (line !== "") flush();
          continue;
        }
      } else if (lineWidth + tokenWidth > maxWidth) {
        if (tokenWidth > maxWidth) {
          // Longer than a whole row: fill the current row, then continue at grapheme boundaries.
          for (const { segment } of GRAPHEMES.segment(token)) {
            let glyph = segment;
            let glyphWidth = graphemeWidth(segment);
            if (glyphWidth > maxWidth) {
              glyph = "\u2026";
              glyphWidth = 1;
            }
            if (lineWidth + glyphWidth > maxWidth) flush();
            line += glyph;
            lineWidth += glyphWidth;
          }
          continue;
        }
        if (line.trim() !== "") flush();
        else {
          line = "";
          lineWidth = 0;
        }
      }
      line += token;
      lineWidth += tokenWidth;
    }
    rows.push(line.trimEnd());
  }
  return rows;
}

/** Whether stdout can show ANSI colors; honors `NO_COLOR`, `TERM=dumb` and reported depth. */
export function terminalSupportsColor(): boolean {
  const stdout = process.stdout as NodeJS.WriteStream;
  return typeof stdout.getColorDepth === "function" && stdout.getColorDepth() >= 4;
}

const SGR_COLORS: Record<NamedColor, number> = {
  black: 30, red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36, white: 37,
  brightBlack: 90, brightRed: 91, brightGreen: 92, brightYellow: 93,
  brightBlue: 94, brightMagenta: 95, brightCyan: 96, brightWhite: 97,
};
const HEX_COLOR = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;
/** RGB of the 16 named colors (xterm defaults), used to quantize hex colors on 16-color terminals. */
const NAMED_RGB: readonly [number, number, number][] = [
  [0, 0, 0], [205, 0, 0], [0, 205, 0], [205, 205, 0], [0, 0, 238], [205, 0, 205], [0, 205, 205], [229, 229, 229],
  [127, 127, 127], [255, 0, 0], [0, 255, 0], [255, 255, 0], [92, 92, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255],
];

/** Terminal color depth in bits (4, 8 or 24); unknown output is treated as 16 colors. */
function colorDepth(): number {
  const stdout = process.stdout as NodeJS.WriteStream;
  return typeof stdout.getColorDepth === "function" ? stdout.getColorDepth() : 4;
}

/** SGR parameters for one color; hex colors degrade to 256-color or 16-color codes by terminal depth. */
function colorCodes(color: TerminalColor, background: boolean): string {
  const named = (SGR_COLORS as Record<string, number | undefined>)[color];
  if (named !== undefined) return String(named + (background ? 10 : 0));
  const match = HEX_COLOR.exec(color);
  if (!match) return "";
  const [r, g, b] = [match[1], match[2], match[3]].map((part) => parseInt(part, 16));
  const depth = colorDepth();
  if (depth >= 24) return `${background ? 48 : 38};2;${r};${g};${b}`;
  if (depth >= 8) {
    const cube = (v: number): number => Math.round(v / 255 * 5);
    return `${background ? 48 : 38};5;${16 + 36 * cube(r) + 6 * cube(g) + cube(b)}`;
  }
  let best = 0;
  let bestDistance = Infinity;
  NAMED_RGB.forEach(([nr, ng, nb], index) => {
    const distance = (nr - r) ** 2 + (ng - g) ** 2 + (nb - b) ** 2;
    if (distance < bestDistance) { best = index; bestDistance = distance; }
  });
  return String((best < 8 ? 30 + best : 82 + best) + (background ? 10 : 0));
}

function sgr(style: TerminalStyle | undefined): string {
  if (!style) return "";
  const codes: string[] = [];
  if (style.bold) codes.push("1");
  if (style.dim) codes.push("2");
  if (style.italic) codes.push("3");
  if (style.underline) codes.push("4");
  if (style.inverse) codes.push("7");
  if (style.foreground) codes.push(colorCodes(style.foreground, false));
  if (style.background) codes.push(colorCodes(style.background, true));
  const joined = codes.filter(Boolean).join(";");
  return joined ? `\u001b[${joined}m` : "";
}

/** Sanitized spans clipped to `columns` cells; colors are dropped when `color` is false. */
export function normalizeTerminalLine(
  line: TerminalLine | undefined,
  columns: number,
  color = true,
): TerminalSpan[] {
  const spans: readonly TerminalSpan[] = line === undefined ? [] : typeof line === "string" ? [{ text: line }] : line;
  const result: TerminalSpan[] = [];
  let used = 0;
  for (const span of spans) {
    if (used >= columns) break;
    const text = truncateTerminalText(span.text, columns - used);
    if (!text) continue;
    used += displayWidth(text);
    let style = span.style;
    if (style && !color) {
      const { foreground: _foreground, background: _background, ...rest } = style;
      style = rest;
    }
    const styleKey = sgr(style);
    const previous = result.at(-1);
    if (previous && sgr(previous.style) === styleKey) previous.text += text;
    else result.push(styleKey ? { text, style: style! } : { text });
  }
  return result;
}

type FrameRows = { keys: string[]; spans: TerminalSpan[][] };

function frameRowKeys(frame: TerminalFrame, size: TerminalSize, color: boolean): FrameRows {
  const keys: string[] = [];
  const spans: TerminalSpan[][] = [];
  for (let row = 0; row < size.rows; row += 1) {
    const normalized = normalizeTerminalLine(frame.lines[row], size.columns, color);
    spans.push(normalized);
    keys.push(normalized.map((span) => sgr(span.style) + "\u0000" + span.text).join("\u0001"));
  }
  return { keys, spans };
}

function diffRowKeys(previous: readonly string[] | undefined, next: FrameRows): number[] {
  const changed: number[] = [];
  for (let row = 0; row < next.keys.length; row += 1) {
    if (previous?.[row] !== next.keys[row]) changed.push(row);
  }
  return changed;
}

/** Zero-based screen rows whose visible text or style differ; every row when `previous` is absent. */
export function changedTerminalRows(
  previous: TerminalFrame | undefined,
  next: TerminalFrame,
  size: TerminalSize,
): number[] {
  return diffRowKeys(previous && frameRowKeys(previous, size, true).keys, frameRowKeys(next, size, true));
}

export type KeyboardSegment = { text: string } | { key: "SHIFT_ENTER" };

/**
 * Rewrites protocol key reports into the legacy bytes terminal-kit understands (Esc, Ctrl+letter,
 * Alt+key, Shift+Tab…). Shift+Enter has no legacy byte, so it becomes its own key segment.
 */
export function translateKeyboardInput(input: string): KeyboardSegment[] {
  const segments: KeyboardSegment[] = [];
  let text = "";
  let last = 0;
  for (const match of input.matchAll(KEY_REPORT)) {
    text += input.slice(last, match.index);
    last = match.index + match[0].length;
    const code = Number(match[1] ?? match[4]);
    const modifiers = Number(match[2] ?? match[3] ?? 1) - 1;
    const shift = (modifiers & 1) !== 0;
    const alt = (modifiers & 2) !== 0;
    const ctrl = (modifiers & 4) !== 0;
    if (code === 13 && shift && !alt && !ctrl) {
      if (text) segments.push({ text });
      text = "";
      segments.push({ key: "SHIFT_ENTER" });
      continue;
    }
    let bytes: string;
    if (code === 13) bytes = "\r";
    else if (code === 9) bytes = shift ? "\u001b[Z" : "\t";
    else if (code === 127 || code === 8) bytes = "\u007f";
    else if (code === 27) bytes = "\u001b";
    else if (ctrl && code === 32) bytes = "\u0000";
    else if (ctrl && ((code >= 97 && code <= 122) || (code >= 64 && code <= 95))) bytes = String.fromCharCode(code & 0x1f);
    else if (code >= 32 && code < 0xe000) bytes = String.fromCodePoint(shift && code >= 97 && code <= 122 ? code - 32 : code);
    else continue; // private-use functional keys (keypad, media, lone modifiers) have no legacy form
    text += alt ? `\u001b${bytes}` : bytes;
  }
  text += input.slice(last);
  if (text) segments.push({ text });
  return segments;
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
  readonly #color: boolean;
  /** Normalized keys of the rows currently on screen; undefined forces a full repaint. */
  #rows?: string[];
  #size?: TerminalSize;

  constructor(options: TerminalAdapterOptions = {}) {
    this.#options = options;
    this.#color = options.color ?? terminalSupportsColor();
  }

  /** Whether semantic colors are drawn; otherwise only bold/dim/inverse/underline survive. */
  get color(): boolean {
    return this.#color;
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
    this.#rows = undefined;
    process.stdin.on("data", this.#onInput);
    this.#terminal.on("key", this.#onKey);
    this.#terminal.on("mouse", this.#onMouse);
    this.#terminal.on("resize", this.#onResize);
    process.on("SIGINT", this.#onSigint);
    process.on("uncaughtExceptionMonitor", this.#onFatalException);

    this.#terminal.fullscreen(true);
    this.#terminal.hideCursor();
    process.stdout.write(ENABLE_BRACKETED_PASTE);
    this.#terminal.grabInput({ mouse: this.#options.mouse ?? "button", safe: true });
    // Route terminal-kit's input through the keyboard-protocol translator instead of raw stdin.
    process.stdin.removeListener("data", this.#kitStdin);
    process.stdout.write(ENABLE_KEYBOARD_PROTOCOL);
  }

  render(frame: TerminalFrame): void {
    if (this.#state !== "running") throw new Error("TerminalAdapter.start() must be called before render().");

    const size = this.size;
    if (!this.#size || this.#size.columns !== size.columns || this.#size.rows !== size.rows) this.#rows = undefined;
    const rows = frameRowKeys(frame, size, this.#color);
    const changed = diffRowKeys(this.#rows, rows);
    this.#rows = rows.keys;
    this.#size = size;

    // One buffered write per frame, wrapped in synchronized-output mode where supported:
    // only changed rows are rewritten, and each rewrite clears only its stale tail.
    let output = "\u001b[?2026h\u001b[?25l";
    for (const row of changed) {
      output += `\u001b[${row + 1};1H`;
      let width = 0;
      for (const span of rows.spans[row]) {
        output += `${sgr(span.style)}${span.text}\u001b[0m`;
        width += displayWidth(span.text);
      }
      if (width < size.columns) output += "\u001b[K";
    }
    const cursor = frame.cursor;
    if (cursor && cursor.visible !== false) {
      const column = Math.min(size.columns - 1, Math.max(0, Math.floor(cursor.column)));
      const row = Math.min(size.rows - 1, Math.max(0, Math.floor(cursor.row)));
      output += `\u001b[${row + 1};${column + 1}H\u001b[?25h`;
    }
    process.stdout.write(output + "\u001b[?2026l");
  }

  cleanup(): void {
    if (this.#state !== "running") return;
    this.#cancelEscape();
    clearTimeout(this.#candidateTimer);
    this.#state = "closed";

    process.stdin.removeListener("data", this.#onInput);
    process.stdout.write(DISABLE_KEYBOARD_PROTOCOL);
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

  #cancelEscape(): void {
    clearTimeout(this.#escapeTimer);
    this.#escapeTimer = undefined;
    this.#pendingEscape = undefined;
    this.#standaloneEscape = false;
  }

  get #kitStdin(): (chunk: Buffer) => void {
    return (this.#terminal as unknown as { onStdin(chunk: Buffer): void }).onStdin;
  }

  readonly #onInput = (chunk: Buffer | string): void => {
    const text = typeof chunk === "string" ? chunk : this.#decoder.write(chunk);
    for (const segment of translateKeyboardInput(text)) {
      if (this.#state !== "running") return;
      if ("key" in segment) {
        this.#onKey(segment.key, [segment.key], {});
        continue;
      }
      this.#onRawData(segment.text);
      this.#kitStdin(Buffer.from(segment.text, "utf8"));
    }
  };

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
    this.#rows = undefined;
    this.#options.onResize?.({ columns, rows });
  };

  readonly #onSigint = (): void => {
    this.cleanup();
    this.#options.onInterrupt?.();
  };

  readonly #onFatalException = (): void => {
    this.cleanup();
  };

  readonly #onRawData = (text: string): void => {
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
