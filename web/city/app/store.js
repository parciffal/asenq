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
    this.ui = {
      selected: null,
      filter: null,
      showProcesses: true,
      focus: false,
      follow: false,
      tab: "map",
      search: "",
      searchOpen: false,
      transcript: null,
      inspectorOpen: false,
      sort: { sessions: ["name", 1], channels: ["name", 1], messages: ["at", -1] },
    };
    this.transcript = { scope: null, messages: [], hasMore: false, loading: false, error: null };
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
      transcript: this.transcript,
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
      this.ui.inspectorOpen = false;
    }
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
  setShowProcesses(show) { this.ui.showProcesses = show; this.emit(); }
  setFocus(focus) { this.ui.focus = focus; this.emit(); }
  setFollow(follow) { if (this.ui.follow === follow) return; this.ui.follow = follow; this.emit(); }
  setTab(tab) { this.ui.tab = tab; this.emit(); }
  setSearch(search) { this.ui.search = search; this.emit(); }
  openSearch() { this.ui.searchOpen = true; this.ui.search = ""; this.emit(); }
  closeSearch() { this.ui.searchOpen = false; this.ui.search = ""; this.emit(); }
  setInspectorOpen(open) { this.ui.inspectorOpen = open; this.emit(); }

  openTranscript(scope) {
    this.ui.transcript = scope;
    this.transcript = { scope, messages: [], hasMore: false, loading: true, error: null };
    this.emit();
  }

  closeTranscript() {
    this.ui.transcript = null;
    this.transcript = { scope: null, messages: [], hasMore: false, loading: false, error: null };
    this.emit();
  }

  setTranscriptPage(scope, page, { prepend = false } = {}) {
    if (!this.ui.transcript || !sameScope(this.ui.transcript, scope)) return;
    const merged = new Map();
    const all = prepend ? [...page.messages, ...this.transcript.messages] : [...this.transcript.messages, ...page.messages];
    for (const message of all) merged.set(message.id, message);
    this.transcript = {
      scope,
      messages: [...merged.values()].sort((a, b) => a.order - b.order),
      hasMore: page.hasMore,
      loading: false,
      error: null,
    };
    this.emit();
  }

  setTranscriptLoading(loading, error = null) {
    this.transcript = { ...this.transcript, loading, error };
    this.emit();
  }

  upsertTranscriptMessage(message) {
    if (!this.ui.transcript) return;
    const messages = new Map(this.transcript.messages.map((item) => [item.id, item]));
    messages.set(message.id, message);
    this.transcript = { ...this.transcript, messages: [...messages.values()].sort((a, b) => a.order - b.order) };
    this.emit();
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
