import type { Harness, Kind } from "../shared/protocol.js";
import type { TerminalFrame } from "../tui/terminal.js";

/** Harnesses the viz can show; Codex has no asenq adapter, so it only ever appears as a process-detected bug. */
export type VizHarness = Harness | "codex";
export const VIZ_HARNESSES: readonly VizHarness[] = ["claude", "omp", "opencode", "codex"];

/** `human` is the single netrunner node; `feral` bugs are agent processes asenq does not know. */
export type BugKind = "human" | "orchestrator" | "worker" | "feral";

/**
 * working: harness reports busy (or a feral process burns CPU).
 * idle: connected, waiting.
 * lost: registered but stale / not answering pings.
 * dead: session is gone (flatlined).
 */
export type BugState = "working" | "idle" | "lost" | "dead";

export type Bug = {
  /** Stable session id, the literal "human", or `proc:<pid>` for feral bugs. */
  id: string;
  /** Display name: session name, "netrunner" for the human, `<harness>-<pid>` for feral bugs. */
  name: string;
  kind: BugKind;
  /** null only for the human. */
  harness: VizHarness | null;
  state: BugState;
  cwd: string | null;
  /** Session channels; empty for human and feral bugs. */
  channels: string[];
  /** Former names; messages addressed to them reach this bug. */
  previousNames: string[];
  pid?: number;
  /** Registered session with no role set; drawn like a worker but never labelled one. */
  unassigned?: true;
  /** Epoch ms of last harness contact, when known. */
  lastSeen: number | null;
};

/** A persistent link drawn between two bugs. `from` is always the upstream node (human or orchestrator). */
export type Edge = { from: string; to: string; via: "channel" | "human" };

/** One recent message shown in the feed and animated as a packet on the link between its endpoints. */
export type FeedLine = {
  /** Unique, increasing. */
  seq: number;
  at: number;
  fromId: string | null;
  toId: string | null;
  from: string;
  to: string;
  kind: Kind | "chat";
  text: string;
};

export type World = {
  /** Human first, then orchestrators, workers, feral bugs; stable order within each group (by name). */
  bugs: Bug[];
  edges: Edge[];
  /** Newest last, at most 50. */
  feed: FeedLine[];
  connection: "connected" | "offline";
};

/** A message in flight: `ageMs` is time since birth; scene decides how far along the link it is. */
export type Packet = { seq: number; fromId: string; toId: string; kind: FeedLine["kind"]; ageMs: number };

export type Direction = "left" | "right" | "up" | "down" | "next" | "prev";

export type VizUi = {
  selectedId: string | null;
  /** Only bugs of this harness (plus the links they need) are shown; null shows all. The human always stays. */
  filter: VizHarness | null;
  /** Dim everything except the selected bug, its links and its link partners. */
  focus: boolean;
  /** Show feral (process-detected) bugs. */
  feral: boolean;
};

/** Clickable bug rectangle, zero-based screen cells. */
export type Hit = { id: string; column: number; row: number; width: number; height: number };

export type SceneResult = { frame: TerminalFrame; hits: Hit[] };
