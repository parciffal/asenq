import type { MsgStatus, PositionedEvent, StoredMessage } from "../shared/protocol.js";
import {
  sanitizeTerminalText, terminalTextWidth, truncateTerminalText, wrapTerminalText,
  type TerminalLine, type TerminalSpan, type TerminalStyle,
} from "./terminal.js";

/**
 * Semantic styles use foreground colors so the terminal's own background shows through.
 * The terminal adapter drops unsupported colors, retaining bold/dim/inverse fallback.
 */
export const theme = {
  brand: { foreground: "brightCyan", bold: true },
  accent: { foreground: "cyan" },
  accentBold: { foreground: "cyan", bold: true },
  human: { foreground: "brightBlue", bold: true },
  agent: { foreground: "magenta", bold: true },
  dim: { dim: true },
  bold: { bold: true },
  border: { foreground: "brightBlack", dim: true },
  key: { inverse: true, dim: true },
  ok: { foreground: "green" },
  warn: { foreground: "yellow" },
  bad: { foreground: "red", bold: true },
  unread: { foreground: "brightCyan", bold: true },
  selected: { inverse: true },
  focused: { foreground: "cyan", bold: true, underline: true },
} as const satisfies Record<string, TerminalStyle>;

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function statusStyle(status: MsgStatus | string): TerminalStyle {
  if (status === "delivered" || status === "posted") return theme.ok;
  if (status === "queued" || status === "held") return theme.warn;
  return theme.bad;
}

export function harnessShortName(harness: string): string {
  if (harness === "claude") return "cc";
  if (harness === "opencode") return "oc";
  return harness;
}

/** Truncate a label to `width` cells, marking any cut with an ellipsis. */
export function ellipsize(text: string, width: number): string {
  if (width <= 0) return "";
  if (terminalTextWidth(text) <= width) return sanitizeTerminalText(text);
  return truncateTerminalText(text, width - 1) + "…";
}

function spansWidth(spans: readonly TerminalSpan[]): number {
  return spans.reduce((sum, span) => sum + terminalTextWidth(span.text), 0);
}

/** Clip spans to `width`, ellipsizing the span that crosses the edge. */
export function clipSpans(spans: readonly TerminalSpan[], width: number): TerminalSpan[] {
  const result: TerminalSpan[] = [];
  let used = 0;
  const total = spansWidth(spans);
  for (const span of spans) {
    const spanWidth = terminalTextWidth(span.text);
    if (total <= width || used + spanWidth <= width - 1) {
      if (used + spanWidth > width) break;
      result.push(span);
      used += spanWidth;
      continue;
    }
    const text = ellipsize(span.text, width - used);
    if (text) result.push({ ...span, text });
    break;
  }
  return result;
}

/**
 * One row with left content and right-aligned content; the left side is ellipsized first so
 * the right side (state, counts, key hints) never collides with it.
 */
export function justify(
  left: readonly TerminalSpan[],
  right: readonly TerminalSpan[],
  width: number,
  fill?: TerminalStyle,
): TerminalSpan[] {
  const rightSpans = clipSpans(right, width);
  const rightWidth = spansWidth(rightSpans);
  const leftSpans = clipSpans(left, Math.max(0, width - rightWidth - (rightWidth ? 1 : 0)));
  const gap = width - spansWidth(leftSpans) - rightWidth;
  const spans = [...leftSpans, { text: " ".repeat(Math.max(0, gap)), ...(fill ? { style: fill } : {}) }, ...rightSpans];
  return fill ? spans.map((span) => ({ ...span, style: { ...fill, ...span.style } })) : spans;
}

/** Pad spans with spaces to exactly `width` cells (after clipping). */
export function padSpans(spans: readonly TerminalSpan[], width: number, style?: TerminalStyle): TerminalSpan[] {
  return justify(spans, [], width, style);
}

export type Panes = { list: number; conversation: number } | undefined;

/** Split widths for wide terminals; undefined means one focused pane. */
export function paneWidths(columns: number): Panes {
  if (columns < 80) return undefined;
  const list = Math.min(32, Math.max(22, Math.floor(columns * 0.25)));
  return { list, conversation: columns - list - 1 };
}

/** Local time for today's items, otherwise the date too; `compact` drops the time for older items. */
export function formatTime(at: number, now = Date.now(), compact = false): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (new Date(now).toDateString() === date.toDateString()) return time;
  const day = date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return compact ? day : `${day} ${time}`;
}

const wrapCache = new Map<string, string[]>();

function wrappedBody(message: StoredMessage, width: number): string[] {
  const key = `${message.id}\u0000${width}`;
  let rows = wrapCache.get(key);
  if (!rows) {
    if (wrapCache.size > 4000) wrapCache.clear();
    rows = wrapTerminalText(message.text, width);
    wrapCache.set(key, rows);
  }
  return rows;
}

export type MessageRange = { start: number; bodyEnd: number; end: number };
export type TranscriptLayout = { rows: TerminalLine[]; ranges: Map<string, MessageRange>; order: string[] };

export type TranscriptOptions = {
  width: number;
  selectedId?: string;
  expanded?: (id: string) => boolean;
  firstUnreadId?: string;
  /** Rows before the first message, such as the older-history hint. */
  leading?: TerminalLine[];
  empty?: string;
  now?: number;
};

export function senderLabel(message: StoredMessage): string {
  return message.from === "human" ? "you" : message.from;
}

function headerSpans(message: StoredMessage, now: number): TerminalSpan[] {
  const human = message.from === "human";
  const spans: TerminalSpan[] = [
    { text: human ? "› " : "● ", style: human ? theme.human : theme.agent },
    { text: senderLabel(message), style: human ? theme.human : theme.agent },
  ];
  if (message.channel) spans.push({ text: ` in #${message.channel}`, style: theme.dim });
  else if (message.to !== "human" && !human) spans.push({ text: ` → ${message.to}`, style: theme.agent });
  else if (human) spans.push({ text: ` → ${message.to === "human" ? "you" : message.to}`, style: theme.dim });
  spans.push({ text: "  " }, { text: message.status, style: statusStyle(message.status) });
  if (message.kind && message.kind !== "chat") spans.push({ text: ` · ${message.kind}${message.kind === "control" && message.action ? ` ${message.action}` : ""}`, style: theme.dim });
  if (message.done) spans.push({ text: " · done", style: theme.dim });
  spans.push({ text: `  ${formatTime(message.createdAt, now)}`, style: theme.dim });
  return spans;
}

function detailLines(message: StoredMessage): string[] {
  const lines = [
    `id ${message.id}${message.kind ? ` · kind ${message.kind}` : ""}${message.action ? ` · action ${message.action}` : ""}${message.done ? " · done" : ""}`,
    `from ${message.from}${message.fromSessionId ? ` (${message.fromSessionId})` : ""} → ${message.channel ? `#${message.channel}` : message.to}${message.toSessionId ? ` (${message.toSessionId})` : ""}`,
    `status ${message.status}${message.reason ? `: ${message.reason}` : ""} · order ${message.order} · ${new Date(message.createdAt).toLocaleString()}`,
  ];
  if (message.thread) lines.push(`thread ${message.thread}`);
  if (message.replyTo) lines.push(`reply to ${message.replyTo}`);
  return lines;
}

/**
 * Lay out each message as a distinct block: header, wrapped body and optional details.
 * Bodies are wrapped, never clipped; ranges let callers map rows back to messages.
 */
export function layoutTranscript(messages: readonly StoredMessage[], options: TranscriptOptions): TranscriptLayout {
  const width = Math.max(1, options.width);
  const bodyWidth = Math.max(1, width - 2);
  const now = options.now ?? Date.now();
  const rows: TerminalLine[] = [...(options.leading ?? [])];
  if (rows.length && messages.length) rows.push("");
  const ranges = new Map<string, MessageRange>();
  const order: string[] = [];
  if (!messages.length && options.empty) rows.push([{ text: ellipsize(options.empty, width), style: theme.dim }]);
  for (const message of messages) {
    if (order.length) rows.push("");
    if (message.id === options.firstUnreadId) {
      rows.push(clipSpans([{ text: "── new ", style: theme.unread }, { text: "─".repeat(Math.max(0, width - 7)), style: theme.accent }], width));
    }
    const start = rows.length;
    const selected = message.id === options.selectedId;
    const header = justify(headerSpans(message, now), [], width, selected ? theme.selected : undefined);
    rows.push(header);
    for (const line of wrappedBody(message, bodyWidth)) rows.push(`  ${line}`);
    const bodyEnd = rows.length - 1;
    if (options.expanded?.(message.id)) {
      for (const detail of detailLines(message)) {
        for (const line of wrapTerminalText(detail, Math.max(1, width - 4))) {
          rows.push([{ text: "  ┊ ", style: theme.accent }, { text: line, style: theme.dim }]);
        }
      }
    }
    ranges.set(message.id, { start, bodyEnd, end: rows.length - 1 });
    order.push(message.id);
  }
  return { rows, ranges, order };
}

/** Viewport position anchored to content so arrivals, prepends and re-wraps do not move it. */
export type Viewport = { follow: boolean; anchor?: { id: string; row: number } };

export function maxTop(layout: TranscriptLayout, height: number): number {
  return Math.max(0, layout.rows.length - height);
}

export function viewportTop(layout: TranscriptLayout, viewport: Viewport, height: number): number {
  const bottom = maxTop(layout, height);
  if (viewport.follow || !viewport.anchor) return bottom;
  const range = layout.ranges.get(viewport.anchor.id);
  if (!range) return bottom;
  return Math.max(0, Math.min(bottom, range.start + viewport.anchor.row));
}

/** Anchor a top row to the message block containing it (or the first block for leading rows). */
export function viewportAt(layout: TranscriptLayout, top: number, height: number): Viewport {
  const bottom = maxTop(layout, height);
  const clamped = Math.max(0, Math.min(bottom, top));
  if (clamped >= bottom) return { follow: true };
  let anchor: Viewport["anchor"];
  for (const id of layout.order) {
    const range = layout.ranges.get(id)!;
    if (range.start > clamped && anchor) break;
    anchor = { id, row: clamped - range.start };
  }
  return anchor ? { follow: false, anchor } : { follow: true };
}

/** Grapheme-accurate hard wrap for the editor, preserving every typed character and the cursor. */
export function editorLayout(text: string, cursor: number, width: number): { rows: string[]; cursorRow: number; cursorColumn: number } {
  const rows: string[] = [""];
  let column = 0;
  let cursorRow = 0;
  let cursorColumn = 0;
  const max = Math.max(1, width);
  for (const { segment, index } of GRAPHEMES.segment(text)) {
    if (index === cursor) [cursorRow, cursorColumn] = [rows.length - 1, column];
    if (segment === "\n") {
      rows.push("");
      column = 0;
      continue;
    }
    const cells = Math.min(max, terminalTextWidth(segment));
    if (column + cells > max) {
      rows.push("");
      column = 0;
      if (index === cursor) [cursorRow, cursorColumn] = [rows.length - 1, 0];
    }
    rows[rows.length - 1] += sanitizeTerminalText(segment);
    column += cells;
  }
  if (cursor >= text.length) {
    if (column >= max) {
      rows.push("");
      column = 0;
    }
    [cursorRow, cursorColumn] = [rows.length - 1, column];
  }
  return { rows, cursorRow, cursorColumn };
}

/** Grapheme-boundary index before/after `cursor`. */
export function stepGrapheme(text: string, cursor: number, direction: -1 | 1): number {
  let previous = 0;
  for (const { index, segment } of GRAPHEMES.segment(text)) {
    if (direction === 1 && index >= cursor) return index + segment.length;
    if (direction === -1 && index + segment.length >= cursor) return index;
    previous = index + segment.length;
  }
  return direction === 1 ? text.length : previous;
}

export type ActivityFilter = "important" | "all";

export function isImportantEvent(item: PositionedEvent): boolean {
  return item.event.type !== "read";
}

export function activitySpans(item: PositionedEvent, names: (id: string) => string | undefined): TerminalSpan[] {
  const event = item.event;
  const position: TerminalSpan = { text: `${item.position}`.padStart(6) + "  ", style: theme.dim };
  if (event.type === "message") {
    const m = event.msg;
    const where = m.channel ? `#${m.channel}` : m.to === "human" ? "you" : m.to;
    return [
      position,
      { text: "message  ", style: theme.accent },
      { text: senderLabel(m), style: m.from === "human" ? theme.human : theme.agent },
      { text: ` → ${where}  ` },
      { text: event.status, style: statusStyle(event.status) },
      ...(event.reason ? [{ text: ` (${event.reason})`, style: theme.dim }] : []),
      { text: `  ${sanitizeTerminalText(m.text)}`, style: theme.dim },
    ];
  }
  if (event.type === "session") {
    const detail = event.action === "renamed" ? `${event.oldName ?? "?"} → ${event.name}` : event.name;
    const style = event.action === "gone" ? theme.warn : event.action === "removed" ? theme.dim : theme.ok;
    return [position, { text: "session  ", style: theme.accent }, { text: `${event.action} `, style }, { text: detail, style: theme.bold }, { text: `  ${event.harness}`, style: theme.dim }];
  }
  if (event.type === "read") {
    const scope = event.state.scope;
    const stream = scope.scope === "session" ? names(scope.sessionId) ?? scope.sessionId : `#${scope.channel}`;
    return [position, { text: "read     ", style: theme.dim }, { text: `${stream} · ${event.state.unread} unread${event.state.reminder ? " · reminder" : ""}`, style: theme.dim }];
  }
  return [position, { text: "retention", style: theme.warn }, { text: "  older records pruned", style: theme.dim }];
}
