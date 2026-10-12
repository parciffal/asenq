import assert from "node:assert/strict";
import { test } from "node:test";

// The browser stays uncompiled, so this runtime URL reaches the shipped web/ tree from dist/test.
const city = await import(new URL("../../web/city/app/logic.js", import.meta.url).href);
const { CityStore } = await import(new URL("../../web/city/app/store.js", import.meta.url).href);
// Static imports would resolve from dist/; these URLs intentionally load the uncompiled browser modules.
const chat = await import(new URL("../../web/city/app/chat.js", import.meta.url).href);

type Character = {
  id: string; name: string; previousNames: string[]; source: "registered" | "process" | "human";
  harness: string | null; role: string | null; state: string | null; stale: boolean | null;
  ping: string | null; busy: boolean | null; cpu: number | null; memberships: string[];
};
const character = (overrides: Partial<Character> = {}): Character => ({
  id: "session-1", name: "worker", previousNames: [], source: "registered", harness: "claude", role: "worker",
  state: "live", stale: false, ping: null, busy: null, cpu: null, memberships: [], ...overrides,
});

test("busy animation alternates work poses on a 500ms cadence", () => {
  const worker = character({ busy: true });
  assert.equal(city.poseFor(worker, null, 0, "connected", false).pose, "work_a");
  assert.equal(city.poseFor(worker, null, 500, "connected", false).pose, "work_b");
  assert.equal(city.poseFor(worker, null, 1000, "connected", false).pose, "work_a");
});

test("operator uses idle behavior even when the daemon reports busy", () => {
  const operator = character({ source: "human", busy: true });
  assert.deepEqual(city.poseFor(operator, null, 500, "connected", true), {
    pose: "idle_a", tone: "normal", label: "OPERATOR",
  });
});

test("unknown busy state is static and visibly labelled UNKNOWN", () => {
  const worker = character({ busy: null });
  const first = city.poseFor(worker, null, 1200, "connected", false);
  const second = city.poseFor(worker, null, 1250, "connected", false);
  assert.deepEqual(second, first);
  assert.equal(first.label, "UNKNOWN");
  assert.equal(first.badge, "?");
});

test("send animation lasts 800ms and changes pose after its first 400ms", () => {
  const worker = character({ busy: false });
  const anim = { send: 1000 };
  assert.equal(city.poseFor(worker, anim, 1000, "connected", false).pose, "send_a");
  assert.equal(city.poseFor(worker, anim, 1399, "connected", false).pose, "send_a");
  assert.equal(city.poseFor(worker, anim, 1400, "connected", false).pose, "send_b");
  assert.equal(city.poseFor(worker, anim, 1799, "connected", false).pose, "send_b");
  assert.equal(city.poseFor(worker, anim, 1800, "connected", false).label, "IDLE");
});

test("reduced motion holds active work and send poses", () => {
  const worker = character({ busy: true });
  assert.equal(city.poseFor(worker, null, 500, "connected", true).pose, "work_a");
  assert.equal(city.poseFor(worker, { send: 0 }, 600, "connected", true).pose, "send_a");
});

test("offline and stale lifecycle labels take precedence over activity", () => {
  const worker = character({ busy: true, state: "stale", stale: true });
  assert.deepEqual(city.poseFor(worker, { send: 0 }, 1, "offline", false), { pose: "idle_a", tone: "offline", label: "OFFLINE" });
  assert.equal(city.poseFor(worker, { send: 0 }, 1, "connected", false).label, "LOST");
});

test("label sanitization removes terminal and bidi controls and truncates by code point", () => {
  assert.equal(city.sanitizeLabel("ab\u202ecd\u001b"), "abcd");
  assert.equal(city.sanitizeLabel("12345678901234567"), "1234567890123456…");
  assert.equal(city.sanitizeLabel("😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀"), "😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀…");
});

test("target cycling wraps stable layout order and excludes filtered characters", () => {
  const venue = { kind: "venue", venueKey: "venue:0" };
  const claude = { kind: "character", id: "claude-1" };
  const omp = { kind: "character", id: "omp-1" };
  const state = {
    characters: [character({ id: "claude-1", harness: "claude" }), character({ id: "omp-1", harness: "omp" })],
    layout: { targets: [
      { target: venue, order: 0 }, { target: claude, order: 1 }, { target: omp, order: 2 },
    ] },
  };
  const targets = city.orderedTargets(state, "claude", true);
  assert.deepEqual(targets.map((item: { target: { kind: string; id?: string } }) => item.target.id ?? item.target.kind), ["venue", "claude-1"]);
  assert.deepEqual(city.cycle(targets, "c:claude-1", 1).target, venue);
  assert.deepEqual(city.cycle(targets, "v:venue:0", -1).target, claude);
});

test("search matches sanitized current and former names plus channel names", () => {
  const worker = character({ id: "worker-id", name: "current", previousNames: ["old-name"] });
  const target = { kind: "character", id: worker.id };
  const venueTarget = { kind: "venue", venueKey: "venue:0" };
  const state = {
    characters: [worker], venues: [{ key: "venue:0", name: "design" }],
    layout: { targets: [{ target, order: 1 }, { target: venueTarget, order: 0 }] },
  };
  assert.deepEqual(city.search(state, "old-name"), [target]);
  assert.deepEqual(city.search(state, "design"), [venueTarget]);
});

test("search distinguishes long names that share their truncated display prefix", () => {
  const first = character({ id: "first", name: "1234567890123456A-worker" });
  const second = character({ id: "second", name: "1234567890123456B-worker" });
  const firstTarget = { kind: "character", id: first.id };
  const secondTarget = { kind: "character", id: second.id };
  const state = {
    characters: [first, second],
    layout: { targets: [{ target: firstTarget, order: 0 }, { target: secondTarget, order: 1 }] },
  };
  assert.deepEqual(city.search(state, first.name), [firstTarget]);
  assert.deepEqual(city.search(state, "1234567890123456A"), [firstTarget]);
});

test("hiding processes clears a selected process and its follow state", () => {
  const store = new CityStore();
  const process = character({ id: "process:42", source: "process" });
  const target = { kind: "character", id: process.id };
  store.setState({
    connection: "connected", characters: [process], venues: [], feed: [],
    layout: { targets: [{ target, order: 0 }], routes: {} },
  });
  store.setSelected(target);
  store.setFollow("traffic");
  store.setShowProcesses(false);
  assert.equal(store.ui.selected, null);
  assert.equal(store.ui.inspectorOpen, false);
  assert.equal(store.ui.follow, false);
});

test("chat scopes use channel names and registered identities only", () => {
  const worker = character({ id: "registered" });
  const process = character({ id: "proc:8", source: "process" });
  const state = {
    characters: [worker, process], venues: [{ key: "venue:0", name: "design" }],
    layout: { venues: [{ key: "venue:0" }] },
  };
  assert.deepEqual(city.scopeOf({ kind: "venue", venueKey: "venue:0" }, state), { scope: "channel", channel: "design" });
  assert.deepEqual(city.scopeOf({ kind: "character", id: "registered" }, state), { scope: "session", sessionId: "registered" });
  assert.equal(city.scopeOf({ kind: "character", id: "proc:8" }, state), null);
  assert.equal(city.scopeOf({ kind: "character", id: "human" }, { characters: [character({ id: "human", source: "human" })] }), null);
});

test("message matching isolates channel history and includes both sides of a DM", () => {
  const channel = { id: "post", channel: "design", fromSessionId: "a", toSessionId: undefined };
  const dm = { id: "dm", channel: undefined, fromSessionId: "a", toSessionId: "b" };
  assert.equal(city.messageTouches(channel, { scope: "channel", channel: "design" }), true);
  assert.equal(city.messageTouches(channel, { scope: "channel", channel: "ops" }), false);
  assert.equal(city.messageTouches(dm, { scope: "session", sessionId: "a" }), true);
  assert.equal(city.messageTouches(dm, { scope: "session", sessionId: "b" }), true);
  assert.equal(city.messageTouches(dm, { scope: "session", sessionId: "c" }), false);
});

test("walk paths return to the street spine and sample route segments in cell units", () => {
  assert.deepEqual(city.walkPath({ x: 1, y: -4 }, { x: 7, y: -2 }), [
    { x: 1, y: -4 }, { x: 1, y: 0 }, { x: 7, y: 0 }, { x: 7, y: -2 },
  ]);
  const route = { length: 10, segments: [{ from: { x: 0, y: 0 }, to: { x: 10, y: 0 }, length: 10, start: 0 }] };
  assert.deepEqual(city.sample(route, 4), { x: 4, y: 0 });
});

test("conversation sorting uses recency then title and filtering includes previews", () => {
  const entries = [
    { title: "Beta", lastActivity: 20, preview: { text: "deploy ready" } },
    { title: "Alpha", lastActivity: 20, preview: null },
    { title: "Newest", lastActivity: 30, preview: null },
  ];
  assert.deepEqual(chat.sortConversations(entries).map((item: { title: string }) => item.title), ["Newest", "Alpha", "Beta"]);
  assert.deepEqual(chat.filterConversations(entries, "DEPLOY").map((item: { title: string }) => item.title), ["Beta"]);
  assert.deepEqual(chat.filterConversations(entries, "alpha").map((item: { title: string }) => item.title), ["Alpha"]);
  assert.equal(entries[0].title, "Beta");
});

test("reply waiting follows the newest DM involving the selected identity", () => {
  const outgoing = { toSessionId: "session", from: "human", order: 1 };
  const incoming = { fromSessionId: "session", to: "human", order: 2 };
  assert.equal(chat.awaitingReply([], "session"), false);
  assert.equal(chat.awaitingReply([outgoing], "session"), true);
  assert.equal(chat.awaitingReply([outgoing, incoming], "session"), false);
  assert.equal(chat.awaitingReply([incoming, outgoing], "session"), true);
  assert.equal(chat.awaitingReply([{ ...outgoing, toSessionId: "other" }], "session"), false);
  assert.equal(chat.awaitingReply([outgoing, { ...incoming, channel: "ops" }], "session"), true);
});

test("message status marks distinguish every delivery outcome", () => {
  assert.deepEqual(["queued", "delivered", "replied", "held", "rejected", "failed", "expired", "posted", "dropped"].map(chat.statusMark),
    ["⌛", "✓", "✓✓", "HELD", "✗", "✗", "✗", "•", "✗"]);
});

test("mention suggestions match member prefixes and always offer all", () => {
  const members = [{ name: "ops-11" }, { name: "design" }];
  assert.deepEqual(chat.mentionSuggestions(members, "@ops"), ["ops-11", "all"]);
  assert.deepEqual(chat.mentionSuggestions(members, "wor"), ["worker", "all"]);
  assert.deepEqual(chat.mentionSuggestions(members, "orch"), ["orchestrator", "all"]);
  assert.deepEqual(chat.mentionSuggestions(members, "missing"), ["all"]);
});

test("message day groups split at local midnight", () => {
  const messages = [
    { id: "late", createdAt: new Date(2026, 9, 11, 23, 59, 59).getTime() },
    { id: "early", createdAt: new Date(2026, 9, 12, 0, 0, 0).getTime() },
    { id: "later", createdAt: new Date(2026, 9, 12, 12, 0, 0).getTime() },
  ];
  assert.deepEqual(chat.groupByDay(messages).map((group: { messages: { id: string }[] }) => group.messages.map((message) => message.id)),
    [["late"], ["early", "later"]]);
  assert.deepEqual(chat.groupByDay([]), []);
});
