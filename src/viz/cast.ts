import type { Appearance, Outfit, Pose } from "./appearance.js";
import { DETAILED } from "./cast-detailed.js";

export type DetailedVariant = { palette: readonly string[]; frames: Readonly<Record<Pose, string>> };
type Hair = "short" | "spiky" | "curly" | "long" | "locs" | "ponytail" | "bun" | "cap" | "hood" | "swept";
type Trait = { hair: Hair; H: string; skin: keyof typeof SKIN; G?: string; Q?: string; X?: string; accessory?: "clip" | "earpiece" | "scarf" | "collar"; beard?: true | string; stubble?: boolean; backpack?: boolean; longcoat?: boolean; capTail?: boolean; cyberarm?: boolean; wrist?: boolean };
const SKIN = { L1: "#f2c9a6", L2: "#e0ab84", M: "#b97a4f", D: "#8a5634", DD: "#5e3a24" } as const;
const COLORS: Record<Outfit | "operator", readonly string[]> = {
  claude: ["#f6e6d2", "#d9581f", "#2a2a2a", "#b8742c", "#242424", "#e8d4bc", "#1f1f22", "#ff8a3a", "#ff7a1a"],
  codex: ["#f7f7f7", "#2ab8e8", "#1c1c24", "#8a8a92", "#24242c", "#f0f0f0", "#1e2a3a", "#3fd2ff", "#3fd2ff"],
  gemini: ["#0a48c8", "#e88a2a", "#242424", "#a07a3a", "#2c2c2c", "#1a4fd0", "#1f2a44", "#5ab8ff", "#6ac4ff"],
  qwen: ["#8444c4", "#b07ae8", "#242424", "#8a6a3a", "#2c2c2c", "#8a4ad0", "#222228", "#c08aff", "#b88aff"],
  llama: ["#0a6670", "#f08a24", "#2c2c2c", "#a8742c", "#242424", "#3a2c22", "#1e2a3a", "#f08a24", "#ff7a2a"],
  mistral: ["#fc9404", "#ffb84a", "#2c2c2c", "#a8843a", "#34342c", "#2e2a26", "#2a2a2e", "#ffb84a", "#ffc04a"],
  neutral: ["#4a4d55", "#8a8f99", "#2c2c2c", "#7a7d84", "#34342c", "#2e2a26", "#2a2a2e", "#c8ccd4", "#e8dec8"],
  operator: ["#2f3036", "#f5c518", "#f0eee8", "#f5c518", "#2a2b30", "#1c1c1e", "#1f2a33", "#2fd6e6", "#f5d33a"],
};
const TRAITS: Record<Outfit | "operator", readonly Trait[]> = {
  claude: [
    { hair: "long", H: "#cc4c24", skin: "L1", accessory: "clip", X: "#3fd2e0", longcoat: true },
    { hair: "spiky", H: "#2c2c2c", skin: "M", cyberarm: true, longcoat: true },
    { hair: "locs", H: "#2c2424", skin: "DD", G: "#9a8a7a", longcoat: true },
    { hair: "spiky", H: "#e4541c", skin: "L1", G: "#3aa0e0", longcoat: true },
    { hair: "cap", H: "#242424", Q: "#f6f0e8", skin: "D", backpack: true, longcoat: true },
    { hair: "long", H: "#343434", skin: "L2", longcoat: true },
  ],
  codex: [
    { hair: "spiky", H: "#1c1c24", skin: "L1" },
    { hair: "ponytail", H: "#ccc4cc", skin: "DD" },
    { hair: "long", H: "#044ca4", skin: "L1", G: "#3fd2ff" },
    { hair: "curly", H: "#1c1c24", skin: "D", G: "#3fd2ff" },
    { hair: "ponytail", H: "#9464dc", skin: "L1", G: "#3fd2ff" },
    { hair: "cap", H: "#242424", Q: "#fafafa", skin: "L1", backpack: true },
  ],
  gemini: [
    { hair: "spiky", H: "#2c2c2c", skin: "L1" },
    { hair: "locs", H: "#1c1c1c", skin: "DD" },
    { hair: "long", H: "#0474a4", skin: "L1", G: "#3a9ae8" },
    { hair: "ponytail", H: "#8c54d4", skin: "L1" },
    { hair: "short", H: "#1c1c1c", skin: "D", G: "#3a9ae8" },
    { hair: "spiky", H: "#fccc3c", skin: "L1" },
  ],
  qwen: [
    { hair: "ponytail", H: "#a464dc", skin: "L1", backpack: true },
    { hair: "locs", H: "#242424", skin: "DD", longcoat: true },
    { hair: "spiky", H: "#2c2c2c", skin: "L1", backpack: true },
    { hair: "cap", H: "#242424", Q: "#3c3444", capTail: true, skin: "L1", backpack: true },
    { hair: "short", H: "#2c2424", skin: "D", G: "#5a6cf0", backpack: true },
    { hair: "long", H: "#2c2c34", skin: "L1" },
  ],
  llama: [
    { hair: "curly", H: "#241c1c", skin: "L2", beard: true, longcoat: true },
    { hair: "bun", H: "#047484", skin: "L1", G: "#f08a24" },
    { hair: "locs", H: "#2c2424", skin: "DD" },
    { hair: "short", H: "#f4c484", skin: "L1", beard: "#d8a868", accessory: "earpiece", X: "#3a3a3a" },
    { hair: "ponytail", H: "#2c2c2c", skin: "L1", accessory: "scarf", X: "#e8501c" },
    { hair: "cap", H: "#242424", Q: "#0c7c8c", skin: "D", backpack: true },
  ],
  mistral: [
    { hair: "ponytail", H: "#3c3434", skin: "L2", accessory: "scarf", X: "#d8401c", longcoat: true },
    { hair: "curly", H: "#543424", skin: "L1", beard: true, accessory: "collar", X: "#ece4d6", backpack: true, longcoat: true },
    { hair: "bun", H: "#f4cca4", skin: "L1", backpack: true, longcoat: true },
    { hair: "curly", H: "#342424", skin: "DD", G: "#f09a1c", longcoat: true },
    { hair: "cap", H: "#242424", Q: "#343434", skin: "L1", backpack: true, longcoat: true },
    { hair: "hood", H: "#241c1c", skin: "L1", longcoat: true },
  ],
  neutral: [],
  operator: [{ hair: "swept", H: "#1e1a1a", skin: "L2", stubble: true, wrist: true }],
};
TRAITS.neutral = TRAITS.mistral.map((trait) => ({
  ...trait,
  ...(trait.X === undefined ? {} : { X: "#6a6e77" }),
}));

const HAIR: Partial<Record<Hair, Readonly<Record<number, string>>>> = {
  spiky: { 0: ".H.H.H." }, curly: { 0: ".HHHHH.", 2: ".H___H." },
  long: { 2: ".H___H.", 3: ".H___H." }, locs: { 2: ".H___H.", 3: ".H___H.", 4: "_H___H_" },
  ponytail: { 0: "_____H_", 1: "______H", 2: "______H" }, bun: { 0: "..HHHH." },
  cap: { 0: "..QQQ..", 1: ".QQQQQQ" }, hood: { 0: ".CCCCC.", 1: "CCHHHCC", 2: "C_____C", 3: "C_____C" },
  swept: { 0: ".HHHH..", 1: "HHHHHS." },
};
const cache = new Map<string, readonly (string | null)[][]>();

/** Hand-composed silhouettes retain face and accessory cues at seven-pixel width. */
export function compactPixels(appearance: Appearance, pose: Pose, size: "compact" | "mini"): readonly (string | null)[][] {
  const key = `${appearance.outfit}:${appearance.variant}:${pose}:${size}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const trait = TRAITS[appearance.outfit][appearance.variant]!;
  const palette: Record<string, string> = { H: trait.H, S: SKIN[trait.skin], E: "#1a1414", G: trait.G ?? "#1a1414", Q: trait.Q ?? trait.H, X: trait.X ?? "#2a2a2e", B: "#2a2a2e", M: "#8a96a4", W: "#2fd6e6", s: "#8a6a52" };
  for (const [i, slot] of [..."CcTAPFKkD"].entries()) palette[slot] = COLORS[appearance.outfit][i]!;
  let rows: string[][];
  if (size === "mini") {
    rows = [trait.hair === "cap" ? "QQQ" : trait.hair === "hood" ? "CHC" : "HHH", trait.G ? "GGG" : pose === "idle_b" ? "SSS" : "ESE", pose === "work_a" ? "KKK" : pose === "work_b" ? "KkK" : pose.startsWith("send") ? "CTD" : "CTC", pose === "walk_a" ? "P.." : pose === "walk_b" ? "..P" : "P.P"].map((row) => [...row]);
  } else {
    rows = ["..HHH..", ".HHHHH.", "..ESE..", "..SSS..", "CCcTcCC", "S.CAC.S", ".PP.PP.", ".FF.FF."].map((row) => [...row]);
    if (pose === "idle_b") rows[trait.G ? 4 : 2] = [...(trait.G ? ".CcTcC." : "..SSS..")] ;
    if (pose === "walk_a") { rows[5] = [..."S.CAC.."]; rows[6] = [..."PP...P."]; rows[7] = [..."F....FF"]; }
    if (pose === "walk_b") { rows[5] = [..."..CAC.S"]; rows[6] = [...".P...PP"]; rows[7] = [..."FF....F"]; }
    if (pose === "work_a" || pose === "work_b") rows[5] = [...(pose === "work_a" ? ".SKKKS." : ".SKkKS.")];
    if (pose === "send_a") { for (let y = 0; y < 4; y++) rows[y]![6] = "DSCC"[y]!; rows[4] = [..."CCcTcC."]; rows[5] = [..."S.CAC.."]; }
    if (pose === "send_b") { rows[3]![6] = "D"; rows[4] = [..."CCcTcCS"]; rows[5] = [..."S.CAC.."]; }
    if (trait.longcoat && !pose.startsWith("walk")) rows[6] = [...".CP.PC."];
    const arms: [number, number, string][] = [];
    if (pose.startsWith("send")) for (let y = 0; y < 6; y++) arms.push([y, 6, rows[y]![6]!]);
    if (pose.startsWith("work")) for (let x = 1; x <= 5; x++) arms.push([5, x, rows[5]![x]!]);
    for (const [y, overlay] of Object.entries(HAIR[trait.hair] ?? {})) for (let x = 0; x < overlay.length; x++) if (overlay[x] !== "_") rows[Number(y)]![x] = overlay[x]!;
    if (trait.capTail) rows[2]![6] = "H";
    if (trait.G) for (let x = 2; x <= 4; x++) rows[2]![x] = "G";
    if (trait.beard) {
      palette.h = typeof trait.beard === "string" ? trait.beard : trait.H;
      for (let x = 2; x <= 4; x++) rows[3]![x] = "h";
    }
    if (trait.stubble) { rows[3]![2] = "s"; rows[3]![4] = "s"; }
    if (trait.accessory === "clip") rows[1]![5] = "X";
    if (trait.accessory === "earpiece") rows[2]![5] = "X";
    if (trait.accessory === "scarf" || trait.accessory === "collar") for (let x = 2; x <= 4; x++) rows[4]![x] = "X";
    if (trait.backpack) { rows[4]![1] = "B"; rows[5]![1] = "B"; }
    for (const [y, x, slot] of arms) rows[y]![x] = slot;
    if (trait.cyberarm) {
      for (let y = 1; y <= 5; y++) if (rows[y]![6] === "S" || rows[y]![6] === "C") rows[y]![6] = "M";
      if (pose.startsWith("work")) rows[5]![5] = "M";
    }
    if (trait.wrist) {
      const y = pose === "send_a" ? 2 : 4;
      const x = pose.startsWith("work") || pose === "send_b" ? 5 : 6;
      rows[y]![x] = "W";
    }
  }
  const pixels = rows.map((row) => row.map((slot) => slot === "." ? null : palette[slot]!));
  cache.set(key, pixels);
  return pixels;
}

export function detailedPixels(appearance: Appearance, pose: Pose): readonly (string | null)[][] {
  const key = `${appearance.outfit}:${appearance.variant}:${pose}:detailed`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const variant = DETAILED[appearance.outfit][appearance.variant]!;
  const pixels = variant.frames[pose].split("\n").map((row) => [...row].map((slot) => slot === "." ? null : variant.palette[parseInt(slot, 12)]!));
  cache.set(key, pixels);
  return pixels;
}
