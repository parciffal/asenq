import { targetKey, scopeOf, search, messageTouches, sanitizeLabel } from "./logic.js";

const element = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
};
const button = (text, className, onClick) => {
  const node = element("button", className, text);
  node.type = "button";
  node.addEventListener("click", onClick);
  return node;
};
const kindClass = (kind) => `kind-tag kind-${["chat", "task", "result", "status", "control"].includes(kind) ? kind : "chat"}`;
const display = (value) => value === null || value === undefined || value === "" ? "unknown" : String(value);
const timeText = (time) => {
  if (!Number.isFinite(time)) return "--:--";
  return new Date(time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
};
const ageText = (time) => {
  if (!Number.isFinite(time)) return "unknown";
  const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
  return seconds < 60 ? `${seconds}s ago` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ago` : `${Math.floor(seconds / 3600)}h ago`;
};

export class CityHud {
  constructor(store, api) {
    this.store = store;
    this.api = api;
    this.scene = null;
    this.searchIndex = 0;
    this.composerDraft = "";
    this.composerStatus = { text: "", error: false };
    this.historyRequest = 0;
    this.transcriptGeneration = 0;
    this.transcriptScopeKey = null;
    this.transcriptFirstOrder = null;
    this.transcriptCount = 0;
    this.drawerQuery = window.matchMedia("(max-width: 1100px)");
    this.root = document.getElementById("app");
    this.topbar = document.getElementById("topbar");
    this.cityArea = document.getElementById("city-area");
    this.side = document.getElementById("side-panel");
    this.feed = document.getElementById("feed-panel");
    this.footer = document.getElementById("footer");
    this.transcript = document.getElementById("transcript");
    this.searchLayer = document.getElementById("search-layer");
    this.drawerToggle = document.getElementById("drawer-toggle");
    this.toast = document.getElementById("toast");
    this.tableView = element("div");
    this.tableView.id = "table-view";
    this.tableView.hidden = true;
    this.cityArea.append(this.tableView);
    this.buildSearch();
    this.drawerToggle.addEventListener("click", () => this.store.setInspectorOpen(!this.store.ui.inspectorOpen));
    this.unsubscribe = this.store.subscribe((state) => this.render(state));
    this.resizeListener = () => this.render(this.store.snapshot());
    window.addEventListener("resize", this.resizeListener);
    this.render(this.store.snapshot());
  }

  destroy() {
    this.unsubscribe?.();
    window.removeEventListener("resize", this.resizeListener);
  }

  setScene(scene) { this.scene = scene; this.render(this.store.snapshot()); }

  buildSearch() {
    this.searchLayer.replaceChildren();
    this.searchInput = element("input", "search-input");
    this.searchInput.type = "search";
    this.searchInput.autocomplete = "off";
    this.searchInput.placeholder = "SEARCH SESSIONS / CHANNELS";
    this.searchInput.setAttribute("aria-label", "Search sessions and channels");
    this.searchResults = element("div", "search-results");
    this.searchInput.addEventListener("input", () => {
      this.searchIndex = 0;
      this.store.setSearch(this.searchInput.value);
    });
    this.searchInput.addEventListener("keydown", (event) => this.onSearchKey(event));
    this.searchLayer.append(this.searchInput, this.searchResults);
  }

  render(state) {
    this.renderTop(state);
    this.renderSide(state);
    this.renderFeed(state);
    this.renderFooter(state);
    this.renderTabs(state);
    this.renderSearch(state);
    this.renderTranscript(state);
    this.root.classList.toggle("drawer-open", state.ui.inspectorOpen);
    this.drawerToggle.hidden = !this.drawerQuery.matches;
    this.drawerToggle.textContent = state.ui.inspectorOpen ? "CLOSE INSPECTOR [I]" : "INSPECTOR [I]";
    this.drawerToggle.setAttribute("aria-expanded", String(state.ui.inspectorOpen));
    this.refreshViewport();
  }

  renderTop(state) {
    this.topbar.replaceChildren();
    const brand = element("div", "brand");
    brand.append(document.createTextNode("ASENQ // CITY MAP "));
    brand.append(element("small", "", "LOCAL NETWORK"));
    this.topbar.append(brand);
    const nav = element("nav", "nav-tabs");
    nav.setAttribute("aria-label", "City views");
    for (const [tab, title] of [["map", "[ MAP ]"], ["sessions", "SESSIONS"], ["channels", "CHANNELS"], ["messages", "MESSAGES"]]) {
      const item = button(title, `nav-tab${state.ui.tab === tab ? " active" : ""}`, () => this.store.setTab(tab));
      item.dataset.tab = tab;
      item.setAttribute("aria-pressed", String(state.ui.tab === tab));
      nav.append(item);
    }
    this.topbar.append(nav);
    const status = element("div", "top-status");
    let connectionText, statusClass;
    if (state.wire?.connection === "offline") { connectionText = "SIGNAL LOST · STALE SNAPSHOT"; statusClass = "status-offline"; }
    else if (!state.wire || state.connectionState !== "open") { connectionText = "RECONNECTING"; statusClass = "status-reconnecting"; }
    else { connectionText = "LINK ESTABLISHED"; statusClass = "status-connected"; }
    status.append(element("span", statusClass, connectionText));
    if (state.wire) status.append(element("span", "status-count", `${state.wire.characters.filter((c) => c.source === "registered").length} SESSIONS · ${state.wire.venues.length} VENUES`));
    if (state.wire?.reducedMotion) status.append(element("span", "status-warning", "REDUCED MOTION"));
    if (state.wire?.settingsWarning) status.append(element("span", "status-warning", state.wire.settingsWarning));
    if (state.wire?.notice) status.append(element("span", "status-notice", state.wire.notice));
    this.topbar.append(status);
  }

  renderSide(state) {
    this.side.replaceChildren();
    if (!state.wire) {
      this.side.append(element("div", "section-heading", "CITY INSPECTOR"));
      this.side.append(element("p", "detail-value", "Waiting for live city state…"));
      return;
    }
    const target = state.ui.selected;
    const venue = target?.kind === "venue" ? state.venuesByKey.get(target.venueKey) : null;
    const character = target && target.kind !== "venue" ? state.charactersById.get(target.id) : null;
    if (venue) this.renderVenueInspector(state, venue);
    else if (character?.source === "process") this.renderProcessInspector(character);
    else if (character?.source === "human") this.renderOperatorInspector();
    else if (character) this.renderSessionInspector(state, character);
    else this.renderEmptyInspector();
    const overview = this.makeSection("CITY OVERVIEW");
    this.minimap = element("canvas", "city-overview");
    this.minimap.width = 640;
    this.minimap.height = 320;
    this.minimap.setAttribute("aria-label", "City overview minimap; click or drag to recenter");
    this.minimap.addEventListener("pointerdown", (event) => {
      this.minimap.setPointerCapture(event.pointerId);
      this.centerFromMinimap(event);
    });
    this.minimap.addEventListener("pointermove", (event) => { if (event.buttons) this.centerFromMinimap(event); });
    overview.append(this.minimap);
    this.side.append(overview);
    const hints = this.makeSection("QUICK KEYS");
    hints.append(element("div", "key-hints", "[Enter] OPEN · [Tab] SELECT · [F] FOLLOW · [T] TRAFFIC"));
    this.side.append(hints);
    this.drawMinimap(state);
  }

  renderEmptyInspector() {
    const section = this.makeSection("CITY INSPECTOR");
    section.append(element("div", "detail-value", "Select a character or channel to inspect live city state."));
    this.side.append(section);
  }

  renderVenueInspector(state, venue) {
    const section = this.makeSection(`CHANNEL #${venue.name}`);
    const members = venue.rosterIds.map((id) => state.charactersById.get(id)).filter(Boolean);
    this.addDetail(section, "VENUE", venue.appearance);
    this.addDetail(section, "MEMBERS", String(members.length));
    this.addDetail(section, "POSTS", String(venue.postCount));
    this.side.append(section);
    const roster = this.makeSection("SESSIONS");
    const list = element("div", "roster");
    for (const character of members) {
      const filtered = character.source !== "human" && state.ui.filter !== null && character.harness !== state.ui.filter;
      const row = button("", `roster-row${filtered ? " roster-filtered" : ""}`, () => this.selectTarget({ kind: "character", id: character.id }, true));
      row.append(element("span", "roster-name", sanitizeLabel(character.name)));
      row.append(element("span", "roster-meta", `${shortHarness(character.harness)} · ${roleLabel(character)}`));
      row.title = `${character.name} · ${character.state ?? "unknown"}${filtered ? " · filtered" : ""}`;
      if (filtered) row.append(element("span", "roster-meta", "FILTERED"));
      list.append(row);
    }
    if (!members.length) list.append(element("div", "detail-value", "No sessions in this channel."));
    roster.append(list);
    this.side.append(roster);
  }

  renderSessionInspector(state, character) {
    const section = this.makeSection(sanitizeLabel(character.name));
    const canvas = element("canvas", "character-preview");
    canvas.width = 32; canvas.height = 48;
    this.drawCharacterPreview(canvas, character.appearance);
    section.append(canvas);
    if (character.previousNames?.length) this.addDetail(section, "FORMER NAMES", character.previousNames.join(", "));
    this.addDetail(section, "SOURCE", character.source);
    this.addDetail(section, "HARNESS", display(character.harness));
    this.addDetail(section, "ROLE", character.role ?? "UNSET");
    this.addDetail(section, "STATE", this.stateLabel(character));
    this.addDetail(section, "PING", display(character.ping));
    this.addDetail(section, "STALE", character.stale === null ? "UNKNOWN" : character.stale ? "YES" : "NO");
    this.addDetail(section, "BUSY", character.busy === null ? "UNKNOWN" : character.busy ? "YES" : "NO");
    this.addDetail(section, "MEMBERSHIPS", character.memberships.length ? character.memberships.join(", ") : "none");
    const canonicalHome = state.wire.layout.characters.find((item) => item.id === character.id)?.home;
    for (const name of character.memberships) {
      const venue = state.wire.venues.find((item) => item.name === name);
      if (venue) this.addDetail(section, `#${name}`, venue.key === canonicalHome ? "CANONICAL HOME" : "MEMBER");
    }
    this.addDetail(section, "LAST SEEN", ageText(character.lastSeen));
    this.addDetail(section, "CWD", display(character.cwd));
    this.addDetail(section, "OUTFIT", `${character.appearance.outfit} v${character.appearance.variant} · ${appearanceReason(character.appearance.reason)}`);
    this.addDetail(section, "MODEL", "unknown (not reported)");
    this.side.append(section);
  }

  renderProcessInspector(character) {
    const section = this.makeSection(sanitizeLabel(character.name));
    this.addDetail(section, "PID", display(character.pid));
    this.addDetail(section, "HARNESS", display(character.harness));
    this.addDetail(section, "CPU", Number.isFinite(character.cpu) ? `${Math.round(character.cpu)}% (inferred)` : "unknown (inferred)");
    this.addDetail(section, "STATUS", "detected, not registered");
    this.side.append(section);
  }

  renderOperatorInspector() {
    const section = this.makeSection("[H] OPERATOR");
    this.addDetail(section, "ROLE", "human participant");
    this.side.append(section);
  }

  stateLabel(character) {
    if (character.state === "removed") return "REMOVED";
    if (character.state === "gone") return "GONE";
    if (character.state === "stale" || character.stale === true || character.ping === "not_responding") return "STALE / LOST";
    return character.state ?? "UNKNOWN";
  }

  makeSection(title) {
    const section = element("section", "panel-section");
    section.append(element("h2", "section-heading", title));
    return section;
  }

  addDetail(section, key, value) {
    const row = element("div", "detail-grid");
    row.append(element("span", "detail-key", key));
    row.append(element("span", "detail-value", display(value)));
    section.append(row);
  }

  drawCharacterPreview(canvas, appearance) {
    const source = this.scene?.textures?.get?.(`ch:${appearance.outfit}:${appearance.variant}:idle_a`)?.getSourceImage?.();
    const context = canvas.getContext("2d");
    context.imageSmoothingEnabled = false;
    context.clearRect(0, 0, canvas.width, canvas.height);
    if (source) context.drawImage(source, 0, 0, 32, 48);
  }

  renderFeed(state) {
    this.feed.replaceChildren();
    this.feed.append(element("h2", "feed-heading", "LIVE CITY TRAFFIC"));
    const lines = element("div", "feed-lines");
    const feed = state.wire?.feed ?? [];
    for (const line of [...feed].slice(-4).reverse()) {
      const row = button("", "feed-line", () => this.selectFeedLine(line));
      row.append(element("time", "", timeText(line.at)));
      row.append(element("span", line.channel ? "" : "kind-tag kind-chat", line.channel ? `#${line.channel}` : "DM"));
      row.append(element("span", "", line.channel ? `${line.from}:` : `${line.from} → ${line.to}:`));
      row.append(element("span", "feed-text", line.text));
      row.append(element("span", kindClass(line.kind), line.kind));
      lines.append(row);
    }
    if (!feed.length) lines.append(element("div", "detail-value", "No observed messages yet."));
    this.feed.append(lines);
  }

  renderFooter(state) {
    this.footer.replaceChildren();
    for (const [key, label] of [["←↑↓→", "PAN"], ["+/-", "ZOOM"], ["TAB", "SELECT"], ["ENTER", "OPEN"], ["/", "FIND"], ["F", "FOLLOW"], ["T", "TRAFFIC"], ["H", "HARNESS"], ["SPACE", "FOCUS"], ["ESC", "BACK"]]) {
      const span = element("span", "");
      span.append(element("kbd", "", `[${key}]`), document.createTextNode(` ${label}`));
      this.footer.append(span);
    }
    if (state.ui.filter) this.footer.append(element("span", "status-warning", `FILTER ${state.ui.filter.toUpperCase()}`));
    if (!state.ui.showProcesses) this.footer.append(element("span", "status-warning", "PROCESSES OFF"));
    if (state.ui.follow) this.footer.append(element("span", "status-connected", `FOLLOW ${state.ui.follow.toUpperCase()}`));
  }

  renderTabs(state) {
    const isMap = state.ui.tab === "map";
    this.tableView.hidden = isMap;
    this.tableView.replaceChildren();
    if (!isMap && state.wire) this.renderTable(state);
  }

  renderTable(state) {
    const tab = state.ui.tab;
    const records = tab === "sessions" ? state.wire.characters.filter((item) => item.source === "registered")
      : tab === "channels" ? state.wire.venues : state.wire.feed.slice(-50);
    const [field, direction] = state.ui.sort[tab];
    const sorted = [...records].sort((a, b) => compareField(a, b, field) * direction);
    const columns = tab === "sessions" ? ["name", "harness", "role", "state", "busy", "memberships"]
      : tab === "channels" ? ["name", "members", "posts"] : ["at", "channel", "from", "to", "kind", "text"];
    const table = element("table", "data-table");
    const head = element("thead");
    const headerRow = element("tr");
    for (const column of columns) {
      const cell = element("th");
      cell.append(button(`${column.toUpperCase()}${field === column ? direction > 0 ? " ▲" : " ▼" : ""}`, "", () => this.store.toggleSort(tab, column)));
      headerRow.append(cell);
    }
    head.append(headerRow); table.append(head);
    const body = element("tbody");
    for (const record of sorted) {
      const row = element("tr");
      for (const column of columns) row.append(element("td", "", this.tableValue(tab, record, column)));
      row.addEventListener("click", () => this.selectTableRecord(tab, record));
      body.append(row);
    }
    table.append(body);
    this.tableView.append(table);
  }

  tableValue(tab, item, field) {
    if (tab === "sessions") {
      if (field === "busy") return item.busy === null ? "unknown" : item.busy ? "busy" : "idle";
      if (field === "role") return item.role ?? "UNSET";
      if (field === "memberships") return item.memberships.join(", ") || "—";
      return display(item[field]);
    }
    if (tab === "channels") {
      if (field === "members") return String(item.rosterIds.length);
      if (field === "posts") return String(item.postCount);
      return item.name;
    }
    if (field === "at") return timeText(item.at);
    if (field === "channel") return item.channel ? `#${item.channel}` : "DM";
    if (field === "text") return display(item.text);
    return display(item[field]);
  }

  selectTableRecord(tab, record) {
    if (tab === "sessions") this.selectTarget({ kind: "character", id: record.id }, true);
    else if (tab === "channels") this.selectTarget({ kind: "venue", venueKey: record.key }, true);
    else this.selectFeedLine(record);
  }

  selectFeedLine(line) {
    let target = line.channelTarget;
    if (!target && line.channel) {
      const venue = this.store.venuesByKey && [...this.store.venuesByKey.values()].find((item) => item.name === line.channel);
      if (venue) target = { kind: "venue", venueKey: venue.key };
    }
    if (!target) {
      const id = line.toId ?? line.fromId;
      if (id && this.store.charactersById.has(id)) target = { kind: "character", id };
    }
    if (target) this.selectTarget(target, true);
  }

  selectTarget(target, center) {
    this.store.setSelected(target);
    if (this.store.ui.tab !== "map") this.store.setTab("map");
    if (center) this.scene?.centerTarget(target);
  }

  renderSearch(state) {
    const open = state.ui.searchOpen;
    this.searchLayer.hidden = !open;
    if (!open) return;
    if (this.searchInput.value !== state.ui.search) this.searchInput.value = state.ui.search;
    const results = search(state, state.ui.search);
    this.searchResults.replaceChildren();
    if (!results.length) {
      this.searchResults.append(element("div", "search-empty", "No match"));
      return;
    }
    results.forEach((target, index) => {
      let name;
      if (target.kind === "venue") name = `#${state.venuesByKey.get(target.venueKey)?.name ?? target.venueKey}`;
      else name = state.charactersById.get(target.id)?.name ?? target.id;
      const row = button(name, `result-row${index === this.searchIndex ? " active" : ""}`, () => this.chooseSearch(target));
      if (index === this.searchIndex) row.setAttribute("aria-current", "true");
      this.searchResults.append(row);
      if (index === this.searchIndex) row.scrollIntoView?.({ block: "nearest" });
    });
  }

  openSearch() {
    this.searchIndex = 0;
    this.store.openSearch();
    this.searchInput.focus();
  }

  closeSearch() { this.searchInput.blur(); this.store.closeSearch(); }

  onSearchKey(event) {
    const results = search(this.store.snapshot(), this.searchInput.value);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      if (results.length) this.searchIndex = (this.searchIndex + (event.key === "ArrowDown" ? 1 : -1) + results.length) % results.length;
      this.renderSearch(this.store.snapshot());
    } else if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      if (results.length) this.chooseSearch(results[this.searchIndex] ?? results[0]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.closeSearch();
    }
  }

  chooseSearch(target) {
    this.closeSearch();
    this.selectTarget(target, true);
  }

  scopeFor(target) { return scopeOf(target, this.store.snapshot()); }

  openTranscript(scope) {
    this.historyRequest++;
    this.transcriptGeneration++;
    this.composerDraft = "";
    this.store.openTranscript(scope);
    this.loadHistory(scope, undefined, false);
  }

  closeTranscript() {
    this.historyRequest++;
    this.transcriptGeneration++;
    this.composerDraft = "";
    this.store.closeTranscript();
  }

  async loadHistory(scope, before, prepend) {
    if (!sameHistoryScope(this.store.ui.transcript, scope)) return;
    const request = ++this.historyRequest;
    this.store.setTranscriptLoading(true);
    try {
      const page = await this.api.history(scope, before);
      if (request !== this.historyRequest || !sameHistoryScope(this.store.ui.transcript, scope)) return;
      this.store.setTranscriptPage(scope, page, { prepend });
    } catch (error) {
      if (request !== this.historyRequest || !sameHistoryScope(this.store.ui.transcript, scope)) return;
      this.store.setTranscriptLoading(false, error.message);
    }
  }

  async handleMessage(data) {
    const message = data?.msg;
    const scope = this.store.ui.transcript;
    if (!message || !scope || !messageTouches(message, scope)) return;
    await this.loadHistory(scope, undefined, false);
  }

  renderTranscript(state) {
    const scope = state.ui.transcript;
    this.transcript.hidden = !scope;
    if (!scope) {
      this.transcriptScopeKey = null;
      this.transcriptFirstOrder = null;
      this.transcriptCount = 0;
      return;
    }
    const currentScopeKey = scope.scope === "channel" ? `channel:${scope.channel}` : `session:${scope.sessionId}`;
    const sameScope = this.transcriptScopeKey === currentScopeKey;
    if (!sameScope) this.composerStatus = { text: "", error: false };
    const previousMessages = sameScope ? this.transcript.querySelector(".transcript-messages") : null;
    const previousTop = previousMessages?.scrollTop ?? 0;
    const previousHeight = previousMessages?.scrollHeight ?? 0;
    const wasAtBottom = previousMessages !== null
      && previousMessages.scrollHeight - previousMessages.clientHeight - previousTop <= 16;
    const history = state.transcript.messages;
    const firstOrder = history[0]?.order ?? null;
    const prepended = sameScope && this.transcriptCount > 0 && history.length > this.transcriptCount
      && firstOrder !== this.transcriptFirstOrder;
    const activeComposer = document.activeElement === this.composer;
    const selection = activeComposer ? [this.composer.selectionStart, this.composer.selectionEnd] : null;
    this.transcript.replaceChildren();
    const toolbar = element("div", "transcript-toolbar");
    const title = scope.scope === "channel" ? `#${scope.channel}` : state.charactersById.get(scope.sessionId)?.name ?? scope.sessionId;
    toolbar.append(element("h2", "transcript-heading", title));
    toolbar.append(button("CLOSE", "transcript-close", () => this.closeTranscript()));
    this.transcript.append(toolbar);
    if (state.transcript.hasMore) this.transcript.append(button("LOAD OLDER", "", () => {
      const before = this.store.transcript.messages[0]?.order;
      if (before !== undefined) this.loadHistory(scope, before, true);
    }));
    const messages = element("div", "transcript-messages");
    messages.setAttribute("role", "log");
    for (const message of state.transcript.messages) messages.append(this.messageCard(message));
    if (state.transcript.loading && !state.transcript.messages.length) messages.append(element("div", "detail-value", "Loading history…"));
    if (state.transcript.error) messages.append(element("div", "composer-result error", state.transcript.error));
    this.transcript.append(messages);
    const composer = element("form", "transcript-composer");
    this.transcriptScopeKey = currentScopeKey;
    this.transcriptFirstOrder = firstOrder;
    this.transcriptCount = history.length;
    this.composer = element("textarea");
    this.composer.placeholder = "MESSAGE… (Enter sends · Shift+Enter newline)";
    this.composer.value = this.composerDraft;
    this.composer.addEventListener("input", () => { this.composerDraft = this.composer.value; });
    this.composer.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        this.submitMessage(scope);
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        this.closeTranscript();
      }
    });
    const actions = element("div", "composer-actions");
    this.composerResult = element("span", this.composerStatus.error ? "composer-result error" : "composer-result", this.composerStatus.text);
    const submit = button("SEND", "", () => this.submitMessage(scope));
    actions.append(this.composerResult, submit);
    composer.append(this.composer, actions);
    composer.addEventListener("submit", (event) => { event.preventDefault(); this.submitMessage(scope); });
    this.transcript.append(composer);
    this.transcript.append(element("div", "transcript-note", "Viewing here does not mark messages read."));
    requestAnimationFrame(() => {
      if (!messages.isConnected) return;
      if (previousMessages) {
        if (prepended) messages.scrollTop = previousTop + Math.max(0, messages.scrollHeight - previousHeight);
        else if (wasAtBottom) messages.scrollTop = messages.scrollHeight;
        else messages.scrollTop = Math.min(previousTop, messages.scrollHeight);
      } else if (history.length) messages.scrollTop = messages.scrollHeight;
    });
    if (activeComposer) {
      this.composer.focus();
      this.composer.setSelectionRange(...selection);
    }
  }

  messageCard(message) {
    const card = element("article", "transcript-message");
    const meta = element("div", "transcript-meta");
    meta.append(element("time", "", timeText(message.createdAt)));
    meta.append(element("span", "", `${message.from} → ${message.to}`));
    meta.append(element("span", kindClass(message.kind ?? "chat"), message.kind ?? "chat"));
    card.append(meta);
    card.append(element("div", "transcript-body", message.text ?? message.file?.summary ?? ""));
    if (message.status) card.append(element("div", "transcript-status", message.status));
    if (message.file) card.append(element("div", "transcript-file", `${message.file.summary ?? "File"}${message.file.path ? ` · ${message.file.path}` : ""}`));
    return card;
  }

  async submitMessage(scope) {
    const text = this.composer?.value ?? "";
    if (!text.trim()) return;
    const generation = this.transcriptGeneration;
    const target = scope.scope === "channel" ? { kind: "channel", name: scope.channel } : { kind: "session", id: scope.sessionId };
    this.setComposerStatus("SENDING…");
    try {
      const reply = await this.api.send(target, text);
      const result = sendResult(reply);
      if (generation !== this.transcriptGeneration) {
        this.showToast(result, false);
        return;
      }
      this.composerDraft = "";
      if (this.composer) this.composer.value = "";
      this.setComposerStatus(result);
      this.showToast(result, false);
      await this.loadHistory(scope, undefined, false);
    } catch (error) {
      if (generation === this.transcriptGeneration) this.setComposerStatus(error.message, true);
      this.showToast(error.message, true);
    }
  }
  setComposerStatus(text, error = false) {
    this.composerStatus = { text, error };
    if (!this.composerResult) return;
    this.composerResult.className = error ? "composer-result error" : "composer-result";
    this.composerResult.textContent = text;
  }


  showToast(message, isError) {
    this.toast.textContent = message;
    this.toast.classList.toggle("error", isError);
    this.toast.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => { this.toast.hidden = true; }, 2800);
  }

  setFatal(message) {
    this.cityArea.querySelector(".fatal-error")?.remove();
    const box = element("div", "fatal-error", `CITY RUNTIME ERROR · ${message}`);
    this.cityArea.append(box);
  }
  drawMinimap(state = this.store.snapshot()) {
    if (!this.minimap || !state.wire) return;
    const context = this.minimap.getContext("2d");
    if (!context) return;
    const width = this.minimap.width, height = this.minimap.height;
    context.imageSmoothingEnabled = false;
    context.fillStyle = "#100609"; context.fillRect(0, 0, width, height);
    const bounds = state.wire.layout.bounds;
    const scale = Math.min((width - 20) / Math.max(1, bounds.width * 8), (height - 20) / Math.max(1, bounds.height * 8));
    const ox = (width - bounds.width * 8 * scale) / 2;
    const oy = (height - bounds.height * 8 * scale) / 2;
    const point = (x, y) => ({ x: ox + (x - bounds.x) * 8 * scale, y: oy + (y - bounds.y) * 8 * scale });
    const spineY = point(0, 0).y;
    context.strokeStyle = "rgba(85,206,209,.7)"; context.lineWidth = Math.max(1, 2 * scale);
    context.beginPath(); context.moveTo(ox, spineY); context.lineTo(width - ox, spineY); context.stroke();
    const selectedKey = state.ui.selected ? targetKey(state.ui.selected) : null;
    for (const venue of state.wire.layout.venues) {
      const p = point(venue.rect.x, venue.rect.y);
      context.fillStyle = selectedKey === `v:${venue.key}` ? "#f4e45a" : "#a52b3a";
      context.fillRect(p.x, p.y, Math.max(2, venue.rect.width * 8 * scale), Math.max(2, venue.rect.height * 8 * scale));
    }
    for (const placed of state.wire.layout.characters) {
      const character = state.charactersById.get(placed.id);
      if (placed.home !== null || !character || (character.source === "process" && !state.ui.showProcesses)) continue;
      const p = point(placed.anchor.x, placed.anchor.y);
      context.fillStyle = character.source === "human" ? "#f4e45a" : selectedKey === `c:${character.id}` ? "#f4e45a" : character.source === "process" ? "#8b7577" : "#55ced1";
      context.fillRect(p.x - 1, p.y - 1, 3, 3);
    }
    const view = this.scene?.getViewportRect?.();
    if (view) {
      const p = point(view.x, view.y);
      context.strokeStyle = "#f4e45a"; context.lineWidth = 1;
      context.strokeRect(p.x, p.y, view.width * 8 * scale, view.height * 8 * scale);
    }
    this.minimapProjection = { bounds, scale, ox, oy };
  }

  centerFromMinimap(event) {
    const state = this.store.snapshot();
    if (!state.wire || !this.minimapProjection) return;
    const rect = this.minimap.getBoundingClientRect();
    const x = (event.clientX - rect.left) * this.minimap.width / rect.width;
    const y = (event.clientY - rect.top) * this.minimap.height / rect.height;
    const { bounds, scale, ox, oy } = this.minimapProjection;
    const worldX = bounds.x + (x - ox) / (scale * 8);
    const worldY = bounds.y + (y - oy) / (scale * 8);
    this.scene?.centerAt(worldX * 8, worldY * 8);
  }

  refreshViewport() { if (this.minimap) this.drawMinimap(); }
}

function shortHarness(harness) {
  return harness === "claude" ? "CC" : harness === "codex" ? "CX" : harness === "opencode" ? "OC" : harness?.toUpperCase() ?? "—";
}
function roleLabel(character) { return character.role === "orchestrator" ? "ORCH" : character.role === "worker" ? "WORKER" : "UNSET"; }
function appearanceReason(reason) {
  return ({ operator: "operator", "session-mapping": "session mapping", "harness-mapping": "harness mapping", "no-model-metadata": "no model metadata", "detected-process": "detected process" })[reason] ?? reason;
}
function compareField(a, b, field) {
  const get = (item) => field === "name" ? item.name : field === "members" ? item.rosterIds.length : field === "posts" ? item.postCount
    : field === "busy" ? (item.busy === null ? -1 : Number(item.busy)) : field === "memberships" ? item.memberships.join(",")
      : field === "at" ? item.at : item[field];
  const x = get(a), y = get(b);
  if (typeof x === "number" && typeof y === "number") return x - y;
  return String(x ?? "").localeCompare(String(y ?? ""), undefined, { numeric: true, sensitivity: "base" });
}
function sendResult(reply) {
  if (reply?.results?.length) return reply.results.map((result) => result.status ?? result.state ?? "posted").join(" · ");
  const result = reply?.result;
  if (result && typeof result === "object") return result.status ?? result.state ?? "sent";
  return "posted";
}

function sameHistoryScope(left, right) {
  if (!left || !right || left.scope !== right.scope) return false;
  return left.scope === "channel" ? left.channel === right.channel : left.sessionId === right.sessionId;
}
