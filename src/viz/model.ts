import type { ListedSession } from "../shared/protocol.js";
import type { ProcInfo } from "./scan.js";
import type { Bug, BugKind, Edge, FeedLine, VizHarness, World } from "./types.js";

/** Archived (gone) sessions linger as flatlined bugs this long after their last contact. */
const GONE_VISIBLE_MS = 30 * 60_000;
/** Minimum harness session id length trusted for matching against process command lines. */
const MIN_SESSION_ID_MATCH = 8;
/** A feral process at or above this CPU percentage counts as working. */
const WORKING_CPU = 5;

export type WorldInput = {
  sessions: ListedSession[];
  procs: ProcInfo[];
  feed: FeedLine[];
  connection: World["connection"];
  now: number;
};

const byName = (a: Bug, b: Bug): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/**
 * Process detection is a heuristic. Processes cannot be tied to a session reliably, so:
 *  1. a process whose command line contains a registered session's full `harnessSessionId`
 *     (e.g. `omp -r <uuid>`) is accounted for by that session;
 *  2. per harness, the remaining processes are compared with the remaining live (live or stale)
 *     registered sessions of that harness; if there are more processes than sessions, the surplus
 *     are feral. The newest processes (smallest elapsedSec) are the ones presumed unregistered;
 *  3. Codex has no asenq adapter, so every Codex process is feral.
 * Limits: a freshly started agent shows as feral until it registers (OpenCode only registers after
 * its first prompt); a process that fails to register hides behind an unrelated session of the same
 * harness unless it is newer; helper processes the classifier cannot tell apart count as agents;
 * a child agent launched by another of the same harness is not deduplicated.
 */
function feralBugs(sessions: ListedSession[], procs: ProcInfo[]): Bug[] {
  const accountedFor = new Set<string>();
  const unmatched = procs.filter((proc) => {
    const owner = sessions.find((s) =>
      s.harnessSessionId !== null && s.harnessSessionId.length >= MIN_SESSION_ID_MATCH && proc.command.includes(s.harnessSessionId));
    if (owner) accountedFor.add(owner.id);
    return !owner;
  });
  const feral: Bug[] = [];
  const harnesses = new Set<VizHarness>(unmatched.map((p) => p.harness));
  for (const harness of harnesses) {
    const candidates = unmatched.filter((p) => p.harness === harness).sort((a, b) => a.elapsedSec - b.elapsedSec || a.pid - b.pid);
    const registered = sessions.filter((s) => s.harness === harness && s.state !== "gone" && !accountedFor.has(s.id)).length;
    for (const proc of candidates.slice(0, Math.max(0, candidates.length - registered))) {
      feral.push({
        id: `proc:${proc.pid}`, name: `${harness}-${proc.pid}`, kind: "feral", harness,
        state: proc.cpu >= WORKING_CPU ? "working" : "idle",
        cwd: null, channels: [], previousNames: [], pid: proc.pid, lastSeen: null,
      });
    }
  }
  return feral.sort(byName);
}

/** Pure projection of daemon sessions, detected processes and the recent feed into the drawn world. */
export function buildWorld(input: WorldInput): World {
  const { sessions, procs, feed, connection, now } = input;
  const human: Bug = {
    id: "human", name: "netrunner", kind: "human", harness: null, state: "idle",
    cwd: null, channels: [], previousNames: [], lastSeen: null,
  };
  const registered: Bug[] = [];
  for (const s of sessions) {
    if (s.state === "gone" && (s.lastSeen === null || now - s.lastSeen > GONE_VISIBLE_MS)) continue;
    const kind: BugKind = s.role === "orchestrator" ? "orchestrator" : "worker";
    registered.push({
      id: s.id, name: s.name, kind, harness: s.harness,
      state: s.state === "gone" ? "dead"
        : s.state === "stale" || s.ping === "not_responding" ? "lost"
        : s.busy === true ? "working" : "idle",
      cwd: s.cwd, channels: [...s.channels], previousNames: [...s.previousNames], lastSeen: s.lastSeen,
      ...(s.role === null ? { unassigned: true as const } : {}),
    });
  }
  const orchestrators = registered.filter((b) => b.kind === "orchestrator").sort(byName);
  const workers = registered.filter((b) => b.kind === "worker").sort(byName);

  const edges: Edge[] = orchestrators.map((o) => ({ from: human.id, to: o.id, via: "human" }));
  for (const worker of workers) {
    const leads = orchestrators.filter((o) => o.channels.some((c) => worker.channels.includes(c)));
    if (leads.length) for (const o of leads) edges.push({ from: o.id, to: worker.id, via: "channel" });
    else edges.push({ from: human.id, to: worker.id, via: "human" });
  }
  const visible = new Set(registered.map((b) => b.id));
  return { bugs: [human, ...orchestrators, ...workers, ...feralBugs(sessions.filter((s) => visible.has(s.id)), procs)], edges, feed, connection };
}
