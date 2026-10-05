# TUI redesign — mockups

Design exploration for `asenq tui` (`src/tui/`). Canvas: https://claude.ai/artifact/DgQPRKU3NEP8m7sP2RT8Ft

These files are reference mockups, not runtime code. Each `*.dc.html` is a
120×32-cell terminal frame (JetBrains Mono 13px / 18px rows) drawn in HTML;
they load `./support.js` from the canvas host, so open them on the canvas
rather than directly in a browser. Read them as specs: copy, glyphs, colors
and row layout are what matter.

| File | Direction |
|---|---|
| `Today.dc.html` | Baseline: the current TUI, as in `assets/asenq-tui.gif` |
| `Refined.dc.html` | **A · Refined split** — same structure and keys, polished |
| `ChatFirst.dc.html` | **B · Chat-first** — single sidebar, no tab bar |
| `Console.dc.html` | **C · Ops console** — dense dashboard for many agents |

Sample session names and message text are placeholders.

## Constraints all directions keep

- ANSI-16 only. The hex values below are the reference terminal theme used
  in the mockups; in code each maps to a slot in `theme` (`src/tui/layout.ts`),
  foreground-only, so the user's terminal background shows through.
  Background fills (selected row, bubbles, key chips) map to `inverse` or
  a dim/bright-black background slot.
- Everything existing stays: Sessions / Inbox / Channels / Activity, read
  markers and unread reminders, held messages, inbound policy, archive,
  `?` command palette, composer with `Ctrl+E` editor, narrow (<80 col)
  single-pane mode, mouse hit targets.

## Palette → theme slots

| Role | Mock hex | ANSI slot | Existing `theme` key |
|---|---|---|---|
| Text | `#c9ccd3` | default fg | — |
| Dim / meta | `#8a909c` | dim | `dim` |
| Accent | `#5ccfe6` | cyan | `accent` |
| Brand, unread, focus | `#8be9fd` bold | brightCyan bold | `brand`, `unread` |
| Agent sender | `#d58bf0` bold | magenta bold | `agent` |
| Human sender (you) | `#82aaff` bold | brightBlue bold | `human` |
| Live / delivered | `#8bd5a0` | green | `ok` |
| Held / reconnecting / queued | `#e6c07b` | yellow | `warn` |
| Failed / refused | `#f07178` bold | red bold | `bad` |
| Borders, separators | `#303643` | brightBlack / dim | new: `border` |
| Selected row bg | `#222836` | inverse or brightBlack bg | `selected` |
| Key chip | `#2a303c` bg | inverse dim | new: `key` |

## Glyphs

- Session state: `●` live (green), `◌` reconnecting (yellow), archived = dim, no dot.
- Held: `⏸` (yellow). Delivered: `✓` (green). New-messages divider: dashed cyan rule labelled `N new`.
- Harness short names in lists: `cc` (Claude Code), `oc` (OpenCode), `omp`.
- Panels: rounded box drawing `╭─ Title ─╮ │ ╰─╯`, title inset into the top border.

## A · Refined split (recommended base)

Header row: `asenq` chip (inverse cyan) · tabs, active tab as an inverse/highlighted
pill, inbox unread count in brightCyan · right side global counters
`3 live · 1 held · 2 unread  ● connected`.

Left panel `╭─ Sessions 6 ─╮`, ~30 cols:
- Section labels in dim caps: `LIVE`, `RECONNECTING`, `▸ archive N`.
- Row: `● name` … right-aligned `harness  unread`. Held-policy sessions show `⏸`.
- Selected row: highlight bg + cyan left marker (`▌`), name in brightCyan bold.
- Bottom of panel: `/ filter sessions` hint above a separator.

Right panel `╭─ reviewer · omp · accepting · since 01:12 PM ─╮`:
- `· beginning of retained history ·` centered, dim.
- Message header: `sender → target` left (sender colored, rest dim), right `✓ delivered  01:21 PM`.
  Kind shown as a small inverse yellow tag (`task`, `result`, `status`); `chat` omitted.
- Body indented 2 cols, blank row between messages.
- Unread divider: `N new ┄┄┄┄` in cyan.
- `End ↓ latest` hint bottom-right when not following.

Composer: its own rounded box under the transcript, cyan border when focused,
inset label `to reviewer`, prompt `›`, right hint `⏎ send  ⇧⏎ newline  ^E editor`.

Footer: key chips (inverse) + dim labels, context-sensitive like today's
`hints`: `↑↓ move  ⏎ open  ⇥ focus  c write  / filter  h held` … right `? commands  q quit`.

## B · Chat-first (ideas worth borrowing into A)

- One sidebar replaces the tab bar: `✉ Inbox N`, `SESSIONS`, `CHANNELS`, and an
  `ACTIVITY` tail of the last 3 important events at the bottom.
- Agent↔agent messages in a session conversation are rendered dim/compact
  (`orch → worker-oc [task]`); messages to/from you are full-contrast.
- Your messages right-aligned in a tinted bubble.
- **Held bar** above the composer when the open session has held messages:
  `⏸ held  orch → worker-omp · "preview…"   r release  x drop` (yellow border).
- Composer shows the target as `@orch`; `/` opens commands.
- `^K` quick-jump to any session/channel.

## C · Ops console

- Header: counters row `4 live · 1 reconnecting · 1 held · 2 unread · 0 failed`.
- Full-width sessions table: `NAME HARNESS STATE POLICY UNREAD LAST MESSAGE`.
- Lower split: conversation preview (timestamp gutter) | stacked `Held N` queue
  (actionable) over a live `Activity · important` feed.
- Footer adds `b broadcast`, `p policy`, `h held`, `# channels`.

## Suggested implementation order

1. Theme: add `border` and `key` styles; harness short-name helper.
2. Box-drawing panel helper with inset title (replaces the `│` split in `paneWidths` rendering).
3. Header counters + tab pill; footer key chips (reuse existing `hints` strings).
4. Session list sections, state dots, harness column, selected-row marker.
5. Transcript header layout (`sender → target` … status + time), kind tag, dashed new divider.
6. Composer box.
7. Optional from B: dim agent↔agent rows, held bar with `r`/`x`.

Keep `test/tui.test.ts` green; it asserts on rendered rows, so update
expectations alongside each step.
