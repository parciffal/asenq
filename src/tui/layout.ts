import type { MsgStatus, PositionedEvent, StoredMessage } from "../shared/protocol.js";
import { renderMessageBody } from "../shared/render.js";
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
  if (status === "delivered" || status === "posted" || status === "replied") return theme.ok;
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
    rows = wrapTerminalText(renderMessageBody(message), width);
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
  /** Authoritative human unread count at firstUnreadId; defaults to 1, never counts agent traffic. */
  unreadCount?: number;
  /** Rows before the first message, such as the older-history hint. */
  leading?: TerminalLine[];
  empty?: string;
  now?: number;
};

export function senderLabel(message: StoredMessage): string {
  return message.from === "human" ? "you" : message.from;
}

function headerSpans(message: StoredMessage, now: number, width: number, fill?: TerminalStyle): TerminalSpan[] {
  const sender = senderLabel(message);
  const target = message.channel ? `#${message.channel}` : message.to === "human" ? "you" : message.to;
  const senderWidth = terminalTextWidth(sender);
  const targetWidth = terminalTextWidth(target);
  const minimumIdentity = Math.min(width, Math.min(6, senderWidth) + 3 + Math.min(6, targetWidth));
  const status: TerminalSpan = {
    text: `${message.status === "delivered" || message.status === "posted" ? "✓ " : ""}${message.status}`,
    style: statusStyle(message.status),
  };
  const time: TerminalSpan = { text: `  ${formatTime(message.createdAt, now)}`, style: theme.dim };
  const tags: TerminalSpan[] = [];
  if (message.kind && message.kind !== "chat") {
    const kind = ` ${message.kind}${message.kind === "control" && message.action ? ` ${message.action}` : ""} `;
    if (terminalTextWidth(kind) + 2 + minimumIdentity <= width) {
      tags.push({ text: "  " }, { text: kind, style: { ...theme.warn, inverse: true } });
    }
  }
  if (message.done && spansWidth(tags) + 7 + minimumIdentity <= width) {
    tags.push({ text: " · done", style: theme.dim });
  }
  if (!message.channel && message.sourceChannel) {
    const source = ` via #${message.sourceChannel}`;
    if (spansWidth(tags) + terminalTextWidth(source) + minimumIdentity <= width) {
      tags.push({ text: source, style: theme.dim });
    }
  }
  const tagWidth = spansWidth(tags);
  let right = [status, time];
  // Keep both labels and message meaning readable; time yields first, then delivery state.
  if (spansWidth(right) + 1 + minimumIdentity + tagWidth > width) right = [status];
  if (spansWidth(right) + 1 + minimumIdentity + tagWidth > width) right = [];
  const leftWidth = width - spansWidth(right) - (right.length ? 1 : 0);
  const identityWidth = leftWidth - tagWidth;
  let senderBudget = senderWidth;
  let targetBudget = targetWidth;
  if (senderWidth + 3 + targetWidth > identityWidth) {
    const namesWidth = Math.max(0, identityWidth - 3);
    senderBudget = Math.min(senderWidth, Math.ceil(namesWidth / 2));
    targetBudget = Math.min(targetWidth, namesWidth - senderBudget);
    senderBudget = Math.min(senderWidth, namesWidth - targetBudget);
  }
  const identity: TerminalSpan[] = identityWidth >= 5 ? [
    { text: ellipsize(sender, senderBudget), style: message.from === "human" ? theme.human : theme.agent },
    { text: " → ", style: theme.dim },
    { text: ellipsize(target, targetBudget), style: theme.dim },
  ] : [
    { text: sender, style: message.from === "human" ? theme.human : theme.agent },
    { text: " → ", style: theme.dim },
    { text: target, style: theme.dim },
  ];
  return justify([...identity, ...tags], right, width, fill);
}

function detailLines(message: StoredMessage): string[] {
  const lines = [
    `id ${message.id}${message.kind ? ` · kind ${message.kind}` : ""}${message.action ? ` · action ${message.action}` : ""}${message.done ? " · done" : ""}`,
    `from ${message.from}${message.fromSessionId ? ` (${message.fromSessionId})` : ""} → ${message.channel ? `#${message.channel}` : message.to}${message.toSessionId ? ` (${message.toSessionId})` : ""}`,
    `status ${message.status}${message.reason ? `: ${message.reason}` : ""} · order ${message.order} · ${new Date(message.createdAt).toLocaleString()}`,
  ];
  if (message.reset) lines.push(`reset ${message.reset}`);
  if (message.resetResult) lines.push(`resetResult ${message.resetResult}`);
  if (message.sourceChannel) lines.push(`via #${message.sourceChannel}`);
  if (message.thread) lines.push(`thread ${message.thread}`);
  if (message.replyTo) lines.push(`reply to ${message.replyTo}${message.replyToMissing ? " (purged message)" : ""}`);
  return lines;
}

/**
 * Lay out each message as a distinct block: fitted header, full wrapped body and optional details.
 * Only direct nonhuman exchanges are dim and omit the spacer between adjacent such blocks.
 * The divider uses the caller's human unread count, not the number of subsequent messages.
 * Ranges exclude dividers/spacers; bodyEnd precedes details so read-on-view still requires the full body.
 */
export function layoutTranscript(messages: readonly StoredMessage[], options: TranscriptOptions): TranscriptLayout {
  const width = Math.max(1, options.width);
  const indent = " ".repeat(Math.min(2, width - 1));
  const bodyWidth = width - indent.length;
  const now = options.now ?? Date.now();
  const rows: TerminalLine[] = [...(options.leading ?? [])];
  if (rows.length && messages.length) rows.push("");
  const ranges = new Map<string, MessageRange>();
  const order: string[] = [];
  if (!messages.length && options.empty) rows.push([{ text: ellipsize(options.empty, width), style: theme.dim }]);
  let previousCompact = false;
  for (const message of messages) {
    const compact = !message.channel && message.from !== "human" && message.to !== "human";
    if (order.length && !(previousCompact && compact)) rows.push("");
    if (message.id === options.firstUnreadId) {
      const label = `${options.unreadCount ?? 1} new `;
      rows.push(clipSpans([{ text: label, style: theme.unread }, { text: "┄".repeat(Math.max(0, width - terminalTextWidth(label))), style: theme.accent }], width));
    }
    const start = rows.length;
    const selected = message.id === options.selectedId;
    const fill = compact ? { ...theme.dim, ...(selected ? theme.selected : {}) } : selected ? theme.selected : undefined;
    rows.push(headerSpans(message, now, width, fill));
    for (const line of wrappedBody(message, bodyWidth)) {
      const text = `${indent}${line}`;
      rows.push(compact ? [{ text, style: theme.dim }] : text);
    }
    const bodyEnd = rows.length - 1;
    if (options.expanded?.(message.id)) {
      const prefix = truncateTerminalText("  ┊ ", Math.max(0, width - 1));
      for (const detail of detailLines(message)) {
        for (const line of wrapTerminalText(detail, width - terminalTextWidth(prefix))) {
          rows.push([{ text: prefix, style: compact ? { ...theme.accent, dim: true } : theme.accent }, { text: line, style: theme.dim }]);
        }
      }
    }
    ranges.set(message.id, { start, bodyEnd, end: rows.length - 1 });
    order.push(message.id);
    previousCompact = compact;
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
      { text: `  ${sanitizeTerminalText(renderMessageBody(m))}`, style: theme.dim },
    ];
  }
  if (event.type === "session") {
    const detail = event.action === "renamed" ? `${event.oldName ?? "?"} → ${event.name}` : event.name;
    const style = event.action === "gone" ? theme.warn : event.action === "removed" ? theme.dim : theme.ok;
    return [position, { text: "session  ", style: theme.accent }, { text: `${event.action} `, style }, { text: detail, style: theme.bold }, { text: `  ${event.harness}`, style: theme.dim }];
  }
  if (event.type === "channel") {
    return [position, { text: "channel  ", style: theme.accent }, { text: `${event.action} #${event.channel.name}`, style: theme.bold }, { text: `  ${event.channel.memberIds?.length ?? 0} members`, style: theme.dim }];
  }
  if (event.type === "ping") {
    return [position, { text: "ping     ", style: theme.accent }, { text: names(event.sessionId) ?? event.sessionId, style: theme.bold }, { text: `  ${event.ping}`, style: event.ping === "not_responding" ? theme.warn : theme.dim }];
  }
  if (event.type === "read") {
    const scope = event.state.scope;
    const stream = scope.scope === "session" ? names(scope.sessionId) ?? scope.sessionId : `#${scope.channel}`;
    return [position, { text: "read     ", style: theme.dim }, { text: `${stream} · ${event.state.unread} unread${event.state.reminder ? " · reminder" : ""}`, style: theme.dim }];
  }
  return [position, { text: "retention", style: theme.warn }, { text: "  older records pruned", style: theme.dim }];
}
