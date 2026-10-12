import { targetKey, scopeOf, search, messageTouches } from "./logic.js";
import { filterConversations, groupByDay, statusMark, awaitingReply, mentionSuggestions } from "./chat.js";

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
    this.composerOptions = { kind: "chat", action: "pause", thread: "", done: false, replyTo: null };
    this.composerStatus = { text: "", error: false };
    this.chatGeneration = 0;
    this.chatScopeKey = null;
    this.chatFirstOrder = null;
    this.chatCount = 0;
    this.chatFilter = "";
    this.formValues = new Map();
    this.confirmations = new Map();
    this.manageStatus = "";
    this.readSuppressed = null;
    this.readThrough = null;
    this.sending = false;
    this.pendingMessage = null;
    this.destroyed = false;
    this.drawerQuery = window.matchMedia("(max-width: 1100px)");
    this.root = document.getElementById("app");
    this.topbar = document.getElementById("topbar");
    this.cityArea = document.getElementById("city-area");
    this.side = document.getElementById("side-panel");
    this.feed = document.getElementById("feed-panel");
    this.footer = document.getElementById("footer");
    try { this.sideWidth = localStorage.getItem("asenq.city.side") === "560" ? 560 : 360; }
    catch { this.sideWidth = 360; }
    this.root.style.setProperty("--side", `${this.sideWidth}px`);
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
    this.visibilityListener = () => this.scheduleRead();
    document.addEventListener("visibilitychange", this.visibilityListener);
    window.addEventListener("focus", this.visibilityListener);
    this.blurListener = () => clearTimeout(this.readTimer);
    window.addEventListener("blur", this.blurListener);
    this.render(this.store.snapshot());
  }

  destroy() {
    this.unsubscribe?.();
    this.destroyed = true;
    for (const timer of [this.readTimer, this.refreshTimer, this.toastTimer]) clearTimeout(timer);
    for (const entry of this.confirmations.values()) clearTimeout(entry.timer);
    document.removeEventListener("visibilitychange", this.visibilityListener);
    window.removeEventListener("focus", this.visibilityListener);
    window.removeEventListener("blur", this.blurListener);
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
    this.scheduleRead();
    this.root.classList.toggle("drawer-open", state.ui.inspectorOpen);
    this.drawerToggle.hidden = !this.drawerQuery.matches;
    this.drawerToggle.textContent = state.ui.inspectorOpen ? "CLOSE SIDEBAR [I]" : "SIDEBAR [I]";
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
    const active = this.side.contains(document.activeElement) ? document.activeElement : null;
    const field = active?.dataset.field;
    const selection = active && typeof active.selectionStart === "number" ? [active.selectionStart, active.selectionEnd] : null;
    const oldList = this.side.querySelector(".chat-messages");
    if (oldList && this.chatScopeKey) this.chatScroll = { top: oldList.scrollTop, height: oldList.scrollHeight, bottom: this.atBottom(oldList) };
    const previous = this.chatScroll ?? null;
    const sideTop = this.sideBody?.scrollTop ?? 0;
    this.side.replaceChildren();
    this.minimap = null;
    const header = element("div", "side-tabs");
    for (const tab of ["inspect", "chats", "manage"]) {
      const item = button(tab.toUpperCase(), state.ui.sidebarTab === tab ? "active" : "", () => this.store.setSidebarTab(tab));
      item.setAttribute("aria-pressed", String(state.ui.sidebarTab === tab));
      item.dataset.field = `sidebar:${tab}`;
      header.append(item);
    }
    header.append(button("⇔", "side-width", () => {
      this.sideWidth = this.sideWidth === 360 ? 560 : 360;
      try { localStorage.setItem("asenq.city.side", String(this.sideWidth)); } catch {}
      this.root.style.setProperty("--side", `${this.sideWidth}px`);
      window.dispatchEvent(new Event("resize"));
    }));
    this.side.append(header);
    this.sideBody = element("div", `side-body${state.ui.sidebarTab === "chats" && state.ui.chat ? " thread-body" : ""}`);
    this.side.append(this.sideBody);
    if (state.ui.sidebarTab !== "manage") this.deleteConfirmVenue = undefined;
    if (state.ui.sidebarTab === "chats") this.renderChats(state, previous);
    else if (state.ui.sidebarTab === "manage") this.renderManage(state);
    else this.renderInspector(state);
    this.sideBody.scrollTop = sideTop;
    if (field) {
      const replacement = [...this.side.querySelectorAll("[data-field]")].find((node) => node.dataset.field === field);
      replacement?.focus({ preventScroll: true });
      if (selection && replacement?.setSelectionRange) replacement.setSelectionRange(...selection);
      if (field === "message-text" && state.ui.chat?.scope === "channel" && replacement) {
        this.renderMentions(this.side.querySelector(".mention-suggestions"), state.ui.chat, state);
      }
    }
  }

  renderInspector(state) {
    if (!state.wire) {
      this.sideBody.append(element("p", "detail-value", "Waiting for live city state…"));
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
    const actions = element("div", "context-actions");
    const scope = this.scopeFor(target);
    if (scope) actions.append(button("OPEN CHAT", "", () => this.openChat(scope)));
    if (target && character?.source !== "human") actions.append(button("MANAGE", "", () => this.openManage(target)));
    this.sideBody.append(actions);
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
    this.sideBody.append(overview);
    const hints = this.makeSection("QUICK KEYS");
    hints.append(element("div", "key-hints", "[Enter] OPEN · [Tab] SELECT · [F] FOLLOW · [T] TRAFFIC"));
    this.sideBody.append(hints);
    this.drawMinimap(state);
  }

  renderEmptyInspector() {
    const section = this.makeSection("CITY INSPECTOR");
    section.append(element("div", "detail-value", "Select a character or channel to inspect live city state."));
    this.sideBody.append(section);
  }

  renderVenueInspector(state, venue) {
    const section = this.makeSection(`CHANNEL #${venue.name}`);
    const members = venue.rosterIds.map((id) => state.charactersById.get(id)).filter(Boolean);
    this.addDetail(section, "VENUE", venue.appearance);
    this.addDetail(section, "MEMBERS", String(members.length));
    this.addDetail(section, "POSTS", String(venue.postCount));
    this.sideBody.append(section);
    const roster = this.makeSection("SESSIONS");
    const list = element("div", "roster");
    for (const character of members) {
      const filtered = character.source !== "human" && state.ui.filter !== null && character.harness !== state.ui.filter;
      const row = button("", `roster-row${filtered ? " roster-filtered" : ""}`, () => this.selectTarget({ kind: "character", id: character.id }, true));
      row.append(element("span", "roster-name", character.name));
      row.append(element("span", "roster-meta", `${shortHarness(character.harness)} · ${roleLabel(character)}`));
      row.title = `${character.name} · ${character.state ?? "unknown"}${filtered ? " · filtered" : ""}`;
      if (filtered) row.append(element("span", "roster-meta", "FILTERED"));
      list.append(row);
    }
    if (!members.length) list.append(element("div", "detail-value", "No sessions in this channel."));
    roster.append(list);
    this.sideBody.append(roster);
  }

  renderSessionInspector(state, character) {
    const section = this.makeSection(character.name);
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
    this.sideBody.append(section);
  }

  renderProcessInspector(character) {
    const section = this.makeSection(character.name);
    this.addDetail(section, "PID", display(character.pid));
    this.addDetail(section, "HARNESS", display(character.harness));
    this.addDetail(section, "CPU", Number.isFinite(character.cpu) ? `${Math.round(character.cpu)}% (inferred)` : "unknown (inferred)");
    this.addDetail(section, "STATUS", "detected, not registered");
    this.sideBody.append(section);
  }

  renderOperatorInspector() {
    const section = this.makeSection("[H] OPERATOR");
    this.addDetail(section, "ROLE", "human participant");
    this.sideBody.append(section);
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

  openChat(scope) {
    const sameThread = sameHistoryScope(this.store.ui.chat, scope);
    this.chatGeneration++;
    if (!sameThread) {
      this.composerDraft = "";
      this.composerOptions = { kind: "chat", action: "pause", thread: "", done: false, replyTo: null };
    }
    this.composerStatus = { text: "", error: false };
    this.pendingMessage = null;
    this.readSuppressed = null;
    this.readThrough = null;
    this.chatScopeKey = null;
    this.chatScroll = null;
    this.hasNewMessages = false;
    this.historyRefresh = false;
    this.store.openChat(scope);
    if (scope) this.loadHistory(scope);
    this.refreshConversations();
  }

  closeChat() {
    this.chatGeneration++;
    this.chatScopeKey = null;
    this.chatScroll = null;
    this.readSuppressed = null;
    this.store.closeChat();
  }

  openManage(target) {
    if (target) this.store.setSelected(target);
    this.store.setSidebarTab("manage");
  }

  setHover(text) { document.getElementById("city").title = text ?? ""; }

  async loadHistory(scope, before, prepend = false) {
    if (!sameHistoryScope(this.store.ui.chat, scope)) return;
    const generation = this.chatGeneration;
    if (this.historyBusy === generation) {
      if (!prepend) this.historyRefresh = true;
      return;
    }
    this.historyBusy = generation;
    this.store.setChatLoading(true);
    try {
      const page = await this.api.history(scope, before);
      if (generation !== this.chatGeneration || !sameHistoryScope(this.store.ui.chat, scope)) return;
      this.store.setChatPage(scope, page, { prepend });
    } catch (error) {
      if (generation === this.chatGeneration) this.store.setChatLoading(false, error.message);
    } finally {
      if (this.historyBusy === generation) {
        this.historyBusy = null;
        if (this.historyRefresh) {
          this.historyRefresh = false;
          if (sameHistoryScope(this.store.ui.chat, scope)) this.loadHistory(scope);
        }
      }
    }
  }

  handleState(wire) {
    const scope = this.store.ui.chat;
    const oldVenue = scope?.scope === "channel" ? [...this.store.venuesByKey.values()].find((v) => v.name === scope.channel) : null;
    const signature = JSON.stringify([wire.characters.map((c) => [c.id, c.name, c.state, c.inbound]), wire.venues.map((v) => [v.key, v.name, v.rosterIds])]);
    this.store.setState(wire);
    if (oldVenue) {
      const venue = this.store.venuesByKey.get(oldVenue.key);
      if (!venue) this.closeChat();
      else if (venue.name !== scope.channel) {
        const { composerDraft, composerOptions } = this;
        this.openChat({ scope: "channel", channel: venue.name });
        Object.assign(this, { composerDraft, composerOptions });
      }
    }
    if (signature !== this.conversationStateSignature) {
      this.conversationStateSignature = signature;
      this.scheduleConversations();
    }
  }

  handleMessage(data) {
    this.scheduleConversations();
    const scope = this.store.ui.chat;
    if (data?.msg && scope && messageTouches(data.msg, scope)) this.loadHistory(scope);
  }

  handleRead(data) {
    const read = data?.state;
    if (read) this.store.setConversations(this.store.conversations.map((item) => sameHistoryScope(item.scope, read.scope)
      ? { ...item, unread: read.unread, reminder: read.reminder !== null } : item));
    this.scheduleConversations();
  }

  scheduleConversations() {
    if (this.refreshTimer || this.destroyed) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      this.refreshConversations();
    }, 250);
  }

  async refreshConversations() {
    if (this.destroyed) return;
    if (this.refreshBusy) { this.refreshAgain = true; return; }
    this.refreshBusy = true;
    try {
      const result = await this.api.conversations();
      this.conversationsError = null;
      if (!this.destroyed) this.store.setConversations(result.conversations);
      if ([...this.store.charactersById.values()].some((c) => c.inbound === "hold") || this.store.held.length) {
        const held = await this.api.held();
        if (!this.destroyed) this.store.setHeld(held.messages);
      }
    } catch (error) {
      this.conversationsError = error.message;
      if (!this.destroyed) this.renderSide(this.store.snapshot());
    } finally {
      this.refreshBusy = false;
      if (this.refreshAgain && !this.destroyed) { this.refreshAgain = false; this.scheduleConversations(); }
    }
  }

  renderChats(state, previous) {
    const scope = state.ui.chat;
    if (!scope) {
      const filter = element("input", "chat-filter");
      filter.type = "search";
      filter.placeholder = "FILTER CONVERSATIONS";
      filter.setAttribute("aria-label", "Filter conversations");
      filter.dataset.field = "chat-filter";
      filter.value = this.chatFilter;
      filter.addEventListener("input", () => { this.chatFilter = filter.value; this.renderSide(this.store.snapshot()); });
      this.sideBody.append(filter);
      if (this.manageStatus) this.sideBody.append(element("div", "composer-result", this.manageStatus));
      if (state.held.length) this.sideBody.append(element("div", "held-banner", `HELD ${state.held.length}`));
      if (this.conversationsError) this.sideBody.append(element("div", "composer-result error", this.conversationsError));
      const entries = filterConversations(state.conversations, this.chatFilter);
      for (const item of entries) {
        const row = button("", "conversation", () => {
          const target = item.scope.scope === "session" ? { kind: "character", id: item.scope.sessionId }
            : [...state.venuesByKey.values()].find((v) => v.name === item.scope.channel);
          const mapTarget = target?.key ? { kind: "venue", venueKey: target.key } : target;
          if (mapTarget && state.targetsByKey.has(targetKey(mapTarget))) this.selectTarget(mapTarget, true);
          else this.store.setSelected(null, { openInspector: false });
          this.openChat(item.scope);
        });
        const head = element("div", "conversation-head");
        head.append(element("span", "conversation-title", `${item.scope.scope === "channel" ? "#" : ""}${item.title}`));
        if (item.unread > 0) head.append(element("span", "unread-badge", item.unread));
        if (item.reminder) head.append(element("span", "unread-badge", "REMINDER"));
        const character = item.scope.scope === "session" ? state.charactersById.get(item.scope.sessionId) : null;
        if (item.archived) head.append(element("span", "kind-tag", "ARCHIVED"));
        else if (character) head.append(element("span", "roster-meta", `${shortHarness(character.harness)} · ${this.stateLabel(character)}`));
        row.append(head);
        if (item.preview?.text) row.append(element("div", "conversation-preview", item.preview.text));
        this.sideBody.append(row);
      }
      if (!entries.length) this.sideBody.append(element("p", "detail-value", "No conversations match."));
      return;
    }
    const key = scope.scope === "session" ? `s:${scope.sessionId}` : `ch:${scope.channel}`;
    const sameScope = this.chatScopeKey === key;
    const history = state.chat.messages;
    const character = scope.scope === "session" ? state.charactersById.get(scope.sessionId) : null;
    const summary = state.conversations.find((item) => sameHistoryScope(item.scope, scope));
    const title = scope.scope === "channel" ? `#${scope.channel}` : character?.name ?? summary?.title ?? scope.sessionId;
    const toolbar = element("div", "chat-toolbar");
    toolbar.append(button("← BACK", "", () => this.closeChat()), element("h2", "chat-heading", title));
    toolbar.append(button("MARK UNREAD", "", () => {
      this.readSuppressed = key;
      clearTimeout(this.readTimer);
      this.runManage("read.mark", { scope, state: "unread" });
    }));
    if (summary?.archived && scope.scope === "session") toolbar.append(
      this.confirmButton(`purge:${scope.sessionId}`, "PURGE", "CONFIRM PURGE", () => this.runManage("session.purge", { id: scope.sessionId })));
    this.sideBody.append(toolbar);
    if (this.manageStatus) this.sideBody.append(element("div", "composer-result", this.manageStatus));
    if (character) this.sideBody.append(element("div", "thread-state", `${this.stateLabel(character)} · BUSY ${character.busy == null ? "UNKNOWN" : character.busy ? "YES" : "NO"} · INBOUND ${character.inbound ?? "UNKNOWN"} · STALE ${character.stale == null ? "UNKNOWN" : character.stale ? "YES" : "NO"}`));
    this.renderHeld(state, character);
    const messages = element("div", "chat-messages");
    messages.setAttribute("role", "log");
    if (state.chat.hasMore) {
      const older = button("LOAD OLDER", "", () => this.loadHistory(scope, this.store.chat.messages[0]?.order, true));
      older.disabled = state.chat.loading;
      messages.append(older);
    }
    for (const group of groupByDay(history)) {
      messages.append(element("div", "date-separator", group.date.toLocaleDateString()));
      for (const message of group.messages) messages.append(this.messageCard(message, history));
    }
    if (this.pendingMessage) messages.append(element("article", "chat-message outgoing pending", this.pendingMessage));
    if (scope.scope === "session" && !summary?.archived && awaitingReply(history, scope.sessionId)) {
      const latest = history[history.length - 1];
      messages.append(element("div", "waiting-indicator", `WAITING FOR ${title}${character?.busy === true ? " · WORKING" : ""}${latest?.status === "queued" ? " · QUEUED — picked up on its next prompt" : ""}`));
    }
    if (state.chat.loading && !history.length) messages.append(element("p", "detail-value", "Loading history…"));
    if (state.chat.error) messages.append(element("div", "composer-result error", state.chat.error),
      button("RETRY HISTORY", "", () => this.loadHistory(scope)));
    this.sideBody.append(messages);
    this.newMessages = button("NEW MESSAGES ↓", "new-messages", () => {
      messages.scrollTop = messages.scrollHeight;
      this.hasNewMessages = false;
      this.newMessages.hidden = true;
      this.scheduleRead();
    });
    this.newMessages.hidden = true;
    this.sideBody.append(this.newMessages);
    if (summary?.archived) this.sideBody.append(element("p", "manage-hint", "ARCHIVED · this conversation is read-only."));
    else this.renderComposer(scope, state);
    const firstOrder = history[0]?.order ?? null;
    const prepended = sameScope && this.chatCount > 0 && history.length > this.chatCount && firstOrder !== this.chatFirstOrder;
    if (sameScope && previous) {
      messages.scrollTop = prepended ? previous.top + Math.max(0, messages.scrollHeight - previous.height)
        : previous.bottom ? messages.scrollHeight : previous.top;
      if (!previous.bottom && !prepended && history.length > this.chatCount) this.hasNewMessages = true;
      if (previous.bottom) this.hasNewMessages = false;
      this.newMessages.hidden = !this.hasNewMessages;
    } else messages.scrollTop = messages.scrollHeight;
    messages.addEventListener("scroll", () => {
      if (this.atBottom(messages)) { this.hasNewMessages = false; this.newMessages.hidden = true; }
      this.scheduleRead();
    });
    this.chatScopeKey = key;
    this.chatFirstOrder = firstOrder;
    this.chatCount = history.length;
  }

  renderHeld(state, character) {
    if (character?.inbound !== "hold") return;
    const held = state.held.filter((message) => message.toSessionId === character.id || (!message.toSessionId && message.to === character.name));
    for (const message of held) {
      const banner = element("div", "held-banner");
      banner.append(element("div", "", `HELD · ${message.from}: ${message.text || message.file?.summary || ""}`));
      banner.append(button("RELEASE", "", () => this.runManage("held.release", { msgId: message.id })),
        button("DROP", "", () => this.runManage("held.drop", { msgId: message.id })));
      this.sideBody.append(banner);
    }
  }

  messageCard(message, history) {
    const outgoing = message.from === "operator" || message.from === "human";
    const card = element("article", `chat-message${outgoing ? " outgoing" : " incoming"}`);
    const meta = element("div", "chat-meta");
    meta.append(element("time", "", timeText(message.createdAt)), element("span", "", message.from),
      element("span", kindClass(message.kind ?? "chat"), message.kind ?? "chat"));
    if (message.thread) meta.append(element("span", "kind-tag", message.thread));
    if (message.done) meta.append(element("span", "kind-tag", "DONE"));
    card.append(meta);
    if (message.replyTo) {
      const original = history.find((item) => item.id === message.replyTo);
      card.append(element("blockquote", "reply-quote", original ? `${original.from}: ${original.text || original.file?.summary || ""}` : `reply to ${message.replyTo}`));
    }
    if (message.action) card.append(element("div", "kind-control", `CONTROL · ${message.action}`));
    card.append(element("div", "chat-text", message.text ?? message.file?.summary ?? ""));
    if (message.file) card.append(element("div", "chat-file", `${message.file.summary} · ${message.file.path}`));
    card.append(element("div", "chat-status", `${statusMark(message.status)} ${message.status}${message.reason ? ` · ${message.reason}` : ""}`));
    const archived = this.store.conversations.some((item) => item.archived && sameHistoryScope(item.scope, this.store.ui.chat));
    if (!outgoing && !archived && this.store.ui.chat?.scope === "session") card.append(button("REPLY", "reply-link", () => {
      this.composerOptions.replyTo = message.id;
      this.renderSide(this.store.snapshot());
      this.composer?.focus();
    }));
    return card;
  }

  renderComposer(scope, state) {
    const composer = element("form", "chat-composer");
    if (scope.scope === "session") {
      const controls = element("div", "composer-options");
      const kind = this.optionSelect("message-kind", ["chat", "task", "status", "control"], this.composerOptions.kind, (value) => {
        this.composerOptions.kind = value;
        this.renderSide(this.store.snapshot());
      });
      kind.setAttribute("aria-label", "Message kind");
      controls.append(kind);
      if (this.composerOptions.kind === "control") {
        const action = this.optionSelect("message-action", ["pause", "resume", "cancel"], this.composerOptions.action, (value) => { this.composerOptions.action = value; });
        action.setAttribute("aria-label", "Control action");
        controls.append(action);
      }
      const thread = element("input");
      thread.dataset.field = "message-thread";
      thread.placeholder = "THREAD LABEL (optional)";
      thread.maxLength = 200;
      thread.value = this.composerOptions.thread;
      thread.setAttribute("aria-label", "Thread label");
      thread.addEventListener("input", () => { this.composerOptions.thread = thread.value; });
      controls.append(thread, this.checkbox("message-done", "DONE", this.composerOptions.done, (value) => { this.composerOptions.done = value; }));
      composer.append(controls);
      if (this.composerOptions.replyTo) composer.append(button(`reply to ${this.composerOptions.replyTo} ×`, "reply-chip", () => {
        this.composerOptions.replyTo = null;
        this.renderSide(this.store.snapshot());
      }));
    }
    this.composer = element("textarea");
    this.composer.dataset.field = "message-text";
    this.composer.setAttribute("aria-label", "Message");
    this.composer.placeholder = "MESSAGE… (Enter sends · Shift+Enter newline)";
    this.composer.value = this.composerDraft;
    const suggestions = element("div", "mention-suggestions");
    this.composer.addEventListener("input", () => {
      this.composerDraft = this.composer.value;
      if (scope.scope === "channel") this.renderMentions(suggestions, scope, state);
    });
    this.composer.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        event.stopPropagation();
        this.submitMessage(scope);
      } else if (event.key === "Escape") {
        // Leave the composer (draft kept); a second Escape from the map closes the thread.
        event.preventDefault();
        event.stopPropagation();
        this.composer.blur();
      }
    });
    const actions = element("div", "composer-actions");
    actions.append(element("span", `composer-result${this.composerStatus.error ? " error" : ""}`, this.composerStatus.text));
    const submit = button(this.composerStatus.error ? "RETRY" : "SEND", "", () => this.submitMessage(scope));
    submit.disabled = this.sending;
    actions.append(submit);
    composer.append(this.composer, suggestions, actions);
    if (scope.scope === "channel") this.renderMentions(suggestions, scope, state);
    composer.addEventListener("submit", (event) => { event.preventDefault(); this.submitMessage(scope); });
    this.sideBody.append(composer);
  }

  renderMentions(container, scope, state) {
    container.replaceChildren();
    const before = this.composer.value.slice(0, this.composer.selectionStart);
    const match = before.match(/(?:^|[\s(\[<{"'`])@([A-Za-z0-9_-]*)$/);
    if (!match) return;
    const venue = [...state.venuesByKey.values()].find((v) => v.name === scope.channel);
    const members = (venue?.rosterIds ?? []).map((id) => state.charactersById.get(id)).filter(Boolean);
    for (const name of mentionSuggestions(members, match[1])) container.append(button(`@${name}`, "", () => {
      const end = this.composer.selectionStart;
      const start = end - match[1].length - 1;
      this.composer.setRangeText(`@${name} `, start, end, "end");
      this.composerDraft = this.composer.value;
      container.replaceChildren();
      this.composer.focus();
    }));
  }

  async submitMessage(scope) {
    const text = this.composerDraft;
    if (!text.trim() || this.sending) return;
    const generation = this.chatGeneration;
    const target = scope.scope === "channel" ? { kind: "channel", name: scope.channel } : { kind: "session", id: scope.sessionId };
    const options = scope.scope === "session" ? {
      kind: this.composerOptions.kind,
      ...(this.composerOptions.kind === "control" ? { action: this.composerOptions.action } : {}),
      ...(this.composerOptions.thread ? { thread: this.composerOptions.thread } : {}),
      ...(this.composerOptions.replyTo ? { replyTo: this.composerOptions.replyTo } : {}),
      done: this.composerOptions.done,
    } : undefined;
    this.sending = true;
    this.pendingMessage = text;
    this.composerStatus = { text: "SENDING…", error: false };
    this.renderSide(this.store.snapshot());
    try {
      const reply = await this.api.send(target, text, options);
      const result = sendResult(reply);
      if (generation === this.chatGeneration) {
        if (this.composerDraft === text) this.composerDraft = "";
        this.composerOptions.replyTo = null;
        this.composerStatus = { text: result, error: false };
        this.loadHistory(scope);
      }
      this.showToast(result, false);
      this.scheduleConversations();
    } catch (error) {
      if (generation === this.chatGeneration) this.composerStatus = { text: error.message, error: true };
      this.showToast(error.message, true);
    } finally {
      this.sending = false;
      if (generation === this.chatGeneration) this.pendingMessage = null;
      if (!this.destroyed) this.renderSide(this.store.snapshot());
    }
  }

  atBottom(list) { return list.scrollHeight - list.clientHeight - list.scrollTop <= 16; }

  canRead(scope) {
    return !this.destroyed && sameHistoryScope(scope, this.store.ui.chat) && this.store.ui.sidebarTab === "chats"
      && (!this.drawerQuery.matches || this.store.ui.inspectorOpen) && document.visibilityState === "visible"
      && document.hasFocus() && this.atBottom(this.side.querySelector(".chat-messages") ?? { scrollHeight: 1, clientHeight: 0, scrollTop: -100 });
  }

  scheduleRead() {
    const scope = this.store.ui.chat;
    if (!scope || !this.canRead(scope) || this.readSuppressed === this.chatScopeKey || this.store.chat.loading) {
      clearTimeout(this.readTimer);
      this.readTimer = null;
      return;
    }
    const latest = this.store.chat.messages.at(-1)?.order ?? 0;
    const signature = `${this.chatScopeKey}:${latest}`;
    if (signature === this.readThrough || this.readTimerSignature === signature && this.readTimer) return;
    clearTimeout(this.readTimer);
    this.readTimerSignature = signature;
    this.readTimer = setTimeout(async () => {
      this.readTimer = null;
      if (!this.canRead(scope) || this.readSuppressed === this.chatScopeKey) return;
      try {
        const result = await this.api.manage("read.mark", { scope, state: "read" });
        if (result.applied !== false) this.readThrough = signature;
        this.handleRead(result);
      } catch (error) {
        // Do not re-arm for the same newest message on every render; a new message or scope change retries.
        this.readThrough = signature;
        this.showToast(error.message, true);
      }
    }, 400);
  }

  inputField(key, initial, placeholder) {
    const input = element("input");
    input.dataset.field = key;
    input.value = this.formValues.get(key) ?? initial;
    input.placeholder = placeholder;
    input.setAttribute("aria-label", placeholder);
    input.addEventListener("input", () => this.formValues.set(key, input.value));
    return input;
  }

  optionSelect(key, options, selected, onChange) {
    const select = element("select");
    select.dataset.field = key;
    for (const item of options) {
      const value = typeof item === "string" ? item : item.value;
      const option = element("option", "", typeof item === "string" ? item : item.label);
      option.value = value;
      select.append(option);
    }
    select.value = selected;
    if (!select.value && select.options.length) select.selectedIndex = 0;
    select.addEventListener("change", () => onChange(select.value));
    return select;
  }

  checkbox(key, title, checked, onChange) {
    const label = element("label", "check-label");
    const input = element("input");
    input.type = "checkbox";
    input.dataset.field = key;
    input.checked = checked;
    input.addEventListener("change", () => onChange(input.checked));
    label.append(input, document.createTextNode(title));
    return label;
  }

  async runManage(op, params) {
    if (this.manageBusy) return;
    this.manageBusy = true;
    this.manageStatus = "WORKING…";
    this.renderSide(this.store.snapshot());
    try {
      const result = await this.api.manage(op, params);
      if (op === "session.purge" && (params.all || this.store.ui.chat?.sessionId === params.id)) this.closeChat();
      this.manageStatus = manageResult(op, result);
      if (op === "read.mark") this.handleRead(result);
      this.showToast(this.manageStatus, false);
      if (this.store.ui.chat) this.loadHistory(this.store.ui.chat);
      await this.refreshConversations();
    } catch (error) {
      this.manageStatus = error.message;
      this.showToast(error.message, true);
    } finally {
      this.manageBusy = false;
      this.clearDeleteConfirmations();
      if (!this.destroyed) this.renderSide(this.store.snapshot());
    }
  }

  confirmButton(key, title, confirm, action) {
    const armed = this.confirmations.has(key);
    const node = button(armed ? confirm : title, "danger-action", () => {
      if (this.confirmations.has(key)) {
        clearTimeout(this.confirmations.get(key).timer);
        this.confirmations.delete(key);
        action();
      } else {
        const timer = setTimeout(() => {
          this.confirmations.delete(key);
          if (!this.destroyed) this.renderSide(this.store.snapshot());
        }, 5000);
        this.confirmations.set(key, { timer });
        this.renderSide(this.store.snapshot());
      }
    });
    node.disabled = this.manageBusy;
    node.dataset.field = `confirm:${key}`;
    return node;
  }

  radioGroup(section, title, values, selected, action) {
    const group = element("fieldset", "manage-radios");
    group.append(element("legend", "", title));
    for (const value of values) {
      const label = element("label");
      const input = element("input");
      input.type = "radio";
      input.dataset.field = `radio:${title}:${value}`;
      input.name = title;
      input.value = value;
      input.checked = value === selected;
      input.disabled = this.manageBusy;
      input.addEventListener("change", () => action(value));
      label.append(input, document.createTextNode(value));
      group.append(label);
    }
    section.append(group);
  }

  clearDeleteConfirmations() {
    for (const key of [...this.formValues.keys()]) if (key.startsWith("delete-channel:")) this.formValues.delete(key);
  }

  renderManage(state) {
    this.sideBody.append(element("div", "composer-result manage-result", this.manageStatus));
    const target = state.ui.selected;
    const character = target && target.kind !== "venue" ? state.charactersById.get(target.id) : null;
    const venue = target?.kind === "venue" ? state.venuesByKey.get(target.venueKey) : null;
    if (this.deleteConfirmVenue !== (venue?.key ?? null)) {
      this.clearDeleteConfirmations();
      this.deleteConfirmVenue = venue?.key ?? null;
    }
    const live = [...state.charactersById.values()].filter((c) => c.source === "registered" && c.state !== "removed");
    if (character?.source === "registered") this.renderSessionManage(state, character, live);
    else if (character?.source === "process") {
      const section = this.makeSection(character.name);
      section.append(element("p", "detail-value", "detected, not registered"),
        this.confirmButton(`kill:${character.pid}`, `KILL PROCESS pid ${character.pid}`, "CONFIRM KILL", () => this.runManage("process.kill", { pid: character.pid })));
      this.sideBody.append(section);
    } else if (venue) this.renderChannelManage(state, venue, live);
    else this.sideBody.append(element("p", "detail-value", "Select a session, process or channel to manage."));
    const global = this.makeSection("GLOBAL MANAGEMENT");
    const name = this.inputField("create-channel", "", "CHANNEL NAME");
    global.append(element("div", "manage-hint", "CREATE CHANNEL · lowercase letters, digits, - and _"), name,
      button("CREATE CHANNEL", "", () => this.runManage("channel.create", { name: name.value })));
    const stale = [...state.charactersById.values()].filter((c) => c.source === "registered" && c.stale === true).length;
    global.append(this.confirmButton("close-stale", `CLOSE ALL STALE (${stale})`, "CONFIRM CLOSE STALE", () => this.runManage("session.closeStale", {})),
      this.confirmButton("purge-all", "PURGE ALL ARCHIVED", "CONFIRM PURGE ALL", () => this.runManage("session.purge", { all: true })));
    this.sideBody.append(global);
  }

  renderSessionManage(state, character, live) {
    const section = this.makeSection(character.name);
    const id = character.id;
    const rename = this.inputField(`rename:${id}`, character.name, "SESSION NAME");
    section.append(rename, button("APPLY NAME", "", () => this.runManage("session.rename", { id, name: rename.value })));
    this.radioGroup(section, "ROLE", ["orchestrator", "worker", "unset"], character.role ?? "unset",
      (role) => this.runManage("session.role", { id, role: role === "unset" ? null : role }));
    this.radioGroup(section, "INBOUND", ["accept", "hold", "refuse"], character.inbound ?? "accept",
      (mode) => this.runManage("session.inbound", { id, mode }));
    section.append(button("PING", "", () => this.runManage("session.ping", { id })));
    const membership = this.makeSection("CHANNEL MEMBERSHIPS");
    for (const name of character.memberships) membership.append(button(`#${name} ×`, "membership-chip", () => this.runManage("channel.remove", { name, id })));
    const channels = [...state.venuesByKey.values()].filter((v) => !character.memberships.includes(v.name));
    if (channels.length) {
      const key = `add-channel:${id}`;
      const add = this.optionSelect(key, channels.map((v) => ({ value: v.name, label: `#${v.name}` })),
        this.formValues.get(key) ?? channels[0].name, (value) => this.formValues.set(key, value));
      membership.append(add, button("ADD CHANNEL", "", () => this.runManage("channel.add", { name: add.value, id })));
    }
    section.append(membership);
    const replacements = live.filter((c) => c.id !== id);
    if (replacements.length) {
      const key = `replace:${id}`;
      const replace = this.optionSelect(key, replacements.map((c) => ({ value: c.id, label: c.name })),
        this.formValues.get(key) ?? replacements[0].id, (value) => this.formValues.set(key, value));
      section.append(replace, button("REPLACE ONTO…", "", () => this.runManage("session.replace", { fromId: id, toId: replace.value })));
    }
    const terminateKey = `terminate:${id}`;
    if (character.ownerPid) section.append(this.checkbox(terminateKey, `ALSO SIGTERM PROCESS pid ${character.ownerPid} (inferred from resume id)`,
      this.formValues.get(terminateKey) ?? true, (checked) => this.formValues.set(terminateKey, checked)));
    else section.append(element("p", "manage-hint", "Process not identified: it keeps running after close"));
    section.append(this.confirmButton(`close:${id}`, "CLOSE SESSION", "CONFIRM CLOSE", () => this.runManage("session.close",
      { id, terminate: Boolean(character.ownerPid) && (this.formValues.get(terminateKey) ?? true) })));
    this.sideBody.append(section);
  }

  renderChannelManage(state, venue, live) {
    const section = this.makeSection(`#${venue.name}`);
    const rename = this.inputField(`channel-rename:${venue.key}`, venue.name, "CHANNEL NAME");
    section.append(rename, button("APPLY NAME", "", () => this.runManage("channel.rename", { name: venue.name, to: rename.value })));
    const members = this.makeSection("MEMBERS");
    for (const id of venue.rosterIds) members.append(button(`${state.charactersById.get(id)?.name ?? id} ×`, "membership-chip",
      () => this.runManage("channel.remove", { name: venue.name, id })));
    const candidates = live.filter((c) => !venue.rosterIds.includes(c.id));
    if (candidates.length) {
      const key = `add-member:${venue.key}`;
      const add = this.optionSelect(key, candidates.map((c) => ({ value: c.id, label: c.name })),
        this.formValues.get(key) ?? candidates[0].id, (value) => this.formValues.set(key, value));
      members.append(add, button("ADD MEMBER", "", () => this.runManage("channel.add", { name: venue.name, id: add.value })));
    }
    section.append(members, element("p", "manage-hint", "Deleting this channel deletes its posts; direct messages stay. Type the exact channel name to confirm."));
    const typed = this.inputField(`delete-channel:${venue.key}`, "", `TYPE ${venue.name}`);
    const remove = button("DELETE CHANNEL", "danger-action", () => {
      if (typed.value === venue.name) this.runManage("channel.delete", { name: venue.name });
    });
    remove.disabled = typed.value !== venue.name || this.manageBusy;
    typed.addEventListener("input", () => { remove.disabled = typed.value !== venue.name || this.manageBusy; });
    section.append(typed, remove);
    this.sideBody.append(section);
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
  if (reply?.results?.length) return reply.results.map((result) => `${result.to}: ${result.status}${result.reason ? ` · ${result.reason}` : ""}`).join(" · ");
  const result = reply?.result;
  if (result && typeof result === "object") return `${result.to ?? "message"}: ${result.status ?? result.state ?? "sent"}${result.reason ? ` · ${result.reason}` : ""}`;
  return "posted";
}

function manageResult(op, result) {
  if (op === "session.close") return `closed · ${result.terminated ? `terminated pid ${result.terminated}` : result.reason ? `${result.reason}: it keeps running` : "process not identified: it keeps running"}`;
  if (op === "session.ping") return result.results?.map((item) => `${item.name}: ${item.ping}`).join(" · ") || result.ping || "unknown";
  if (op === "read.mark") return result.state?.unread ? "marked unread" : "marked read";
  if (result.terminated) return `terminated pid ${result.terminated}`;
  if (result.closed !== undefined) return `closed ${result.closed}`;
  if (result.purged !== undefined) return `purged ${result.purged}`;
  return `${op} · complete`;
}

function sameHistoryScope(left, right) {
  if (!left || !right || left.scope !== right.scope) return false;
  return left.scope === "channel" ? left.channel === right.channel : left.sessionId === right.sessionId;
}
