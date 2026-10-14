import { clipSpans, theme } from "./layout.js";
import { terminalTextWidth, type TerminalSpan } from "./terminal.js";

const KEY_GLYPHS: Record<string, string> = {
  Enter: "⏎", "Shift+Enter": "⇧⏎", Tab: "⇥", "Ctrl+E": "^E", "Ctrl+K": "^K", "Ctrl+X": "^X",
};

/** Raw hints remain the shortcut source. Shrink labels before hiding any key chip;
 * prose such as "type to filter" stays dim rather than becoming a fake shortcut. */
export function hintSpans(hints: string, width: number): TerminalSpan[] {
  const parts = hints.split(" · ").map((part) => {
    const match = /^(Shift\+Enter|Ctrl\+[EKX]|Enter|Tab|Esc|End|↑↓|←→|c|y|n|\?)(?: (.*))?$/.exec(part);
    return match ? { key: match[1], label: match[2] ?? "" } : { label: part };
  });
  for (const mode of ["full", "glyphs", "keys"] as const) {
    const spans: TerminalSpan[] = [];
    for (const part of parts) {
      if (mode === "keys" && !part.key) continue;
      if (spans.length) spans.push({ text: mode === "keys" ? " " : " · ", style: theme.dim });
      if (part.key) {
        const key = mode === "full" ? part.key : KEY_GLYPHS[part.key] ?? part.key;
        spans.push({ text: key, style: theme.key });
      }
      if (part.label && mode !== "keys") {
        spans.push({ text: `${part.key ? " " : ""}${part.label}`, style: theme.dim });
      }
    }
    if (spans.reduce((sum, span) => sum + terminalTextWidth(span.text), 0) <= width || mode === "keys") {
      return clipSpans(spans, width);
    }
  }
  return [];
}
