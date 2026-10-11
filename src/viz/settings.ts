import { readFileSync } from "node:fs";
import { vizSettingsPath } from "../shared/paths.js";
import type { Outfit } from "./appearance.js";
import { VIZ_HARNESSES } from "./types.js";
import type { VizHarness } from "./types.js";

export type VizSettings = {
  reducedMotion: boolean;
  sessions: Readonly<Record<string, Outfit>>;
  harnesses: Readonly<Partial<Record<VizHarness, Outfit>>>;
};
export const DEFAULT_VIZ_SETTINGS: VizSettings = Object.freeze({ reducedMotion: false, sessions: Object.freeze({}), harnesses: Object.freeze({}) });
const OUTFITS: readonly string[] = ["claude", "codex", "gemini", "qwen", "llama", "mistral", "neutral"];
const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function readVizSettings(): { settings: VizSettings; warning: string | null } {
  let text: string;
  try {
    text = readFileSync(vizSettingsPath(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { settings: DEFAULT_VIZ_SETTINGS, warning: null };
    return { settings: DEFAULT_VIZ_SETTINGS, warning: "viz.json: unable to read" };
  }
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { settings: DEFAULT_VIZ_SETTINGS, warning: "viz.json: invalid JSON" }; }
  let warning: string | null = null;
  const invalid = (path: string, reason: string): void => { warning ??= `viz.json: ${path}: ${reason}`; };
  if (!object(raw)) return { settings: DEFAULT_VIZ_SETTINGS, warning: "viz.json: $: expected object" };
  let reducedMotion = false;
  if (raw.reducedMotion !== undefined) {
    if (typeof raw.reducedMotion === "boolean") reducedMotion = raw.reducedMotion;
    else invalid("reducedMotion", "expected boolean");
  }
  const sessions: Record<string, Outfit> = Object.create(null);
  const harnesses: Partial<Record<VizHarness, Outfit>> = Object.create(null);
  if (raw.appearance !== undefined) {
    if (!object(raw.appearance)) invalid("appearance", "expected object");
    else for (const group of ["sessions", "harnesses"] as const) {
      const values = raw.appearance[group];
      if (values === undefined) continue;
      if (!object(values)) { invalid(`appearance.${group}`, "expected object"); continue; }
      for (const [key, value] of Object.entries(values)) {
        // Unknown harness keys, like other unknown configuration keys, are ignored.
        if (group === "harnesses" && !VIZ_HARNESSES.includes(key as VizHarness)) continue;
        if (typeof value !== "string" || !OUTFITS.includes(value)) {
          invalid(`appearance.${group}.${key}`, "expected outfit claude|codex|gemini|qwen|llama|mistral|neutral");
          continue;
        }
        if (group === "sessions") sessions[key] = value as Outfit;
        else harnesses[key as VizHarness] = value as Outfit;
      }
    }
  }
  return { settings: { reducedMotion, sessions, harnesses }, warning };
}
