import type { ChannelSummary, ListedSession, PositionedEvent, SessionIdentity } from "../shared/protocol.js";
import type { ProcInfo } from "./scan.js";
import type { CityCharacter, FeedLine, VenueAppearance, VizHarness, World } from "./types.js";

const GONE_VISIBLE_MS = 30 * 60_000;
const MIN_SESSION_ID_MATCH = 8;
export type WorldInput = {
  sessions: ListedSession[];
  channels: ChannelSummary[];
  identities: SessionIdentity[];
  procs: ProcInfo[];
  feed: FeedLine[];
  connection: World["connection"];
  now: number;
};

/** A fetched bundle, rebased over authoritative events received while requests were in flight. */
export type CitySnapshot = { sessions: ListedSession[]; channels: ChannelSummary[]; identities: SessionIdentity[] };
export function rebaseCitySnapshot(bundle: CitySnapshot, events: readonly PositionedEvent[]): void {
  for (const { event } of events) {
    if (event.type === "session") {
      const identity = event.session;
      const at = bundle.identities.findIndex((session) => session.id === identity.id);
      if (at < 0) bundle.identities.push(identity);
      else bundle.identities[at] = identity;
      const live = bundle.sessions.findIndex((session) => session.id === identity.id);
      if (live < 0) continue; // Identity events do not report contact or availability.
      if (identity.state === "removed") bundle.sessions.splice(live, 1);
      else {
        const session = bundle.sessions[live];
        bundle.sessions[live] = {
          ...session, name: identity.name, previousNames: identity.previousNames,
          harness: identity.harness === "unknown" ? session.harness : identity.harness,
          cwd: identity.cwd ?? session.cwd, state: identity.state, inbound: identity.inbound, role: identity.role ?? null,
        };
      }
    } else if (event.type === "channel") {
      const previous = bundle.channels.find((channel) => channel.name === event.channel.name
        || (event.action === "renamed" && channel.name === event.oldName));
      const channel = { ...event.channel };
      if (channel.memberIds === undefined && previous?.memberIds !== undefined) channel.memberIds = previous.memberIds;
      // A later post may already be included in the fetched summary.
      if (previous && previous.lastOrder > channel.lastOrder) {
        channel.count = previous.count;
        channel.lastAt = previous.lastAt;
        channel.lastOrder = previous.lastOrder;
      }
      if (event.action === "renamed" && event.oldName) bundle.channels = bundle.channels.filter((item) => item.name !== event.oldName);
      const at = bundle.channels.findIndex((item) => item.name === channel.name);
      if (at < 0) bundle.channels.push(channel);
      else bundle.channels[at] = channel;
    } else if (event.type === "ping") {
      const session = bundle.sessions.find((session) => session.id === event.sessionId);
      if (session?.state === "live") session.ping = event.ping;
    } else if (event.type === "message" && event.status === "posted" && event.msg.channel !== undefined) {
      const channel = bundle.channels.find((channel) => channel.name === event.msg.channel);
      if (channel && event.msg.order > channel.lastOrder) {
        channel.count++;
        channel.lastAt = event.msg.createdAt;
        channel.lastOrder = event.msg.order;
      }
    }
  }
}

export function hashId(id: string): number {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 16777619);
  return hash >>> 0;
}
const APPEARANCES: readonly VenueAppearance[] = ["office", "bar", "garage", "arcade", "communications"];
export const venueAppearance = (name: string): VenueAppearance => APPEARANCES[hashId(name) % APPEARANCES.length]!;

/** Detection only: full resume-id matches first, then newest per-harness process surplus.
 * This cannot prove ownership; unrelated registrations may conceal unregistered processes.
 * Codex has no adapter. Keep this heuristic aligned with the unchanged process scanner. */
function detectedProcesses(sessions: ListedSession[], procs: ProcInfo[]): CityCharacter[] {
  const accountedFor = new Set<string>();
  const unmatched = procs.filter((proc) => {
    const owner = sessions.find((s) => s.harnessSessionId !== null && s.harnessSessionId.length >= MIN_SESSION_ID_MATCH && proc.command.includes(s.harnessSessionId));
    if (owner) accountedFor.add(owner.id);
    return !owner;
  });
  const detected: CityCharacter[] = [];
  const harnesses = new Set<VizHarness>(unmatched.map((p) => p.harness));
  for (const harness of harnesses) {
    const candidates = unmatched.filter((p) => p.harness === harness).sort((a, b) => a.elapsedSec - b.elapsedSec || a.pid - b.pid);
    const registered = sessions.filter((s) => s.harness === harness && s.state !== "gone" && !accountedFor.has(s.id)).length;
    for (const proc of candidates.slice(0, Math.max(0, candidates.length - registered))) {
      detected.push({
        id: `proc:${proc.pid}`, name: `${harness}-${proc.pid}`, source: "process", harness,
        state: null, stale: null, ping: null, busy: null, cpu: proc.cpu, role: null,
        cwd: null, memberships: [], previousNames: [], pid: proc.pid, lastSeen: null,
      });
    }
  }
  return detected.sort((a, b) => a.id.localeCompare(b.id));
}

/** Hosts resolve missing memberIds through channel_members before publishing the bundle.
 * Posts, roles, and ListedSession.channels are never substitutes for that roster. */
export function buildWorld(input: WorldInput): World {
  const { sessions, channels, identities, procs, feed, connection, now } = input;
  const memberships = new Map<string, string[]>();
  for (const channel of channels) {
    for (const id of new Set(channel.memberIds ?? [])) {
      const names = memberships.get(id) ?? [];
      names.push(channel.name);
      memberships.set(id, names);
    }
  }
  const listed = new Map(sessions.map((s) => [s.id, s]));
  const historical = new Map(identities.map((s) => [s.id, s]));
  const ids = new Set([...listed.keys(), ...memberships.keys()]);
  const registered: CityCharacter[] = [];
  for (const id of [...ids].sort()) {
    const s = listed.get(id);
    const identity = historical.get(id);
    const member = memberships.has(id);
    if (!member && s?.state === "gone" && (s.lastSeen === null || now - s.lastSeen > GONE_VISIBLE_MS)) continue;
    registered.push({
      id, name: s?.name ?? identity?.name ?? id, previousNames: [...new Set([...(s?.previousNames ?? []), ...(identity?.previousNames ?? [])])],
      source: "registered", harness: s?.harness ?? (identity?.harness === "unknown" ? null : identity?.harness ?? null),
      role: s ? s.role : identity?.role ?? null, state: identity?.state === "removed" ? "removed" : s?.state ?? identity?.state ?? null,
      stale: s?.stale ?? null, ping: s?.ping ?? null, busy: s?.busy ?? null, cpu: null,
      cwd: s ? s.cwd : identity?.cwd ?? null, memberships: (memberships.get(id) ?? []).sort(), lastSeen: s?.lastSeen ?? null,
    });
  }
  const byId = new Map(registered.map((c) => [c.id, c]));
  const human: CityCharacter = {
    id: "human", name: "operator", source: "human", harness: null, role: null, state: "live", stale: false,
    ping: null, busy: false, cpu: null, cwd: null, memberships: [], previousNames: [], lastSeen: null,
  };
  const visible = new Set(registered.map((c) => c.id));
  return {
    characters: [human, ...registered, ...detectedProcesses(sessions.filter((s) => visible.has(s.id)), procs)],
    venues: channels.map((c) => ({ key: c.name, name: c.name, appearance: venueAppearance(c.name), postCount: c.count,
      roster: [...new Set(c.memberIds ?? [])].sort().map((id) => byId.get(id)!) })),
    feed: feed.slice(-50), connection,
  };
}
