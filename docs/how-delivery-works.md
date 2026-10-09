# How delivery works

User workflows and command reference: [README](../README.md). This document preserves the detailed behavior behind naming, delivery, reading and human actions for protocol revision **17**.

## Harness wiring and delivery

Setup wires installed harnesses as follows:

- **Claude Code:** adds one hook command (`asenq hook claude`) to `~/.claude/settings.json` for `SessionStart`, `SessionEnd`, `PostToolUse`, `UserPromptSubmit` and `Stop`, and registers the MCP server with `claude mcp add --scope user asenq`.
- **OpenCode:** writes the plugin shim `~/.config/opencode/plugins/asenq.js`.
- **omp:** writes the extension shim `~/.omp/agent/extensions/asenq.js`, or `$PI_CODING_AGENT_DIR/extensions/asenq.js` when that variable is set.
- **Old mcp-messenger:** removes its wiring if found (hooks, MCP entries, OpenCode plugin).

Before changing a JSON file for the first time, setup saves a copy next to it as `<file>.asenq-bak`. To undo everything, run `asenq setup --remove`. It keeps the message history in `~/.asenq/asenq.db`.

A per-user daemon listens on `~/.asenq/asenq.sock` (mode 0600) and stores sessions and messages in SQLite. Any asenq command or adapter starts the daemon if it isn't running.

| Harness | Registration | Delivery |
|---|---|---|
| Claude Code | `SessionStart` hook; the MCP server attaches using `CLAUDE_CODE_SESSION_ID` | One user frame written to the session's `CLAUDE_CODE_MESSAGING_SOCKET`. If there is no socket, hooks deliver it: `PostToolUse` / `UserPromptSubmit` add it as context, and `Stop` blocks with it. |
| OpenCode | Plugin, when a top-level session is created or first becomes active | `client.session.promptAsync` |
| omp | Extension, at `session_start` of the top-level session | `pi.sendUserMessage(text, { deliverAs: "aside" })` |

Subagents (Claude subagents, OpenCode child sessions, omp subagents) are not registered.

## Names and session identity

`ASENQ_NAME` or a usable Claude session title takes precedence. A new session with no usable name (missing, empty, invalid or reserved) gets a readable default such as `claude-arctic-fox`. The first word pair is derived from the full harness session id, not Claude's process socket, so it is stable on a fresh database.

If that default is taken, asenq walks the bundled adjective/animal pairs in a deterministic order. Only after every pair is taken does it try `-2`, `-3`, … on the original pair. A resumed identity uses its retained name and the existing revival-clash rules; default-name selection applies only to new identities, and an explicit rename is not regenerated.

A usable requested name, `ASENQ_NAME`, or Claude title is an explicit claim: if another live or reconnecting session reserves that current or former name, registration fails with `name_taken`.

`asenq rename <old> <new>` or `asenq_rename` changes the name, not the session identity or conversation. Until the identity is explicitly closed, messages sent to any former name reach it using its **current** recipient name in send results, deliveries and history.

Live and reconnecting (`gone`) sessions reserve both their current name and every forwarding former name. Explicit fresh registration and renaming reject another live or reconnecting identity's reservation with `name_taken`; you can reclaim your own former name unless another live or reconnecting identity also reserves it. Automatically removed identities reserve no names, so a new identity can reuse them. Reconnecting by harness identity ignores a newly supplied name and restores the stored identity and name; if a removed identity's stored name was claimed, revival uses a numeric suffix, keeps the old name as a former name and publishes a rename.

Name lookup prefers live/reconnecting current names, then live/reconnecting former names, then automatically removed current names, then automatically removed former names. Ties within one level fail with `ambiguous_target`, listing candidate names, ids and timestamps rather than picking a recipient. Automatically removed identities still admit queued messages through their current and former names, subject to inbound policy.

Explicit closure ends forwarding through every former name and the current name: a closed identity is excluded from name lookup, does not reserve names, and cannot receive new messages. Resuming its old harness session creates a fresh identity rather than reviving the closed conversation. Automatic removal is not closure and preserves forwarding and waiting messages.

### Resume recognition and lineage fingerprints

- **The session resumes.** omp/OpenCode registration keys and recorded Claude session ids restore the identity, current name and waiting messages, even after removal or a daemon restart. Claude resumes that change ids are also recognised by copied transcript lineage: only the first 8 JSONL lines are inspected. Exactly one offline match revives; a live match (a fork), ambiguous matches or unavailable lineage creates a new identity. If the copied head arrives later, hooks or MCP attach merge the provisional identity into its ancestor, keeping both queues, conversation history and human read state. Ambiguous candidate ids are logged for manual replacement. Sharing a name and working directory alone never establishes identity. If a revived name was claimed, revival chooses a suffix and records its former name.
- **A resume transcript is still being copied.** Lineage recognition for `source=resume` waits for 8 complete JSONL lines. Shorter heads remain provisional and retry on later hooks or MCP attach, without timers; this avoids selecting a fork from partially copied evidence. Once a usable complete head decides revival, fork, ambiguity or no match, that decision is final: a later removed fork cannot replace the live identity.

On late Claude lineage recognition, provisional channel memberships are unioned into the ancestor; its existing role wins, or it inherits the provisional role if unset. Its inbound policy is unchanged. Sharing a name or working directory alone never proves identity.

### Session metadata and availability

`asenq ls` and `asenq_list` show current and former names, stable identity, harness, working directory, role, channels, inbound policy, state, latest ping, busy status, last contact and the actual harness session ID. Filters select a literal working-directory prefix, an exact harness or current channel membership; all supplied filters must match.

```sh
asenq ls --cwd /work/project --harness opencode --channel backend
```

`lastSeen` is durable harness contact (registration, hooks, bound requests, acknowledgments and matched pongs), not direct-message activity. Legacy sessions without recorded contact show `unknown`. A disconnected row is `gone`; a connected row whose latest ping is `not_responding` is `stale`. Both have `stale=yes`. Never-pinged rows show `ping=never`; unsupported checks show `unknown (unavailable)`. New contact or messages do not clear a failed ping; an answered ping does.

Busy is informational: omp reports `agent_start` / `agent_end`, OpenCode reports session status, and Claude uses the existing UserPromptSubmit/Stop hooks. Scheduled omp continuations and Claude Stop hooks that return polled messages stay busy. Unknown or unsupported status is not idle; disconnect, registration and daemon restart reset it to unknown. Busy never changes delivery policy.

When the actual harness session ID is known, the list includes a shell-quoted resume command: `claude -r <id>`, `omp -r <id>` or `opencode -s <id>`. Unknown IDs omit the command rather than inventing one.

A role belongs to the session identity, not its name: renaming and reconnecting preserve it, while a different identity reusing the name starts unset. `asenq ls` and `asenq_list` show the role. Every delivered direct-message header tells the recipient its own role (`your-role=worker` or `your-role=orchestrator`); unset roles omit that label. TUI rows use inverse `orch` / `wrk` tags beside short harness labels, with metadata on a second row when needed; the conversation header also shows the full role. Archived identities retain their dimmed role tag; automatically removed identities accept queued direct messages while retained.

## Channels and mentions

Channels have durable names and rosters of session identities. A session may belong to several channels, with any mix of roles. Membership survives rename, temporary disconnection, automatic removal and revival; another identity reusing a name does not inherit it. Human **close**, archive **purge** and identity retention remove that identity's memberships without deleting the channel or its posts. Late Claude lineage recognition unions provisional memberships into the ancestor, preserves an existing ancestor role or inherits the provisional role when unset, and leaves the ancestor's inbound policy unchanged.

The human can create channels and edit any roster through the CLI or **? → Create channel / Add channel member / Remove channel member** in the TUI. An orchestrator can create a new channel with itself as first member, or add itself to any existing channel; it can edit other members only in channels it belongs to. Workers and unset-role sessions cannot create channels or edit rosters. Adding requires a live target. Removal resolves current names before former names within that roster and refuses ambiguous matches; the human can instead pass `--session-id` to remove a specific identity, including an archived member. The TUI always removes by identity.

Posting to an unknown channel still creates it, with an empty roster and no automatic membership. Existing post-only channels migrate with empty rosters. Add/remove/member queries require an existing channel. Channel reads remain unrestricted: membership alone does not push channel posts. Mention delivery is opt-in per post.

For a sending session, `"*"` produces a direct message to each **live** session sharing any of its channels, once even if several channels overlap, and never to the sender. A channel member with no live co-members reaches nobody; it does not fall back to machine-wide delivery. A sender belonging to no channel reaches every other live session on the machine. Human broadcasts remain machine-wide, and the human is never a broadcast target. Named direct messages remain unrestricted by membership; broadcasts use the same inbound policy, rate limits and delivery handling as other direct messages.

The Channels tab lists each roster under its channel with role and lifecycle state. Selecting a member keeps the channel conversation and composer in channel scope, not a direct message. Purging retained posts keeps the channel; deleting an identity through retention removes its memberships.

### Channel mentions

Mention a member's current or former name to deliver a channel post as a direct message. Group keywords take precedence over member names:

| Token | Targets |
|---|---|
| `@orch`, `@orchestrator`, `@orchestrators` | Members with the orchestrator role |
| `@wrk`, `@worker`, `@workers` | Members with the worker role |
| `@all` | All channel members |

Every group excludes the posting session; the human is never a target. Each resolved identity is targeted once per post, even when named repeatedly or included by several groups. A group with no matching members is valid and produces no direct messages. Current names take precedence over former names within the roster; an ambiguous former name is an error.

Mentions start at the beginning of text, after whitespace, or after `(`, `[`, `{`, `<`, `"`, `'`, or a backtick. A token ends at the first character outside ASCII letters, digits, `_` and `-`: `(@alpha)`, `"@alpha"` and `@alpha,` address `alpha`. Other preceding characters block mentions, so `foo@alpha`, `foo+@alpha.example` and `foo-@alpha.example` stay literal. Parsing is case-sensitive and has no Markdown or code-block exceptions.

An unknown, ambiguous or non-member token fails the **whole post** with `unknown_mention`, listing valid members and any ambiguous candidates. No channel, retained post or direct message is created by that failed request. Use `asenq_channel_members` to inspect the roster before posting.

The pushed direct-message header names the channel and poster; the post body is unchanged. Direct-message policies still apply: session-sent posts to held targets remain held, refused targets are rejected, and human posts bypass hold just as ordinary human direct messages do. Sends return the post's `msgId` and per-target `results` with real states, rather than claiming that a held or rejected target was delivered. The CLI and `asenq_channel_send` show those target names and states. Posts without mentions remain on demand.

Auto-removed members retain their identity and membership: accepted mention messages queue under that stable identity and deliver after revival, including across daemon restarts. Closing an identity removes its memberships and excludes it from group mentions. Its current and former names fail with `unknown_mention` unless another eligible member now resolves that token.

## Queue expiry, replies and retention

- **The target disappears.** After 2 minutes disconnected sessions leave the active list, but automatic removal does not expire queued or held messages. Known non-closed offline identities still accept messages by their current name or, for the human, stable identity through the protocol, subject to inbound policy. Removed identities remain for at least `historyDays` after removal, and longer while retained messages reference them. Never-registered names and closed identities return `unknown_target`; rejected sends to closed identities add no history row. An active holder of a current name wins over retained holders; if only multiple non-closed removed identities hold that name, sends return `ambiguous_target` with candidate identities so the human can retry by stable id. Closed identities are excluded from these candidates.

- **Loops and floods.** From one session, the same text sent to the same target within 30 s is dropped. For control messages, the kind and action also distinguish duplicates, so identical text with `pause` then `resume` is delivered twice. Each session can send 30 messages in a burst, then one every 2 s. A target with 50 queued messages refuses more.
- **Inbound policy.** `asenq inbound <name> hold` holds messages from other sessions until you run `asenq release` or `asenq drop`. Listing held message bodies with `asenq held`, releasing them and dropping them are human-only operations; registered session connections cannot read held messages. `refuse` rejects both human and session sends. Human sends bypass `hold`.
- **Queue expiry.** A queued message expires once its age reaches 24 hours, including while offline or awaiting an acknowledgment. Set `queueTtlMs` in `~/.asenq/config.json` to change this deadline in milliseconds (default `86400000`); setup preserves it. Restart the daemon after changing it. Expired messages are never delivered on revival, and a live sending session gets an asenq delivery notice. Held messages do not expire by age, but releasing one into the queue applies the deadline from its original creation time.
- **Replies.** A delivered direct message becomes `replied` when a later reciprocal direct message carries its id in `reply_to` and reaches the original sender. Queued or held replies wait until delivery. Direct messages admitted to the human inbox keep their existing `posted` status, which counts as delivered for reply confirmation; channel posts, third-party messages and daemon delivery notices do not count. Failed, expired or dropped originals never become replied. History and inbox reads retain the replied status, and it does not reset a session's inbox position. Reply references to a retained original remain readable after it becomes replied; the status change does not mark it as purged.
- **History.** Messages are kept for 7 days. Set `historyDays` in `~/.asenq/config.json` to change this.
- **Stale sessions.** Only disconnected sessions or live sessions that fail a fresh ping are eligible for **Close all stale**. There is no idle-time threshold or automatic closure; unsupported clients have an `unknown` ping result and remain safe.

## Replacement and delivery ownership

When a newly registered session is not recognised as the same identity as the source, use `asenq replace <from> <to>`, **? → Replace session** in the TUI, or the `asenq_replace` tool. The source may be any non-closed retained identity, including a disconnected or automatically removed session; the destination must be live. CLI and MCP callers may select either endpoint by its ranked current/former name or by stable identity id.

The destination keeps its current name, cwd, inbound policy, history, read position, harness association and existing roster. The source's set role overrides the destination role; otherwise the destination keeps its role. Channel memberships and the source's current/former names move to the destination, except names still held by another live or reconnecting identity. Those names are returned as `skippedNames`; replacement still succeeds and moves the other names and waiting messages.

Queued and held inbound messages move to the destination without changing their ids, historical names, timestamps, TTLs or other message metadata. Held messages remain held for human review. The source is closed and archived: its delivered history, outbound messages, conversation and read markers remain separate. A human may replace any source; an orchestrator must share a channel with the source. Other callers receive `not_permitted`.

Replacement cannot undo an in-flight delivery already received by the old source. Its late acknowledgments do not change the moved messages or the destination's delivery state, but moving work is not an exactly-once guarantee.

Each endpoint must have exactly one selector: CLI positional name or `--from-id` / `--to-id`; MCP `from` / `from_id` or `to` / `to_id`. Names follow ranked lookup; IDs select the retained identity directly. The destination cannot equal the source.

Queued and held messages change destination identity only; their historical sender/target names, IDs, creation time, original expiry and other metadata remain intact. Source closure happens with the transfer. Late acknowledgments cannot mutate the moved messages or the destination delivery state, and messages already received by the old source cannot be withdrawn.

## Compact before delivery

The MCP equivalent is `asenq_send { to: "worker-omp", text: "Start the next task", kind: "task", reset: "compact" }`. Workers and unset-role sessions receive `not_permitted`; broadcasts (`"*"`), the human address, stable-ID sends and channel posts reject the flag with `bad_request`. Normal inbound policy and queue admission still apply.

- **omp:** the adapter declares `compact`, awaits `ctx.compact({ suppressContinuation: true })`, then injects the message. Compaction does not automatically continue the interrupted task.
- **OpenCode / Claude Code / adapters without the capability:** no compaction; the message is delivered normally. OpenCode compaction is tracked separately in [#42](https://github.com/parciffal/asenq/issues/42).

A capable live target acknowledges receipt immediately: the send result reports **`reset=pending`**, not completed compaction. The adapter then compacts and delivers the task; history and tail events record **`resetResult=compacted`** or **`resetResult=failed`**. Failure to compact still delivers the message. A target without the capability reports **`reset=unsupported`** once delivered, also retained as `resetResult=unsupported`. `asenq log --id <msgId>` shows the final outcome.

In the TUI, select a transcript message with the arrow keys and press Enter to see its `reset` request and final `resetResult`.

Held and queued sends retain the request but omit the initial reset outcome. They resolve the current adapter capability and compact only on actual delivery. Later sends to a target with a pending reset queue in the daemon, avoiding repeated pushes during a slow compaction; other sessions remain independent. Completion flushes that target's queue.

A pending reset has a **10-minute** daemon-side cap (`DaemonOpts.resetTimeoutMs`); sweep expiry records failure and releases deferred delivery attempts. Disconnect also ends the pending reset as failed; deferred messages remain queued for reconnection. A hung harness API is not repaired by this deadline: subsequent attempts still use normal delivery acknowledgments and retries. An adapter injection error or an interrupted accepted delivery is recorded as failed without repeating compaction.

Before receipt acceptance, queue expiry or delivery-binding removal/replacement cancels the pending attempt and immediately releases the target's delivery gate. A stale compact receipt is rejected, not relabeled as unsupported; adapters do not compact or inject after that rejection.

Every compact push carries a unique `resetAttempt` token, echoed in its receipt and completion. A stale push cannot acquire permission from a later retry of the same message.

This summarizes the existing context; it never clears context or creates a new harness session. The harness session ID and asenq identity stay unchanged.

Receipt acceptance is delivery-mechanism acceptance, not proof of completed compaction or model execution. Its delivered state is persisted before queue-expiry sweep can race it; the final reset result is reported separately. A message ID alone cannot identify a delivery attempt: `resetAttempt` prevents an old receipt or completion from authorising a retry of the same message.

## File references

Prefer a file reference for anything over **~4,000 characters**, rather than pasting a large body into a direct message. MCP tools accept:

```json
{
  "to": "worker-oc",
  "text": "Please review the findings",
  "file": {
    "path": "/absolute/path/to/findings.md",
    "summary": "API test findings and suggested fixes"
  },
  "thread": "api-review"
}
```

Call `asenq_send` with this object; `text` may be omitted when `file` is present. `path` must be an **absolute path to a readable regular file** on this machine. `summary` is required and limited to **500 characters**. Invalid, missing or unreadable paths are errors, not empty file copies.

The daemon reads the file once at send time and stores only its **path, summary, SHA-256 hash and byte size**, never its contents. Delivery and session inbox/thread reads show the summary, path, size, a 12-character hash prefix and a check hint. The recipient reads the source file on demand under the same OS user's filesystem permissions; asenq does not copy, upload, freeze or grant access to the file. File references are direct-message metadata, not channel file references. Sending references and checking them are exposed through MCP tools; the CLI and TUI have no file-reference composer.

Hashing streams asynchronously after checking the open file's type; byte size comes from that check. There is no file-byte limit, and existing request timeouts still apply to very large or slow files. File metadata appears before optional text, including in the TUI's existing message views; a clipped Claude delivery points to `asenq_inbox id=…` for full recovery.

Use `asenq_file_check { id: "m_…" }` to compare the current file with the full send-time hash:

- `match`: the current contents match the snapshot.
- `changed`: the file is readable, but its contents differ.
- `missing`: the file is gone, unreadable or no longer a regular file.

Only the retained direct message's sender or recipient can check its reference, using their session identity rather than a reusable name; `human` is authorized for messages sent to or from its inbox. An unknown or unrelated message, or one with no file reference, is an error. The original metadata remains in message history even if the file changes or disappears. A matching hash is **not a lock or an immutable file copy**: the file can change between the check and a read, or during a read. Read and verify again when that distinction matters.

## Inbox position and full-text recovery

`asenq_inbox` defaults to `unread_only: true`, `limit: 20` (maximum 200). A session's plain unread read returns delivered messages **oldest delivery first**, exactly once through these reads, and advances its durable inbox position to the last returned message; repeat it to drain delivered unread messages. Held or queued messages become unread only when delivered, even if created before messages already read. Delivery alone does not mark a session's inbox read. Adding `thread`, `from`, `since`, or `before` makes an unread read non-mutating and **newest creation first**. `unread_only: false` also returns newest-creation-first history without advancing the position. Human unread uses the existing shared read markers and reminders; inbox reads do not change them.

`thread` and `from` match exact labels and sender names. `since` is exclusive newer-than; `before` is exclusive older-than. Both accept a string containing an ISO timestamp, decimal Unix milliseconds, or a retained message id. Timestamp boundaries compare creation times; message-id boundaries compare durable message order, so they distinguish messages with equal timestamps. Filters combine. For older history, keep the same filters and set `before` to the oldest fully displayed message id in the result; the **more available** marker normally includes this hint. For a plain unread read, call `asenq_inbox` again instead.

Non-id inbox output is capped at **16,000 JavaScript characters**, including headers, separators and markers. The tool asks the daemon for a 15,000-character serialized-message budget, reserving room for formatting and recovery hints before unread advances. Whole messages are preferred; a near-cap whole message may use a compact **more available** marker without the paging hint. An oversized first message keeps its header/id and a Unicode-safe clipped body with an explicit **truncated / more available** marker. Oversized metadata may also be omitted to preserve the id and cap. Do not page past a clipped message to recover its missing text.

Recover it with `asenq_inbox { id: "m_…" }`: this explicit lookup returns exactly one full, **uncapped** retained message sent or received by the caller, overrides other filters and does not advance the inbox position. For a threaded message, `asenq_thread_read { thread: "label" }` also returns the full retained direct-message thread in durable ascending order, across both directions for the caller; optional `since` uses the same exclusive boundary rules. Thread reads are uncapped and non-mutating; channel posts and unrelated participants' messages are excluded. These explicit recovery reads can return large results.

Human `asenq inbox` prints the newest 20-message page oldest first without changing read markers. Session inbox position and human read markers are separate. Delivery does not imply reading.

## Closure, purge and confirmation

`close` is human-only: it terminally archives the session, removes its channel memberships, expires its queued/held messages with sender notices, and ends resolution through its current/former names and harness identity. Notices for offline, non-closed senders queue for delivery when the same sender identity revives; closed senders receive none. Resuming a closed harness session creates a new identity without its old memberships. Closing an already closed identity is safe to repeat. `purge` is also human-only and permanently deletes archived conversations, their removed identities, memberships and reading positions; it never deletes live/reconnecting sessions, channels or channel posts, even posts authored by a purged identity. Independent delivery-failure notices remain with their senders. Retained replies keep their original message ID and show **(purged message)** when the referenced message is gone.

These commands accept an exact **current** name or a stable identity ID; former names are not destructive-command targets. `close` prefers a live/reconnecting name over old archives. `purge` rejects a name also held by a live/reconnecting session. Ambiguous archive names are rejected with candidate IDs; use an explicit archived ID instead. The CLI prints the actual closed/purged IDs and runs immediately, without an interactive confirmation (like `drop`); `purge --all` deletes all archives at submission time. Use the TUI for a visible confirmation preview.

The palette's **Close all stale** action first waits for a fresh ping, refreshes session state, then previews disconnected (`gone`) sessions and live sessions whose latest ping is `not_responding`. Quiet running sessions are not stale, even after hours without direct messages: direct-message activity is informational only. A supported adapter that answers is `responding`; hook-only Claude sessions and older adapters that do not declare ping support are `unknown` and safely excluded while live. Disconnected sessions are always stale regardless of their previous ping. Nothing is closed until you confirm the exact identity snapshot.

Select the **Archive** heading or an archived conversation and use `?` for **Purge all archives** or **Purge conversation**, respectively. Every close/purge preview shows the exact target count, the first ten names with stable IDs, and an **and N more** count if needed. Press `y` to confirm or `n` / `Esc` to cancel; `Enter` does not confirm, pasted text is ignored, and arrow/page keys scroll longer previews. Only the previewed identity IDs are submitted: new targets or new archives are not silently added. Purge refreshes every open console's conversation, inbox and activity caches; unrelated conversations and channel posts remain.

Use **? → Replace session** to choose any non-closed identity as the source, then a live destination other than that source. Picker rows reuse the session-list state, harness and role cues, with archived sources dimmed. The preview names the exact source and destination and wraps the full source-close warning; press `y` to confirm or `n` / `Esc` to cancel. `Enter` and pasted text do not confirm. The action uses the captured stable identity IDs, so renames or reused names cannot redirect it, and the destination's live eligibility is checked again on confirmation. On partial success, a scrollable result panel wraps every skipped name in full without claiming it forwards. After success, the destination's session and held-message caches refresh; its history, drafts and read position remain separate from the archived source.

Other open consoles reconcile moved-message ownership and refresh archived-conversation ordering without merging histories or discarding drafts.

## Console display and reading

Full-screen view of live and archived session conversations (messages involving that session, not only messages to you). Four tabs — **Sessions**, **Inbox**, **Channels**, **Activity** — share one layout: list beside conversation at ≥80 columns, or a picker on narrower terminals. A fifth tab, **Map** (`m`), shows the live `asenq viz` bug-map instead; it has no conversation, composer or read marker, and only polls while shown.

Sessions groups **LIVE** (`●`), **RECONNECTING** (`◌`) and a collapsed **▸ archive N**, sorted by recent direct-message activity. Rows show `cc` / `oc` / `omp` harness labels, role tags and `⏸` for a non-accepting inbound policy. Failed probes show a warning dot and a separate `not_responding` detail row without displacing other metadata; clicking that row still selects the same identity. The selected identity keeps its cyan `▌` marker and name highlight while you read or write. Renaming keeps a conversation; reusing a removed name starts another. Channels show the same identity cues in their member lists.

Transcript headers put sender → target on the left and delivery state with time on the right. Non-chat kinds use a tag; chat omits it. A dashed cyan **N new** divider uses the human unread count, not intervening session-to-session traffic. Direct session-to-session blocks are dim and adjacent blocks omit blank spacers; messages to/from the human and channel posts keep full contrast. Every body stays wrapped and reachable, never truncated; only labels shorten with `…`. When scrolled away from the tail, **End ↓ latest** appears outside the readable message rows.

Unread is **not delivery**. Counts cover messages to `human` (by sending session identity) plus non-human channel posts; session-to-session traffic never counts. Read markers are shared across TUI windows and survive restart; plain `asenq inbox` / `asenq channel read` do not change them. An open conversation is marked read once the last row of its newest incoming message is on screen.

Use **? → Ping sessions** to check live sessions and refresh their status. OMP and OpenCode adapters answer immediately through their connection, without starting a model turn; Claude sessions with a messaging socket are probed through that socket. A failed check shows **not_responding** on the session row but does not disconnect or close it. A later answered ping replaces that status; disconnection clears the cached ping.

`asenq tail` includes ping results keyed by stable session identity, so failed probes and later recoveries remain visible outside the TUI.

The header's **failed** counter covers all retained failed or expired direct messages, not just the loaded conversation. Status events update it live; pruning retained history reduces it.

Role tags are inverse `orch` / `wrk`, beside short harness labels, with metadata on a second row when needed; archived tags are dim. Channel member rows retain channel conversation/composer scope. Purging retained posts keeps the channel, while identity retention removes that identity’s memberships.

The channel composer opens a member/keyword picker at a valid `@`; typing filters it and arrows choose. Enter inserts without posting, then a later Enter sends. Escape dismisses without losing the draft. Direct-message composers and email text do not open it.

## Claude Code settings

- **Bypass mode.** Claude sessions running in bypass-permissions mode hold cross-session messages for approval unless `"crossSessionInbound": "accept"` is set. `asenq doctor` warns about this; asenq never changes Claude's permission settings.
- **Native envelope (opt-in).** `"claude": { "envelope": true }` in `~/.asenq/config.json` wraps messages in Claude's own `<cross-session-message>` format. This shows the sender's name natively and lets Claude reply with its built-in messaging. The format is private and was checked against Claude Code 2.1.278–2.1.283. Restart the daemon after changing it (`asenq daemon stop`).

## Development timing overrides

`asenq daemon run` accepts test-only timing overrides in milliseconds: `ASENQ_ACK_TIMEOUT_MS`, `ASENQ_GRACE_MS`, and `ASENQ_TICK_MS` (which covers the sweep, retry and probe intervals).
