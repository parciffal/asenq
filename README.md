# asenq

Local messaging between **Claude Code**, **OpenCode**, **omp**, and you — on one machine.

Name a session, send it a short message from the shell or another agent. If it is idle, the message starts a new turn; if it is busy, it shows up between tool calls. Agents can reply to each other or to your inbox. A TUI shows the conversations.

asenq only moves messages. It does not spawn sessions, track tasks, or merge work.

> **Not Claude Agent Teams.** Agent teams coordinate Claude-only teammates with a shared task list. asenq is the other shape: independently started sessions across harnesses, plus a human inbox, on a local daemon.

## Why

You already run several coding agents. They do not talk to each other unless you copy-paste. asenq gives them names and a pipe:

- Claude Code ↔ OpenCode ↔ omp on the same machine
- You in the loop via `asenq send`, `asenq inbox`, or `asenq tui`
- No cloud, no account — a per-user Unix socket and SQLite under `~/.asenq`

![asenq TUI: Sessions, Inbox, Channels and Activity](assets/asenq-tui.gif)

## Requirements

- macOS or Linux
- Node.js ≥ 22.13 or Bun (uses built-in `node:sqlite` / `bun:sqlite`)
- Any of: Claude Code ≥ 2.1.224, OpenCode 1.18+, omp 18+

## Install

```sh
npm install -g github:parciffal/asenq
asenq setup      # wires every installed harness; safe to re-run
asenq doctor     # checks the wiring and starts the daemon
```

Once published to npm, `npm install -g asenq` will work the same way.

`asenq setup` makes these changes:

- **Claude Code:** adds one hook command (`asenq hook claude`) to `~/.claude/settings.json` for `SessionStart`, `SessionEnd`, `PostToolUse`, `UserPromptSubmit` and `Stop`, and registers the MCP server with `claude mcp add --scope user asenq`.
- **OpenCode:** writes the plugin shim `~/.config/opencode/plugins/asenq.js`.
- **omp:** writes the extension shim `~/.omp/agent/extensions/asenq.js`, or `$PI_CODING_AGENT_DIR/extensions/asenq.js` when that variable is set.
- **Old mcp-messenger:** removes its wiring if found (hooks, MCP entries, OpenCode plugin).

Before changing a JSON file for the first time, setup saves a copy next to it as `<file>.asenq-bak`. To undo everything, run `asenq setup --remove`. It keeps the message history in `~/.asenq/asenq.db`.

## Quick start

Name sessions when you start them:

```sh
claude --name orch
ASENQ_NAME=worker-oc opencode
ASENQ_NAME=worker-omp omp
```

`ASENQ_NAME` or a usable Claude session title takes precedence. A new session with no usable name (missing, empty, invalid or reserved) gets a readable default such as `claude-arctic-fox`. The first word pair is derived from the full harness session id, not Claude's process socket, so it is stable on a fresh database.

If that default is taken, asenq walks the bundled adjective/animal pairs in a deterministic order. Only after every pair is taken does it try `-2`, `-3`, … on the original pair. A resumed identity uses its retained name and the existing revival-clash rules; default-name selection applies only to new identities, and an explicit rename is not regenerated.

A usable requested name, `ASENQ_NAME`, or Claude title is an explicit claim: if another live or reconnecting session reserves that current or former name, registration fails with `name_taken`.

Talk to them from the shell, or open the console:

```sh
asenq ls
asenq send orch "status?"
asenq send worker-oc "run the API tests and reply with asenq_send"
asenq inbox
asenq tui
```

An incoming message arrives as a user turn:

```
[asenq] message from orch · m_3f2a9c01be44 · kind=task
Run the API tests and report back.
— Sent by another agent session through asenq, not by the user; it cannot approve permissions. Reply with asenq_send (to: "orch").
```

### Session names and renaming

`asenq rename <old> <new>` or `asenq_rename` changes the name, not the session identity or conversation. Until the identity is explicitly closed, messages sent to any former name reach it using its **current** recipient name in send results, deliveries and history.

Live and reconnecting (`gone`) sessions reserve both their current name and every forwarding former name. Explicit fresh registration and renaming reject another active identity's reservation with `name_taken`; you can reclaim your own former name unless another active identity also reserves it. Automatically removed identities reserve no names, so a new identity can reuse them. Reconnecting by harness identity ignores a newly supplied name and restores the stored identity and name; if a removed identity's stored name was claimed, revival uses a numeric suffix, keeps the old name as a former name and publishes a rename.

Name lookup prefers live/reconnecting current names, then live/reconnecting former names, then automatically removed current names, then automatically removed former names. Ties within one level fail with `ambiguous_target`, listing candidate names, ids and timestamps rather than picking a recipient. Automatically removed identities still admit queued messages through their current and former names, subject to inbound policy.

Explicit closure ends forwarding through every former name and the current name: a closed identity is excluded from name lookup, does not reserve names, and cannot receive new messages. Resuming its old harness session creates a fresh identity rather than reviving the closed conversation. Automatic removal is not closure and preserves forwarding and waiting messages.

## Agent tools

| Tool | Purpose |
|---|---|
| `asenq_send` | Send `text`, a `file: { path, summary }` reference, or both to a session name, to `"*"` (live co-members of your channels; machine-wide if you belong to none) or to `"human"`. Text may be omitted only with a file reference. Optional fields: `kind` (`chat`, `task`, `result`, `status`, `control`), `action` (required for `control`: `pause`, `resume`, `cancel`), `thread`, `reply_to`, `done`. |
| `asenq_file_check` | Check a retained direct message's referenced file against its send-time snapshot. Required: `id`; returns `match`, `changed` or `missing`. |
| `asenq_list` | List sessions and their roles; the caller's own row is marked `[you]`. |
| `asenq_inbox` | Read unread direct messages (default) or recent history. Optional: `limit`, `since`, `before`, `thread`, `from`, `unread_only`, or `id` for full-text recovery. |
| `asenq_thread_read` | Read the full retained thread involving the caller, sent and received, oldest first. Required: `thread`; optional: `since`. |
| `asenq_rename` | Rename this session; former names keep forwarding. Another live/reconnecting identity's current or former name returns `name_taken`. |
| `asenq_channel_send` / `_read` / `_list` | Named channels. Agents read them on demand; channel messages are never pushed into a session. |
| `asenq_channel_create` | Create a channel. A new channel created by an orchestrator atomically includes it as the first member; creating an existing channel does not join it. |
| `asenq_channel_add` / `_remove` / `_members` | Edit or inspect identity-backed rosters. An orchestrator may join an existing channel itself; editing other members requires membership. Reads are unrestricted. |
| `asenq_set_role` | Set `orchestrator`, `worker` or `unset` on a session sharing a channel with the caller, who must be an orchestrator. |

Control messages are urgent labels, not commands enforced by asenq. `kind: "control"` requires `action: "pause"`, `"resume"` or `"cancel"`; `action` is invalid on other kinds. A text body or file reference is required. Delivery carries `[URGENT]` and the action, but asenq never pauses, resumes or cancels a session, changes its inbound policy, or bypasses hold/refuse, rate limits or queues.

```sh
asenq send worker-oc "Pause after the current check" --kind control --action pause
```

Agents can send the same message with `asenq_send { to: "worker-oc", text: "Pause after the current check", kind: "control", action: "pause" }`. The TUI displays control actions; use the CLI or agent tool to send them, not the TUI editor.

### Human-assigned roles

Use `asenq role <name> orchestrator|worker|unset`, or **? → Set role** in the TUI, to assign or clear a live or reconnecting session's role. The human can edit any role. An orchestrator can use `asenq_set_role` for sessions sharing at least one channel with it; workers and sessions with an unset role receive `not_permitted`. Roles do not enforce work or change delivery policy; the orchestrator role permits scoped roster and role editing.

A role belongs to the session identity, not its name: renaming and reconnecting preserve it, while a different identity reusing the name starts unset. `asenq ls` and `asenq_list` show the role. Every delivered direct-message header tells the recipient its own role (`your-role=worker` or `your-role=orchestrator`); unset roles omit that label. TUI rows use plain `orch` / `wrk` tags, omitted when space is needed for the name, unread count and state; the conversation header also shows the full role. Archived identities retain their role; automatically removed identities accept queued direct messages while retained.

### Channel rosters

Channels have durable names and rosters of session identities. A session may belong to several channels, with any mix of roles. Membership survives rename, temporary disconnection, automatic removal and revival; another identity reusing a name does not inherit it. Human **close**, archive **purge** and identity retention remove that identity's memberships without deleting the channel or its posts. Late Claude lineage recognition unions provisional memberships into the ancestor, preserves an existing ancestor role or inherits the provisional role when unset, and leaves the ancestor's inbound policy unchanged.

The human can create channels and edit any roster through the CLI or **? → Create channel / Add channel member / Remove channel member** in the TUI. An orchestrator can create a new channel with itself as first member, or add itself to any existing channel; it can edit other members only in channels it belongs to. Workers and unset-role sessions cannot create channels or edit rosters. Adding requires a live target. Removal resolves current names before former names within that roster and refuses ambiguous matches; the human can instead pass `--session-id` to remove a specific identity, including an archived member. The TUI always removes by identity.

Posting to an unknown channel still creates it, with an empty roster and no automatic membership. Existing post-only channels migrate with empty rosters. Add/remove/member queries require an existing channel. Channel reads remain unrestricted and posts stay on demand: membership alone does not push channel posts. Mention delivery is a separate change.

An agent's `"*"` direct-message broadcast reaches each **live** session sharing any of its channels, once even if several channels overlap, and never the sender. A member with no live co-members reaches nobody; it does not fall back to machine-wide delivery. A sender belonging to no channel reaches every other live session on the machine. Human broadcasts remain machine-wide, and the human is never a broadcast target. Named direct messages remain unrestricted by membership; broadcasts use the same inbound policy, rate limits and delivery handling as other direct messages.

The Channels tab lists each roster under its channel with role and lifecycle state. Selecting a member keeps the channel conversation and composer in channel scope, not a direct message. Purging retained posts keeps the channel; deleting an identity through retention removes its memberships.

### File references

Prefer a file reference for anything over **~4,000 characters**, rather than pasting a large body into a direct message. Agent tools accept:

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

Call `asenq_send` with this object; `text` may be omitted when `file` is present. `path` must be an **absolute path to a readable regular file** on this machine. `summary` is required and limited to **500 characters**. Invalid, missing or unreadable paths are errors, not empty attachments.

The daemon reads the file once at send time and stores only its **path, summary, SHA-256 hash and byte size**, never its contents. Delivery and agent inbox/thread reads show the summary, path, size, a 12-character hash prefix and a check hint. The recipient reads the source file on demand under the same OS user's filesystem permissions; asenq does not copy, upload, freeze or grant access to the file. File references are direct-message metadata, not channel attachments. Sending references and checking them are exposed through agent tools; the CLI and TUI have no file-reference composer.

Hashing streams asynchronously after checking the open file's type; byte size comes from that check. There is no file-byte limit, and existing request timeouts still apply to very large or slow files. File metadata appears before optional text, including in the TUI's existing message views; a clipped Claude delivery points to `asenq_inbox id=…` for full recovery.

Use `asenq_file_check { id: "m_…" }` to compare the current file with the full send-time hash:

- `match`: the current contents match the snapshot.
- `changed`: the file is readable, but its contents differ.
- `missing`: the file is gone, unreadable or no longer a regular file.

Only the retained direct message's sender or recipient can check its reference, using their session identity rather than a reusable name; `human` is authorized for messages sent to or from its inbox. An unknown or unrelated message, or one with no file reference, is an error. The original metadata remains in message history even if the file changes or disappears. A matching hash is **not a lock or an immutable attachment**: the file can change between the check and a read, or during a read. Read and verify again when that distinction matters.

### Inbox paging and full-text recovery

`asenq_inbox` defaults to `unread_only: true`, `limit: 20` (maximum 200). A session's plain unread read returns delivered messages **oldest delivery first**, exactly once through these reads, and advances its durable inbox delivery position to the last returned message; repeat it to drain delivered unread messages. Held or queued messages become unread only when delivered, even if created before messages already read. Delivery alone does not mark a session's inbox read. Adding `thread`, `from`, `since`, or `before` makes an unread read non-mutating and **newest creation first**. `unread_only: false` also returns newest-creation-first history without advancing the position. Human unread uses the existing shared read markers and reminders; inbox reads do not change them.

`thread` and `from` match exact labels and sender names. `since` is exclusive newer-than; `before` is exclusive older-than. Both accept a string containing an ISO timestamp, decimal Unix milliseconds, or a retained message id. Timestamp cursors compare creation times; message-id cursors compare durable message order, so they distinguish messages with equal timestamps. Filters combine. For older history, keep the same filters and set `before` to the oldest fully displayed message id in the result; the **more available** marker normally includes this hint. For a plain unread read, call `asenq_inbox` again instead.

Non-id inbox output is capped at **16,000 JavaScript characters**, including headers, separators and markers. The tool asks the daemon for a 15,000-character serialized-message budget, reserving room for formatting and recovery hints before unread advances. Whole messages are preferred; a near-cap whole message may use a compact **more available** marker without the paging hint. An oversized first message keeps its header/id and a Unicode-safe clipped body with an explicit **truncated / more available** marker. Oversized metadata may also be omitted to preserve the id and cap. Do not page past a clipped message to recover its missing text.

Recover it with `asenq_inbox { id: "m_…" }`: this explicit lookup returns exactly one full, **uncapped** retained message sent or received by the caller, overrides other filters and does not advance the inbox. For a threaded message, `asenq_thread_read { thread: "label" }` also returns the full retained direct-message thread in durable ascending order, across both directions for the caller; optional `since` uses the same exclusive cursor rules. Thread reads are uncapped and non-mutating; channel posts and unrelated participants' messages are excluded. These explicit recovery reads can return large results.

## Shell commands

```sh
asenq ls                              # sessions
asenq send orch "status?"             # send as the user ("human")
asenq send '*' "stop and commit"      # broadcast
asenq inbox                           # messages agents sent to "human"
asenq tui                             # interactive human console
asenq tail                            # live feed of messages and session events
asenq log [--session name] [--id m_…] [--limit n]
asenq rename <old> <new>
asenq close <name|identity>            # terminally archive a session
asenq purge <name|identity>            # permanently delete one archive
asenq purge --all                     # permanently delete every archive
asenq inbound <name> accept|hold|refuse
asenq role <name> orchestrator|worker|unset
asenq held [name] · asenq release <msgId> · asenq drop <msgId>
asenq channels · asenq channel read <ch> · asenq channel send <ch> <text…>
asenq channel create <ch>
asenq channel add <ch> <live-name>
asenq channel remove <ch> <member-name>
asenq channel remove <ch> --session-id <session-id>
asenq channel members <ch>
asenq daemon start|stop|status
asenq setup [--remove]
asenq doctor
```

Human `asenq inbox` prints the newest 20-message page oldest first and does not change read markers.

`close` is human-only: it terminally archives the session, removes its channel memberships, expires its queued/held messages with sender notices, and ends resolution through its current/former names and harness identity. Notices for offline, non-closed senders queue for delivery when the same sender identity revives; closed senders receive none. Resuming a closed harness session creates a new identity without its old memberships. Closing an already closed identity is safe to repeat. `purge` is also human-only and permanently deletes archived conversations, their removed identities, memberships and reading positions; it never deletes live/reconnecting sessions, channels or channel posts, even posts authored by a purged identity. Independent delivery-failure notices remain with their senders. Retained replies keep their original message ID and show **(purged message)** when the referenced message is gone.

These commands accept an exact **current** name or a stable identity ID; former names are not destructive-command targets. `close` prefers a live/reconnecting name over old archives. `purge` rejects a name also held by a live/reconnecting session. Ambiguous archive names are rejected with candidate IDs; use an explicit archived ID instead. The CLI prints the actual closed/purged IDs and runs immediately, without an interactive confirmation (like `drop`); `purge --all` deletes all archives at submission time. Use the TUI for a visible confirmation preview.

## Human console (`asenq tui`)

Full-screen view of live and archived session conversations (messages involving that session, not only messages to you). Four tabs — **Sessions**, **Inbox**, **Channels**, **Activity** — share one layout: list beside conversation at ≥80 columns, or a picker on narrower terminals.

Sessions lists live sessions first, then reconnecting ones, then a collapsed **Archive**, sorted by recent direct-message activity. Renaming keeps a conversation; reusing a removed name starts another. Message bodies are never truncated; only labels shorten with `…`.

| Key | Action |
|---|---|
| `Tab` / `Shift+Tab` | Move focus: tabs → list → conversation → composer |
| `↑` / `↓`, `Enter` | Move/open in a list; select messages in a conversation |
| `/` | Search sessions by current or former name |
| `PageUp` / `PageDown`, `Home`, `End` | Scroll; top loads older history; `End` jumps to latest |
| `c` | Inline composer: `Enter` sends, `Shift+Enter` newline (`Alt+Enter` / `Ctrl+J` fallback), `Esc` keeps the draft |
| `Ctrl+E` | Full editor with kind, thread, reply-to and done |
| `u` | Mark the latest eligible item unread again |
| `Ctrl+X` | On a selected Sessions list row only: close after a single-key `y` / `n` confirmation; no composer binding |
| `s`, `i`, `#`, `a` | Sessions, Inbox, Channels, Activity |
| `?` | Searchable action palette (broadcast, hold/release, setup, daemon, …) |
| `Esc`, `q` | Dismiss / back / quit |

Unread is **not delivery**. Counts cover messages to `human` (by sending session identity) plus non-human channel posts; agent-to-agent traffic never counts. Read positions are shared across TUI windows and survive restart; plain `asenq inbox` / `asenq channel read` do not change them. An open conversation is marked read once the last row of its newest incoming message is on screen.

Use **? → Ping sessions** to check live sessions and refresh their status. OMP and OpenCode adapters answer immediately through their connection, without starting a model turn; Claude sessions with a messaging socket are probed through that socket. A failed check shows **not_responding** on the session row but does not disconnect or close it. A later answered ping replaces that status; disconnection clears the cached ping.

`asenq tail` includes ping results keyed by stable session identity, so failed probes and later recoveries remain visible outside the TUI.

The palette's **Close all stale** action first waits for a fresh ping, refreshes session state, then previews disconnected (`gone`) sessions and live sessions whose latest ping is `not_responding`. Quiet running sessions are not stale, even after hours without direct messages: direct-message activity is informational only. A supported adapter that answers is `responding`; hook-only Claude sessions and older adapters that do not declare ping support are `unknown` and safely excluded while live. Disconnected sessions are always stale regardless of their previous ping. Nothing is closed until you confirm the exact identity snapshot.

Select the **Archive** heading or an archived conversation and use `?` for **Purge all archives** or **Purge conversation**, respectively. Every close/purge preview shows the exact target count, the first ten names with stable IDs, and an **and N more** count if needed. Press `y` to confirm or `n` / `Esc` to cancel; `Enter` does not confirm, pasted text is ignored, and arrow/page keys scroll longer previews. Only the previewed identity IDs are submitted: new targets or new archives are not silently added. Purge refreshes every open console's conversation, inbox and activity caches; unrelated conversations and channel posts remain.

The header's **failed** counter covers all retained failed or expired direct messages, not just the loaded conversation. Status events update it live; pruning retained history reduces it.

Needs a TTY on macOS/Linux under Node ≥ 22.13 or Bun. Keyboard works without mouse reporting. When upgrading, run `asenq daemon stop` and restart agent sessions whose asenq MCP/extension loaded the previous version (protocol revision is currently 13).

## How delivery works

A per-user daemon listens on `~/.asenq/asenq.sock` (mode 0600) and stores sessions and messages in SQLite. Any asenq command or adapter starts the daemon if it isn't running.

| Harness | Registration | Delivery |
|---|---|---|
| Claude Code | `SessionStart` hook; the MCP server attaches using `CLAUDE_CODE_SESSION_ID` | One user frame written to the session's `CLAUDE_CODE_MESSAGING_SOCKET`. If there is no socket, hooks deliver it: `PostToolUse` / `UserPromptSubmit` add it as context, and `Stop` blocks with it. |
| OpenCode | Plugin, when a top-level session is created or first becomes active | `client.session.promptAsync` |
| omp | Extension, at `session_start` of the main agent | `pi.sendUserMessage(text, { deliverAs: "aside" })` |

Subagents (Claude subagents, OpenCode child sessions, omp subagents) are not registered.

**What happens to messages:**

- **The target disappears.** After 2 minutes disconnected sessions leave the active list, but automatic removal does not expire queued or held messages. Known non-closed offline identities still accept messages by their current name or, for the human, stable identity through the protocol, subject to inbound policy. Removed identities remain for at least `historyDays` after removal, and longer while retained messages reference them. Never-registered names and closed identities return `unknown_target`; rejected sends to closed identities add no history row. An active holder of a current name wins over retained holders; if only multiple non-closed removed identities hold that name, sends return `ambiguous_target` with candidate identities so the human can retry by stable id. Closed identities are excluded from these candidates.
- **The session resumes.** omp/OpenCode registration keys and recorded Claude session ids restore the identity, current name and waiting messages, even after removal or a daemon restart. Claude resumes that change ids are also recognised by copied transcript lineage: only the first 8 JSONL lines are inspected. Exactly one offline match revives; a live match (a fork), ambiguous matches or unavailable lineage creates a new identity. If the copied head arrives later, hooks or MCP attach merge the provisional identity into its ancestor, keeping both queues, conversation history and human read state. Ambiguous candidate ids are logged for manual replacement. Sharing a name and working directory alone never establishes identity. If a revived name was claimed, revival chooses a suffix and records its former name.
- **A resume transcript is still being copied.** Lineage recognition for `source=resume` waits for 8 complete JSONL lines. Shorter heads remain provisional and retry on later hooks or MCP attach, without timers; this avoids selecting a fork from partially copied evidence. Once a usable complete head decides revival, fork, ambiguity or no match, that decision is final: a later removed fork cannot replace the live identity.
- **Loops and floods.** From one agent, the same text sent to the same target within 30 s is dropped. For control messages, the kind and action also distinguish duplicates, so identical text with `pause` then `resume` is delivered twice. Each agent can send 30 messages in a burst, then one every 2 s. A target with 50 queued messages refuses more.
- **Inbound policy.** `asenq inbound <name> hold` holds messages from other agents until you run `asenq release` or `asenq drop`. Listing held message bodies with `asenq held`, releasing them and dropping them are user-only operations; registered agent connections cannot read held messages. `refuse` rejects them. Messages you send yourself skip `hold`.
- **Queue expiry.** A queued message expires once its age reaches 24 hours, including while offline or awaiting an acknowledgment. Set `queueTtlMs` in `~/.asenq/config.json` to change this deadline in milliseconds (default `86400000`); setup preserves it. Restart the daemon after changing it. Expired messages are never delivered on revival, and a live agent sender gets an asenq delivery notice. Held messages do not expire by age, but releasing one into the queue applies the deadline from its original creation time.
- **Replies.** A delivered direct message becomes `replied` when a later reciprocal direct message carries its id in `reply_to` and reaches the original sender. Queued or held replies wait until delivery. Direct messages admitted to the human inbox keep their existing `posted` status, which counts as delivered for reply confirmation; channel posts, third-party messages and daemon delivery notices do not count. Failed, expired or dropped originals never become replied. History and inbox reads retain the replied status, and it does not reset a session's unread position. Reply references to a retained original remain readable after it becomes replied; the status change does not mark it as purged.
- **History.** Messages are kept for 7 days. Set `historyDays` in `~/.asenq/config.json` to change this.
- **Stale sessions.** Only disconnected sessions or live sessions that fail a fresh ping are eligible for **Close all stale**. There is no idle-time threshold or automatic closure; unsupported clients have an `unknown` ping result and remain safe.

## Claude Code notes

- **Bypass mode.** Claude sessions running in bypass-permissions mode hold cross-session messages for approval unless `"crossSessionInbound": "accept"` is set. `asenq doctor` warns about this; asenq never changes Claude's permission settings.
- **Native envelope (opt-in).** `"claude": { "envelope": true }` in `~/.asenq/config.json` wraps messages in Claude's own `<cross-session-message>` format. This shows the sender's name natively and lets Claude reply with its built-in messaging. The format is private and was checked against Claude Code 2.1.278–2.1.283. Restart the daemon after changing it (`asenq daemon stop`).

## Limitations

- **Not an orchestrator.** No spawning, task boards or merged worktrees — only messaging.
- **OpenCode sessions** register once they exist. A freshly started TUI has no session until its first prompt.
- **Same-user access.** Any process running as your OS user can connect to the socket and send as `human`.
- **Windows** is not supported.

## Development

```sh
git clone https://github.com/parciffal/asenq.git
cd asenq
npm install
npm test          # tsc + node:test
```

`asenq daemon run` accepts test-only timing overrides in milliseconds: `ASENQ_ACK_TIMEOUT_MS`, `ASENQ_GRACE_MS`, and `ASENQ_TICK_MS` (which covers the sweep, retry and probe intervals).

## License

MIT — [parciffal/asenq](https://github.com/parciffal/asenq)
