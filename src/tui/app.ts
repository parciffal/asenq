import { spawnSync } from "node:child_process";
import { AsenqClient, type ClientOpts } from "../shared/client.js";
import { KINDS } from "../shared/protocol.js";
import type {
  ChannelSummary, HistoryScope, InboxSummary, PositionedEvent, ReadScope, ReadState, SendResult,
  SessionIdentity, StoredMessage, SyncResult,
} from "../shared/protocol.js";
import { renderMessageBody } from "../shared/render.js";
import {
  activitySpans, clipSpans, editorLayout, ellipsize, formatTime, harnessShortName, isImportantEvent, justify, layoutTranscript,
  maxTop, padSpans, paneWidths, stepGrapheme, theme, viewportAt, viewportTop,
  type ActivityFilter, type TranscriptLayout, type Viewport,
} from "./layout.js";
import {
  sanitizeTerminalText, TerminalAdapter, TerminalUnavailableError, terminalTextWidth, wrapTerminalText,
  type KeyInput, type MouseInput, type TerminalAdapterOptions, type TerminalCursor, type TerminalFrame,
  type TerminalLine, type TerminalSize, type TerminalSpan,
} from "./terminal.js";
import { roundedPanel } from "./panel.js";
import { hintSpans } from "./chrome.js";
import { heldBar } from "./held.js";

/** The drawing surface the console needs; `TerminalAdapter` in production, a recorder in tests. */
export interface Screen {
  readonly size: TerminalSize;
  start(): void;
  render(frame: TerminalFrame): void;
  cleanup(): void;
}

export type ConsoleDeps = {
  client?(options: ClientOpts): AsenqClient;
  screen?(options: TerminalAdapterOptions): Screen;
};

const TABS = [["sessions", "Sessions"], ["inbox", "Inbox"], ["channels", "Channels"], ["activity", "Activity"]] as const;
type Tab = typeof TABS[number][0];
type Focus = "tabs" | "list" | "transcript" | "composer";

const ACTION_GROUPS = [
  ["Navigate", ["Sessions", "Inbox", "Channels", "Activity", "Quick jump", "Search sessions", "Toggle archive", "Toggle inbox feed", "Toggle activity filter"]],
  ["Messages", ["Compose / send", "Full editor", "Broadcast", "Mark read", "Mark latest unread", "Read channel", "Post channel", "Log by session or message ID"]],
  ["Held", ["Held messages", "Release held message", "Drop held message"]],
  ["Sessions", ["Rename session", "Inbound policy", "Set role"]],
  ["Channels", ["Create channel", "Add channel member", "Remove channel member"]],
  ["Daemon", ["Daemon status", "Daemon start", "Daemon stop", "Reconnect", "Setup", "Remove setup", "Doctor"]],
  ["Help", ["Help", "Error details", "Quit"]],
] as const;
type Action = typeof ACTION_GROUPS[number][1][number];
const ACTIONS: { group: string; label: Action }[] = ACTION_GROUPS.flatMap(([group, labels]) =>
  labels.map((label: Action) => ({ group, label })));
const SHORTCUTS: Partial<Record<Action, string>> = {
  Sessions: "s", Inbox: "i", Channels: "#", Activity: "a", "Quick jump": "Ctrl+K", "Search sessions": "/", "Toggle inbox feed": "v",
  "Toggle activity filter": "f", "Compose / send": "c", "Full editor": "Ctrl+E", "Mark read": "End",
  "Mark latest unread": "u", Help: "?", Quit: "q",
};

const HELP = [
  "asenq TUI",
  "",
  "Tabs: s Sessions · i Inbox · # Channels · a Activity. Tab / Shift+Tab move focus between tabs, list, conversation and composer.",
  "List: ↑↓ move · Enter open · / search current and former session names · Enter on Archive expands it.",
  "Ctrl+K: quick-jump from anywhere to a session (including former names and archives) or #channel. Type an ordered subsequence · ↑↓ choose · Enter open · Esc returns with your draft.",
  "Channels: member rows stay in the channel conversation; use ? to create channels or add/remove members. Removal targets the selected member's stable identity.",
  "Conversation: ↑↓ select messages (long ones scroll) · Enter shows message details · PgUp/PgDn scroll · End jumps to the latest. An open conversation is read once its newest incoming message is on screen · u marks the latest item unread again.",
  "Composer: c to write · Enter sends · Shift+Enter (or Alt+Enter / Ctrl+J) inserts a newline · Ctrl+E full editor with kind/thread/reply/done · Esc leaves it (the draft is kept).",
  "Inbox: v switches between grouped senders and the chronological feed. Activity: f shows read-marker events too; Enter opens the conversation.",
  "? opens this action palette; type to filter. Esc dismisses errors, closes panels and returns to Sessions. q quits.",
  "CLI commands remain available in another terminal.",
];

type Stream = {
  messages: StoredMessage[];
  hasMore: boolean;
  loading: boolean;
  loaded: boolean;
  viewport: Viewport;
  selectedId?: string;
  expanded: Set<string>;
};
type Binding = { id: string; name: string; edited: boolean };
type Field = { label: string; value: string; multiline?: boolean };
type Form = {
  title: string;
  description?: string[];
  fields: Field[];
  focus: number;
  submit(values: string[]): Promise<void>;
  /** Stable session target of a compose form; editing the first field unbinds it. */
  binding?: Binding;
  /** Where field 1 (the text) is kept as a draft while editing. */
  draftKey?(form: Form): string;
};
type Panel = { title: string; lines?: string[]; messages?: StoredMessage[]; top: number; height: number; rows: number };
type Notice = { text: string; kind: "info" | "new" | "error"; until?: number };
type Target =
  | { kind: "tab"; tab: Tab }
  | { kind: "entry"; key: string }
  | { kind: "message"; id: string }
  | { kind: "palette"; index: number }
  | { kind: "finder"; key: string }
  | { kind: "field"; index: number }
  | { kind: "composer" }
  | { kind: "picker" }
  | { kind: "list" }
  | { kind: "transcript" };
type Hit = { row: number; start: number; end: number; target: Target };
type Entry = { key?: string; rows(width: number, selected: boolean, focused: boolean): TerminalLine[] };
type Shown = { key: string; layout: TranscriptLayout; top: number; height: number };
type ComposeTarget = { kind: "session"; id: string; name: string } | { kind: "channel"; name: string };
type Pane = { rows: TerminalLine[]; cursor?: TerminalCursor };
type JumpItem = { key: string; name: string; former?: string; session?: SessionIdentity; rank: number; state: number };

/** Shift+Enter where the terminal reports it; Alt+Enter and Ctrl+J (iTerm's Shift+Enter) elsewhere. */
const NEWLINE_KEYS: Record<string, true> = { SHIFT_ENTER: true, ALT_ENTER: true, CTRL_J: true };
const stringify = (e: unknown): string => e instanceof Error ? e.message : String(e);
const keyOf = (scope: HistoryScope): string =>
  scope.scope === "session" ? `s:${scope.sessionId}` : scope.scope === "channel" ? `c:${scope.channel}` : "inbox";
const senderKey = (m: { fromSessionId?: string; from: string }): string =>
  m.fromSessionId ? `i:${m.fromSessionId}` : `i:n:${m.from}`;
const cleanInput = (text: string): string =>
  sanitizeTerminalText(text.replace(/\r\n?/g, "\n"), { multiline: true });

/** Exact and prefix matches precede case-insensitive ordered subsequences. */
const jumpRank = (name: string, query: string): number => {
  const value = name.toLowerCase();
  if (!query || value === query) return 0;
  if (value.startsWith(query)) return 1;
  let offset = 0;
  for (const character of query) {
    const index = value.indexOf(character, offset);
    if (index < 0) return Infinity;
    offset = index + character.length;
  }
  return 2;
};

export class ConsoleApp {
  private readonly screen: Screen;
  private readonly client: AsenqClient;
  private sessions: SessionIdentity[] = [];
  private sessionOrders: Record<string, number> = {};
  private channels: ChannelSummary[] = [];
  private summaries: InboxSummary[] = [];
  private readStates = new Map<string, ReadState>();
  private heldMessages = new Map<string, StoredMessage>();
  private shownHeldId?: string;
  private heldActionPending = false;
  private heldDirty = false;
  private streams = new Map<string, Stream>();
  private activity: PositionedEvent[] = [];
  private activityFilter: ActivityFilter = "important";
  private tab: Tab = "sessions";
  private focus: Focus = "list";
  private selection: Record<Tab, string | undefined> = { sessions: undefined, inbox: undefined, channels: undefined, activity: undefined };
  private listTop: Record<Tab, number> = { sessions: 0, inbox: 0, channels: 0, activity: 0 };
  private followActivity = true;
  private archiveOpen = false;
  private query = "";
  private searching = false;
  private inboxFeed = false;
  private panel?: Panel;
  private form?: Form;
  private palette?: { query: string; selected: number; top: number };
  private finder?: { query: string; selected?: string; top: number };
  private notice?: Notice;
  private noticeTimer?: NodeJS.Timeout;
  private errorDetail = "";
  private drafts = new Map<string, string>();
  private cursor = 0;
  private cursorKey = "";
  private sending = false;
  private hits: Hit[] = [];
  private shown?: Shown;
  private connection: "connecting" | "connected" | "offline" = "connecting";
  private watermark = 0;
  private pushedPosition = 0;
  private syncing = false;
  private replaying = false;
  private resync = false;
  private closed = false;
  private tasks = new Set<Promise<unknown>>();
  /** Stream whose `u` reminder must survive until the user scrolls, presses End or reopens it. */
  private readHold?: string;
  private reading = false;
  private resolve?: (code: number) => void;

  constructor(deps: ConsoleDeps = {}) {
    const clientOptions: ClientOpts = {
      autoStart: true,
      onPush: (p) => {
        if (p.push !== "event") return;
        this.pushedPosition = Math.max(this.pushedPosition, p.position);
        if (p.position > this.watermark) this.track(this.replay());
      },
      onReconnect: async () => { await this.hydrate(); },
    };
    this.client = deps.client ? deps.client(clientOptions) : new AsenqClient(clientOptions);
    const screenOptions: TerminalAdapterOptions = {
      onKey: (k) => this.track(this.key(k)),
      onMouse: (m) => this.track(this.mouse(m)),
      onResize: () => this.render(),
      onPaste: (text) => { this.paste(text); this.render(); },
      onInterrupt: () => this.quit(),
    };
    this.screen = deps.screen ? deps.screen(screenOptions) : new TerminalAdapter(screenOptions);
  }

  async run(): Promise<number> {
    try {
      this.screen.start();
    } catch (e) {
      if (!(e instanceof TerminalUnavailableError)) throw e;
      process.stderr.write("asenq tui requires a usable terminal (TTY); use asenq commands without one\n");
      return 1;
    }
    const done = new Promise<number>((resolve) => { this.resolve = resolve; });
    this.render();
    this.track(this.hydrate());
    return done;
  }

  /** Resolves once every in-flight key, mouse, sync and replay task has settled (test seam). */
  async idle(): Promise<void> {
    while (this.tasks.size) await Promise.allSettled([...this.tasks]);
  }

  private track(task: Promise<unknown>): void {
    const tracked = task.catch((e) => this.fail(e)).finally(() => this.tasks.delete(tracked));
    this.tasks.add(tracked);
  }

  private quit(code = 0): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.noticeTimer);
    this.client.close();
    this.screen.cleanup();
    this.resolve?.(code);
  }

  // ------------------------------------------------------------------ notices

  private say(text: string, kind: Notice["kind"] = "info"): void {
    clearTimeout(this.noticeTimer);
    if (kind === "error") {
      this.errorDetail = text;
      this.notice = { text, kind };
      return;
    }
    if (this.notice?.kind === "error") return; // a failure stays until dismissed or resolved
    this.notice = { text, kind, until: Date.now() + 6000 };
    this.noticeTimer = setTimeout(() => {
      if (this.notice?.kind !== "error") this.notice = undefined;
      this.render();
    }, 6000);
    this.noticeTimer.unref?.();
  }

  private fail(e: unknown): void {
    this.say(stringify(e), "error");
    this.render();
  }

  // ------------------------------------------------------------------ data

  private scope(): HistoryScope | undefined {
    const selected = this.selection[this.tab];
    if (this.tab === "sessions") return selected?.startsWith("s:") ? { scope: "session", sessionId: selected.slice(2) } : undefined;
    if (this.tab === "inbox") {
      if (this.inboxFeed || !selected) return { scope: "inbox" };
      return selected.startsWith("i:n:") ? { scope: "inbox" } : { scope: "session", sessionId: selected.slice(2) };
    }
    if (this.tab === "channels") {
      const channel = this.selectedChannel();
      return channel ? { scope: "channel", channel } : undefined;
    }
    return undefined;
  }

  private selectedChannel(): string | undefined {
    const key = this.selection.channels;
    return key?.startsWith("m:") ? key.slice(2, key.indexOf(":", 2)) : key?.slice(2);
  }

  private selectedChannelMember(): string | undefined {
    const key = this.selection.channels;
    return key?.startsWith("m:") ? key.slice(key.indexOf(":", 2) + 1) : undefined;
  }

  private readScope(): ReadScope | undefined {
    const scope = this.scope();
    return scope && scope.scope !== "inbox" ? scope : undefined;
  }

  private session(id: string): SessionIdentity | undefined {
    return this.sessions.find((s) => s.id === id);
  }

  private eligible(scope: ReadScope, m: StoredMessage): boolean {
    return scope.scope === "channel"
      ? m.channel === scope.channel && m.from !== "human"
      : !m.channel && m.fromSessionId === scope.sessionId && m.to === "human";
  }

  private composeTarget(): ComposeTarget | undefined {
    if (this.connection !== "connected") return undefined;
    const scope = this.scope();
    if (scope?.scope === "channel") return { kind: "channel", name: scope.channel };
    if (scope?.scope !== "session") return undefined;
    const session = this.session(scope.sessionId);
    return session && session.state !== "removed" ? { kind: "session", id: session.id, name: session.name } : undefined;
  }

  private draftKey(target: ComposeTarget): string {
    return target.kind === "session" ? `session:${target.id}` : `channel:${target.name}`;
  }

  /** Selects the oldest incoming held message by durable target identity, independent of names. */
  private heldForSession(sessionId: string): { message: StoredMessage; count: number } | undefined {
    let message: StoredMessage | undefined;
    let count = 0;
    for (const held of this.heldMessages.values()) {
      if (held.toSessionId !== sessionId) continue;
      count++;
      if (!message || held.order < message.order) message = held;
    }
    return message ? { message, count } : undefined;
  }

  /** Replaces held state from the authoritative operation, including transitions missed by replay. */
  private async refreshHeld(): Promise<void> {
    const held = await this.client.request("held");
    this.heldMessages = new Map((held.messages as StoredMessage[]).map((m) => [m.id, m]));
    this.heldDirty = false;
  }

  private async hydrate(): Promise<void> {
    if (this.closed || this.syncing) return;
    this.syncing = true;
    try {
      const previous = this.watermark;
      const snapshot = await this.client.sync();
      const [summaries, events] = await Promise.all([
        this.client.inboxSummaries(), this.client.recentEvents(), this.refreshHeld(),
      ]);
      this.applySnapshot(snapshot);
      this.summaries = summaries;
      this.activity = events;
      if (previous) this.watermark = previous; // replay missed events before trusting the new watermark
      this.connection = "connected";
      if (this.notice?.kind === "error" && this.notice.text.startsWith("Disconnected")) this.notice = undefined;
      this.ensureSelection();
      const scope = this.scope();
      if (scope) await this.load(scope);
    } catch (e) {
      this.connection = "offline";
      this.say(`Disconnected: ${stringify(e)} · ? → Doctor / Daemon start / Reconnect`, "error");
    } finally {
      this.syncing = false;
      this.render();
      if (this.connection === "connected") void this.replay();
    }
  }

  private applySnapshot(s: SyncResult): void {
    this.sessions = s.sessions;
    this.sessionOrders = { ...s.sessionLastOrders };
    this.channels = s.channels;
    this.readStates = new Map(s.readStates.map((r) => [keyOf(r.scope), r]));
    this.watermark = s.watermark;
  }

  private async replay(): Promise<void> {
    if (this.closed || this.replaying || this.syncing) return;
    this.replaying = true;
    try {
      for (;;) {
        const r = await this.client.replay(this.watermark);
        if (r.gap) {
          this.say("History gap: retained events were pruned; reloading the snapshot. Older missing changes cannot be recovered.");
          this.resync = true;
          break;
        }
        for (const event of r.events) {
          this.watermark = Math.max(this.watermark, event.position);
          this.applyEvent(event);
        }
        if (!r.hasMore) break;
      }
      // Refresh only after relevant replay transitions; the held op is authoritative even
      // when a hold and its release both occurred between snapshots.
      if (this.heldDirty && !this.resync) await this.refreshHeld();
    } catch (e) {
      this.connection = "offline";
      this.say(`Disconnected: ${stringify(e)} · reconnecting`, "error");
    } finally {
      this.replaying = false;
      this.ensureSelection();
      this.render();
      if (this.resync) {
        this.resync = false;
        this.streams.clear();
        this.watermark = 0;
        await this.hydrate();
      } else if (this.connection === "connected" && this.pushedPosition > this.watermark) await this.replay();
    }
  }

  private applyEvent(item: PositionedEvent): void {
    if (!this.activity.length || item.position > this.activity.at(-1)!.position) {
      this.activity.push(item);
      if (this.activity.length > 200) this.activity.shift();
    }
    const e = item.event;
    if (e.type === "message") {
      if (e.status === "held" || this.heldMessages.has(e.msg.id)) this.heldDirty = true;
      const m: StoredMessage = { ...e.msg, status: e.status, ...(e.reason ? { reason: e.reason } : {}) };
      if (!e.reason) delete m.reason;
      if (!m.channel) {
        for (const id of [m.fromSessionId, m.toSessionId]) {
          if (id) this.sessionOrders[id] = Math.max(this.sessionOrders[id] ?? 0, m.order);
        }
      }
      for (const [key, stream] of this.streams) {
        const matches = m.channel
          ? key === `c:${m.channel}`
          : key === `s:${m.fromSessionId}` || key === `s:${m.toSessionId}` || (key === "inbox" && m.to === "human");
        if (!matches || !stream.loaded) continue;
        const index = stream.messages.findIndex((x) => x.id === m.id);
        if (index >= 0) stream.messages[index] = m;
        else if (!stream.hasMore || !stream.messages.length || m.order > stream.messages[0].order) {
          stream.messages.push(m);
          stream.messages.sort((a, b) => a.order - b.order);
        }
      }
      if (!m.channel && m.to === "human" && m.from !== "human") {
        const key = senderKey(m);
        const index = this.summaries.findIndex((s) => senderKey(s.latest) === key);
        const name = (m.fromSessionId && this.session(m.fromSessionId)?.name) || m.from;
        const summary: InboxSummary = { ...(m.fromSessionId ? { sessionId: m.fromSessionId } : {}), name, latest: m };
        if (index < 0) this.summaries.push(summary);
        else if (this.summaries[index].latest.order <= m.order) this.summaries[index] = summary;
        this.summaries.sort((a, b) => b.latest.order - a.latest.order);
      }
      if (m.channel && e.status === "posted") {
        const channel = this.channels.find((c) => c.name === m.channel);
        if (channel && m.order > channel.lastOrder) Object.assign(channel, { count: channel.count + 1, lastAt: m.createdAt, lastOrder: m.order });
        else if (!channel) this.channels.push({ name: m.channel, count: 1, lastAt: m.createdAt, lastOrder: m.order, memberIds: [] });
        this.channels.sort((a, b) => b.lastOrder - a.lastOrder);
      }
      const incoming = m.from !== "human" && (m.channel !== undefined || m.to === "human");
      if (incoming && e.status === "posted") {
        const key = m.channel ? `c:${m.channel}` : `s:${m.fromSessionId}`;
        const current = this.scope();
        const watching = current && keyOf(current) === key && this.streams.get(key)?.viewport.follow;
        if (!watching) this.say(m.channel ? `New post in #${m.channel} from ${m.from}` : `New message from ${m.from}`, "new");
      }
    } else if (e.type === "read") {
      this.readStates.set(keyOf(e.state.scope), e.state);
    } else if (e.type === "channel") {
      const index = this.channels.findIndex((c) => c.name === e.channel.name);
      if (index >= 0) this.channels[index] = e.channel;
      else this.channels.push(e.channel);
      this.channels.sort((a, b) => b.lastOrder - a.lastOrder || a.name.localeCompare(b.name));
    } else if (e.type === "session") {
      const index = this.sessions.findIndex((s) => s.id === e.session.id);
      if (index >= 0) this.sessions[index] = e.session;
      else this.sessions.push(e.session);
      for (const summary of this.summaries) if (summary.sessionId === e.session.id) summary.name = e.session.name;
    } else if (e.type === "retention") {
      this.resync = true;
    }
    if (this.tab === "activity" && this.followActivity) this.selection.activity = undefined;
  }

  private async load(scope: HistoryScope, older = false): Promise<void> {
    const key = keyOf(scope);
    const current = this.streams.get(key) ?? {
      messages: [], hasMore: false, loading: false, loaded: false, viewport: { follow: true }, expanded: new Set<string>(),
    };
    if (current.loading || (older && !current.hasMore) || (!older && current.loaded)) return;
    current.loading = true;
    this.streams.set(key, current);
    this.render();
    try {
      const before = older ? current.messages[0]?.order : undefined;
      const page = await this.client.historyPage({ ...scope, ...(before === undefined ? {} : { before }), limit: 60 });
      const prior = new Set(current.messages.map((m) => m.id));
      current.messages = [...page.messages.filter((m) => !prior.has(m.id)), ...current.messages].sort((a, b) => a.order - b.order);
      current.hasMore = page.hasMore;
      current.loaded = true;
    } catch (e) {
      this.say(`History: ${stringify(e)}`, "error");
    } finally {
      current.loading = false;
      this.render();
    }
  }

  // ------------------------------------------------------------------ lists

  private stateLabel(s: SessionIdentity): TerminalSpan {
    if (s.state === "live") return { text: "live", style: theme.ok };
    if (s.state === "gone") return { text: "gone", style: theme.warn };
    return { text: "archived", style: theme.dim };
  }

  /** Unread badge: compact `+N · ` in lists, `N unread · ` in titles; `!` marks a reminder. */
  private unreadSpans(key: string, long = false): TerminalSpan[] {
    const state = this.readStates.get(key);
    if (!state?.unread) return [];
    const reminder = state.reminder !== null ? "!" : "";
    return [{ text: long ? `${state.unread} unread${reminder} · ` : `+${state.unread}${reminder} · `, style: theme.unread }];
  }

  private marker(selected: boolean): TerminalSpan {
    return { text: selected ? "› " : "  ", style: theme.accentBold };
  }

  private entries(tab: Tab): Entry[] {
    const heading = (text: string): Entry => ({ rows: (width) => [[{ text: ellipsize(text, width), style: theme.accent }]] });
    const pick = (selected: boolean, focused: boolean) => selected && focused ? theme.selected : undefined;
    if (tab === "sessions") {
      const q = this.query.toLowerCase();
      const orders = this.sessionOrders;
      const matching = this.sessions
        .filter((s) => !q || s.name.includes(q) || s.previousNames.some((name) => name.includes(q)))
        .sort((a, b) => (orders[b.id] ?? 0) - (orders[a.id] ?? 0) || b.createdAt - a.createdAt || a.id.localeCompare(b.id));
      const row = (s: SessionIdentity): Entry => ({
        key: `s:${s.id}`,
        rows: (width, selected, focused) => {
          const unread = (this.readStates.get(`s:${s.id}`)?.unread ?? 0) > 0;
          const former = q && !s.name.includes(q) ? s.previousNames.find((name) => name.includes(q)) : undefined;
          const right = [...this.unreadSpans(`s:${s.id}`), this.stateLabel(s)];
          const left = [this.marker(selected), { text: s.name, style: unread ? theme.bold : {} }, ...(former ? [{ text: ` was ${former}`, style: theme.dim }] : [])];
          const role = s.role === "orchestrator" ? "orch" : s.role === "worker" ? "wrk" : "";
          const statusWidth = right.reduce((sum, span) => sum + terminalTextWidth(span.text), 0);
          const roleFits = width - statusWidth - role.length - 2 >= 2 + Math.min(2, terminalTextWidth(s.name));
          if (role && roleFits) right.unshift({ text: `${role} ` });
          const labelWidth = left.reduce((sum, span) => sum + terminalTextWidth(span.text), 0);
          // Harness metadata yields before names, roles and unread/state indicators.
          const harnessWidth = Math.max(0, width - right.reduce((sum, span) => sum + terminalTextWidth(span.text), 0) - labelWidth - 2);
          const harness = ellipsize(harnessShortName(s.harness), harnessWidth);
          if (harness) right.unshift({ text: `${harness} `, style: theme.dim });
          return [justify(
            left,
            right,
            width, pick(selected, focused),
          )];
        },
      });
      const live = matching.filter((s) => s.state === "live");
      const gone = matching.filter((s) => s.state === "gone");
      const archived = matching.filter((s) => s.state === "removed");
      const result: Entry[] = [];
      if (live.length) result.push(heading(`Live ${live.length}`), ...live.map(row));
      if (gone.length) result.push(heading(`Reconnecting ${gone.length}`), ...gone.map(row));
      if (archived.length) {
        const open = this.archiveOpen || q !== "";
        result.push({
          key: "archive",
          rows: (width, selected, focused) => [justify(
            [this.marker(selected), { text: `${open ? "▾" : "▸"} Archive`, style: theme.accent }],
            [{ text: `${archived.length}`, style: theme.dim }], width, pick(selected, focused),
          )],
        });
        if (open) result.push(...archived.map(row));
      }
      return result;
    }
    if (tab === "inbox") {
      return this.summaries.map((summary) => {
        const key = summary.sessionId ? `i:${summary.sessionId}` : `i:n:${summary.name}`;
        return {
          key,
          rows: (width, selected, focused) => {
            const unreadKey = summary.sessionId ? `s:${summary.sessionId}` : "";
            const preview = sanitizeTerminalText(renderMessageBody(summary.latest));
            return [
              justify(
                [this.marker(selected), { text: summary.name, style: theme.agent }, ...(summary.sessionId ? [] : [{ text: " legacy", style: theme.dim }])],
                [...this.unreadSpans(unreadKey), { text: formatTime(summary.latest.createdAt, Date.now(), true), style: theme.dim }],
                width, pick(selected, focused),
              ),
              padSpans([{ text: "  " }, { text: ellipsize(preview, Math.max(0, width - 2)), style: theme.dim }], width, pick(selected, focused)),
            ];
          },
        };
      });
    }
    if (tab === "channels") {
      return this.channels.flatMap((channel): Entry[] => [
        {
          key: `c:${channel.name}`,
          rows: (width, selected, focused) => [justify(
            [this.marker(selected), { text: `#${channel.name}`, style: theme.accentBold }],
            this.unreadSpans(`c:${channel.name}`).map((span) => ({ ...span, text: span.text.replace(/ · $/, "") })),
            width, pick(selected, focused),
          )],
        },
        ...(channel.memberIds ?? []).flatMap((id): Entry[] => {
          const member = this.session(id);
          if (!member) return [];
          return [{
            key: `m:${channel.name}:${id}`,
            rows: (width, selected, focused) => {
              const role = member.role === "orchestrator" ? "orch" : member.role === "worker" ? "wrk" : "unset";
              const detail = [{ text: `${role} `, style: theme.dim }, this.stateLabel(member)];
              const label = [this.marker(selected), { text: "  " }, { text: member.name, style: theme.agent }];
              const detailWidth = detail.reduce((sum, span) => sum + terminalTextWidth(span.text), 0);
              const fill = pick(selected, focused);
              if (width < 4 + Math.min(2, terminalTextWidth(member.name)) + 1 + detailWidth) {
                return [padSpans(label, width, fill), padSpans([{ text: "    " }, ...detail], width, fill)];
              }
              return [justify(label, detail, width, fill)];
            },
          }];
        }),
      ]);
    }
    const names = (id: string): string | undefined => this.session(id)?.name;
    return this.activity
      .filter((item) => this.activityFilter === "all" || isImportantEvent(item))
      .map((item) => ({
        key: `e:${item.position}`,
        rows: (width, selected, focused) => [padSpans(
          [this.marker(selected), ...activitySpans(item, names)], width, pick(selected, focused),
        )],
      }));
  }

  private selectable(tab: Tab): string[] {
    return this.entries(tab).flatMap((entry) => entry.key ? [entry.key] : []);
  }

  private ensureSelection(): void {
    for (const [tab] of TABS) {
      const keys = this.selectable(tab);
      const current = this.selection[tab];
      if (tab === "activity") {
        if (current && !keys.includes(current)) this.selection.activity = undefined;
        continue;
      }
      if (!current || !keys.includes(current)) {
        // Keep an archived selection that the collapsed archive merely hides.
        if (tab === "sessions" && current?.startsWith("s:") && this.session(current.slice(2))) continue;
        if (tab === "channels" && current?.startsWith("m:")) {
          const channelKey = `c:${this.selectedChannel()}`;
          if (keys.includes(channelKey)) {
            this.selection.channels = channelKey;
            continue;
          }
        }
        this.selection[tab] = keys.find((key) => key !== "archive") ?? keys[0];
      }
    }
  }

  private selectedActivity(): string | undefined {
    return this.selection.activity ?? this.selectable("activity").at(-1);
  }

  private async moveSelection(delta: number): Promise<void> {
    const keys = this.selectable(this.tab);
    if (!keys.length) return;
    const current = this.tab === "activity" ? this.selectedActivity() : this.selection[this.tab];
    const index = current ? keys.indexOf(current) : -1;
    const next = Math.max(0, Math.min(keys.length - 1, index < 0 ? (delta > 0 ? 0 : keys.length - 1) : index + delta));
    this.selection[this.tab] = keys[next];
    if (this.tab === "activity") this.followActivity = next === keys.length - 1;
    await this.opened();
  }

  /** Loads the newly selected conversation; selection never marks anything read. */
  private async opened(): Promise<void> {
    this.panel = undefined;
    this.render();
    const scope = this.scope();
    if (scope) await this.load(scope);
  }

  private async setTab(tab: Tab): Promise<void> {
    this.tab = tab;
    this.searching = false;
    this.panel = undefined;
    if (this.focus !== "tabs") this.focus = "list";
    this.ensureSelection();
    await this.opened();
  }

  private async openEntry(): Promise<void> {
    if (this.tab === "sessions" && this.selection.sessions === "archive") {
      this.archiveOpen = !this.archiveOpen;
      this.render();
      return;
    }
    if (this.tab === "activity") return this.openActivity();
    this.readHold = undefined;
    this.focus = "transcript";
    await this.opened();
  }

  private async openActivity(): Promise<void> {
    const key = this.selectedActivity();
    const item = this.activity.find((entry) => `e:${entry.position}` === key);
    if (!item) return;
    const e = item.event;
    let sessionId: string | undefined;
    if (e.type === "channel") {
      this.selection.channels = `c:${e.channel.name}`;
      await this.setTab("channels");
      this.focus = "transcript";
      return this.render();
    }
    if (e.type === "message") {
      if (e.msg.channel) {
        this.selection.channels = `c:${e.msg.channel}`;
        await this.setTab("channels");
        this.focus = "transcript";
        return this.render();
      }
      sessionId = e.msg.from === "human" ? e.msg.toSessionId : e.msg.fromSessionId ?? e.msg.toSessionId;
    } else if (e.type === "session") sessionId = e.session.id;
    else if (e.type === "read") sessionId = e.state.scope.scope === "session" ? e.state.scope.sessionId : undefined;
    const session = sessionId && this.session(sessionId);
    if (!session) {
      this.say("That event has no retained conversation to open.");
      return this.render();
    }
    if (session.state === "removed") this.archiveOpen = true;
    this.query = "";
    this.selection.sessions = `s:${session.id}`;
    await this.setTab("sessions");
    this.focus = "transcript";
    this.render();
  }

  // ------------------------------------------------------------------ quick jump

  private jumpItems(): JumpItem[] {
    const query = (this.finder?.query ?? "").toLowerCase();
    const items: JumpItem[] = [];
    if (!query.startsWith("#")) {
      for (const session of this.sessions) {
        let rank = jumpRank(session.name, query);
        let former: string | undefined;
        for (const name of session.previousNames) {
          const previousRank = jumpRank(name, query);
          if (previousRank < rank) {
            rank = previousRank;
            former = name;
          }
        }
        if (rank !== Infinity) items.push({
          key: `s:${session.id}`, name: session.name, session, rank,
          state: session.state === "live" ? 0 : session.state === "gone" ? 1 : 2,
          ...(former ? { former } : {}),
        });
      }
    }
    const channelQuery = query.startsWith("#") ? query.slice(1) : query;
    for (const channel of this.channels) {
      const rank = jumpRank(channel.name, channelQuery);
      if (rank !== Infinity) items.push({ key: `c:${channel.name}`, name: channel.name, rank, state: 0 });
    }
    return items.sort((a, b) => a.rank - b.rank || a.state - b.state
      || Number(!a.session) - Number(!b.session)
      || a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
  }

  private openFinder(): void {
    if (!this.finder) this.finder = { query: "", top: 0 };
    this.render();
  }

  private finderIndex(items: JumpItem[]): number {
    const finder = this.finder!;
    const index = Math.max(0, items.findIndex((item) => item.key === finder.selected));
    finder.selected = items[index]?.key;
    return index;
  }

  private async jumpTo(key: string): Promise<void> {
    const item = this.jumpItems().find((entry) => entry.key === key);
    if (!item) return this.render();
    if (this.form) this.syncFormDraft(this.form);
    this.finder = undefined;
    this.form = undefined;
    this.palette = undefined;
    this.panel = undefined;
    this.searching = false;
    this.query = "";
    this.readHold = undefined;
    this.tab = item.session ? "sessions" : "channels";
    this.selection[this.tab] = item.key;
    if (item.session?.state === "removed") this.archiveOpen = true;
    this.focus = "transcript";
    await this.opened();
  }

  private async finderKey(k: KeyInput): Promise<void> {
    const finder = this.finder!;
    const items = this.jumpItems();
    const selected = this.finderIndex(items);
    if (k.name === "ESCAPE") this.finder = undefined;
    else if (k.name === "UP" || k.name === "DOWN") {
      const index = Math.max(0, Math.min(items.length - 1, selected + (k.name === "UP" ? -1 : 1)));
      finder.selected = items[index]?.key;
    } else if (k.name === "ENTER" || k.name === "KP_ENTER") {
      const item = items[selected];
      if (item) return this.jumpTo(item.key);
    } else if (k.name === "BACKSPACE" || k.name === "CTRL_U") {
      finder.query = k.name === "CTRL_U" ? "" : finder.query.slice(0, stepGrapheme(finder.query, finder.query.length, -1));
      finder.selected = undefined;
      finder.top = 0;
    } else if (k.text && !k.ctrl) {
      finder.query += cleanInput(k.text).replace(/\n/g, " ");
      finder.selected = undefined;
      finder.top = 0;
    }
    this.render();
  }

  private finderPane(width: number, height: number, y0: number): Pane {
    const finder = this.finder!;
    const items = this.jumpItems();
    const selectedIndex = this.finderIndex(items);
    const boxed = width >= 6 && height >= 4;
    const inset = boxed ? 1 : 0;
    const innerWidth = Math.max(0, width - 2 * inset);
    const innerHeight = height - 2 * inset;
    const title: TerminalLine = [{ text: "Quick jump", style: theme.accentBold }];
    const rows: TerminalLine[] = !boxed && innerHeight >= 2 ? [clipSpans(title, innerWidth)] : [];
    const queryRow = rows.length;
    const prompt = innerWidth >= 3 ? "› " : "";
    const promptWidth = terminalTextWidth(prompt);
    const query = editorLayout(finder.query, finder.query.length, Math.max(1, innerWidth - promptWidth));
    rows.push(clipSpans([
      { text: prompt, style: theme.accentBold },
      { text: query.rows[query.cursorRow] },
    ], innerWidth));
    const available = Math.max(0, innerHeight - rows.length);
    if (selectedIndex < finder.top) finder.top = selectedIndex;
    if (selectedIndex >= finder.top + available) finder.top = selectedIndex - available + 1;
    finder.top = Math.max(0, Math.min(finder.top, items.length - available));
    if (!items.length && available) rows.push(clipSpans([{ text: "No matching sessions or channels", style: theme.dim }], innerWidth));
    for (let index = finder.top; index < Math.min(items.length, finder.top + available); index++) {
      const item = items[index];
      const selected = item.key === finder.selected;
      const left: TerminalSpan[] = [
        this.marker(selected),
        { text: item.session ? item.name : `#${item.name}`, style: selected ? theme.accentBold : theme.bold },
        ...(item.former ? [{ text: ` was ${item.former}`, style: theme.dim }] : []),
      ];
      const right: TerminalSpan[] = item.session
        ? [{ text: item.session.state === "gone" ? "reconnecting" : item.session.state === "live" ? "live" : "archived", style: this.stateLabel(item.session).style }]
        : [{ text: "channel", style: theme.dim }];
      this.hits.push({ row: y0 + inset + rows.length, start: inset, end: width - inset, target: { kind: "finder", key: item.key } });
      rows.push(justify(left, right, innerWidth, selected ? theme.selected : undefined));
    }
    const cursor = width > 0 ? {
      row: y0 + inset + queryRow,
      column: inset + Math.max(0, Math.min(innerWidth - 1, promptWidth + query.cursorColumn)),
    } : undefined;
    return {
      rows: boxed ? roundedPanel(title, rows, width, height, true) : rows,
      ...(cursor ? { cursor } : {}),
    };
  }

  // ------------------------------------------------------------------ rendering

  private render(): void {
    if (this.closed) return;
    const { columns: width, rows: height } = this.screen.size;
    this.hits = [];
    this.shown = undefined;
    this.shownHeldId = undefined;
    const top = height >= 4 ? 1 : 0;
    const bottom = height >= 2 ? 1 : 0;
    const bodyHeight = Math.max(0, height - top - bottom);
    const lines: TerminalLine[] = [];
    if (top) lines.push(this.tabBar(width));
    if (this.finder) this.hits = []; // visible tabs are inert while the finder owns input
    const body = this.body(width, bodyHeight, top);
    lines.push(...body.rows);
    if (bottom) lines.push(this.footer(width));
    this.screen.render({ lines, ...(body.cursor ? { cursor: body.cursor } : {}) });
    const shown = this.shown as Shown | undefined; // assigned while laying out the body
    const engaged = this.focus === "transcript" || this.focus === "composer";
    if (shown && engaged && this.readStates.get(shown.key)?.unread && !this.reading && this.readHold !== shown.key) {
      this.track(this.readIfReached());
    }
  }

  private tabBar(width: number): TerminalLine {
    let inboxUnread = 0;
    let channelUnread = 0;
    for (const [key, state] of this.readStates) {
      if (key.startsWith("s:")) inboxUnread += state.unread;
      if (key.startsWith("c:")) channelUnread += state.unread;
    }
    // One entry per counter: adding another does not change the fitting or hit logic.
    const counters = [
      { count: this.sessions.filter((s) => s.state === "live").length, label: "live", short: "L", style: theme.dim },
      { count: this.sessions.filter((s) => s.state === "gone").length, label: "reconnecting", short: "R", style: theme.warn },
      { count: this.heldMessages.size, label: "held", short: "H", style: theme.warn },
      { count: inboxUnread + channelUnread, label: "unread", short: "U", style: theme.unread },
    ];
    const connection: TerminalSpan = this.connection === "connected"
      ? { text: "● connected", style: theme.ok }
      : this.connection === "offline" ? { text: "○ offline", style: theme.bad } : { text: "◌ connecting", style: theme.warn };
    const used = (spans: TerminalSpan[]): number => spans.reduce((sum, span) => sum + terminalTextWidth(span.text), 0);
    type Fit = { labels: "full" | "active" | "short" | "minimal"; brand: boolean; badges: boolean; counters: "full" | "short" | "none"; status: boolean };
    // Keep counters reachable with compact tabs before omitting them; preserve complete
    // tab hit regions and a connection symbol even at physically constrained widths.
    const fits: Fit[] = [
      { labels: "full", brand: true, badges: true, counters: "full", status: true },
      { labels: "full", brand: true, badges: true, counters: "short", status: true },
      { labels: "active", brand: true, badges: false, counters: "short", status: false },
      { labels: "short", brand: false, badges: false, counters: "short", status: true },
      { labels: "short", brand: false, badges: false, counters: "short", status: false },
      { labels: "minimal", brand: false, badges: false, counters: "short", status: false },
      { labels: "full", brand: true, badges: true, counters: "none", status: true },
      { labels: "full", brand: true, badges: true, counters: "none", status: false },
      { labels: "active", brand: true, badges: false, counters: "none", status: true },
      { labels: "active", brand: true, badges: false, counters: "none", status: false },
      { labels: "short", brand: false, badges: false, counters: "none", status: true },
      { labels: "short", brand: false, badges: false, counters: "none", status: false },
      { labels: "minimal", brand: false, badges: false, counters: "none", status: false },
    ];
    for (const fit of fits) {
      const left: TerminalSpan[] = fit.brand ? [{ text: " asenq ", style: { ...theme.brand, inverse: true } }, { text: " " }] : [];
      const hits: Hit[] = [];
      let column = used(left);
      for (const [tab, label] of TABS) {
        const active = tab === this.tab;
        const full = fit.labels === "full" || (fit.labels === "active" && active);
        const text = fit.labels === "minimal" ? label[0] : ` ${full ? label : label[0]}`;
        const style = active ? { ...theme.accentBold, inverse: true } : theme.dim;
        const spans: TerminalSpan[] = [{ text, style }];
        const unread = tab === "inbox" ? inboxUnread : tab === "channels" ? channelUnread : 0;
        if (fit.badges && unread) spans.push({ text: ` ${unread}`, style: theme.unread });
        if (fit.labels !== "minimal") spans.push({ text: " ", style });
        const length = used(spans);
        left.push(...spans);
        hits.push({ row: 0, start: column, end: column + length, target: { kind: "tab", tab } });
        column += length;
      }
      const right: TerminalSpan[] = [];
      if (fit.counters !== "none") {
        counters.forEach((counter, index) => {
          if (index) right.push({ text: " · ", style: theme.dim });
          right.push({ text: `${counter.count} ${fit.counters === "full" ? counter.label : counter.short}`, style: counter.style });
        });
        right.push({ text: "  " });
      }
      right.push(fit.status ? connection : { ...connection, text: connection.text.slice(0, 1) });
      const gap = width - column - used(right);
      // Never clip constructed tabs: recorded hit regions must exactly match visible cells.
      if (gap >= (fit.labels === "minimal" ? 0 : 1)) {
        this.hits.push(...hits);
        return [...left, { text: " ".repeat(gap) }, ...right];
      }
    }
    // Below five cells there is no room for four mouse tabs plus the state symbol.
    // Keyboard tab shortcuts and the palette remain available; show only the active target.
    if (width <= 1) return clipSpans([{ ...connection, text: connection.text.slice(0, 1) }], width);
    this.hits.push({ row: 0, start: 0, end: 1, target: { kind: "tab", tab: this.tab } });
    return [
      { text: TABS.find(([tab]) => tab === this.tab)![1][0], style: { ...theme.accentBold, inverse: true } },
      { text: " ".repeat(width - 2) },
      { ...connection, text: connection.text.slice(0, 1) },
    ];
  }

  private footer(width: number): TerminalLine {
    let hints = this.finder ? "type to filter · ↑↓ choose · Enter open · Esc close"
      : this.palette ? "type to filter · ↑↓ · Enter run · Esc close · Ctrl+K jump"
      : this.form ? "Tab field · Enter submit · Shift+Enter newline · Esc cancel · Ctrl+K jump"
      : this.searching ? "type name · ↑↓ · Enter keep · Esc clear · Ctrl+K jump"
      : this.focus === "composer" ? "Enter send · Shift+Enter newline · Ctrl+E editor · Esc done · Ctrl+K jump"
      : this.focus === "transcript" ? "↑↓ select · Enter details · End latest · c write · Ctrl+K jump · ? menu"
      : this.focus === "tabs" ? "←→ switch · Enter open · Ctrl+K jump · ? menu"
      : "↑↓ move · Enter open · Tab focus · Ctrl+K jump · ? menu";
    if (this.shownHeldId && !this.finder && !this.palette && !this.form && !this.searching && this.focus !== "composer") {
      hints += " · r release · x drop";
    }
    const notice = this.notice;
    if (!notice) return padSpans(hintSpans(hints, width), width);
    const style = notice.kind === "error" ? theme.bad : notice.kind === "new" ? theme.unread : theme.accent;
    const left: TerminalSpan[] = [
      { text: notice.kind === "error" ? "✖ " : notice.kind === "new" ? "● " : "· ", style },
      { text: notice.text, style },
    ];
    const right = hintSpans(notice.kind === "error" ? `Esc dismiss · ${hints}` : hints, Math.floor(width / 2));
    return justify(left, right, width);
  }

  private body(width: number, height: number, y0: number): Pane {
    if (height <= 0) return { rows: [] };
    if (this.finder) return this.finderPane(width, height, y0);
    if (this.palette) return this.palettePane(width, height, y0);
    if (this.form) return this.formPane(width, height, y0);
    if (this.tab === "activity") return this.listPane(width, height, y0, 0);
    const panes = paneWidths(width);
    if (!panes) {
      return this.focus === "list" || this.focus === "tabs"
        ? this.listPane(width, height, y0, 0)
        : this.conversationPane(width, height, y0, 0, true);
    }
    const interiorHeight = Math.max(0, height - 2);
    const left: Pane = interiorHeight ? this.listPane(panes.list - 2, interiorHeight, y0 + 1, 1) : { rows: [] };
    const right = this.conversationPane(panes.conversation - 2, interiorHeight, y0 + 1, panes.list + 2, false);
    const listTitle: TerminalLine = [{ text: TABS.find(([tab]) => tab === this.tab)![1], style: theme.accentBold }];
    const leftRows = roundedPanel(listTitle, left.rows, panes.list, height, this.focus === "list");
    const rightRows = roundedPanel(
      this.title(panes.conversation - 6, false, y0, panes.list + 4),
      right.rows, panes.conversation, height, this.focus === "transcript" || this.focus === "composer",
    );
    const rows: TerminalLine[] = [];
    for (let row = 0; row < height; row++) rows.push([...leftRows[row], { text: " " }, ...rightRows[row]]);
    return { rows, ...(left.cursor ?? right.cursor ? { cursor: left.cursor ?? right.cursor } : {}) };
  }

  private listPane(width: number, height: number, y0: number, x0: number): Pane {
    const tab = this.tab;
    const focused = this.focus === "list";
    const header: TerminalLine[] = [];
    let cursor: TerminalCursor | undefined;
    if (tab === "sessions" && (this.searching || this.query)) {
      header.push(justify([{ text: "/ ", style: theme.accentBold }, { text: this.query }], this.searching ? [] : [{ text: "Esc clear", style: theme.dim }], width));
      if (this.searching) cursor = { row: y0, column: x0 + Math.min(width - 1, 2 + terminalTextWidth(this.query)) };
    } else if (tab === "activity") {
      header.push(justify(
        [{ text: "Activity ", style: theme.accentBold }, { text: this.activityFilter === "important" ? "messages, sessions, channels and retention" : "all events", style: theme.dim }],
        [{ text: this.activityFilter === "important" ? "f all · Enter open" : "f important · Enter open", style: theme.dim }], width,
      ));
    } else if (tab === "inbox") {
      header.push(justify([{ text: this.inboxFeed ? "Senders · feed shown" : "Senders", style: theme.accentBold }], [{ text: "v feed", style: theme.dim }], width));
    }
    const available = Math.max(0, height - header.length);
    const selected = tab === "activity" ? this.selectedActivity() : this.selection[tab];
    const rows: TerminalLine[] = [];
    const keys: (string | undefined)[] = [];
    let selStart = -1;
    let selEnd = -1;
    for (const entry of this.entries(tab)) {
      const isSelected = entry.key !== undefined && entry.key === selected;
      if (isSelected) selStart = rows.length;
      for (const row of entry.rows(width, isSelected, focused)) {
        rows.push(row);
        keys.push(entry.key);
      }
      if (isSelected) selEnd = rows.length - 1;
    }
    if (!rows.length) {
      const empty = tab === "sessions" ? (this.query ? "No matching sessions" : this.connection === "offline" ? "Daemon unavailable" : "No sessions yet")
        : tab === "inbox" ? "No incoming messages" : tab === "channels" ? "No channels yet" : "No retained events";
      rows.push([{ text: ellipsize(empty, width), style: theme.dim }]);
      keys.push(undefined);
    }
    let top = this.listTop[tab];
    if (tab === "activity" && this.followActivity) top = rows.length - available;
    if (selStart >= 0 && selStart < top) top = selStart;
    if (selEnd >= 0 && selEnd >= top + available) top = selEnd - available + 1;
    top = Math.max(0, Math.min(top, rows.length - available));
    this.listTop[tab] = top;
    const visible = rows.slice(top, top + available);
    header.forEach((_, index) => this.hits.push({ row: y0 + index, start: x0, end: x0 + width, target: { kind: "list" } }));
    visible.forEach((_, index) => {
      const key = keys[top + index];
      this.hits.push({ row: y0 + header.length + index, start: x0, end: x0 + width, target: key ? { kind: "entry", key } : { kind: "list" } });
    });
    return { rows: [...header, ...visible], ...(cursor ? { cursor } : {}) };
  }

  private title(width: number, narrow: boolean, y0: number, x0: number): TerminalLine {
    const scope = this.scope();
    const back: TerminalSpan[] = narrow ? [{ text: "‹ ", style: theme.accentBold }] : [];
    if (narrow) this.hits.push({ row: y0, start: x0, end: x0 + 2, target: { kind: "picker" } });
    if (this.panel) return justify([...back, { text: this.panel.title, style: theme.accentBold }], [{ text: "Esc close", style: theme.dim }], width);
    if (!scope) return justify([...back, { text: this.tab === "channels" ? "No channel selected" : "No session selected", style: theme.dim }], [], width);
    if (scope.scope === "inbox") {
      return justify([...back, { text: "Inbox", style: theme.accentBold }, { text: " · all incoming messages", style: theme.dim }], [{ text: this.inboxFeed ? "v grouped" : "legacy sender", style: theme.dim }], width);
    }
    if (scope.scope === "channel") {
      const count = this.channels.find((c) => c.name === scope.channel)?.count ?? 0;
      return justify([...back, { text: `#${scope.channel}`, style: theme.accentBold }], [...this.unreadSpans(keyOf(scope), true), { text: `${count} retained`, style: theme.dim }], width);
    }
    const session = this.session(scope.sessionId);
    const left: TerminalSpan[] = [...back, { text: session?.name ?? scope.sessionId, style: theme.accentBold }];
    if (session?.role) left.push({ text: ` · ${session.role}` });
    if (session?.previousNames.length) left.push({ text: ` formerly ${session.previousNames.join(", ")}`, style: theme.dim });
    if (session?.harness && session.harness !== "unknown") left.push({ text: ` · ${session.harness}`, style: theme.dim });
    const right: TerminalSpan[] = [...this.unreadSpans(keyOf(scope), true)];
    if (session) right.push(session.state === "removed" ? { text: "archived · read only", style: theme.dim } : this.stateLabel(session));
    return justify(left, right, width);
  }

  private conversationPane(width: number, height: number, y0: number, x0: number, narrow: boolean): Pane {
    if (height <= 0) {
      if (this.panel) this.panel.height = 0;
      return { rows: [] };
    }
    const rows: TerminalLine[] = [];
    const titled = narrow && height >= 3;
    if (titled) rows.push(this.title(width, narrow, y0, x0));
    if (this.panel) return this.panelPane(rows, width, height, y0, x0);
    const target = this.composeTarget();
    const scope = this.scope();
    const available = height - rows.length;
    // Held controls follow the viewed identity, including read-only archived conversations.
    const held = scope?.scope === "session" ? this.heldForSession(scope.sessionId) : undefined;
    // Reserve one transcript row and the editor's input before held chrome. A full bar
    // needs three rows; short panes use one, and the smallest panes hide it entirely.
    const heldRows = held ? heldBar(held.message, held.count, width, available >= 8 ? 3 : available >= 3 ? 1 : 0) : [];
    // Keep two transcript rows in previews; focused editors may borrow one, but never
    // lose their input row to chrome. Short panes use an unboxed editor instead.
    const composerRoom = this.focus === "composer" ? Math.max(1, available - 1) : available >= 5 ? available - 2 : 0;
    let composer: Pane | undefined;
    if (target && composerRoom) composer = this.composerPane(target, width, Math.min(8, Math.max(1, composerRoom - heldRows.length)), x0);
    const transcriptHeight = height - rows.length - heldRows.length - (composer?.rows.length ?? 0);
    const transcriptY = y0 + rows.length;
    let body: TerminalLine[];
    if (!scope) {
      const text = this.connection === "offline" && !this.sessions.length
        ? `Daemon unavailable. ${this.notice?.text ?? ""}`
        : this.tab === "channels" ? "Use ? → Create channel or Post channel to start a channel." : "Select a session in the list.";
      body = wrapTerminalText(text, width).map((line) => [{ text: line, style: theme.dim }]);
    } else {
      const key = keyOf(scope);
      const stream = this.streams.get(key);
      const readScope = scope.scope === "inbox" ? undefined : scope;
      const state = readScope && this.readStates.get(key);
      const firstUnread = readScope && state?.unread
        ? stream?.messages.find((m) => this.eligible(readScope, m) && (m.order > state.position || m.order === state.reminder))
        : undefined;
      const leading: TerminalLine[] = [[{
        text: ellipsize(stream?.loading ? "Loading…" : stream?.hasMore ? "↑ older messages · scroll up or PgUp" : "Beginning of retained history", width),
        style: theme.dim,
      }]];
      const layout = layoutTranscript(stream?.messages ?? [], {
        width,
        ...(stream?.selectedId && this.focus === "transcript" ? { selectedId: stream.selectedId } : {}),
        expanded: (id) => stream?.expanded.has(id) ?? false,
        ...(firstUnread ? { firstUnreadId: firstUnread.id } : {}),
        leading,
        empty: stream?.loaded ? "No retained messages" : "",
      });
      const top = viewportTop(layout, stream?.viewport ?? { follow: true }, transcriptHeight);
      this.shown = { key, layout, top, height: transcriptHeight };
      body = layout.rows.slice(top, top + transcriptHeight);
      const rowIds: (string | undefined)[] = new Array(layout.rows.length);
      for (const [id, range] of layout.ranges) for (let row = range.start; row <= range.end; row++) rowIds[row] = id;
      body.forEach((_, index) => {
        const id = rowIds[top + index];
        this.hits.push({ row: transcriptY + index, start: x0, end: x0 + width, target: id ? { kind: "message", id } : { kind: "transcript" } });
      });
    }
    body = body.slice(0, transcriptHeight);
    for (let index = body.length; index < transcriptHeight; index++) {
      body.push("");
      this.hits.push({ row: transcriptY + index, start: x0, end: x0 + width, target: { kind: "transcript" } });
    }
    rows.push(...body);
    if (held && heldRows.length) {
      rows.push(...heldRows);
      this.shownHeldId = held.message.id;
    }
    if (!composer) return { rows };
    const composerY = y0 + rows.length;
    composer.rows.forEach((_, index) => {
      this.hits.push({ row: composerY + index, start: x0, end: x0 + width, target: { kind: "composer" } });
    });
    rows.push(...composer.rows);
    return { rows, ...(composer.cursor ? { cursor: { ...composer.cursor, row: composerY + composer.cursor.row } } : {}) };
  }

  private composerPane(target: ComposeTarget, width: number, maxRows: number, x0: number): Pane {
    const key = this.draftKey(target);
    const text = this.drafts.get(key) ?? "";
    if (this.cursorKey !== key) {
      this.cursorKey = key;
      this.cursor = text.length;
    }
    const focused = this.focus === "composer";
    const label = `to ${target.kind === "channel" ? "#" : ""}${target.name}`;
    const boxed = width >= 6 && maxRows >= 3;
    const inset = boxed ? 1 : 0;
    const innerWidth = width - 2 * inset;
    const promptWidth = Math.min(2, Math.max(0, innerWidth - 1));
    const hint = innerWidth >= 60 ? "⏎ send ⇧⏎ newline ^E editor" : innerWidth >= 30 ? "⏎ send" : "";
    const hintWidth = terminalTextWidth(hint);
    const textWidth = Math.max(1, innerWidth - promptWidth - hintWidth - (hint ? 1 : 0));
    const layout = editorLayout(text, this.cursor, textWidth);
    const count = Math.min(maxRows - 2 * inset, Math.max(1, layout.rows.length));
    const first = Math.max(0, Math.min(layout.cursorRow - count + 1, layout.rows.length - count));
    const content: TerminalLine[] = [];
    for (let index = 0; index < count; index++) {
      const prompt = (index + first === 0 ? "› " : "  ").slice(0, promptWidth);
      const value = !text && !focused
        ? ellipsize(`Write to ${target.kind === "session" ? target.name : `#${target.name}`} — press c`, textWidth)
        : layout.rows[first + index] ?? "";
      content.push(justify(
        [{ text: prompt, style: focused ? theme.human : theme.dim }, { text: value, ...(!text && !focused ? { style: theme.dim } : {}) }],
        index === 0 && hint ? [{ text: hint, style: theme.dim }] : [], innerWidth,
      ));
    }
    const rows = boxed ? roundedPanel(
      [{ text: label, style: focused ? theme.accentBold : theme.bold }, ...(this.sending ? [{ text: " sending…", style: theme.warn }] : [])],
      content, width, content.length + 2, focused,
    ) : content;
    // Both the prompt and the hard-wrap budget exclude borders and hints. The cursor
    // stays on an input cell, including at a full-width wrap or in the short fallback.
    return focused ? { rows, cursor: { row: inset + layout.cursorRow - first, column: x0 + inset + promptWidth + layout.cursorColumn } } : { rows };
  }

  private panelPane(rows: TerminalLine[], width: number, height: number, y0: number, x0: number): Pane {
    const panel = this.panel!;
    const available = height - rows.length;
    const content: TerminalLine[] = panel.messages
      ? layoutTranscript(panel.messages, { width, expanded: () => true, empty: "Nothing to show" }).rows
      : (panel.lines ?? []).flatMap((line) => wrapTerminalText(line, width).map((row): TerminalLine => row));
    panel.height = available;
    panel.rows = content.length;
    panel.top = Math.max(0, Math.min(panel.top, content.length - available));
    const visible = content.slice(panel.top, panel.top + available);
    for (let index = 0; index < available; index++) {
      this.hits.push({ row: y0 + rows.length + index, start: x0, end: x0 + width, target: { kind: "transcript" } });
    }
    return { rows: [...rows, ...visible] };
  }

  private palettePane(width: number, height: number, y0: number): Pane {
    const palette = this.palette!;
    const items = this.paletteItems();
    palette.selected = Math.max(0, Math.min(palette.selected, items.length - 1));
    const rows: TerminalLine[] = [justify(
      [{ text: "? ", style: theme.accentBold }, { text: palette.query || "" }, ...(palette.query ? [] : [{ text: "search actions", style: theme.dim }])],
      [{ text: `${items.length} actions`, style: theme.dim }], width,
    )];
    const list: { line: TerminalLine; index?: number }[] = [];
    let group = "";
    items.forEach((item, index) => {
      if (item.group !== group) {
        group = item.group;
        list.push({ line: [{ text: ellipsize(group.toUpperCase(), width), style: theme.accent }] });
      }
      const selected = index === palette.selected;
      list.push({
        index,
        line: justify([this.marker(selected), { text: item.label, style: selected ? theme.bold : {} }],
          SHORTCUTS[item.label] ? [{ text: SHORTCUTS[item.label]!, style: theme.dim }] : [], width, selected ? theme.selected : undefined),
      });
    });
    if (!items.length) list.push({ line: [{ text: "No matching actions", style: theme.dim }] });
    const available = height - 1;
    const selectedRow = list.findIndex((entry) => entry.index === palette.selected);
    if (selectedRow >= 0 && selectedRow < palette.top) palette.top = Math.max(0, selectedRow - 1);
    if (selectedRow >= palette.top + available) palette.top = selectedRow - available + 1;
    palette.top = Math.max(0, Math.min(palette.top, list.length - available));
    list.slice(palette.top, palette.top + available).forEach((entry, index) => {
      rows.push(entry.line);
      if (entry.index !== undefined) this.hits.push({ row: y0 + 1 + index, start: 0, end: width, target: { kind: "palette", index: entry.index } });
    });
    return { rows, cursor: { row: y0, column: Math.min(width - 1, 2 + terminalTextWidth(palette.query)) } };
  }

  private paletteItems(): { group: string; label: Action }[] {
    const q = (this.palette?.query ?? "").toLowerCase();
    return ACTIONS.filter((item) => !q || item.label.toLowerCase().includes(q) || item.group.toLowerCase().includes(q));
  }

  private formPane(width: number, height: number, y0: number): Pane {
    const form = this.form!;
    const rows: { line: TerminalLine; field?: number }[] = [];
    rows.push({ line: justify([{ text: form.title, style: theme.accentBold }], [{ text: "Tab next field · Enter submit · Esc cancel", style: theme.dim }], width) });
    for (const text of form.description ?? []) {
      for (const line of wrapTerminalText(text, width)) rows.push({ line: [{ text: line, style: theme.dim }] });
    }
    let cursor: TerminalCursor | undefined;
    let cursorRow = 0;
    form.fields.forEach((field, index) => {
      const focused = index === form.focus;
      rows.push({ field: index, line: [this.marker(focused), { text: ellipsize(field.label, width - 2), style: focused ? theme.accentBold : theme.dim }] });
      const layout = editorLayout(field.value, field.value.length, Math.max(1, width - 4));
      const shown = focused || !field.multiline ? layout.rows : layout.rows.slice(-3);
      const skipped = layout.rows.length - shown.length;
      shown.forEach((row) => rows.push({ field: index, line: [{ text: "    " }, { text: row, style: focused ? {} : theme.dim }] }));
      if (focused) {
        cursorRow = rows.length - shown.length + (layout.cursorRow - skipped);
        cursor = { row: 0, column: 4 + layout.cursorColumn };
      }
    });
    const available = height;
    const top = Math.max(0, Math.min(cursorRow - available + 1, rows.length - available));
    const visible = rows.slice(top, top + available);
    visible.forEach((entry, index) => {
      if (entry.field !== undefined) this.hits.push({ row: y0 + index, start: 0, end: width, target: { kind: "field", index: entry.field } });
    });
    if (cursor) cursor.row = y0 + cursorRow - top;
    return { rows: visible.map((entry) => entry.line), ...(cursor ? { cursor } : {}) };
  }

  // ------------------------------------------------------------------ transcript navigation

  private currentStream(): { scope: HistoryScope; stream: Stream } | undefined {
    const scope = this.scope();
    const stream = scope && this.streams.get(keyOf(scope));
    return scope && stream ? { scope, stream } : undefined;
  }

  /** Scrolls the visible transcript; returns whether the viewport moved. */
  private scrollTranscript(delta: number): boolean {
    const current = this.currentStream();
    const shown = this.shown;
    if (!current || !shown || shown.key !== keyOf(current.scope)) return false;
    const next = Math.max(0, Math.min(maxTop(shown.layout, shown.height), shown.top + delta));
    current.stream.viewport = viewportAt(shown.layout, next, shown.height);
    if (next === 0 && current.stream.hasMore) this.track(this.load(current.scope, true));
    if (next !== shown.top) this.readHold = undefined;
    return next !== shown.top;
  }

  private stepMessage(direction: -1 | 1): boolean {
    const current = this.currentStream();
    const shown = this.shown;
    if (!current || !shown || shown.key !== keyOf(current.scope) || !shown.layout.order.length) return false;
    const { layout, top, height } = shown;
    const { stream } = current;
    const order = layout.order;
    const bottom = top + height - 1;
    const index = stream.selectedId ? order.indexOf(stream.selectedId) : -1;
    const selectedRange = index >= 0 ? layout.ranges.get(order[index])! : undefined;
    if (!selectedRange || selectedRange.end < top || selectedRange.start > bottom) {
      // Start from the message nearest the edge being moved towards.
      const visible = order.filter((id) => {
        const range = layout.ranges.get(id)!;
        return range.end >= top && range.start <= bottom;
      });
      stream.selectedId = direction > 0 ? visible[0] ?? order[0] : visible.at(-1) ?? order.at(-1);
      return false;
    }
    const range = selectedRange;
    if (direction > 0 && range.end > bottom) return this.scrollTranscript(1);
    if (direction < 0 && range.start < top) return this.scrollTranscript(-1);
    const nextIndex = index + direction;
    if (nextIndex < 0) {
      if (top > 0) return this.scrollTranscript(-1);
      if (stream.hasMore) this.track(this.load(current.scope, true));
      return false;
    }
    if (nextIndex >= order.length) return this.scrollTranscript(1);
    stream.selectedId = order[nextIndex];
    const next = layout.ranges.get(stream.selectedId)!;
    if (direction > 0 && next.start > bottom) return this.scrollTranscript(Math.min(next.start - bottom, next.end - bottom));
    if (direction < 0 && next.end < top) return this.scrollTranscript(Math.max(next.end - height + 1, next.start) - top);
    return false;
  }

  /**
   * Marks the open conversation read once the last row of its newest incoming message is on
   * screen while the user is in it (conversation or composer focus). Moving through the list
   * never marks anything read, and a fresh `u` reminder holds until the user scrolls, presses
   * End or reopens the conversation.
   */
  private async readIfReached(): Promise<void> {
    const scope = this.readScope();
    const shown = this.shown;
    if (!scope || !shown || shown.key !== keyOf(scope) || this.reading || this.readHold === shown.key) return;
    if (this.focus !== "transcript" && this.focus !== "composer") return;
    const state = this.readStates.get(shown.key);
    const stream = this.streams.get(shown.key);
    if (!state?.unread || !stream) return;
    const latest = stream.messages.findLast((m) => this.eligible(scope, m));
    const range = latest && shown.layout.ranges.get(latest.id);
    if (!latest || !range || range.bodyEnd > shown.top + shown.height - 1) return;
    this.reading = true;
    try {
      await this.markRead(scope, latest.order, state);
    } finally {
      this.reading = false;
    }
  }

  private async markRead(scope: ReadScope, through: number, state: ReadState): Promise<void> {
    const result = await this.client.markRead(scope, through, state.version);
    this.readStates.set(keyOf(scope), result.state);
    if (!result.applied) this.say("Read position changed in another window; repeat to confirm.");
    this.render();
  }

  private async explicitRead(): Promise<void> {
    const scope = this.readScope();
    if (!scope) {
      this.say("Select a session or channel to mark read");
      return this.render();
    }
    const stream = this.streams.get(keyOf(scope));
    const state = this.readStates.get(keyOf(scope));
    if (!state) return;
    let latest = stream?.messages.findLast((m) => this.eligible(scope, m));
    let before = stream?.messages[0]?.order;
    while (!latest && before !== undefined && stream?.hasMore) {
      const older = await this.client.historyPage({ ...scope, before, limit: 200 });
      latest = older.messages.findLast((m) => this.eligible(scope, m));
      if (!older.hasMore) break;
      before = older.messages[0]?.order;
    }
    if (latest) await this.markRead(scope, latest.order, state);
  }

  private async markUnread(): Promise<void> {
    const scope = this.readScope();
    if (!scope) {
      this.say("Select a session or channel to mark unread");
      return this.render();
    }
    const state = this.readStates.get(keyOf(scope));
    if (!state) return;
    const result = await this.client.markUnread(scope, state.version);
    this.readHold = keyOf(scope);
    this.readStates.set(keyOf(scope), result.state);
    if (!result.applied) this.say("Marker changed in another window; repeat to confirm.");
    this.render();
  }

  // ------------------------------------------------------------------ input

  private regions(): Focus[] {
    const regions: Focus[] = ["tabs", "list"];
    if (this.tab !== "activity" && (this.scope() || this.panel)) regions.push("transcript");
    if (this.tab !== "activity" && !this.panel && this.composeTarget()) regions.push("composer");
    return regions;
  }

  private cycleFocus(direction: 1 | -1): void {
    const regions = this.regions();
    const index = regions.indexOf(this.focus);
    this.focus = regions[(index + direction + regions.length) % regions.length];
  }

  private focusComposer(): void {
    if (this.composeTarget()) {
      this.panel = undefined;
      this.focus = "composer";
      return;
    }
    this.openEditor();
  }

  private paste(text: string): void {
    const clean = cleanInput(text);
    if (this.finder) {
      this.finder.query += clean.replace(/\n/g, " ");
      this.finder.selected = undefined;
      this.finder.top = 0;
    } else if (this.palette) this.palette.query += clean.replace(/\n/g, " ");
    else if (this.form) this.formInsert(clean);
    else if (this.searching) this.query += clean.replace(/\n/g, " ").toLowerCase();
    else if (this.composeTarget()) {
      this.focus = "composer";
      this.composerInsert(clean);
    }
  }

  private composerInsert(text: string): void {
    const target = this.composeTarget();
    if (!target) return;
    const key = this.draftKey(target);
    const draft = this.drafts.get(key) ?? "";
    if (this.cursorKey !== key) [this.cursorKey, this.cursor] = [key, draft.length];
    this.drafts.set(key, draft.slice(0, this.cursor) + text + draft.slice(this.cursor));
    this.cursor += text.length;
  }

  private async composerKey(k: KeyInput): Promise<void> {
    const target = this.composeTarget();
    if (!target) {
      this.focus = "transcript";
      return this.render();
    }
    const key = this.draftKey(target);
    const draft = this.drafts.get(key) ?? "";
    if (this.cursorKey !== key) [this.cursorKey, this.cursor] = [key, draft.length];
    const set = (text: string, cursor: number): void => {
      if (text) this.drafts.set(key, text);
      else this.drafts.delete(key);
      this.cursor = cursor;
    };
    switch (k.name) {
      case "ESCAPE":
        if (this.notice?.kind === "error") this.notice = undefined;
        else this.focus = "transcript";
        break;
      case "TAB": this.cycleFocus(1); break;
      case "SHIFT_TAB": this.cycleFocus(-1); break;
      case "ENTER": case "KP_ENTER": case "CTRL_D": await this.sendComposer(target); break;
      case "CTRL_E": this.openEditor(); break;
      case "BACKSPACE": {
        const start = stepGrapheme(draft, this.cursor, -1);
        set(draft.slice(0, start) + draft.slice(this.cursor), start);
        break;
      }
      case "DELETE": {
        const end = stepGrapheme(draft, this.cursor, 1);
        set(draft.slice(0, this.cursor) + draft.slice(end), this.cursor);
        break;
      }
      case "LEFT": this.cursor = stepGrapheme(draft, this.cursor, -1); break;
      case "RIGHT": this.cursor = stepGrapheme(draft, this.cursor, 1); break;
      case "HOME": this.cursor = draft.lastIndexOf("\n", this.cursor - 1) + 1; break;
      case "END": {
        const end = draft.indexOf("\n", this.cursor);
        this.cursor = end < 0 ? draft.length : end;
        break;
      }
      case "CTRL_U": set("", 0); break;
      default:
        if (NEWLINE_KEYS[k.name]) this.composerInsert("\n");
        else if (k.text && !k.ctrl) this.composerInsert(cleanInput(k.text));
    }
    this.render();
  }

  private async sendComposer(target: ComposeTarget): Promise<void> {
    if (this.sending) return;
    const key = this.draftKey(target);
    const text = this.drafts.get(key) ?? "";
    if (!text.trim()) {
      this.say("Message text is empty");
      return;
    }
    this.sending = true;
    this.render();
    try {
      if (target.kind === "session") {
        const result = await this.client.sendToSession(target.id, text);
        this.say(`${result.to}: ${result.status}${result.reason ? ` (${result.reason})` : ""}`);
      } else {
        const reply = await this.client.request("channel_send", { channel: target.name, text });
        this.say(`Posted #${target.name} ${String(reply.msgId ?? "")}`);
      }
      this.drafts.delete(key);
      this.cursor = 0;
      const current = this.currentStream();
      if (current) current.stream.viewport = { follow: true };
      await this.replay();
    } catch (e) {
      this.say(`Send failed or outcome unknown (${stringify(e)}). Check log before retrying; draft retained.`, "error");
    } finally {
      this.sending = false;
    }
  }

  private async key(k: KeyInput): Promise<void> {
    if (this.closed) return;
    if (k.name === "CTRL_K") return this.openFinder();
    if (this.finder) return this.finderKey(k);
    if (this.palette) return this.paletteKey(k);
    if (this.form) return this.formKey(k);
    if (this.searching) return this.searchKey(k);
    if (this.focus === "composer") return this.composerKey(k);
    if (this.shownHeldId && (k.text === "r" || k.text === "x")) {
      return this.heldAction(k.text === "r" ? "release" : "drop");
    }
    const name = k.name;
    if (name === "TAB" || name === "SHIFT_TAB") {
      this.cycleFocus(name === "TAB" ? 1 : -1);
      return this.render();
    }
    if (name === "ESCAPE") return this.escape();
    if (name === "CTRL_E") {
      this.openEditor();
      return this.render();
    }
    switch (k.text) {
      case "?": this.palette = { query: "", selected: 0, top: 0 }; return this.render();
      case "q": return this.quit();
      case "s": return this.setTab("sessions");
      case "i": return this.setTab("inbox");
      case "#": return this.setTab("channels");
      case "a": return this.setTab("activity");
      case "c": this.focusComposer(); return this.render();
      case "u": return this.markUnread();
      case "v": return this.action("Toggle inbox feed");
      case "f": return this.action("Toggle activity filter");
      case "/": return this.action("Search sessions");
    }
    if (this.focus === "tabs") {
      const index = TABS.findIndex(([tab]) => tab === this.tab);
      if (name === "LEFT" || name === "RIGHT") {
        this.focus = "tabs";
        await this.setTab(TABS[(index + (name === "LEFT" ? -1 : 1) + TABS.length) % TABS.length][0]);
        this.focus = "tabs";
        return this.render();
      }
      if (name === "DOWN" || name === "ENTER") this.focus = "list";
      return this.render();
    }
    if (this.focus === "list") {
      if (name === "UP") return this.moveSelection(-1);
      if (name === "DOWN") return this.moveSelection(1);
      if (name === "PAGE_UP") return this.moveSelection(-10);
      if (name === "PAGE_DOWN") return this.moveSelection(10);
      if (name === "HOME") return this.moveSelection(-Infinity);
      if (name === "END") return this.moveSelection(Infinity);
      if (name === "ENTER" || name === "RIGHT") return this.openEntry();
      return;
    }
    if (this.panel) {
      const panel = this.panel;
      const delta = name === "UP" ? -1 : name === "DOWN" ? 1 : name === "PAGE_UP" ? -(panel.height - 1)
        : name === "PAGE_DOWN" ? panel.height - 1 : name === "HOME" ? -Infinity : name === "END" ? Infinity : 0;
      if (delta) panel.top = Math.max(0, Math.min(panel.rows - panel.height, panel.top + delta));
      if (name === "LEFT") this.focus = "list";
      return this.render();
    }
    // transcript
    const shownHeight = this.shown?.height ?? 1;
    if (name === "UP") this.stepMessage(-1);
    else if (name === "DOWN") this.stepMessage(1);
    else if (name === "PAGE_UP") this.scrollTranscript(-Math.max(1, shownHeight - 1));
    else if (name === "PAGE_DOWN") this.scrollTranscript(Math.max(1, shownHeight - 1));
    else if (name === "HOME") this.scrollTranscript(-Infinity);
    else if (name === "END") {
      const current = this.currentStream();
      if (current) {
        current.stream.viewport = { follow: true };
        current.stream.selectedId = undefined;
      }
      this.readHold = undefined;
    } else if (name === "ENTER") {
      const current = this.currentStream();
      const id = current?.stream.selectedId;
      if (current && id) {
        if (current.stream.expanded.has(id)) current.stream.expanded.delete(id);
        else current.stream.expanded.add(id);
      }
    } else if (name === "LEFT") this.focus = "list";
    this.render();
  }

  private async escape(): Promise<void> {
    if (this.notice?.kind === "error") this.notice = undefined;
    else if (this.panel) this.panel = undefined;
    else if (this.query) this.query = "";
    else if (this.focus === "transcript" && !paneWidths(this.screen.size.columns)) this.focus = "list";
    else if (this.tab !== "sessions") return this.setTab("sessions");
    else this.focus = "list";
    this.ensureSelection();
    this.render();
  }

  private async searchKey(k: KeyInput): Promise<void> {
    if (k.name === "ESCAPE") {
      this.searching = false;
      this.query = "";
    } else if (k.name === "ENTER") {
      this.searching = false;
      this.focus = "list";
    } else if (k.name === "UP" || k.name === "DOWN") {
      return this.moveSelection(k.name === "UP" ? -1 : 1);
    } else if (k.name === "BACKSPACE") {
      this.query = this.query.slice(0, stepGrapheme(this.query, this.query.length, -1));
    } else if (k.text && !k.ctrl) {
      this.query += cleanInput(k.text).toLowerCase();
    }
    const keys = this.selectable("sessions");
    if (!keys.includes(this.selection.sessions ?? "")) this.selection.sessions = keys.find((key) => key !== "archive");
    await this.opened();
  }

  private async paletteKey(k: KeyInput): Promise<void> {
    const palette = this.palette!;
    const items = this.paletteItems();
    if (k.name === "ESCAPE") this.palette = undefined;
    else if (k.name === "UP") palette.selected = Math.max(0, palette.selected - 1);
    else if (k.name === "DOWN") palette.selected = Math.min(items.length - 1, palette.selected + 1);
    else if (k.name === "PAGE_UP") palette.selected = Math.max(0, palette.selected - 8);
    else if (k.name === "PAGE_DOWN") palette.selected = Math.min(items.length - 1, palette.selected + 8);
    else if (k.name === "ENTER") {
      const item = items[palette.selected];
      this.palette = undefined;
      if (item) return this.action(item.label);
    } else if (k.name === "BACKSPACE") {
      palette.query = palette.query.slice(0, stepGrapheme(palette.query, palette.query.length, -1));
      palette.selected = 0;
    } else if (k.text && !k.ctrl) {
      palette.query += cleanInput(k.text);
      palette.selected = 0;
    }
    this.render();
  }

  private formInsert(text: string): void {
    const form = this.form!;
    const field = form.fields[form.focus];
    field.value += field.multiline ? text : text.replace(/\n/g, " ");
    if (form.focus === 0 && form.binding) form.binding.edited = true;
    this.syncFormDraft(form);
  }

  private syncFormDraft(form: Form): void {
    if (!form.draftKey) return;
    const key = form.draftKey(form);
    if (form.fields[1].value) this.drafts.set(key, form.fields[1].value);
    else this.drafts.delete(key);
  }

  private async formKey(k: KeyInput): Promise<void> {
    const form = this.form!;
    const field = form.fields[form.focus];
    const name = k.name;
    if (name === "ESCAPE") this.form = undefined;
    else if (name === "TAB" || (name === "ENTER" && !field.multiline)) form.focus = (form.focus + 1) % form.fields.length;
    else if (name === "SHIFT_TAB") form.focus = (form.focus - 1 + form.fields.length) % form.fields.length;
    else if (NEWLINE_KEYS[name] && field.multiline) this.formInsert("\n");
    else if (name === "CTRL_D" || name === "ENTER" || name === "KP_ENTER") {
      try {
        await form.submit(form.fields.map((x) => x.value));
        if (this.form === form) this.form = undefined;
      } catch (e) {
        this.say(stringify(e), "error");
      }
    } else if (name === "CTRL_U" || name === "BACKSPACE") {
      field.value = name === "CTRL_U" ? "" : field.value.slice(0, stepGrapheme(field.value, field.value.length, -1));
      if (form.focus === 0 && form.binding) form.binding.edited = true;
      this.syncFormDraft(form);
    } else if (k.text && !k.ctrl) this.formInsert(cleanInput(k.text));
    this.render();
  }

  private async mouse(m: MouseInput): Promise<void> {
    if (this.closed) return;
    const hit = this.hits.find((h) => h.row === m.row && m.column >= h.start && m.column < h.end);
    if (this.finder) {
      if (m.action === "wheel-up" || m.action === "wheel-down") {
        const items = this.jumpItems();
        const index = Math.max(0, Math.min(items.length - 1, this.finderIndex(items) + (m.action === "wheel-up" ? -1 : 1)));
        this.finder.selected = items[index]?.key;
        return this.render();
      }
      if (m.action === "press" && m.button === "left" && hit?.target.kind === "finder") {
        return this.jumpTo(hit.target.key);
      }
      return;
    }
    if (m.action === "wheel-up" || m.action === "wheel-down") {
      const delta = m.action === "wheel-up" ? -3 : 3;
      if (this.palette) this.palette.selected = Math.max(0, this.palette.selected + Math.sign(delta));
      else if (hit && (hit.target.kind === "entry" || hit.target.kind === "list")) return this.moveSelection(delta);
      else if (this.panel) this.panel.top = Math.max(0, Math.min(this.panel.rows - this.panel.height, this.panel.top + delta));
      else if (hit && (hit.target.kind === "message" || hit.target.kind === "transcript")) {
        this.focus = "transcript";
        this.scrollTranscript(delta);
      }
      return this.render();
    }
    if (m.action !== "press" || m.button !== "left" || !hit) return;
    const target = hit.target;
    switch (target.kind) {
      case "tab": return this.setTab(target.tab);
      case "entry":
        this.focus = "list";
        this.selection[this.tab] = target.key;
        if (this.tab === "activity") return this.openActivity();
        if (target.key === "archive") return this.openEntry();
        return this.opened();
      case "palette": {
        const item = this.paletteItems()[target.index];
        this.palette = undefined;
        if (item) return this.action(item.label);
        break;
      }
      case "field": if (this.form) this.form.focus = target.index; break;
      case "composer": this.focusComposer(); break;
      case "picker": this.focus = "list"; break;
      case "list": this.focus = "list"; break;
      case "transcript": this.focus = "transcript"; break;
      case "message": {
        this.focus = "transcript";
        const current = this.currentStream();
        if (current) {
          if (current.stream.selectedId === target.id) {
            if (current.stream.expanded.has(target.id)) current.stream.expanded.delete(target.id);
            else current.stream.expanded.add(target.id);
          } else current.stream.selectedId = target.id;
        }
        break;
      }
    }
    this.render();
  }

  // ------------------------------------------------------------------ forms & actions

  private async heldAction(action: "release" | "drop"): Promise<void> {
    const msgId = this.shownHeldId;
    if (!msgId || !this.heldMessages.has(msgId) || this.heldActionPending) return;
    this.heldActionPending = true;
    try {
      const reply = await this.client.request(action, { msgId });
      this.heldMessages.delete(msgId);
      this.say(`${msgId}: ${action === "drop" ? "dropped" : String(reply.status)}`);
    } catch (e) {
      this.say(stringify(e), "error");
    } finally {
      try {
        await this.refreshHeld();
        await this.replay();
      } catch (e) {
        this.say(stringify(e), "error");
      } finally {
        this.heldActionPending = false;
        this.render();
      }
    }
  }

  private openForm(title: string, fields: Field[], submit: Form["submit"], description?: string[]): void {
    this.form = { title, fields, focus: 0, submit, ...(description ? { description } : {}) };
    this.render();
  }

  private ask(title: string, labels: string[], submit: (v: string[]) => Promise<void>, defaults: string[] = [], description?: string[]): void {
    this.openForm(title, labels.map((label, i) => ({ label, value: defaults[i] ?? "" })), submit, description);
  }

  /** Full editor with every send option; a bound session target keeps its stable identity until edited. */
  private openEditor(broadcast = false): void {
    const target = broadcast ? undefined : this.composeTarget();
    if (target?.kind === "channel") {
      const key = this.draftKey(target);
      this.form = {
        title: `Post to #${target.name}`, focus: 1,
        fields: [{ label: "Channel", value: target.name }, { label: "Text", value: this.drafts.get(key) ?? "", multiline: true }],
        draftKey: (form) => `channel:${form.fields[0].value}`,
        submit: async ([channel, text]) => {
          const reply = await this.client.request("channel_send", { channel, text });
          this.drafts.delete(`channel:${channel}`);
          this.say(`Posted #${channel} ${String(reply.msgId ?? "")}`);
          await this.replay();
        },
      };
      return;
    }
    const binding: Binding | undefined = target ? { id: target.id, name: target.name, edited: false } : undefined;
    const to = broadcast ? "*" : target?.name ?? "human";
    const count = this.sessions.filter((s) => s.state === "live").length;
    const fields: Field[] = [
      { label: "To (session name, human or * for all live)", value: to },
      { label: "Text", value: this.drafts.get(binding ? `session:${binding.id}` : `target:${to}`) ?? "", multiline: true },
      { label: "Kind (chat/task/result/status)", value: "" },
      { label: "Thread", value: "" },
      { label: "Reply-to message ID", value: "" },
      { label: "Done (yes/no)", value: "no" },
    ];
    if (broadcast) fields.push({ label: `Confirm: type yes ${count} to send to ${count} live sessions`, value: "" });
    const draftKey = (form: Form): string => {
      const to = form.fields[0].value;
      return form.binding && !form.binding.edited && to === form.binding.name ? `session:${form.binding.id}` : `target:${to}`;
    };
    const form: Form = {
      title: broadcast ? "Broadcast" : "Compose", focus: 1, fields, draftKey,
      ...(binding ? { binding, description: [`Sends to session ${binding.name} (${binding.id}); editing To sends by name instead.`] } : {}),
      submit: async ([to, text, kind, thread, reply, done, confirm]) => {
        await this.send(to, text, kind, thread, reply, done, confirm, form.binding);
        this.drafts.delete(draftKey(form));
      },
    };
    this.form = form;
  }

  private async send(target: string, text: string, kind: string, thread: string, replyTo: string, done: string, confirmation?: string, binding?: Binding): Promise<void> {
    if (!text.trim()) throw new Error("Message text is empty");
    const count = this.sessions.filter((s) => s.state === "live").length;
    if (target === "*" && confirmation !== `yes ${count}`) throw new Error(`Broadcast to ${count} live sessions: enter 'yes ${count}' to confirm`);
    if (kind === "control") throw new Error("Control messages require an action; send them with CLI --kind control --action or MCP asenq_send instead");
    const kindOption = KINDS.find((candidate) => candidate === kind);
    if (kind && !kindOption) throw new Error(`Kind must be one of ${KINDS.join(", ")}`);
    if (done && !["yes", "no", "true", "false"].includes(done)) throw new Error("Done must be yes or no");
    const options = { kind: kindOption, thread: thread || undefined, replyTo: replyTo || undefined, done: done === "yes" || done === "true" };
    try {
      const results = binding && !binding.edited && target === binding.name
        ? [await this.client.sendToSession(binding.id, text, options)]
        : (await this.client.request("send", { to: target, text, ...options })).results as SendResult[];
      this.say(results.map((x) => `${x.to}: ${x.status}${x.msgId ? ` ${x.msgId}` : ""}${x.reason ? ` (${x.reason})` : ""}`).join(" · ") || "No live broadcast recipients");
      await this.replay();
    } catch (e) {
      throw new Error(`Send failed or outcome unknown (${stringify(e)}). Check log before retrying; draft retained.`);
    }
  }

  private showPanel(title: string, content: { lines?: string[]; messages?: StoredMessage[] }): void {
    this.panel = { title, ...content, top: 0, height: 1, rows: 0 };
    if (this.tab === "activity") this.tab = "sessions";
    this.focus = "transcript";
  }

  private async executeLocal(args: string[], exit = false): Promise<void> {
    if (exit) this.quit();
    const child = spawnSync(process.execPath, [process.argv[1], ...args], { encoding: "utf8", timeout: 60_000 });
    const lines = [`$ asenq ${args.join(" ")}`, ...(child.stdout ?? "").split("\n"), ...(child.stderr ?? "").split("\n"), `Exit: ${child.status ?? child.error?.message ?? "unknown"}`];
    if (exit) process.stdout.write(lines.join("\n") + "\n");
    else this.showPanel(`asenq ${args.join(" ")}`, { lines });
  }

  private async action(action: Action): Promise<void> {
    const scope = this.scope();
    const selected = scope?.scope === "session" ? this.session(scope.sessionId) : undefined;
    try {
      switch (action) {
        case "Sessions": return this.setTab("sessions");
        case "Inbox": return this.setTab("inbox");
        case "Channels": return this.setTab("channels");
        case "Activity": return this.setTab("activity");
        case "Quick jump": return this.openFinder();
        case "Search sessions":
          await this.setTab("sessions");
          this.searching = true;
          break;
        case "Toggle archive": this.archiveOpen = !this.archiveOpen; break;
        case "Toggle inbox feed":
          this.inboxFeed = !this.inboxFeed;
          return this.setTab("inbox");
        case "Toggle activity filter":
          this.activityFilter = this.activityFilter === "important" ? "all" : "important";
          this.followActivity = true;
          this.selection.activity = undefined;
          if (this.tab !== "activity") return this.setTab("activity");
          break;
        case "Compose / send": this.focusComposer(); break;
        case "Full editor": this.openEditor(); break;
        case "Broadcast": this.openEditor(true); break;
        case "Mark read": await this.explicitRead(); break;
        case "Mark latest unread": await this.markUnread(); break;
        case "Read channel":
          this.ask("Read channel", ["Channel"], async ([channel]) => {
            this.selection.channels = `c:${channel}`;
            await this.setTab("channels");
            this.focus = "transcript";
          });
          break;
        case "Post channel":
          this.openForm("Post channel", [{ label: "Channel", value: scope?.scope === "channel" ? scope.channel : "" }, { label: "Text", value: "", multiline: true }], async ([channel, text]) => {
            const reply = await this.client.request("channel_send", { channel, text });
            this.say(`Posted #${channel} ${String(reply.msgId ?? "")}`);
            await this.replay();
          }, ["Posts are stored for readers; agents are never pushed channel messages."]);
          break;
        case "Create channel":
          this.ask("Create channel", ["Channel"], async ([channel]) => {
            await this.client.request("channel_create", { channel });
            await this.replay();
            this.selection.channels = `c:${channel}`;
            await this.setTab("channels");
          }, [scope?.scope === "channel" ? scope.channel : ""]);
          break;
        case "Add channel member":
          this.ask("Add channel member", ["Channel", "Live session name"], async ([channel, name]) => {
            await this.client.request("channel_add", { channel, name });
            await this.replay();
          }, [scope?.scope === "channel" ? scope.channel : "", selected?.name ?? ""], ["Membership follows the session identity across renames and reconnections."]);
          break;
        case "Remove channel member": {
          const channel = scope?.scope === "channel" ? scope.channel : this.selectedChannel() ?? "";
          const members = channel
            ? (await this.client.request("channel_members", { channel })).members as SessionIdentity[]
            : [];
          const id = this.selectedChannelMember() ?? members[0]?.id ?? "";
          this.ask("Remove channel member", ["Channel", "Session identity ID"], async ([channel, sessionId]) => {
            await this.client.request("channel_remove", { channel, sessionId });
            await this.replay();
          }, [channel, id], [
            "Removes by stable identity, never by a reused or former name.",
            ...members.map((member) => `${member.name} · ${member.role ?? "unset"} · ${member.state} · ${member.id}`),
          ]);
          break;
        }
        case "Log by session or message ID":
          this.ask("Log", ["Session name (blank for all)", "Message ID (optional)"], async ([name, msgId]) => {
            const reply = await this.client.request("log", { name: name || undefined, msgId: msgId || undefined, limit: 200 });
            this.showPanel(`Log${name ? ` · ${name}` : ""}${msgId ? ` · ${msgId}` : ""}`, { messages: reply.messages as StoredMessage[] });
          }, [selected?.name ?? ""]);
          break;
        case "Held messages": {
          const reply = await this.client.request("held");
          this.showPanel("Held messages · ? → Release / Drop", { messages: reply.messages as StoredMessage[] });
          break;
        }
        case "Release held message":
          this.ask("Release held message", ["Message ID"], async ([msgId]) => {
            const reply = await this.client.request("release", { msgId });
            this.say(`${msgId}: ${String(reply.status)}`);
          }, [], ["Delivers the held message to its target now."]);
          break;
        case "Drop held message":
          this.ask("Drop held message", ["Message ID", "Type yes to confirm permanent drop"], async ([msgId, yes]) => {
            if (yes !== "yes") throw new Error("Not dropped: type yes to confirm");
            await this.client.request("drop", { msgId });
            this.say(`${msgId}: dropped`);
          }, [], ["Permanently drops the held message; it is never delivered."]);
          break;
        case "Rename session":
          this.ask("Rename session", ["Current name", "New name"], async ([from, name]) => {
            const reply = await this.client.request("rename", { from, name });
            this.say(`${from} → ${String(reply.name)}`);
          }, [selected?.name ?? ""], ["Renaming keeps the same stable session identity and conversation."]);
          break;
        case "Inbound policy":
          this.ask("Inbound policy", ["Session", "accept/hold/refuse"], async ([name, mode]) => {
            await this.client.request("set_inbound", { name, mode });
            this.say(`${name}: ${mode}`);
          }, [selected?.name ?? "", selected?.inbound ?? "accept"], ["accept delivers, hold keeps agent messages for review, refuse rejects them."]);
          break;
        case "Set role":
          this.ask("Set role", ["Session", "orchestrator/worker/unset"], async ([name, role]) => {
            await this.client.request("set_role", { name, role: role === "unset" ? null : role });
            this.say(`${name}: ${role}`);
          }, [selected?.name ?? "", selected?.role ?? "unset"], ["Roles do not restrict messaging. Orchestrators can edit members and roles within their own channels."]);
          break;
        case "Daemon status": await this.executeLocal(["daemon", "status"]); break;
        case "Daemon start": await this.executeLocal(["daemon", "start"]); break;
        case "Daemon stop":
          this.ask("Stop daemon", ["Type yes to stop the daemon and exit the TUI"], async ([yes]) => {
            if (yes === "yes") await this.executeLocal(["daemon", "stop"], true);
          }, [], ["Stops message routing for every connected session until it is started again."]);
          break;
        case "Setup": await this.executeLocal(["setup"]); break;
        case "Remove setup":
          this.ask("Remove setup", ["Type yes to remove hooks, stop the daemon and exit the TUI"], async ([yes]) => {
            if (yes === "yes") await this.executeLocal(["setup", "--remove"], true);
          });
          break;
        case "Doctor": await this.executeLocal(["doctor"]); break;
        case "Reconnect": await this.hydrate(); break;
        case "Help": this.showPanel("Help", { lines: HELP }); break;
        case "Error details": this.showPanel("Last error", { lines: [this.errorDetail || "No errors this session."] }); break;
        case "Quit": return this.quit();
      }
    } catch (e) {
      this.say(stringify(e), "error");
    }
    this.render();
  }
}

export async function runTui(): Promise<number> {
  return new ConsoleApp().run();
}
