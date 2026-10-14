import type { StoredMessage } from "../shared/protocol.js";
import { ellipsize, justify, theme } from "./layout.js";
import { sanitizeTerminalText, terminalTextWidth, type TerminalLine, type TerminalSpan } from "./terminal.js";

/** Three yellow-bounded rows when there is room, otherwise one bounded row.
 * Width includes both edges; never emit a clipped held label that could arm an unseen action. */
export function heldBar(message: StoredMessage, count: number, width: number, maxRows: number): TerminalLine[] {
  const label = `⏸ held${count > 1 ? ` ${count}` : ""}`;
  const innerWidth = width - 2;
  const labelWidth = terminalTextWidth(label);
  if (maxRows < 1 || innerWidth < labelWidth) return [];
  const border = { ...theme.warn, dim: true };
  const hints = "r release  x drop";
  const hintWidth = terminalTextWidth(hints);
  // The label/count wins at tiny widths; action hints yield before the identity and preview.
  const right: TerminalSpan[] = innerWidth >= labelWidth + hintWidth + 12
    ? [{ text: hints, style: theme.dim }] : [];
  const identity = `  ${sanitizeTerminalText(message.from)} → ${sanitizeTerminalText(message.to)} · `;
  const previewWidth = innerWidth - labelWidth - terminalTextWidth(identity) - (right.length ? hintWidth + 1 : 0) - 2;
  const content = justify([
    { text: label, style: { ...theme.warn, bold: true } },
    ...(innerWidth > labelWidth ? [{ text: identity, style: theme.dim }] : []),
    ...(previewWidth > 0 ? [{ text: `"${ellipsize(sanitizeTerminalText(message.text), previewWidth)}"` }] : []),
  ], right, innerWidth);
  const row: TerminalLine = [{ text: "│", style: border }, ...content, { text: "│", style: border }];
  if (maxRows < 3) return [row];
  return [
    [{ text: `╭${"─".repeat(innerWidth)}╮`, style: border }],
    row,
    [{ text: `╰${"─".repeat(innerWidth)}╯`, style: border }],
  ];
}
