import { spawnSync } from "node:child_process";
import { AsenqClient } from "../shared/client.js";
import { KINDS } from "../shared/protocol.js";
import type { HistoryScope, ReadScope, ReadState, SessionIdentity, StoredMessage, SyncResult, PositionedEvent, SendResult } from "../shared/protocol.js";
import { TerminalAdapter, terminalTextWidth, truncateTerminalText } from "./terminal.js";
import type { KeyInput, MouseInput } from "./terminal.js";

type View = "sessions" | "inbox" | "activity" | "channels" | "channel" | "held" | "log" | "output";
type Form = { title: string; fields: { label: string; value: string; multiline?: boolean }[]; focus: number; submit(values: string[]): Promise<void>; binding?: { id: string; name: string; edited: boolean } };
type Page = { messages: StoredMessage[]; hasMore: boolean; loading: boolean; scroll: number };
const ACTIONS = ["Compose / send", "Broadcast", "Inbox", "Activity", "Log by session or message ID", "Channels", "Read channel", "Post channel", "Held messages", "Release held message", "Drop held message", "Rename session", "Inbound policy", "Mark read", "Mark latest unread", "List sessions", "Daemon status", "Daemon start", "Daemon stop", "Setup", "Remove setup", "Doctor", "Reconnect", "Help", "Quit"] as const;
type Action = typeof ACTIONS[number];
const messageLabel = (m: StoredMessage): string => {
  const meta = [m.kind, m.thread && `thread=${m.thread}`, m.replyTo && `reply=${m.replyTo}`, m.done && "done"].filter(Boolean).join(" · ");
  return `${new Date(m.createdAt).toLocaleTimeString()} ${m.from} → ${m.to} ${m.status}${m.reason ? ` (${m.reason})` : ""}${meta ? ` · ${meta}` : ""} · ${m.id}`;
};
function activityLabel(item: PositionedEvent): string {
  const event = item.event;
  if (event.type === "message") return `${item.position} ${messageLabel(event.msg)}`;
  if (event.type === "session") return `${item.position} ${event.action} ${event.name}`;
  if (event.type === "read") {
    const stream = event.state.scope.scope === "session" ? event.state.scope.sessionId : `#${event.state.scope.channel}`;
    return `${item.position} read marker ${stream} · ${event.state.unread} unread`;
  }
  return `${item.position} retention pruned older records`;
}
const stringify = (e: unknown): string => e instanceof Error ? e.message : String(e);
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

class ConsoleApp {
  private readonly terminal: TerminalAdapter;
  private readonly client: AsenqClient;
  private sessions: SessionIdentity[] = [];
  private channels: { name: string; count: number; lastAt: number }[] = [];
  private readStates = new Map<string, ReadState>();
  private pages = new Map<string, Page>();
  private activity: PositionedEvent[] = [];
  private activityHistory: StoredMessage[] = [];
  private selected = 0;
  private channel = "";
  private view: View = "sessions";
  private viewScroll = 0;
  private form?: Form;
  private menu = false;
  private menuSelected = 0;
  private notice = "Connecting…";
  private output: string[] = [];
  private watermark = 0;
  private pushedPosition = 0;
  private syncing = false;
  private replaying = false;
  private retentionChanged = false;
  private disconnected = false;
  private closed = false;
  private drafts = new Map<string, string>();
  private resolve!: (code: number) => void;

  constructor() {
    this.client = new AsenqClient({ autoStart: true, onPush: (p) => {
      if (p.push === "event") {
        this.pushedPosition = Math.max(this.pushedPosition, p.position);
        if (p.position > this.watermark) void this.replay();
      }
    }, onReconnect: async () => { await this.hydrate(); } });
    this.terminal = new TerminalAdapter({
      onKey: (k) => void this.key(k), onMouse: (m) => void this.mouse(m),
      onResize: () => this.render(), onPaste: (s) => { if (this.form) { this.insert(s); this.render(); } },
      onInterrupt: () => this.quit(),
    });
  }

  async run(): Promise<number> {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      process.stderr.write("asenq tui requires a usable terminal (TTY); use asenq commands without one\n");
      return 1;
    }
    this.terminal.start();
    const done = new Promise<number>((resolve) => { this.resolve = resolve; });
    this.render();
    void this.hydrate();
    return done;
  }

  private quit(code = 0): void {
    if (this.closed) return;
    this.closed = true;
    this.client.close();
    this.terminal.cleanup();
    this.resolve(code);
  }

  private selectedSession(): SessionIdentity | undefined { return this.sessions[this.selected]; }
  private scope(): HistoryScope | undefined {
    if (this.view === "sessions") {
      const s = this.selectedSession();
      return s && { scope: "session", sessionId: s.id };
    }
    if (this.view === "inbox") return { scope: "inbox" };
    if (this.view === "channel" && this.channel) return { scope: "channel", channel: this.channel };
    return undefined;
  }
  private keyOf(scope: HistoryScope): string {
    return scope.scope === "session" ? `s:${scope.sessionId}` : scope.scope === "channel" ? `c:${scope.channel}` : "inbox";
  }
  private marker(scope: ReadScope): ReadState | undefined { return this.readStates.get(this.keyOf(scope)); }

  private async hydrate(): Promise<void> {
    if (this.closed || this.syncing) return;
    this.syncing = true;
    try {
      const previous = this.watermark;
      const snapshot = await this.client.sync();
      this.applySnapshot(snapshot);
      if (previous) this.watermark = previous; // replay missed events before trusting the new watermark
      this.disconnected = false;
      this.notice = "Connected · ? actions · ↑↓ sessions · Enter compose · End read · u unread · q quit";
      const scope = this.scope();
      if (scope) await this.load(scope);
    } catch (e) {
      this.disconnected = true;
      this.notice = `Disconnected: ${stringify(e)} · ? setup/doctor/reconnect · q quit`;
    } finally {
      this.syncing = false;
      this.render();
      if (!this.disconnected) void this.replay();
    }
  }

  private applySnapshot(s: SyncResult): void {
    const id = this.selectedSession()?.id;
    this.sessions = s.sessions;
    this.selected = Math.max(0, id ? this.sessions.findIndex((x) => x.id === id) : 0);
    this.channels = s.channels;
    this.readStates = new Map(s.readStates.map((r) => [this.keyOf(r.scope), r]));
    this.watermark = s.watermark;
  }

  private async replay(): Promise<void> {
    if (this.closed || this.replaying || this.syncing) return;
    this.replaying = true;
    try {
      for (;;) {
        const r = await this.client.replay(this.watermark);
        if (r.gap) {
          this.notice = "History gap: retained events were pruned. Snapshot reloaded; older missing changes cannot be recovered.";
          const snapshot = await this.client.sync();
          this.applySnapshot(snapshot);
          this.pages.clear();
          const scope = this.scope();
          if (scope) await this.load(scope);
          break;
        }
        for (const event of r.events) {
          this.watermark = Math.max(this.watermark, event.position);
          this.applyEvent(event);
        }
        if (!r.hasMore) break;
      }
      this.disconnected = false;
    } catch (e) {
      this.disconnected = true;
      this.notice = `Disconnected: ${stringify(e)} · reconnecting`;
    } finally {
      this.replaying = false;
      this.render();
      if (this.retentionChanged) {
        this.retentionChanged = false;
        this.pages.clear();
        this.activityHistory = [];
        this.notice = "Retention removed older history; refreshing retained conversations.";
        void this.hydrate();
      } else if (!this.disconnected && this.pushedPosition > this.watermark) void this.replay();
    }
  }

  private applyEvent(item: PositionedEvent): void {
    this.activity.push(item);
    if (this.activity.length > 200) this.activity.shift();
    const e = item.event;
    if (e.type === "message") {
      const m = e.msg as StoredMessage;
      const historical = this.activityHistory.findIndex((x) => x.id === m.id);
      if (historical >= 0) this.activityHistory[historical] = { ...this.activityHistory[historical], ...m, status: e.status, reason: e.reason };
      for (const [key, page] of this.pages) {
        if (key === `s:${m.fromSessionId}` || key === `s:${m.toSessionId}` ||
            (key === "inbox" && m.to === "human") || (key === `c:${m.channel}`)) {
          const i = page.messages.findIndex((x) => x.id === m.id);
          if (i >= 0) page.messages[i] = { ...page.messages[i], ...m, status: e.status, reason: e.reason };
          else {
            page.messages.push(m);
            page.scroll += m.text.split(/\r?\n/).length + 2; // keep the old bottom line anchored
          }
          page.messages.sort((a, b) => a.order - b.order);
        }
      }
    } else if (e.type === "read") {
      this.readStates.set(this.keyOf(e.state.scope), e.state);
    } else if (e.type === "session") {
      const index = this.sessions.findIndex((s) => s.id === e.session.id);
      if (index >= 0) this.sessions[index] = e.session;
      else this.sessions.push(e.session);
    } else if (e.type === "retention") {
      this.retentionChanged = true;
    }
  }

  private async load(scope: HistoryScope, older = false): Promise<void> {
    const key = this.keyOf(scope);
    const current = this.pages.get(key) ?? { messages: [], hasMore: true, loading: false, scroll: 0 };
    if (current.loading || (older && !current.hasMore)) return;
    current.loading = true;
    this.pages.set(key, current);
    this.render();
    try {
      const before = older ? current.messages[0]?.order : undefined;
      const page = await this.client.historyPage({ ...scope, before, limit: 60 });
      const prior = new Set(current.messages.map((m) => m.id));
      const added = page.messages.filter((m) => !prior.has(m.id));
      current.messages = [...added, ...current.messages].sort((a, b) => a.order - b.order);
      current.hasMore = page.hasMore;
    } catch (e) { this.notice = `History: ${stringify(e)}`; }
    finally { current.loading = false; this.render(); }
  }

  private async select(index: number): Promise<void> {
    this.selected = Math.max(0, Math.min(index, this.sessions.length - 1));
    this.view = "sessions";
    this.render();
    const scope = this.scope();
    if (scope && !this.pages.has(this.keyOf(scope))) await this.load(scope);
  }

  private render(): void {
    if (this.closed) return;
    const { columns: width, rows: height } = this.terminal.size;
    const w = Math.max(20, width);
    const h = Math.max(6, height);
    const side = w >= 64 ? Math.min(28, Math.floor(w * .32)) : 0;
    const mainWidth = w - side - (side ? 1 : 0);
    const navStart = Math.max(0, this.selected - (h - 6));
    const nav = [`asenq  ${this.disconnected ? "OFFLINE" : "human"}  [${this.view}]`, ...this.sessions.slice(navStart, navStart + h - 5).map((s, n) => {
      const marker = this.marker({ scope: "session", sessionId: s.id });
      return `${n + navStart === this.selected ? "›" : " "} ${s.name} ${s.state !== "live" ? `(${s.state} ${s.id.slice(-6)})` : ""}${marker?.unread ? ` [${marker.unread}]` : ""}${marker?.reminder ? " !" : ""}`;
    })];
    const body: string[] = [];
    const scope = this.scope();
    if (scope) {
      const page = this.pages.get(this.keyOf(scope));
      const s = this.selectedSession();
      const title = scope.scope === "session"
        ? `${s?.name ?? "No session"} · ${s?.state ?? ""} · ${s?.id ?? ""}${s?.previousNames.length ? ` · formerly ${s.previousNames.join(", ")}` : ""}`
        : scope.scope === "channel" ? `#${scope.channel}` : "Human inbox";
      body.push(title, "─".repeat(Math.min(mainWidth, 30)));
      if (page) for (const m of page.messages) {
        body.push(messageLabel(m));
        body.push(...m.text.split(/\r?\n/).map((line) => `  ${line}`));
        body.push("");
      }
      if (!page?.messages.length) body.push(page?.loading ? "Loading…" : "No retained messages");
      if (page?.hasMore) body.unshift("↑ PageUp: older history");
    } else if (this.view === "activity") {
      const historyIds = new Set(this.activityHistory.map((m) => m.id));
      body.push("Global activity · latest 200 retained messages plus live session changes",
        ...this.activityHistory.map(messageLabel),
        ...this.activity.filter((e) => e.event.type !== "message" || !historyIds.has(e.event.msg.id))
          .map(activityLabel));
    } else if (this.view === "channels") {
      body.push("Channels · choose with number or action menu", ...this.channels.map((c, i) => {
        const marker = this.marker({ scope: "channel", channel: c.name });
        return `${i + 1}. #${c.name} (${c.count} retained)${marker?.unread ? ` [${marker.unread}]` : ""}${marker?.reminder ? " !" : ""}`;
      }));
    } else if (this.view === "output" || this.view === "log" || this.view === "held") body.push(...this.output);
    const page = scope ? this.pages.get(this.keyOf(scope)) : undefined;
    const available = h - 4;
    const offset = page?.scroll ?? this.viewScroll;
    const start = Math.max(0, body.length - available - offset);
    const visible = body.slice(start, start + available);
    const lines: string[] = [];
    for (let y = 0; y < available; y++) {
      const label = side ? truncateTerminalText(nav[y] ?? "", side) : "";
      const left = side ? label + " ".repeat(Math.max(0, side - terminalTextWidth(label))) + "│" : "";
      lines.push(truncateTerminalText(left + (visible[y] ?? ""), w));
    }
    lines.push("─".repeat(w));
    lines.push(truncateTerminalText(this.notice, w));
    lines.push(truncateTerminalText("? menu  c compose  i inbox  a activity  # channels  PgUp/PgDn scroll  End read  u unread", w));
    lines.push(truncateTerminalText("↑↓ sessions  Enter compose  Esc back  q quit", w));
    if (this.menu) {
      const count = Math.min(ACTIONS.length, h - 3);
      const first = Math.max(0, Math.min(this.menuSelected - count + 1, ACTIONS.length - count));
      for (let i = 0; i < count; i++) lines[i] = truncateTerminalText(`${first + i === this.menuSelected ? "›" : " "} ${ACTIONS[first + i]}`, w);
      lines[h - 2] = `Actions ${first + 1}–${first + count}/${ACTIONS.length} · ↑↓ select · Enter open · Esc close`;
    }
    if (this.form) {
      const f = this.form;
      lines[0] = truncateTerminalText(` ${f.title} · Tab next · Ctrl+D submit · Esc cancel`, w);
      const count = Math.max(1, h - 4);
      const first = Math.max(0, Math.min(f.focus - count + 1, f.fields.length - count));
      for (let row = 0; row < count && first + row < f.fields.length; row++) {
        const i = first + row;
        const field = f.fields[i];
        const value = field.value.replace(/\n/g, "↵");
        lines[row + 1] = truncateTerminalText(`${i === f.focus ? "›" : " "} ${field.label}: ${value}`, w);
      }
      lines[h - 2] = "Multiline: Enter newline · Ctrl+D submit · Tab next field";
    }
    this.terminal.render({ lines });
  }

  private async reachedEnd(explicit = false): Promise<void> {
    const scope = this.scope();
    if (!scope || scope.scope === "inbox") return;
    const page = this.pages.get(this.keyOf(scope));
    const state = this.marker(scope);
    if (!page || !state) return;
    const incoming = (m: StoredMessage): boolean =>
      scope.scope === "channel" ? m.from !== "human" : m.fromSessionId === scope.sessionId && m.to === "human";
    const index = page.messages.findLastIndex(incoming);
    let latest: StoredMessage | undefined = page.messages[index];
    if (!explicit && latest) {
      let followingLines = 0;
      for (let i = index + 1; i < page.messages.length; i++) {
        const text = page.messages[i].text;
        followingLines += 3; // heading, first text line and separator
        for (let j = 0; j < text.length; j++) if (text.charCodeAt(j) === 10) followingLines++;
      }
      if (followingLines >= Math.max(1, this.terminal.size.rows - 4)) return;
    }
    if (explicit && !latest && page.hasMore) {
      let before = page.messages[0]?.order;
      while (before !== undefined) {
        const older = await this.client.historyPage({ ...scope, before, limit: 200 });
        latest = older.messages.findLast(incoming);
        if (latest || !older.hasMore) break;
        before = older.messages[0]?.order;
      }
    }
    if (!latest) return;
    try {
      const result = await this.client.markRead(scope, latest.order, state.version);
      this.readStates.set(this.keyOf(scope), result.state);
      if (!result.applied) this.notice = "Read position changed in another window; press End again to confirm.";
    } catch (e) { this.notice = stringify(e); }
    this.render();
  }

  private async markUnread(): Promise<void> {
    const scope = this.scope();
    if (!scope || scope.scope === "inbox") { this.notice = "Select a session or channel to mark unread"; this.render(); return; }
    const state = this.marker(scope);
    if (!state) return;
    try {
      const r = await this.client.markUnread(scope, state.version);
      this.readStates.set(this.keyOf(scope), r.state);
      if (!r.applied) this.notice = "Marker changed in another window; repeat to confirm.";
    } catch (e) { this.notice = stringify(e); }
    this.render();
  }

  private draftKey(form: Form): string {
    const target = form.fields[0].value;
    return form.binding && !form.binding.edited && target === form.binding.name ? `session:${form.binding.id}` : `target:${target}`;
  }

  private insert(s: string): void {
    const f = this.form;
    if (!f) return;
    const field = f.fields[f.focus];
    field.value += s;
    if (f.focus === 0 && s && f.binding) f.binding.edited = true;
    if (f.title === "Compose") this.drafts.set(this.draftKey(f), f.fields[1].value);
  }

  private async key(k: KeyInput): Promise<void> {
    const name = k.name;
    if (name === "CTRL_C") return this.quit();
    if (this.form) {
      const f = this.form;
      if (name === "ESCAPE") { this.form = undefined; this.render(); return; }
      if (name === "TAB" || (name === "ENTER" && !f.fields[f.focus].multiline)) { f.focus = (f.focus + 1) % f.fields.length; this.render(); return; }
      if (name === "CTRL_D" || name === "CTRL_ENTER") {
        try { await f.submit(f.fields.map((x) => x.value)); if (this.form === f) this.form = undefined; }
        catch (e) { this.notice = stringify(e); }
        this.render(); return;
      }
      const field = f.fields[f.focus];
      if (name === "CTRL_U") field.value = "";
      else if (name === "BACKSPACE") {
        let last = 0;
        for (const part of graphemes.segment(field.value)) last = part.index;
        field.value = field.value.slice(0, last);
      } else if (name === "ENTER" && field.multiline) this.insert("\n");
      else if (k.text) this.insert(k.text);
      if (f.focus === 0 && (name === "CTRL_U" || name === "BACKSPACE") && f.binding) f.binding.edited = true;
      if (f.title === "Compose") this.drafts.set(this.draftKey(f), f.fields[1].value);
      this.render(); return;
    }
    if (this.menu) {
      if (name === "ESCAPE") this.menu = false;
      else if (name === "UP") this.menuSelected = Math.max(0, this.menuSelected - 1);
      else if (name === "DOWN") this.menuSelected = Math.min(ACTIONS.length - 1, this.menuSelected + 1);
      else if (name === "ENTER") { const action = ACTIONS[this.menuSelected]; this.menu = false; await this.action(action); }
      this.render(); return;
    }
    if (name === "ESCAPE") { this.view = "sessions"; this.render(); return; }
    if (name === "UP" && this.view === "sessions") return this.select(this.selected - 1);
    if (name === "DOWN" && this.view === "sessions") return this.select(this.selected + 1);
    if (name === "UP" && !this.scope()) { this.viewScroll++; this.render(); return; }
    if (name === "DOWN" && !this.scope()) { this.viewScroll = Math.max(0, this.viewScroll - 1); this.render(); return; }
    if (name === "PAGE_UP") {
      const scope = this.scope(); const page = scope && this.pages.get(this.keyOf(scope));
      if (page) { page.scroll += 10; if (page.scroll >= page.messages.length - 10 && scope) await this.load(scope, true); }
      else this.viewScroll += 10;
    } else if (name === "PAGE_DOWN") {
      const scope = this.scope(); const page = scope && this.pages.get(this.keyOf(scope));
      if (page) { page.scroll = Math.max(0, page.scroll - 10); if (!page.scroll) await this.reachedEnd(); }
      else this.viewScroll = Math.max(0, this.viewScroll - 10);
    } else if (name === "END") {
      const scope = this.scope(); const page = scope && this.pages.get(this.keyOf(scope));
      if (page) { page.scroll = 0; await this.reachedEnd(); }
      else this.viewScroll = 0;
    } else if (name === "ENTER" || k.text === "c") await this.action("Compose / send");
    else if (k.text === "?") this.menu = true;
    else if (k.text === "q") this.quit();
    else if (k.text === "i") await this.action("Inbox");
    else if (k.text === "a") await this.action("Activity");
    else if (k.text === "#") await this.action("Channels");
    else if (k.text === "u") await this.markUnread();
    else if (this.view === "channels" && /^[1-9]$/.test(k.text ?? "")) {
      const ch = this.channels[Number(k.text) - 1]; if (ch) await this.openChannel(ch.name);
    }
    this.render();
  }

  private async mouse(m: MouseInput): Promise<void> {
    if (m.action === "wheel-up" || m.action === "wheel-down") {
      const scope = this.scope(); const page = scope && this.pages.get(this.keyOf(scope));
      const delta = m.action === "wheel-up" ? 3 : -3;
      if (page) {
        page.scroll = Math.max(0, page.scroll + delta);
        if (page.scroll >= page.messages.length - 8 && scope) await this.load(scope, true);
        if (m.action === "wheel-down" && page.scroll === 0) await this.reachedEnd();
      }
      else this.viewScroll = Math.max(0, this.viewScroll + delta);
    } else if (m.action === "press" && m.button === "left") {
      if (this.menu) {
        const count = Math.min(ACTIONS.length, Math.max(6, this.terminal.size.rows) - 3);
        const first = Math.max(0, Math.min(this.menuSelected - count + 1, ACTIONS.length - count));
        const i = first + m.row; if (m.row >= 0 && m.row < count) { this.menuSelected = i; this.menu = false; await this.action(ACTIONS[i]); }
      } else if (m.column < Math.min(28, Math.floor(this.terminal.size.columns * .32)) && m.row >= 1) {
        const navStart = Math.max(0, this.selected - (Math.max(6, this.terminal.size.rows) - 6));
        await this.select(navStart + m.row - 1);
      }
    }
    this.render();
  }

  private openForm(title: string, fields: Form["fields"], submit: Form["submit"], binding?: Form["binding"]): void {
    this.form = { title, fields, focus: 0, submit, binding };
    this.render();
  }
  private ask(title: string, labels: string[], submit: (v: string[]) => Promise<void>, defaults: string[] = []): void {
    this.openForm(title, labels.map((label, i) => ({ label, value: defaults[i] ?? "" })), submit);
  }
  private async openChannel(channel: string): Promise<void> {
    this.channel = channel; this.view = "channel";
    const scope = this.scope(); if (scope) await this.load(scope);
  }
  private async send(target: string, text: string, kind: string, thread: string, replyTo: string, done: string, confirmation?: string, binding?: Form["binding"]): Promise<void> {
    if (!text.trim()) throw new Error("Message text is empty");
    const count = this.sessions.filter((s) => s.state === "live").length;
    if (target === "*" && confirmation !== `yes ${count}`) throw new Error(`Broadcast to ${count} live sessions: enter 'yes ${count}' to confirm`);
    const kindOption = KINDS.find((candidate) => candidate === kind);
    if (kind && !kindOption) throw new Error(`Kind must be one of ${KINDS.join(", ")}`);
    if (done && !["yes", "no", "true", "false"].includes(done)) throw new Error("Done must be yes or no");
    const options = { kind: kindOption, thread: thread || undefined, replyTo: replyTo || undefined, done: done === "yes" || done === "true" };
    try {
      const results = binding && !binding.edited && target === binding.name
        ? [await this.client.sendToSession(binding.id, text, options)]
        : (await this.client.request("send", { to: target, text, ...options })).results as SendResult[];
      this.notice = results.map((x) => `${x.to}: ${x.status}${x.msgId ? ` ${x.msgId}` : ""}${x.reason ? ` (${x.reason})` : ""}`).join(" · ") || "No live broadcast recipients";
      this.drafts.delete(binding && !binding.edited && target === binding.name ? `session:${binding.id}` : `target:${target}`);
      await this.replay();
    } catch (e) {
      this.notice = `Send failed or outcome unknown (${stringify(e)}). Check log before retrying; draft retained.`;
      throw e;
    }
  }
  private async executeLocal(args: string[], exit = false): Promise<void> {
    if (exit) { this.quit(); }
    const child = spawnSync(process.execPath, [process.argv[1], ...args], { encoding: "utf8", timeout: 60_000 });
    this.output = [`$ asenq ${args.join(" ")}`, ...(child.stdout ?? "").split("\n"), ...(child.stderr ?? "").split("\n"), `Exit: ${child.status ?? child.error?.message ?? "unknown"}`];
    if (!exit) { this.view = "output"; this.render(); }
    else process.stdout.write(this.output.join("\n") + "\n");
  }
  private async action(action: Action): Promise<void> {
    this.viewScroll = 0;
    const selected = this.selectedSession();
    try {
      switch (action) {
        case "Compose / send":
        case "Broadcast": {
          const target = action === "Broadcast" ? "*" : selected?.state !== "removed" ? selected?.name ?? "human" : "human";
          const binding = action !== "Broadcast" && selected?.state !== "removed" && selected ? { id: selected.id, name: selected.name, edited: false } : undefined;
          const count = this.sessions.filter((s) => s.state === "live").length;
          const draftKey = binding ? `session:${binding.id}` : `target:${target}`;
          this.openForm("Compose", [
            { label: "Target (session/human/*)", value: target }, { label: "Text", value: this.drafts.get(draftKey) ?? "", multiline: true },
            { label: "Kind (chat/task/result/status)", value: "" }, { label: "Thread", value: "" },
            { label: "Reply-to message ID", value: "" }, { label: "Done (yes/no)", value: "no" },
            ...(target === "*" ? [{ label: `Broadcast to ${count} live sessions: type yes ${count}`, value: "" }] : []),
          ], async ([to, text, kind, thread, reply, done, confirm]) => this.send(to, text, kind, thread, reply, done, confirm, binding), binding);
          break;
        }
        case "Inbox": this.view = "inbox"; await this.load({ scope: "inbox" }); break;
        case "Activity": {
          const r = await this.client.request("log", { limit: 200 });
          this.activityHistory = r.messages as StoredMessage[];
          this.view = "activity"; break;
        }
        case "Log by session or message ID":
          this.ask("Log", ["Session name (blank for all)", "Message ID (optional)"], async ([name, msgId]) => {
            const r = await this.client.request("log", { name: name || undefined, msgId: msgId || undefined, limit: 200 });
            this.output = (r.messages as StoredMessage[]).flatMap((m) => [messageLabel(m), m.text, ""]);
            this.view = "log";
          }); break;
        case "Channels": {
          const r = await this.client.request("channel_list");
          this.channels = r.channels as typeof this.channels;
          this.view = "channels"; break;
        }
        case "Read channel": this.ask("Read channel", ["Channel"], async ([channel]) => this.openChannel(channel)); break;
        case "Post channel": this.openForm("Post channel", [{ label: "Channel", value: this.channel }, { label: "Text", value: "", multiline: true }], async ([channel, text]) => {
          const r = await this.client.request("channel_send", { channel, text }); this.notice = `Posted #${channel} ${r.msgId}`; await this.replay();
        }); break;
        case "Held messages": {
          const r = await this.client.request("held");
          this.output = ["Held messages", ...(r.messages as StoredMessage[]).flatMap((m) => [messageLabel(m), m.text, ""])];
          this.view = "held"; break;
        }
        case "Release held message": this.ask("Release", ["Message ID"], async ([msgId]) => {
          const r = await this.client.request("release", { msgId }); this.notice = `${msgId}: ${r.status}`;
        }); break;
        case "Drop held message": this.ask("Drop", ["Message ID", "Type yes to confirm permanent drop"], async ([msgId, yes]) => {
          if (yes !== "yes") return;
          await this.client.request("drop", { msgId }); this.notice = `${msgId}: dropped`;
        }); break;
        case "Rename session": this.ask("Rename", ["Current name", "New name"], async ([from, name]) => {
          const r = await this.client.request("rename", { from, name }); this.notice = `${from} → ${r.name}`;
        }, [selected?.name ?? ""]); break;
        case "Inbound policy": this.ask("Inbound", ["Session", "accept/hold/refuse"], async ([name, mode]) => {
          await this.client.request("set_inbound", { name, mode }); this.notice = `${name}: ${mode}`;
        }, [selected?.name ?? "", selected?.inbound ?? "accept"]); break;
        case "Mark read": await this.reachedEnd(true); break;
        case "Mark latest unread": await this.markUnread(); break;
        case "List sessions": this.view = "sessions"; break;
        case "Daemon status": case "Daemon start": await this.executeLocal(["daemon", action === "Daemon status" ? "status" : "start"]); break;
        case "Daemon stop": this.ask("Stop daemon", ["Type yes to stop daemon and exit TUI"], async ([yes]) => {
          if (yes === "yes") await this.executeLocal(["daemon", "stop"], true);
        }); break;
        case "Setup": await this.executeLocal(["setup"]); break;
        case "Remove setup": this.ask("Remove setup", ["Type yes to remove hooks and stop daemon, then exit TUI"], async ([yes]) => {
          if (yes === "yes") await this.executeLocal(["setup", "--remove"], true);
        }); break;
        case "Doctor": await this.executeLocal(["doctor"]); break;
        case "Reconnect": await this.hydrate(); break;
        case "Help": this.view = "output"; this.output = ["asenq TUI", "? action menu · arrows/Enter navigate", "c compose · Ctrl+D submit · Tab next field · Esc cancel", "i inbox · a activity · # channels · PageUp older · PageDown/End newest", "u mark latest unread · q quit", "CLI commands remain available in another terminal."]; break;
        case "Quit": this.quit(); break;
      }
    } catch (e) { this.notice = stringify(e); }
    this.render();
  }
}

export async function runTui(): Promise<number> { return new ConsoleApp().run(); }
