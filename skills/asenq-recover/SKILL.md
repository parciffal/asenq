---
name: asenq-recover
description: Recover asenq sessions that restart, go quiet or are not recognised. Use when a session needs pinging, "close all stale" or a purge, when a session must resume after a restart, when an unrecognised restarted session needs replacing, or when queued and held messages must be accounted for.
version: 1.0.0
tags: [asenq, recover, ping, resume, replace, close, purge]
---

# Recovering asenq sessions

Only two things make a session **stale**: it is disconnected, or it did not answer its most recent ping. A running session that has simply been quiet is not stale. Only stale sessions are closed by "close all stale".

## Ping and stale

There is no ping CLI command or agent tool. Ping from the human console's action palette:

- **`? → Ping sessions`** — probes live sessions and refreshes their status. omp and OpenCode adapters answer through their connection without starting a model turn; Claude sessions with a messaging socket are probed through it.
- In `asenq ls`, `ping=` shows `responding`, `not_responding`, `never`, or `unknown (unavailable)` for adapters that do not declare ping support. A failed ping shows `not_responding` and `stale=yes` but does not disconnect or close the session; a later answered ping clears it, and disconnection clears the cached ping.
- `asenq tail` reports ping results keyed by stable identity, so a failed probe and its later recovery both stay visible.
- **`? → Close all stale`** waits for a fresh ping first, then previews disconnected (`gone`) sessions and live sessions whose latest ping is `not_responding`. Quiet running sessions are excluded, and unsupported-probe sessions stay safe while live.

`lastSeen` is durable harness contact (registration, hooks, bound requests, acknowledgments, matched pongs), not direct-message activity.

## Close and purge

Both are human-only and irreversible.

- `asenq close <name|identity>` — terminally archives a session: removes its channel memberships, expires its queued and held messages with sender notices, and ends forwarding through its current and former names and harness identity.
- `asenq purge <name|identity>` or `asenq purge --all` — permanently deletes archived conversations, their removed identities, memberships and reading positions. It never deletes live sessions, channels or channel posts.

These commands accept an exact **current** name or a stable identity id; former names are not destructive targets. `purge` rejects a name still held by a live or reconnecting session, and ambiguous archive names are rejected with candidate ids. The CLI acts immediately with no confirmation; use the TUI previews (`? → Purge all archives` / `Purge conversation`) to see the exact target count and ids first.

## Resuming after a restart

`asenq ls` appends a shell-quoted resume command when the harness session id is known:

```
claude -r <id>        omp -r <id>        opencode -s <id>
```

Read the `resume=` line for each session and run it verbatim. If a row has **no** `resume=` line, its harness session id is unknown — do not invent one; start a fresh session instead. Resuming restores the identity, current name and waiting messages even after removal or a daemon restart. Resuming a **closed** identity creates a fresh identity without its old memberships.

## Replacing an unrecognised restart

When a newly registered session is not recognised as the same identity as the source (a restart that looks new), move the source onto it:

```sh
asenq replace <from> <to>
asenq replace --from-id <source-id> <to>
asenq replace <from> --to-id <destination-id>
asenq replace --from-id <source-id> --to-id <destination-id>
```

The agent equivalent is `asenq_replace` with one of `from`/`from_id` and one of `to`/`to_id`.

- The source may be any **non-closed** identity, including a disconnected or automatically removed one; the destination must be **live**.
- A human may replace any source; an orchestrator must share a channel with the source; other callers get `not_permitted`.
- The destination keeps its name, cwd, inbound policy, history, read position and harness association. The source's set role overrides the destination's; otherwise the destination keeps its role.
- Channel memberships and the source's current/former names move, except names still held by another live or reconnecting identity. Those are returned as `skippedNames`; replacement still succeeds and moves the rest.
- Queued and held messages move without changing ids, timestamps, TTLs or other metadata; held messages stay held.
- The source is closed and archived: its delivered history, outbound messages, conversation and read markers stay **separate** — histories are not merged.
- **Former-name forwarding**: after the move, messages sent to any moved former name reach the destination under its current name, until that identity is closed.

## What happens to waiting messages

- A live session that disconnects is removed from the active list after 2 minutes, but its identity and queued or held messages survive. Sending to its current name or, for the human, its stable identity still admits a message, subject to its inbound policy.
- A **queued** message waits for the identity's return until its age reaches `queueTtlMs` (default 24 h from creation), including while offline. Expired messages are never delivered on revival and the live agent sender gets a delivery notice.
- A **held** message does not expire by age; releasing it into the queue applies the deadline from its original creation time. Held messages survive removal and moving.
- **Closed** identities receive nothing: closing expires their queued and held messages with sender notices (queued notices for offline, non-closed senders are delivered when that sender revives). Automatically removed identities still accept messages by their current and former names.
