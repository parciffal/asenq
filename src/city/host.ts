import { AsenqError } from "../shared/protocol.js";
import type { HistoryPage, HistoryScope, Inbound, ListedSession, ReadScope, ReadState, Role, SendOptions, StoredMessage } from "../shared/protocol.js";
import { TICK_MS, VizMap } from "../viz/map.js";
import { readVizSettings } from "../viz/settings.js";
import type { VizSettings } from "../viz/settings.js";
import { CitySource } from "../viz/source.js";
import type { CitySourceDeps } from "../viz/source.js";
import type { CityPacket } from "../viz/types.js";
import { scanProcesses } from "../viz/scan.js";
import type { ProcInfo } from "../viz/scan.js";
import { toWire } from "./wire.js";
import type { CityWire } from "./wire.js";

export type CityDeps = CitySourceDeps & {
  schedule?(fn: () => void, ms: number): () => void;
  settings?(): { settings: VizSettings; warning: string | null };
  reducedMotion?: boolean;
  kill?(pid: number, signal: "SIGTERM"): void;
};
export type CityEvent =
  | { event: "state"; data: CityWire }
  | { event: "packet"; data: CityPacket }
  | { event: "message"; data: { msg: StoredMessage } }
  | { event: "read"; data: { state: ReadState } };

export type ConversationSummary = {
  key: string; scope: ReadScope; title: string; archived: boolean; unread: number;
  reminder: boolean; lastOrder: number; lastActivity: number;
  preview: { text: string; from: string; createdAt: number } | null;
};
export type ManageOp =
  | { op: "session.rename"; id: string; name: string }
  | { op: "session.role"; id: string; role: Role | null }
  | { op: "session.inbound"; id: string; mode: Inbound }
  | { op: "session.ping"; id: string }
  | { op: "session.close"; id: string; terminate: boolean }
  | { op: "session.closeStale" }
  | { op: "session.replace"; fromId: string; toId: string }
  | { op: "session.purge"; id: string; all?: never }
  | { op: "session.purge"; all: true; id?: never }
  | { op: "channel.create"; name: string }
  | { op: "channel.rename"; name: string; to: string }
  | { op: "channel.delete"; name: string }
  | { op: "channel.add" | "channel.remove"; name: string; id: string }
  | { op: "held.release" | "held.drop"; msgId: string }
  | { op: "process.kill"; pid: number }
  | { op: "read.mark"; scope: ReadScope; state: "read" | "unread" };

/** A headless city projection; only explicit management changes human read markers. */
export class CityHost {
  private readonly map: VizMap;
  private readonly source: CitySource;
  private readonly warning: string | null;
  private readonly reducedMotion: boolean;
  private readonly listeners = new Set<(event: CityEvent) => void>();
  private readonly schedule: (fn: () => void, ms: number) => () => void;
  private readonly scan: () => Promise<ProcInfo[]>;
  private readonly kill: (pid: number, signal: "SIGTERM") => void;
  private lastState: string;
  private stopTicks?: () => void;
  private started = false;
  private closed = false;

  constructor(deps: CityDeps = {}) {
    const { settings, warning } = (deps.settings ?? readVizSettings)();
    this.scan = deps.scan ?? scanProcesses;
    this.kill = deps.kill ?? ((pid, signal) => { process.kill(pid, signal); });
    this.warning = warning;
    this.reducedMotion = (deps.reducedMotion ?? false) || settings.reducedMotion;
    this.map = new VizMap({
      settings, settingsWarning: warning, reducedMotion: this.reducedMotion, color: false,
      onPacket: (data) => this.broadcast({ event: "packet", data }),
    });
    this.lastState = JSON.stringify(this.current());
    this.source = new CitySource(this.map, {
      changed: () => this.changed(),
      event: (event) => {
        if (event.type === "message") this.broadcast({ event: "message", data: { msg: event.msg } });
        else if (event.type === "read") this.broadcast({ event: "read", data: { state: event.state } });
      },
    }, deps);
    this.schedule = deps.schedule ?? ((fn, ms) => {
      const timer = setInterval(fn, ms);
      return () => clearInterval(timer);
    });
  }

  start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    this.source.start();
    this.stopTicks = this.schedule(() => {
      this.source.fetch(this.map.step(TICK_MS));
    }, TICK_MS);
  }

  subscribe(listener: (event: CityEvent) => void): () => void {
    this.listeners.add(listener);
    listener({ event: "state", data: this.current() });
    return () => { this.listeners.delete(listener); };
  }

  current(): CityWire { return toWire(this.map.view(), this.warning, this.reducedMotion); }

  history(scope: HistoryScope, before?: number): Promise<HistoryPage> {
    return this.source.client.historyPage({ ...scope, ...(before === undefined ? {} : { before }), limit: 60 });
  }

  async conversations(): Promise<ConversationSummary[]> {
    const snapshot = await this.source.client.sync();
    const summaries = await this.source.client.inboxSummaries();
    const reads = new Map(snapshot.readStates.map((state) => [
      state.scope.scope === "channel" ? `ch:${state.scope.channel}` : `s:${state.scope.sessionId}`, state,
    ]));
    const previews = new Map(summaries.map((summary) => [summary.sessionId, summary]));
    const conversations: ConversationSummary[] = snapshot.channels.map((channel) => {
      const key = `ch:${channel.name}`;
      const read = reads.get(key);
      return {
        key, scope: { scope: "channel", channel: channel.name }, title: channel.name, archived: false,
        unread: read?.unread ?? 0, reminder: read?.reminder != null,
        lastOrder: channel.lastOrder, lastActivity: channel.lastAt, preview: null,
      };
    });
    for (const session of snapshot.sessions) {
      const lastOrder = snapshot.sessionLastOrders[session.id] ?? 0;
      if (session.state === "removed" && lastOrder === 0) continue;
      const key = `s:${session.id}`;
      const read = reads.get(key);
      const preview = previews.get(session.id);
      conversations.push({
        key, scope: { scope: "session", sessionId: session.id }, title: session.name,
        archived: session.state === "removed", unread: read?.unread ?? 0, reminder: read?.reminder != null,
        lastOrder, lastActivity: snapshot.sessionLastActivity[session.id] ?? 0,
        preview: preview ? { text: preview.latest.text, from: preview.name, createdAt: preview.latest.createdAt } : null,
      });
    }
    return conversations.sort((a, b) => b.lastActivity - a.lastActivity || a.title.localeCompare(b.title));
  }

  async held(): Promise<StoredMessage[]> {
    return (await this.source.client.request("held")).messages as StoredMessage[];
  }

  async send(target: { kind: "session"; id: string } | { kind: "channel"; name: string }, text: string, options?: SendOptions): Promise<unknown> {
    if (target.kind === "session") return { result: await this.source.client.sendToSession(target.id, text, options) };
    const { msgId, results } = await this.source.client.request("channel_send", { channel: target.name, text });
    return { msgId, results };
  }

  async manage(operation: ManageOp): Promise<Record<string, unknown>> {
    const client = this.source.client;
    switch (operation.op) {
      case "session.rename": return client.request("rename", { from: this.sessionName(operation.id), name: operation.name });
      case "session.role": return client.request("set_role", { name: this.sessionName(operation.id), role: operation.role });
      case "session.inbound": return client.request("set_inbound", { name: this.sessionName(operation.id), mode: operation.mode });
      case "session.ping": return client.request("ping", { name: this.sessionName(operation.id) });
      case "session.close": {
        // Close deletes the list row, so capture server-owned resume metadata first.
        const sessions = operation.terminate ? (await client.request("list")).sessions as ListedSession[] : [];
        const session = sessions.find((session) => session.id === operation.id);
        const result = await client.request("close", { identity: operation.id });
        if (!operation.terminate) return { ...result, closed: true };
        try { return { ...result, closed: true, ...await this.terminateOwner(session) }; }
        catch (error) {
          return { ...result, closed: true, terminated: null, reason: error instanceof Error ? error.message : String(error) };
        }
      }
      case "session.closeStale": {
        let closed = 0;
        const sessions = (await client.request("list")).sessions as ListedSession[];
        for (const session of sessions) if (session.stale) {
          await client.request("close", { identity: session.id });
          closed++;
        }
        return { closed };
      }
      case "session.replace": return client.request("replace", { fromId: operation.fromId, toId: operation.toId });
      case "session.purge": return client.request("purge", operation.all ? { all: true } : { identity: operation.id });
      case "channel.create": return client.request("channel_create", { channel: operation.name });
      case "channel.rename": return client.request("channel_rename", { channel: operation.name, name: operation.to });
      case "channel.delete": return client.request("channel_delete", { channel: operation.name });
      case "channel.add": return client.request("channel_add", { channel: operation.name, name: this.sessionName(operation.id) });
      case "channel.remove": return client.request("channel_remove", { channel: operation.name, sessionId: operation.id });
      case "held.release": return client.request("release", { msgId: operation.msgId });
      case "held.drop": return client.request("drop", { msgId: operation.msgId });
      case "process.kill": {
        const procs = await this.scan();
        if (operation.pid === process.pid || operation.pid === process.ppid || !procs.some((proc) => proc.pid === operation.pid)) {
          throw new AsenqError("unknown_target", "process not found");
        }
        this.kill(operation.pid, "SIGTERM");
        return { terminated: operation.pid };
      }
      case "read.mark": {
        if (operation.state === "unread") return { state: (await client.markUnread(operation.scope)).state };
        const state = await client.readState(operation.scope);
        const page = await client.historyPage({ ...operation.scope, limit: 1 });
        const through = page.messages.reduce((order, message) => Math.max(order, message.order), 0);
        return { state: (await client.markRead(operation.scope, through, state.version)).state };
      }
    }
  }

  private sessionName(id: string): string {
    const session = this.map.view().world.characters.find((character) => character.id === id && character.source === "registered");
    if (!session) throw new AsenqError("unknown_target", `unknown session ${id}`);
    return session.name;
  }

  private async terminateOwner(session: ListedSession | undefined): Promise<Record<string, unknown>> {
    const resumeId = session?.harnessSessionId;
    if (!resumeId || resumeId.length < 8) return { terminated: null, reason: "process not identified" };
    const owners = (await this.scan()).filter((proc) => proc.command.includes(resumeId));
    if (owners.length !== 1) return { terminated: null, reason: owners.length > 1 ? "ambiguous" : "process not identified" };
    const pid = owners[0].pid;
    if (pid === process.pid || pid === process.ppid) return { terminated: null, reason: "refused" };
    this.kill(pid, "SIGTERM");
    return { terminated: pid, inferred: true };
  }

  idle(): Promise<void> { return this.source.idle(); }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopTicks?.();
    this.source.close();
    this.listeners.clear();
  }

  private changed(): void {
    if (this.closed) return;
    const data = this.current();
    const serialized = JSON.stringify(data);
    if (serialized === this.lastState) return;
    this.lastState = serialized;
    this.broadcast({ event: "state", data });
  }

  private broadcast(event: CityEvent): void {
    if (this.closed) return;
    for (const listener of this.listeners) listener(event);
  }
}
