# Character concepts

AI-generated, unofficial, branding-inspired character concepts supplied by the project owner (2026-10-09/11). These concepts are not affiliated with or endorsed by Anthropic, OpenAI, Google, Alibaba, Meta or Mistral AI. Names and colors are used only as costume themes; trademarks belong to their owners. No model/provider affiliation is inferred from a session's harness.

Original files, copied without modification into `source/`: `claude.png`, `codex.png`, `gemini.png`, `qwen.png`, `llama.png`, `mistral.png`, `manifest.json` and `README.md`, from the owner's `asenq-character-movements` concept pack. `operator.png` is the original `exec-9b80f5c9-ab98-49d0-9544-fbbb9bca6c5f.png`; it depicts the project owner and is used with permission.

Provider sheets have six variant rows and eight pose columns, ordered: `idle_a`, `idle_b`, `walk_a`, `walk_b`, `work_a`, `work_b`, `send_a`, `send_b`. The operator sheet has one large reference plus eight poses in two rows of four in that same order.

Run `node scripts/derive-sprites.mjs` to derive detailed character-cell data, `--check` to compare deterministic output, or `--preview <outfit|operator>` to inspect half-block frames. The generator requires ffmpeg and ffprobe on PATH. Parameters and sanctioned head/neutral corrections live in `derive.json`; generated `src/viz/cast-detailed.ts` must not be hand-edited. Raw raster references are excluded from the npm package.

Detailed frames use a 20×24 pixel canvas, a shared scale per variant and a strict 2% opaque-area clipping limit. Per the owner's “Fit affected variants” choice, only variants exceeding that limit at `23 / idle_a bbox height` use a smaller shared scale: a deterministic 40-iteration binary search finds the maximal scale satisfying every pose. The generator reports fitted scales to stderr; preview artwork alone goes to stdout. A full six-variant preview occupies 168 columns and 85 output rows (operator: 168 columns and 15 rows); allow one extra terminal row for the final newline.
