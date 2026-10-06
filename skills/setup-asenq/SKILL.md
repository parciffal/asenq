---
name: setup-asenq
description: Install, configure, upgrade, or repair asenq for the coding-agent harnesses on this machine. Use when asked to install or set up asenq, run asenq doctor, change asenq config (queueTtlMs, historyDays, Claude envelope), upgrade asenq, or diagnose "protocol mismatch" / "daemon did not start" / stale daemon problems.
version: 1.0.0
tags: [asenq, setup, install, upgrade, doctor, configuration]
---

# Setting up asenq

asenq is a local messaging context for named, top-level coding-agent sessions and a human participant. It moves messages between participants; it does not own tasks or coordinate their work. One per-user daemon listens on a Unix socket and stores sessions and messages in SQLite under `$ASENQ_HOME` (default `~/.asenq`).

All paths below use the default home. `$ASENQ_HOME` overrides the directory holding `asenq.sock`, `asenq.db` (and `asenq.db-wal` / `asenq.db-shm`), `daemon.lock`, `daemon.log` and `config.json`.

## Install

Requirements: macOS or Linux, Node.js >= 22.13 or Bun.

```sh
npm install -g github:parciffal/asenq
asenq setup      # wires every installed harness; safe to re-run
asenq doctor     # checks the wiring and starts the daemon
```

Once the package is published to npm, `npm install -g asenq` works the same way. Until then use the `github:` form above.

`asenq setup` detects each harness by its config directory and makes these changes:

- **Claude Code** (`~/.claude/`): adds one hook command (`asenq hook claude`) to `~/.claude/settings.json` for `SessionStart`, `SessionEnd`, `PostToolUse`, `UserPromptSubmit` and `Stop`, and registers the user-scoped MCP server `asenq` with stdio transport, using this install's runtime and CLI.
- **OpenCode** (`~/.config/opencode/`): writes the plugin shim `~/.config/opencode/plugins/asenq.js`.
- **omp** (`~/.omp/agent/`, or `$PI_CODING_AGENT_DIR/`): writes the extension shim `extensions/asenq.js`.
- Removes old `mcp-messenger` wiring if found.
- Writes `~/.asenq/config.json` (mode 0600) and installs the shipped agent skills.

`setup` prints one line per change (`+` written, `=` unchanged, `-` removed, `!` problem) and skips a harness whose directory is absent. `doctor` prints `ok` / `warn` / `fail` lines and exits non-zero on failure.

## Configuration (`~/.asenq/config.json`)

| Key | Default | Meaning |
|---|---|---|
| `runtime` | the Node/Bun binary | recorded by setup |
| `cli` | installed `cli.js` path | recorded by setup; doctor fails if it is missing |
| `historyDays` | `7` | retained message history |
| `queueTtlMs` | `86400000` (24 h) | queued-message lifetime, in milliseconds |
| `claude.envelope` | `false` | opt-in native Claude envelope |

- **`queueTtlMs`**: a queued message expires once its age reaches this deadline, including while the target is offline or awaiting an acknowledgment. Held messages do **not** expire by age; releasing a held message into the queue applies the deadline from its original creation time, so a long-held message can expire on release.
- **`claude.envelope: true`** wraps deliveries in Claude's own `<cross-session-message>` format (a private format, checked against a specific Claude Code version range). Off by default.

Every config change is read when the **daemon starts**, so restart it after editing: `asenq daemon stop`. `setup` preserves your `queueTtlMs`, `historyDays` and `claude.envelope` across re-runs.

## Upgrading

Stop the daemon and back up both the database and the old build before replacing anything.

```sh
# 1. Record what to restore
asenq --version
cat "$HOME/.asenq/config.json"               # runtime + cli of the installed build
asenq ls                                     # keep each session's `resume=` command
# 2. Save a rollback copy of the installed build and config
OLD_VERSION="$(asenq --version)"
mkdir -p "$HOME/.asenq/rollback"
cp -R "$(npm root -g)/asenq" "$HOME/.asenq/rollback/asenq-$OLD_VERSION"
cp "$HOME/.asenq/config.json" "$HOME/.asenq/rollback/config.json"
# 3. Stop the daemon (required before touching the database)
asenq daemon stop
# 4. Back up the database with SQLite, not a raw copy of the live WAL
sqlite3 "$HOME/.asenq/asenq.db" ".backup '$HOME/.asenq/rollback/asenq.db'"
# 5. Install the new build and rewire
npm install -g github:parciffal/asenq
asenq setup
# 6. Restart each agent session with its recorded resume command
claude -r <id>        # or: omp -r <id>        or: opencode -s <id>
```

- **Database backup**: the database uses WAL. Back it up only after the daemon is stopped, or with a consistent SQLite backup (`.backup`). If you cannot run SQLite, stop the daemon and copy `asenq.db`, `asenq.db-wal` and `asenq.db-shm` **together** — never copy `asenq.db` alone while a daemon is running.
- **Sessions**: a loaded adapter or MCP server speaks the protocol revision it was built with. After an upgrade, restart each session from its `resume=` command in `asenq ls`, or start a fresh session.
- `npm run build` does not clean `dist/`; a git-installed build resolves from the installed package directory recorded as `cli` in `config.json`.

## Troubleshooting

CLI errors print as `asenq: <message>`.

| Symptom | Cause and fix |
|---|---|
| `asenq daemon protocol mismatch; restart it (asenq daemon stop)` | A client and the running daemon speak different revisions (usually an upgraded build against an old daemon). Run `asenq daemon stop`; the next asenq command starts a fresh daemon, then restart agent sessions. |
| `asenq daemon did not start; see <path>` | The daemon was spawned but never answered on the socket. Read the log at `~/.asenq/daemon.log` (the printed path), then check `asenq daemon status`. |
| `asenq is not set up (run: asenq setup)` | `~/.asenq/config.json` is missing. Run `asenq setup`. |
| `asenq daemon not running (run: asenq daemon start)` | A client ran with auto-start disabled. Run `asenq daemon start`. |
| `asenq daemon already running (pid N)` | Another live daemon holds `daemon.lock`. Use it, or `asenq daemon stop` first. A lock whose pid is dead is replaced automatically. |
| `asenq daemon stop` prints `pid N did not stop` | The daemon ignored `SIGTERM` within ~3 s. Inspect that pid before retrying. |
| `shipped skills missing ...; reinstall asenq` | The package is incomplete. Setup fails before changing wiring or config; doctor reports failure per detected harness. Reinstall the complete package, then run setup and doctor again. |

`asenq daemon status` prints `running pid N` or `stopped`. `asenq daemon stop` is safe to repeat.

## Rollback

Restore the saved database together with its matching old build, then rewire, with the daemon stopped. The snapshot holds only the messages present when it was taken, so any message created after the backup is permanently lost when you restore — confirm that is acceptable before rolling back. Use the version directory you saved in step 2 of the upgrade.

```sh
asenq daemon stop
npm install -g "$HOME/.asenq/rollback/asenq-<old-version>"
cp "$HOME/.asenq/rollback/asenq.db" "$HOME/.asenq/asenq.db"
rm -f "$HOME/.asenq/asenq.db-wal" "$HOME/.asenq/asenq.db-shm"
cp "$HOME/.asenq/rollback/config.json" "$HOME/.asenq/config.json"
asenq setup
```

`asenq setup` preserves the `queueTtlMs`, `historyDays` and `claude.envelope` in the restored config, so restoring `config.json` first rolls those values back too.

`asenq setup --remove` unwires hooks, MCP entries, plugin shims, the shipped skills and `config.json`, and stops the daemon; it keeps message history at `~/.asenq/asenq.db`.

## Shipped agent skills

asenq ships four skills in the package under `skills/<name>/SKILL.md`: `setup-asenq`, `asenq-worker`, `asenq-orchestrator` and `asenq-recover`. `asenq setup` installs each into every detected harness skills folder:

- Claude Code: `~/.claude/skills/<name>/`
- omp: `~/.omp/agent/skills/<name>/` (or `$PI_CODING_AGENT_DIR/skills/<name>/`)
- OpenCode: `~/.config/opencode/skills/<name>/` (its documented user skills folder)

Ownership and repair rules:

- Setup records what it last wrote (an ownership manifest with a per-file hash) inside the harness's skills directory, so `setup --remove` can act without a config file.
- Re-running setup leaves an unedited installed copy unchanged and updates an outdated one.
- If the installed `SKILL.md` differs from the last-written hash — you edited it — setup saves your copy as `SKILL.md.asenq-bak` before overwriting. That name is fixed: a later update overwrites `SKILL.md.asenq-bak` with the newest edited copy, so only the most recent edit is kept. A pre-existing untracked file that collides with a skill is backed up the same way.
- Removing an edited installed copy deletes the tracked `SKILL.md` only after saving your edit to `SKILL.md.asenq-bak`, so the edit is preserved.
- `asenq setup --remove` deletes only the `SKILL.md` files asenq installed; unrelated files, directories and `.asenq-bak` backups are preserved.
- `asenq doctor` reports, per harness, whether the skills are installed and current, or skipped and why, and whether a copy is missing, outdated, edited or unowned.

Setup output names each skill as written, unchanged or backed up.
