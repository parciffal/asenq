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

If you don't set a name, asenq uses the Claude session title, or `{harness}-{6 chars of the session id}`. When the name is already taken, asenq adds a suffix (`-2`, `-3`, …).

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

## Agent tools

| Tool | Purpose |
|---|---|
| `asenq_send` | Send `text` to a session name, to `"*"` (every live session) or to `"human"`. Optional fields: `kind` (`chat`, `task`, `result`, `status`), `thread`, `reply_to`, `done`. |
| `asenq_list` | List sessions; the caller's own row is marked `[you]`. |
| `asenq_inbox` | Read unread direct messages (default) or recent history. Optional: `limit`, `since`, `before`, `thread`, `from`, `unread_only`, or `id` for full-text recovery. |
| `asenq_thread_read` | Read the full retained thread involving the caller, sent and received, oldest first. Required: `thread`; optional: `since`. |
| `asenq_rename` | Rename this session. |
| `asenq_channel_send` / `_read` / `_list` | Named channels. Agents read them on demand; channel messages are never pushed into a session. |

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
asenq inbound <name> accept|hold|refuse
asenq held [name] · asenq release <msgId> · asenq drop <msgId>
asenq channels · asenq channel read <ch> · asenq channel send <ch> <text…>
asenq daemon start|stop|status
asenq setup [--remove]
asenq doctor
```

Human `asenq inbox` prints the newest 20-message page oldest first and does not change read markers.

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
| `s`, `i`, `#`, `a` | Sessions, Inbox, Channels, Activity |
| `?` | Searchable action palette (broadcast, hold/release, setup, daemon, …) |
| `Esc`, `q` | Dismiss / back / quit |

Unread is **not delivery**. Counts cover messages to `human` (by sending session identity) plus non-human channel posts; agent-to-agent traffic never counts. Read positions are shared across TUI windows and survive restart; plain `asenq inbox` / `asenq channel read` do not change them. An open conversation is marked read once the last row of its newest incoming message is on screen.

Needs a TTY on macOS/Linux under Node ≥ 22.13 or Bun. Keyboard works without mouse reporting. When upgrading, run `asenq daemon stop` and restart agent sessions whose asenq MCP/extension loaded the previous version (protocol revision is currently 4).

## How delivery works

A per-user daemon listens on `~/.asenq/asenq.sock` (mode 0600) and stores sessions and messages in SQLite. Any asenq command or adapter starts the daemon if it isn't running.

| Harness | Registration | Delivery |
|---|---|---|
| Claude Code | `SessionStart` hook; the MCP server attaches using `CLAUDE_CODE_SESSION_ID` | One user frame written to the session's `CLAUDE_CODE_MESSAGING_SOCKET`. If there is no socket, hooks deliver it: `PostToolUse` / `UserPromptSubmit` add it as context, and `Stop` blocks with it. |
| OpenCode | Plugin, when a top-level session is created or first becomes active | `client.session.promptAsync` |
| omp | Extension, at `session_start` of the main agent | `pi.sendUserMessage(text, { deliverAs: "aside" })` |

Subagents (Claude subagents, OpenCode child sessions, omp subagents) are not registered.

**What happens to messages:**

- **The target disappears.** asenq queues the message. The target has 2 minutes to come back; a harness restarted with the same name and working directory takes over the old session and its queue. After that, the message expires and the sender gets a notice.
- **Loops and floods.** From one agent, the same text sent to the same target within 30 s is dropped. Each agent can send 30 messages in a burst, then one every 2 s. A target with 50 queued messages refuses more.
- **Inbound policy.** `asenq inbound <name> hold` holds messages from other agents until you run `asenq release` or `asenq drop`. `refuse` rejects them. Messages you send yourself skip `hold`.
- **History.** Messages are kept for 7 days. Set `historyDays` in `~/.asenq/config.json` to change this.

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
