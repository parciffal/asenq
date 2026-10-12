import type { Harness, Kind, PingStatus, Role } from "../shared/protocol.js";
import type { TerminalFrame } from "../tui/terminal.js";
import type { Appearance } from "./appearance.js";
import type { CharacterAnimator } from "./animate.js";

/** Codex is detectable, but has no registration adapter. */
export type VizHarness = Harness | "codex";
export const VIZ_HARNESSES: readonly VizHarness[] = ["claude", "omp", "opencode", "codex"];

export type CityCharacter = {
  id: string;
  name: string;
  previousNames: string[];
  source: "registered" | "process" | "human";
  harness: VizHarness | null;
  role: Role | null;
  state: "live" | "stale" | "gone" | "removed" | null;
  stale: boolean | null;
  ping: PingStatus | null;
  busy: boolean | null;
  cpu: number | null;
  cwd: string | null;
  /** Authoritative current channel names, not inferred delivery relationships. */
  memberships: string[];
  lastSeen: number | null;
  pid?: number;
};
export type VenueAppearance = "office" | "bar" | "garage" | "arcade" | "communications";
export type CityVenue = {
  /** Immutable within this map lifetime, transferred only by observed rename. */
  key: string;
  name: string;
  appearance: VenueAppearance;
  roster: CityCharacter[];
  postCount: number;
};
export type CityTarget =
  | { kind: "venue"; venueKey: string }
  | { kind: "character"; id: string }
  | { kind: "membership"; id: string; venueKey: string };
export type FeedLine = {
  seq: number;
  at: number;
  fromId: string | null;
  toId: string | null;
  from: string;
  to: string;
  kind: Kind;
  text: string;
  /** Explicit venue target for posts; sourceChannel on a DM is not a post. */
  channel?: string;
  channelTarget?: Extract<CityTarget, { kind: "venue" }>;
};
export type World = {
  characters: CityCharacter[];
  venues: CityVenue[];
  feed: FeedLine[];
  connection: "connected" | "offline";
};
export type Point = { x: number; y: number };
export type Rect = Point & { width: number; height: number };
export type RouteSegment = { from: Point; to: Point; length: number; start: number };
export type RoutePath = { segments: readonly RouteSegment[]; length: number };
export type Packet = {
  seq: number;
  from: CityTarget;
  to: CityTarget;
  kind: Kind;
  ageMs: number;
  path: RoutePath;
};
export type CityRoom = {
  id: string;
  venueKey: string;
  slot: number;
  floor: number;
  rect: Rect;
  anchor: Point;
  canonical: boolean;
};
export type PlacedVenue = {
  venue: CityVenue;
  rect: Rect;
  entrance: Point;
  floors: number;
  rooms: CityRoom[];
};
export type PlacedCharacter = {
  character: CityCharacter;
  rect: Rect;
  anchor: Point;
  /** null denotes its retained public street workstation. */
  home: string | null;
};
export type TargetPosition = {
  target: CityTarget;
  anchor: Point;
  rect: Rect;
  /** Stable allocation order; unaffected by names, filtering or terminal size. */
  order: number;
};
export type CityLayout = {
  venues: PlacedVenue[];
  characters: PlacedCharacter[];
  byVenue: ReadonlyMap<string, PlacedVenue>;
  byCharacter: ReadonlyMap<string, PlacedCharacter>;
  targets: TargetPosition[];
  /** Target key -> orthogonal path from anchor to y=0 street spine. */
  routes: ReadonlyMap<string, RoutePath>;
  bounds: Rect;
  moved: { id: string; from: Point; to: Point }[];
};
export type CityPacket = { seq: number; from: CityTarget; to: CityTarget; kind: Kind; path: RoutePath; senderId: string };
export type CityView = { world: World; layout: CityLayout; appearances: ReadonlyMap<string, Appearance>; notice: string | null };
export type Viewport = { x: number; y: number; zoom: 1 | 2 | 4 };
export type VizUi = {
  selected: CityTarget | null;
  filter: VizHarness | null;
  focus: boolean;
  processes: boolean;
  viewport: Viewport;
  search: boolean;
  query: string;
  results: CityTarget[];
  searchCursor: number;
  inspector: "normal" | "focused";
  inspectorScroll: number;
  follow: false | "session" | "traffic";
  notice: string | null;
};
export type Hit = {
  target: CityTarget;
  column: number;
  row: number;
  width: number;
  height: number;
  /** Inspector entries win over scenery. */
  priority?: number;
};
export type CityRenderContext = {
  appearances: ReadonlyMap<string, Appearance>;
  animator: CharacterAnimator;
  clock: number;
  reducedMotion: boolean;
  color: boolean;
  settingsWarning: string | null;
};
export type SceneResult = {
  frame: TerminalFrame;
  hits: Hit[];
  /** Screen-space city rectangle used to center selection and preserve zoom anchors. */
  cityRegion?: Rect;
  inspectorLength?: number;
};
