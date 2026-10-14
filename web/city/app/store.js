import { targetKey } from "./logic.js";

export class CityStore extends EventTarget {
  constructor() {
    super();
    this.wire = null;
    this.previousWire = null;
    this.previousAt = 0;
    this.stateAt = 0;
    this.charactersById = new Map();
    this.venuesByKey = new Map();
    this.targetsByKey = new Map();
    this.routesByKey = new Map();
    this.connectionState = "connecting";
    this.conversations = [];
    this.unreadByKey = new Map();
    this.held = [];
    this.ui = {
      selected: null,
      filter: null,
      showProcesses: true,
      focus: false,
      follow: false,
      tab: "map",
      search: "",
      searchOpen: false,
      chat: null,
      sidebarTab: "inspect",
      inspectorOpen: false,
      sort: { sessions: ["name", 1], channels: ["name", 1], messages: ["at", -1] },
    };
    this.chat = { scope: null, messages: [], hasMore: false, loading: false, error: null };
    this.animations = new Map();
  }

  subscribe(listener) {
    const handler = () => listener(this.snapshot());
    this.addEventListener("change", handler);
    return () => this.removeEventListener("change", handler);
  }

  emit() { this.dispatchEvent(new Event("change")); }

  snapshot() {
    return {
      ...(this.wire ?? {}),
      wire: this.wire,
      previousWire: this.previousWire,
      previousAt: this.previousAt,
      charactersById: this.charactersById,
      venuesByKey: this.venuesByKey,
      targetsByKey: this.targetsByKey,
      routesByKey: this.routesByKey,
      connectionState: this.connectionState,
      ui: this.ui,
      chat: this.chat,
      conversations: this.conversations,
      unreadByKey: this.unreadByKey,
      held: this.held,
      animations: this.animations,
    };
  }

  setState(wire) {
    this.previousWire = this.wire;
    this.previousAt = this.stateAt;
    this.stateAt = Date.now();
    this.wire = wire;
    this.charactersById = new Map(wire.characters.map((character) => [character.id, character]));
    this.venuesByKey = new Map(wire.venues.map((venue) => [venue.key, venue]));
    this.targetsByKey = new Map(wire.layout.targets.map((position) => [targetKey(position.target), position]));
    this.routesByKey = new Map(Object.entries(wire.layout.routes));
    if (this.ui.selected && !this.targetsByKey.has(targetKey(this.ui.selected))) {
      this.ui.selected = null;
      if (this.ui.sidebarTab === "inspect") this.ui.inspectorOpen = false;
    }
    this.updateUnread();
    this.emit();
  }

  setConnectionState(state) {
    if (this.connectionState === state) return;
    this.connectionState = state;
    this.emit();
  }

  setSelected(target, { openInspector = true } = {}) {
    this.ui.selected = target;
    if (openInspector) this.ui.inspectorOpen = Boolean(target);
    this.emit();
  }

  setFilter(filter) { this.ui.filter = filter; this.emit(); }
  setShowProcesses(show) {
    this.ui.showProcesses = show;
    if (!show && this.ui.selected) {
      const character = this.ui.selected.kind === "venue" ? null : this.charactersById.get(this.ui.selected.id);
      if (character?.source === "process") {
        this.ui.selected = null;
        this.ui.inspectorOpen = false;
        this.ui.follow = false;
      }
    }
    this.emit();
  }
  setFocus(focus) { this.ui.focus = focus; this.emit(); }
  setFollow(follow) { if (this.ui.follow === follow) return; this.ui.follow = follow; this.emit(); }
  setTab(tab) { this.ui.tab = tab; this.emit(); }
  setSearch(search) { this.ui.search = search; this.emit(); }
  openSearch() { this.ui.searchOpen = true; this.ui.search = ""; this.emit(); }
  closeSearch() { this.ui.searchOpen = false; this.ui.search = ""; this.emit(); }
  setInspectorOpen(open) { this.ui.inspectorOpen = open; this.emit(); }

  openChat(scope) {
    this.ui.chat = scope;
    this.ui.sidebarTab = "chats";
    this.ui.inspectorOpen = true;
    this.chat = { scope, messages: [], hasMore: false, loading: Boolean(scope), error: null };
    this.emit();
  }

  closeChat() {
    this.ui.chat = null;
    this.chat = { scope: null, messages: [], hasMore: false, loading: false, error: null };
    this.emit();
  }

  setChatPage(scope, page, { prepend = false } = {}) {
    if (!this.ui.chat || !sameScope(this.ui.chat, scope)) return;
    const merged = new Map();
    for (const message of [...this.chat.messages, ...page.messages]) merged.set(message.id, message);
    this.chat = {
      scope,
      messages: [...merged.values()].sort((a, b) => a.order - b.order),
      hasMore: prepend || !this.chat.messages.length ? page.hasMore : this.chat.hasMore,
      loading: false,
      error: null,
    };
    this.emit();
  }

  setChatLoading(loading, error = null) {
    this.chat = { ...this.chat, loading, error };
    this.emit();
  }

  setConversations(list) { this.conversations = list; this.updateUnread(); this.emit(); }
  setHeld(list) { this.held = list; this.emit(); }
  setSidebarTab(tab) { this.ui.sidebarTab = tab; this.ui.inspectorOpen = true; this.emit(); }

  updateUnread() {
    this.unreadByKey = new Map();
    let total = 0;
    for (const item of this.conversations) {
      total += item.unread;
      const scope = item.scope;
      const venue = scope.scope === "channel" ? [...this.venuesByKey.values()].find((v) => v.name === scope.channel) : null;
      const key = scope.scope === "session" ? `c:${scope.sessionId}` : venue ? `v:${venue.key}` : null;
      if (key) this.unreadByKey.set(key, item.unread);
    }
    if (typeof document !== "undefined") document.title = `${total ? `(${total}) ` : ""}ASENQ // CITY MAP`;
  }

  toggleSort(table, field) {
    const [oldField, oldDirection] = this.ui.sort[table];
    this.ui.sort[table] = [field, oldField === field ? -oldDirection : 1];
    this.emit();
  }

  setAnimation(id, name, startedAt) {
    const current = this.animations.get(id) ?? {};
    this.animations.set(id, { ...current, [name]: startedAt });
    this.emit();
  }

}

function sameScope(a, b) {
  return a.scope === b.scope && (a.scope === "channel" ? a.channel === b.channel : a.sessionId === b.sessionId);
}
