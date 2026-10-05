import { clipSpans, padSpans, theme } from "./layout.js";
import { terminalTextWidth, type TerminalLine, type TerminalSpan } from "./terminal.js";

/** Wide-pane frame; width and height include the border, with a clipped inset title. */
export function roundedPanel(
  title: TerminalLine,
  content: readonly TerminalLine[],
  width: number,
  height: number,
  focused = false,
): TerminalSpan[][] {
  if (height <= 0) return [];
  const border = focused ? theme.accent : theme.border;
  const inset = clipSpans(typeof title === "string" ? [{ text: title }] : title, Math.max(0, width - 6));
  const titleWidth = inset.reduce((sum, span) => sum + terminalTextWidth(span.text), 0);
  const rows: TerminalSpan[][] = [[
    { text: "╭─ ", style: border },
    ...inset,
    { text: ` ${"─".repeat(Math.max(0, width - titleWidth - 5))}╮`, style: border },
  ]];
  for (let row = 0; row < height - 2; row++) {
    const line = content[row] ?? "";
    rows.push([
      { text: "│", style: border },
      ...padSpans(typeof line === "string" ? [{ text: line }] : line, width - 2),
      { text: "│", style: border },
    ]);
  }
  if (height >= 2) rows.push([{ text: `╰${"─".repeat(width - 2)}╯`, style: border }]);
  return rows;
}
