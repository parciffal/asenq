import { createHash } from "node:crypto";
import type { Harness } from "../shared/protocol.js";

export type DefaultNameWords = { adjectives: readonly string[]; animals: readonly string[] };

export const DEFAULT_NAME_WORDS: DefaultNameWords = {
  adjectives: [
    "agile", "alert", "amber", "arctic", "azure", "bold", "brave", "bright",
    "brisk", "calm", "candid", "clever", "coral", "cozy", "crisp", "curious",
    "daring", "deft", "eager", "fair", "fancy", "fast", "fiery", "fond",
    "fresh", "gentle", "glad", "golden", "grand", "happy", "hardy", "humble",
    "jolly", "keen", "kind", "lively", "loyal", "lucid", "lucky", "mellow",
    "merry", "mild", "nimble", "noble", "patient", "placid", "playful", "proud",
    "quick", "quiet", "rapid", "ready", "rosy", "royal", "sandy", "sharp",
    "shiny", "shy", "silent", "silver", "smart", "snowy", "steady", "sunny",
  ],
  animals: [
    "alpaca", "badger", "bat", "bear", "beaver", "bison", "boar", "buffalo",
    "camel", "cat", "cheetah", "cobra", "cougar", "coyote", "crab", "crane",
    "deer", "dingo", "dog", "dolphin", "dove", "duck", "eagle", "egret",
    "elk", "falcon", "ferret", "finch", "fox", "frog", "gecko", "goat",
    "goose", "heron", "horse", "ibis", "jaguar", "koala", "lemur", "lion",
    "llama", "lynx", "mink", "mole", "moose", "moth", "mouse", "newt",
    "otter", "owl", "panda", "parrot", "penguin", "puma", "rabbit", "raven",
    "robin", "seal", "shark", "sheep", "sloth", "snake", "tiger", "wolf",
  ],
};

/** New nameless identities walk every word pair before using numeric suffixes. */
export function defaultName(
  harness: Harness, sessionId: string, isTaken: (name: string) => boolean,
  words: DefaultNameWords = DEFAULT_NAME_WORDS,
): string {
  const { adjectives, animals } = words;
  if (!adjectives.length || !animals.length) throw new Error("default-name word lists must not be empty");
  const count = adjectives.length * animals.length;
  const hash = createHash("sha256").update(harness).update("\0").update(sessionId).digest();
  const start = hash.readUInt32BE(0) % count;
  const base = `${harness}-${adjectives[Math.floor(start / animals.length)]}-${animals[start % animals.length]}`;
  if (!isTaken(base)) return base;
  for (let offset = 1; offset < count; offset++) {
    const index = (start + offset) % count;
    const name = `${harness}-${adjectives[Math.floor(index / animals.length)]}-${animals[index % animals.length]}`;
    if (!isTaken(name)) return name;
  }
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const name = base.slice(0, 40 - suffix.length).replace(/-+$/, "") + suffix;
    if (!isTaken(name)) return name;
  }
}
