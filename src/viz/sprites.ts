import type { VizHarness } from "./types.js";

/** Shared neon palette: CP2077 yellow/cyan/magenta/red on void black. */
export const PAL = {
  void: "#05060f",
  grid: "#151a33",
  alert: "#ff003c",
  ghost: "#5b6078",
  yellow: "#fcee0a",
  cyan: "#00f0ff",
  magenta: "#ff2bd6",
  green: "#39ff14",
  orange: "#ff9f1c",
  white: "#e8ecff",
} as const;

export type Hex = `#${string}`;

const rgbOf = (hex: string): [number, number, number] => [
  parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16),
];
const hex2 = (value: number): string => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, "0");
const shadeCache = new Map<string, Hex>();
const mixCache = new Map<string, Hex>();

/** Scale a hex color's brightness (0 = black, 1 = unchanged, >1 = toward white-ish). Quantized so results cache. */
export function shade(hex: string, factor: number): Hex {
  const q = Math.max(0, Math.min(48, Math.round(factor * 32)));
  const key = `${hex}${q}`;
  let out = shadeCache.get(key);
  if (out === undefined) {
    const [r, g, b] = rgbOf(hex);
    const f = q / 32;
    // Above 1 the color is pushed toward white so "bright" variants stay neon instead of clipping flat.
    const lift = f > 1 ? f - 1 : 0;
    const scale = (v: number): number => v * Math.min(f, 1) + (255 - v * Math.min(f, 1)) * lift;
    out = `#${hex2(scale(r))}${hex2(scale(g))}${hex2(scale(b))}`;
    shadeCache.set(key, out);
  }
  return out;
}

/** Linear mix of two hex colors; `t` 0 = a, 1 = b. */
export function mix(a: string, b: string, t: number): Hex {
  const q = Math.max(0, Math.min(16, Math.round(t * 16)));
  const key = `${a}${b}${q}`;
  let out = mixCache.get(key);
  if (out === undefined) {
    const [ar, ag, ab] = rgbOf(a);
    const [br, bg, bb] = rgbOf(b);
    const f = q / 16;
    out = `#${hex2(ar + (br - ar) * f)}${hex2(ag + (bg - ag) * f)}${hex2(ab + (bb - ab) * f)}`;
    mixCache.set(key, out);
  }
  return out;
}

export type Species = { name: string; tag: string; color: Hex };

export const SPECIES: Record<VizHarness, Species> = {
  claude: { name: "scarab", tag: "CLAUDE", color: PAL.orange },
  omp: { name: "spider", tag: "OMP", color: PAL.cyan },
  opencode: { name: "mantis", tag: "OPENCODE", color: PAL.green },
  codex: { name: "moth", tag: "CODEX", color: PAL.magenta },
};
/** Fallback for a bug without a known harness. */
export const SPECIES_UNKNOWN: Species = { name: "glitch", tag: "UNKNOWN", color: PAL.ghost };

export function speciesOf(harness: VizHarness | null): Species {
  return harness === null ? SPECIES_UNKNOWN : SPECIES[harness];
}

/** `E` marks an eye cell; the last row alternates between two leg frames. */
export type Art = { rows: readonly string[]; legs: readonly [string, string] };

export const WORKER_W = 7;
export const ORCH_W = 11;
export const HUMAN_W = 13;

export const WORKER_ART: Record<VizHarness, Art> = {
  claude: { rows: [" ▄▀▀▀▄ ", "▐█E█E█▌"], legs: ["╱╱▀▀▀╲╲", "╲╲▀▀▀╱╱"] },
  omp: { rows: ["╲ ▄█▄ ╱", "═╣E█E╠═"], legs: ["╱ ╵ ╵ ╲", "╲ ╷ ╷ ╱"] },
  opencode: { rows: ["  ▟▀▙  ", "╱▐E█E▌╲"], legs: ["╲▝▀▀▀▘╱", "╱▝▀▀▀▘╲"] },
  codex: { rows: ["◢▙ ▲ ▟◣", "█▌E█E▐█"], legs: ["◥█▀▀▀█◤", " ◥▀▀▀◤ "] },
};

export const ORCH_ART: Record<VizHarness, Art> = {
  claude: {
    rows: ["  ▲ ▲▲▲ ▲  ", "▗▟███████▙▖", "▐█▌E███E▐█▌", " ▜███████▛ "],
    legs: ["╱╱ ▀▀▀▀▀ ╲╲", "╲╲ ▀▀▀▀▀ ╱╱"],
  },
  omp: {
    rows: ["  ╲ ▲▲▲ ╱  ", "══╣█████╠══", "  ▐█E█E█▌  ", "══╣▀███▀╠══"],
    legs: ["╱ ╱ ╵ ╵ ╲ ╲", "╲ ╲ ╷ ╷ ╱ ╱"],
  },
  opencode: {
    rows: [" ╲▲ ▲▲▲ ▲╱ ", "  ▟█████▙  ", " ╱▐█E█E█▌╲ ", "╱ ▝▀███▀▘ ╲"],
    legs: ["╲╲  ▀▀▀  ╱╱", "╱╱  ▀▀▀  ╲╲"],
  },
  codex: {
    rows: [" ◢▙ ▲▲▲ ▟◣ ", "◢██▙███▟██◣", "███▌E█E▐███", "◥██▛███▜██◤"],
    legs: [" ◥██▀▀▀██◤ ", "  ◥█▀▀▀█◤  "],
  },
};

/** Full art rows for one leg frame. */
export function artRows(art: Art, leg: 0 | 1): string[] {
  return [...art.rows, art.legs[leg]];
}

const SHIMMER = "░▒▓█▓▒░";

/** The netrunner deck: a console with a scanning gradient strip. */
export function humanRows(tick: number): string[] {
  const shift = ((tick % 7) + 7) % 7;
  const strip = SHIMMER.slice(shift) + SHIMMER.slice(0, shift);
  return ["  ▟▀▀▀▀▀▀▀▙  ", ` ▐ ${strip} ▌ `, `▄█${"▄".repeat(9)}█▄`];
}

/** Which art rows each level draws: full art, a 1-2 row mini sprite, or none. */
export type SpriteMode = "full" | "mini" | "none";
export type SpriteClass = "human" | "orch" | "worker";

export const SPRITE_ROWS: Record<SpriteMode, Record<SpriteClass, readonly number[]>> = {
  full: { human: [0, 1, 2], orch: [0, 1, 2, 3, 4], worker: [0, 1, 2] },
  mini: { human: [1], orch: [0, 2], worker: [1] },
  none: { human: [], orch: [], worker: [] },
};
/** Index (within the drawn rows) of the eye row; links enter the slot at this row. */
export const EYE_ROW: Record<SpriteMode, Record<SpriteClass, number>> = {
  full: { human: 1, orch: 2, worker: 1 },
  mini: { human: 0, orch: 1, worker: 0 },
  none: { human: 0, orch: 0, worker: 0 },
};
export const SPRITE_WIDTH: Record<SpriteClass, number> = { human: HUMAN_W, orch: ORCH_W, worker: WORKER_W };

export const GLITCH_CHARS = "░▒▓▌▐/\\#▚▞";
