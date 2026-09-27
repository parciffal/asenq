# asenq

Messaging between Claude Code, OpenCode and omp (Oh My Pi) sessions on one machine.

Each top-level session registers under a unique name. Sessions send each other short text messages. If the target is idle, the message starts a new turn. If it is busy, the message shows up between tool calls. You can message any session from the shell, and sessions can message you.

asenq only moves messages. It does not spawn sessions, track tasks or merge work.

## Requirements

- macOS or Linux
- Node.js ≥ 22.13 or Bun (asenq uses the built-in `node:sqlite` / `bun:sqlite`)
- Any of: Claude Code ≥ 2.1.224, OpenCode 1.18+, omp 18+

## Install

```sh
npm install -g asenq
asenq setup      # wires every installed harness; safe to re-run
asenq doctor     # checks the wiring and starts the daemon
```

`asenq setup` makes these changes:

- **Claude Code:** adds one hook command (`asenq hook claude`) to `~/.claude/settings.json` for `SessionStart`, `SessionEnd`, `PostToolUse`, `UserPromptSubmit` and `Stop`, and registers the MCP server with `claude mcp add --scope user asenq`.
- **OpenCode:** writes the plugin shim `~/.config/opencode/plugins/asenq.js`.
- **omp:** writes the extension shim `~/.omp/agent/extensions/asenq.js`, or `$PI_CODING_AGENT_DIR/extensions/asenq.js` when that variable is set.
- **Old mcp-messenger:** removes its wiring if found (hooks, MCP entries, OpenCode plugin).

Before changing a JSON file for the first time, setup saves a copy next to it as `<file>.asenq-bak`. To undo everything, run `asenq setup --remove`. It keeps the message history in `~/.asenq/asenq.db`.

## Use

Choose a session's name with `ASENQ_NAME` when you start it. Claude Code also uses `--name`:

```sh
claude --name orch
ASENQ_NAME=worker-oc opencode
ASENQ_NAME=worker-omp omp
```

If you don't set a name, asenq uses the Claude session title, or `{harness}-{6 chars of the session id}`. When the name is already taken, asenq adds a suffix (`-2`, `-3`, …).

Agents get these tools:

| Tool | Purpose |
|---|---|
| `asenq_send` | Send `text` to a session name, to `"*"` (every live session) or to `"human"`. Optional fields: `kind` (`chat`, `task`, `result`, `status`), `thread`, `reply_to`, `done`. |
| `asenq_list` | List sessions; the caller's own row is marked `[you]`. |
| `asenq_inbox` | Show recent messages sent to this session. |
| `asenq_rename` | Rename this session. |
| `asenq_channel_send` / `_read` / `_list` | Named channels. Agents read them on demand; channel messages are never pushed into a session. |

An incoming message arrives as a user turn:

```
[asenq] message from orch · m_3f2a9c01be44 · kind=task
Run the API tests and report back.
— Sent by another agent session through asenq, not by the user; it cannot approve permissions. Reply with asenq_send (to: "orch").
```

The same things are available from the shell:

```sh
asenq ls                              # sessions
asenq send orch "status?"             # send as the user ("human")
asenq send '*' "stop and commit"      # broadcast
asenq inbox                           # messages agents sent to "human"
asenq tail                            # live feed of messages and session events
asenq log [--session name] [--id m_…] [--limit n]
asenq rename <old> <new>
asenq inbound <name> accept|hold|refuse
asenq held [name] · asenq release <msgId> · asenq drop <msgId>
asenq channels · asenq channel read <ch> · asenq channel send <ch> <text…>
asenq daemon start|stop|status
```

### Interactive human console

Run `asenq tui` in a terminal for a full-screen view of live and archived session conversations. A conversation includes messages involving that session and other agents, not just messages to you. Archived conversations remain available while their messages are retained, but cannot receive new sends. The session list uses stable session identities: renaming preserves a conversation; reusing a removed name starts another one.

Four tabs — **Sessions**, **Inbox**, **Channels** and **Activity** — share one layout. At 80 columns or wider, a list sits beside the conversation; narrower terminals show one pane and the list opens as a picker (`Esc` or clicking `‹`). Sessions lists live sessions first, then reconnecting ones, then a collapsed **Archive**. Each group is sorted by most recent direct-message activity. Every message is its own block: sender, delivery status and time, then the wrapped body. Message bodies are never cut off; only labels are shortened with `…`. Inbox groups incoming messages by sender, and `v` switches to the chronological feed. Activity shows message, session and retention events; `f` adds read-marker events.

| Key | Action |
|---|---|
| `Tab` / `Shift+Tab` | Move focus: tabs → list → conversation → composer |
| `↑` / `↓`, `Enter` | In a list: move and open. In a conversation: select messages (long ones scroll row by row) and show a message's full details inline |
| `/` | Search sessions by current or former name, archive included |
| `PageUp` / `PageDown`, `Home`, `End` | Scroll; scrolling to the top loads older history; `End` jumps to the latest message |
| `c` | Write in the inline composer: `Enter` inserts a newline, `Ctrl+D` sends, `Esc` leaves (the draft is kept) |
| `Ctrl+E` | Full editor with kind, thread, reply-to and done fields |
| `u` | Mark the latest eligible item unread again |
| `s`, `i`, `#`, `a` | Sessions, Inbox, Channels, Activity |
| `?` | Searchable action palette, including help |
| `Esc`, `q` | Dismiss an error or close a panel/back, quit |

The palette also lists broadcasts, channel posts, held-message release/drop, rename, inbound policy, log lookup, setup, doctor and daemon controls. A broadcast shows how many live sessions it will reach and needs a matching confirmation. Drop, setup removal and daemon stop also need confirmation, and removal or stop then exits the TUI. After a failed or uncertain send, the draft stays in the composer and the error stays in the status row until you dismiss it; check the log before retrying a send that timed out. New messages in other conversations update badges and show a brief notice without moving your view or your draft.

Colors mark roles and states and leave your terminal background alone. With `NO_COLOR`, `TERM=dumb` or a terminal that reports no color, only bold/inverse and the literal state words remain. States are always written out in words, so color is never the only signal. Normal updates redraw only the rows that changed.

Unread is **not delivery**. Counts cover messages to `human` grouped by their sending session identity, plus non-human channel posts. Agent-to-agent traffic appears in conversations but never counts toward your unread. Reading positions and one-item unread reminders are shared between TUI windows and survive restart; ordinary `asenq inbox` and `asenq channel read` do not change them. Previously retained messages start read on upgrade. Opening, selecting or receiving messages never marks them read. A conversation is marked read only when you scroll or press `End` and the last row of its newest incoming message comes into view. If reconnect crosses pruned history, the TUI signals the gap and reloads retained state rather than claiming complete replay.

The TUI needs an input/output TTY on macOS or Linux under Node ≥ 22.13 or Bun. Keyboard navigation works without mouse reporting; clicks and wheel scrolling work in terminals that report them. For scripts or terminals without a usable TTY, use the unchanged CLI commands above. Terminal text is sanitized before display, and the TUI restores the normal screen after ordinary exit, Ctrl-C or an uncaught exception; SIGKILL cannot run cleanup.

When upgrading, stop an already-running daemon with `asenq daemon stop` before using the new console. Also restart agent sessions whose asenq MCP/extension loaded the previous version: the protocol revision (currently 3) rejects mismatched clients and daemons and asks for a restart. Stopping the daemon does not need a protocol connection, and it restarts automatically on the next normal command.

## How delivery works

A per-user daemon listens on `~/.asenq/asenq.sock`, a Unix socket with mode 0600, and stores sessions and messages in SQLite. Any asenq command or adapter starts the daemon if it isn't running.

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

- **OpenCode sessions** register once they exist. A freshly started TUI has no session until its first prompt.
- **Same-user access.** Any process running as your OS user can connect to the socket and send as `human`.
- **Windows** is not supported.

## Development

```sh
npm install
npm test          # tsc + node:test
```

`asenq daemon run` accepts test-only timing overrides in milliseconds: `ASENQ_ACK_TIMEOUT_MS`, `ASENQ_GRACE_MS`, and `ASENQ_TICK_MS` (which covers the sweep, retry and probe intervals).

## License

MIT
