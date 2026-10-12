export const CELL = 8;
export const px = (point) => ({ x: point.x * CELL, y: point.y * CELL });

export function fnv1a(id) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 0x01000193);
  return hash >>> 0;
}

export function targetKey(target) {
  if (target.kind === "venue") return `v:${target.venueKey}`;
  if (target.kind === "membership") return `m:${target.venueKey}:${target.id}`;
  return `c:${target.id}`;
}

const UNSAFE_LABEL = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
export function sanitizeLabel(text) {
  const clean = String(text ?? "").replace(UNSAFE_LABEL, "");
  const points = Array.from(clean);
  return points.length > 16 ? `${points.slice(0, 16).join("")}…` : clean;
}

function animationAt(anim, key) {
  if (!anim) return null;
  const value = anim[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value && typeof value.startedAt === "number" && Number.isFinite(value.startedAt)) return value.startedAt;
  return null;
}

function idlePose(character, clock, reducedMotion) {
  if (reducedMotion) return "idle_a";
  const phase = ((clock - fnv1a(character.id) % 4000) % 4000 + 4000) % 4000;
  return phase < 200 ? "idle_b" : "idle_a";
}

function activityLabel(character) {
  if (character.source === "human") return "OPERATOR";
  if (character.busy === true) return "BUSY";
  if (character.busy === false) return "IDLE";
  return "UNKNOWN";
}

export function poseFor(character, anim, clock, connection, reducedMotion) {
  if (connection === "offline") return { pose: "idle_a", tone: "offline", label: "OFFLINE" };
  if (character.state === "gone" || character.state === "removed") {
    return { pose: "idle_a", tone: "gone", label: character.state === "gone" ? "GONE" : "REMOVED" };
  }
  if (character.state === "stale" || character.stale === true || character.ping === "not_responding") {
    return { pose: "idle_a", tone: "lost", label: "LOST" };
  }
  if (character.source === "process") {
    const cpu = Number.isFinite(character.cpu) ? `CPU ${Math.round(character.cpu)}% (inferred)` : "CPU unknown (inferred)";
    return { pose: "idle_a", tone: "dim", label: cpu };
  }
  if (anim?.walking === true || (animationAt(anim, "walk") !== null && clock - animationAt(anim, "walk") < 3000)) {
    return { pose: reducedMotion ? "idle_a" : (Math.floor(clock / 250) % 2 ? "walk_b" : "walk_a"), tone: "normal", label: "MOVING" };
  }
  const sendAt = animationAt(anim, "send");
  if (sendAt !== null && clock >= sendAt && clock - sendAt < 800) {
    const suffix = activityLabel(character);
    return { pose: reducedMotion || clock - sendAt < 400 ? "send_a" : "send_b", tone: "normal", label: `${suffix} TX` };
  }
  if (character.source !== "human" && character.busy === true) {
    return { pose: reducedMotion || Math.floor(clock / 500) % 2 === 0 ? "work_a" : "work_b", tone: "normal", label: "BUSY" };
  }
  if (character.source === "human" || character.busy === false) {
    return { pose: idlePose(character, clock, reducedMotion), tone: "normal", label: character.source === "human" ? "OPERATOR" : "IDLE" };
  }
  return { pose: "idle_a", tone: "normal", label: "UNKNOWN", badge: "?" };
}

function characterIndex(state) {
  if (state.charactersById instanceof Map) return state.charactersById;
  return new Map((state.characters ?? []).map((character) => [character.id, character]));
}

export function orderedTargets(state, filter, showProcesses) {
  const characters = characterIndex(state);
  return [...(state.layout?.targets ?? [])]
    .sort((a, b) => a.order - b.order)
    .filter(({ target }) => {
      if (target.kind === "venue") return true;
      const character = characters.get(target.id);
      if (!character) return false;
      if (character.source === "process" && !showProcesses) return false;
      return character.source === "human" || filter === null || character.harness === filter;
    });
}

export function cycle(targets, selectedKey, dir) {
  if (!targets.length) return null;
  const at = targets.findIndex((item) => targetKey(item.target ?? item) === selectedKey);
  if (at < 0) return targets[dir < 0 ? targets.length - 1 : 0];
  return targets[(at + (dir < 0 ? -1 : 1) + targets.length) % targets.length];
}

export function search(state, query) {
  const needle = sanitizeLabel(query).toLocaleLowerCase();
  if (!needle) return [];
  const characters = characterIndex(state);
  const matches = [];
  for (const position of orderedTargets(state, null, state.ui?.showProcesses ?? true)) {
    const target = position.target;
    if (target.kind === "membership") continue;
    let labels = [];
    if (target.kind === "venue") {
      const venue = (state.venues ?? []).find((item) => item.key === target.venueKey);
      if (venue) labels = [venue.name];
    } else {
      const character = characters.get(target.id);
      if (character) labels = [character.name, ...(character.previousNames ?? [])];
    }
    if (labels.some((label) => sanitizeLabel(label).toLocaleLowerCase().includes(needle))) matches.push(target);
  }
  return matches;
}

export function scopeOf(target, state) {
  if (!target) return null;
  if (target.kind === "venue") {
    const venue = state.venuesByKey?.get(target.venueKey)
      ?? (state.venues ?? []).find((item) => item.key === target.venueKey)
      ?? (state.layout?.venues ?? []).find((item) => item.key === target.venueKey);
    const name = venue?.name ?? venue?.venue?.name;
    return name ? { scope: "channel", channel: name } : null;
  }
  const character = characterIndex(state).get(target.id);
  return character?.source === "registered" ? { scope: "session", sessionId: character.id } : null;
}

export function messageTouches(msg, scope) {
  if (!scope) return false;
  if (scope.scope === "channel") return msg.channel === scope.channel;
  if (scope.scope === "session") return msg.fromSessionId === scope.sessionId || msg.toSessionId === scope.sessionId;
  return false;
}

export function walkPath(from, to) {
  return [from, { x: from.x, y: 0 }, { x: to.x, y: 0 }, to];
}

export function sample(path, distance) {
  if (!path?.segments?.length) return path?.segments?.[0]?.from ?? { x: 0, y: 0 };
  const d = Math.max(0, Math.min(path.length, distance));
  for (const segment of path.segments) {
    if (d <= segment.start + segment.length) {
      const ratio = segment.length === 0 ? 0 : (d - segment.start) / segment.length;
      return {
        x: segment.from.x + (segment.to.x - segment.from.x) * ratio,
        y: segment.from.y + (segment.to.y - segment.from.y) * ratio,
      };
    }
  }
  return path.segments[path.segments.length - 1].to;
}
