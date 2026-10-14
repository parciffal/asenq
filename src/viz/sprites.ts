export type Hex = `#${string}`;
export type SpriteTone = "live" | "lost" | "gone" | "offline" | "dim";
export type SpriteCell = { ch: string; fg?: Hex; bg?: Hex } | null;

export const PAL = {
  void: "#100609", grid: "#281018", border: "#a52b3a", white: "#e8dec8",
  cyan: "#55ced1", yellow: "#f4e45a", alert: "#ff4355", ghost: "#70636a",
  orange: "#dba566", green: "#86bd9d", magenta: "#a98bb7",
} as const;

const rgbOf = (hex: string): [number, number, number] => [
  parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16),
];
const hex2 = (value: number): string => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, "0");
const shadeCache = new Map<string, Hex>();
const mixCache = new Map<string, Hex>();

/** Quantized brightness keeps the finite sprite palette cached across frames. */
export function shade(hex: string, factor: number): Hex {
  const q = Math.max(0, Math.min(48, Math.round(factor * 32)));
  const key = `${hex}${q}`;
  let out = shadeCache.get(key);
  if (out === undefined) {
    const [r, g, b] = rgbOf(hex);
    const f = q / 32;
    const lift = f > 1 ? f - 1 : 0;
    const scale = (v: number): number => v * Math.min(f, 1) + (255 - v * Math.min(f, 1)) * lift;
    out = `#${hex2(scale(r))}${hex2(scale(g))}${hex2(scale(b))}`;
    shadeCache.set(key, out);
  }
  return out;
}

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

const TONE: Record<SpriteTone, number> = { live: 1, lost: 0.6, gone: 0.4, offline: 0.55, dim: 0.3 };

/** A null half-pixel is transparent: the scenery must remain visible behind it. */
export function rasterize(pixels: readonly (readonly (string | null)[])[], tone: SpriteTone, color: boolean): SpriteCell[][] {
  const rows: SpriteCell[][] = [];
  for (let y = 0; y < pixels.length; y += 2) {
    const top = pixels[y]!;
    const bottom = pixels[y + 1];
    const row: SpriteCell[] = [];
    for (let x = 0; x < top.length; x++) {
      const t = top[x] ?? null;
      const b = bottom?.[x] ?? null;
      if (t === null && b === null) { row.push(null); continue; }
      const ch = t === null ? "▄" : b === null ? "▀" : !color || t === b ? "█" : "▀";
      if (!color) { row.push({ ch }); continue; }
      const fg = shade(t ?? b!, TONE[tone]);
      row.push(b !== null && t !== null && t !== b ? { ch, fg, bg: shade(b, TONE[tone]) } : { ch, fg });
    }
    rows.push(row);
  }
  return rows;
}

export const PACKET_DOTS = ["⠁", "⠂", "⠄", "⡀"] as const;
export const PACKET_TRAIL = "⠒";
