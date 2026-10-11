import { identityHash } from "./appearance.js";
import type { Pose } from "./appearance.js";
import { sampleRoute } from "./place.js";
import type { SpriteTone } from "./sprites.js";
import type { CityCharacter, Point, RoutePath, World } from "./types.js";

type Animation = { send?: number; walk?: { path: RoutePath; start: number; end: number } };

/** Only the map's visible clock advances animation. Snapshot/poll time never does. */
export class CharacterAnimator {
  private readonly entries = new Map<string, Animation>();

  send(id: string, clock: number): void {
    const entry = this.entries.get(id) ?? {};
    entry.send = clock;
    this.entries.set(id, entry);
  }

  walk(id: string, path: RoutePath, clock: number): void {
    if (path.length <= 0) return;
    const entry = this.entries.get(id) ?? {};
    entry.walk = { path, start: clock, end: clock + Math.max(600, Math.min(3000, path.length * 50)) };
    this.entries.set(id, entry);
  }

  prune(ids: ReadonlySet<string>): void {
    for (const id of this.entries.keys()) if (!ids.has(id)) this.entries.delete(id);
  }

  clear(): void { this.entries.clear(); }
  get size(): number { return this.entries.size; }

  /** Only step advances and expires state; rendering remains a pure read. */
  advance(clock: number): void {
    for (const [id, entry] of this.entries) {
      if (entry.send !== undefined && clock >= entry.send + 800) delete entry.send;
      if (entry.walk !== undefined && clock >= entry.walk.end) delete entry.walk;
      if (entry.send === undefined && entry.walk === undefined) this.entries.delete(id);
    }
  }

  active(id: string): Readonly<Animation> | undefined { return this.entries.get(id); }

  position(id: string, clock: number): Point | null {
    const walk = this.entries.get(id)?.walk;
    if (walk === undefined || clock >= walk.end) return null;
    const fraction = Math.max(0, Math.min(1, (clock - walk.start) / (walk.end - walk.start)));
    return sampleRoute(walk.path, fraction * walk.path.length);
  }
}

export function poseFor(c: CityCharacter, a: CharacterAnimator, clock: number, connection: World["connection"], reducedMotion: boolean): { pose: Pose; tone: SpriteTone; label: string } {
  if (connection === "offline") return { pose: "idle_a", tone: "offline", label: "OFFLINE" };
  if (c.source === "process") return { pose: "idle_a", tone: "dim", label: `CPU ${c.cpu === null ? "?" : c.cpu}% (inferred)` };
  if (c.state === "gone" || c.state === "removed") return { pose: "idle_a", tone: "gone", label: c.state.toUpperCase() };
  if (c.state === "stale" || c.stale === true || c.ping === "not_responding") return { pose: "idle_a", tone: "lost", label: "LOST" };
  const active = a.active(c.id);
  if (!reducedMotion && active?.walk !== undefined && clock < active.walk.end) {
    return { pose: Math.floor((clock - active.walk.start) / 250) % 2 === 0 ? "walk_a" : "walk_b", tone: "live", label: "MOVING" };
  }
  const busy = c.source === "human" ? false : c.busy;
  const label = c.source === "human" ? "OPERATOR" : busy === true ? "BUSY" : busy === false ? "IDLE" : "UNKNOWN ?";
  if (active?.send !== undefined && clock < active.send + 800) return { pose: reducedMotion || clock - active.send < 400 ? "send_a" : "send_b", tone: "live", label: `${label} TX` };
  if (busy === true) return { pose: reducedMotion || Math.floor(clock / 500) % 2 === 0 ? "work_a" : "work_b", tone: "live", label };
  if (busy === false && !reducedMotion && (clock + identityHash(c.id) % 4000) % 4000 < 200) return { pose: "idle_b", tone: "live", label };
  return { pose: "idle_a", tone: "live", label };
}
