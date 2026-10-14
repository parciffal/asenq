import type { VizSettings } from "./settings.js";
import type { CityCharacter, VizHarness } from "./types.js";

export type Affiliation = "claude" | "codex" | "gemini" | "qwen" | "llama" | "mistral";
export type Outfit = Affiliation | "neutral";
export type Pose = "idle_a" | "idle_b" | "walk_a" | "walk_b" | "work_a" | "work_b" | "send_a" | "send_b";
export type Appearance = {
  outfit: Outfit | "operator";
  variant: number;
  reason: "operator" | "session-mapping" | "harness-mapping" | "no-model-metadata" | "detected-process";
};

/** FNV-1a over stable identity, never a mutable name or reported state. */
export function identityHash(id: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 0x01000193);
  return hash >>> 0;
}

export function appearanceOf(c: { id: string; source: CityCharacter["source"]; harness: VizHarness | null }, s: VizSettings): Appearance {
  if (c.source === "human") return { outfit: "operator", variant: 0, reason: "operator" };
  const session = c.source === "registered" && Object.hasOwn(s.sessions, c.id) ? s.sessions[c.id] : undefined;
  const harness = c.harness !== null && Object.hasOwn(s.harnesses, c.harness) ? s.harnesses[c.harness] : undefined;
  return {
    outfit: session ?? harness ?? "neutral",
    variant: identityHash(c.id) % 6,
    reason: session !== undefined ? "session-mapping" : harness !== undefined ? "harness-mapping" : c.source === "process" ? "detected-process" : "no-model-metadata",
  };
}
