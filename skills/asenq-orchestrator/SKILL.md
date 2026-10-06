---
name: asenq-orchestrator
description: How an asenq orchestrator session leads work across sessions. Use when directing other sessions over asenq, assigning or checking roles, creating channels or rosters, mentioning channel members, broadcasting, compacting a target before a new task, tracking work by thread, handling held messages, or handing work to a new session.
version: 1.0.0
tags: [asenq, orchestrator, channels, mentions, broadcast, roles]
---

# Leading with asenq

asenq is a messenger, not a coordinator. It moves direct messages and channel posts between named sessions and the human; it does not spawn sessions, track tasks or merge work. Everything here is messaging plus the roster and role permissions that shape who can talk to whom.

## Roles

A session's **role** is `orchestrator`, `worker` or unset. The human assigns any role; an orchestrator can set roles only for sessions that share at least one channel with it (`asenq_set_role`, or the human CLI `asenq role <name> orchestrator|worker|unset`). Workers and unset-role sessions receive `not_permitted`. Roles do not restrict delivery and do not change a target's inbound policy.

## Channels and members

Channels are durable, named shared streams of posts with a roster of session identities; a channel post reaches a member only when the post mentions it.

- `asenq_channel_create { "channel": "backend" }` — the human or an orchestrator may create one; a channel an orchestrator creates atomically includes that orchestrator as its first member. Creating an existing channel is idempotent and does not join it.
- `asenq_channel_add { "channel": "backend", "name": "worker-oc" }` — the human may add anyone; an orchestrator may add itself to any existing channel, or other live sessions only to channels it already belongs to.
- `asenq_channel_remove { "channel": "backend", "name": "worker-oc" }` — the human or an orchestrator in that channel; resolves current names before former names and refuses ambiguous matches. The human can remove a specific identity with `asenq channel remove <ch> --session-id <id>`.
- `asenq_channel_members { "channel": "backend" }` — reads are unrestricted.
- `asenq_channel_read` / `asenq_channel_list` — read posts and list channels.

Workers and unset-role sessions cannot create channels or edit rosters. Membership survives rename, disconnection, automatic removal and revival; human `close` and archive `purge` remove it, and a name reused by a different identity does not inherit it.

## Mentions and their boundary rule

Posting with `asenq_channel_send { "channel": "backend", "text": "Review @alpha; status from @workers" }` delivers the post as a direct message to each resolved member, in addition to recording it in the channel.

| Token | Targets |
|---|---|
| `@orch`, `@orchestrator`, `@orchestrators` | members with the orchestrator role |
| `@wrk`, `@worker`, `@workers` | members with the worker role |
| `@all` | every other channel member |

Keywords take precedence over member names, and a member can also be named by its current or former name. Parsing is case-sensitive ASCII (`[A-Za-z0-9_-]`). An `@` starts a mention only at the start of the text, after whitespace, or after one of `(`, `[`, `{`, `<`, `"`, `'`, `` ` ``; any other preceding character blocks it, so email local parts such as `foo@alpha` and `foo+@alpha.example` stay literal. A token ends at the first character outside that name set, so `(@alpha)`, `"@alpha"` and `@alpha,` all address `alpha`. There are no Markdown or code-block exceptions.

A group with no matching members is valid and delivers nothing. An unknown, ambiguous or non-member token fails the **whole post** with `unknown_mention` and no message is created; inspect the roster with `asenq_channel_members` first. Each identity is targeted once per post, never the poster, and never the human.

## Broadcast scope

`asenq_send { "to": "*", … }` produces a separate direct message for each **live** session sharing any of your channels, once even when channels overlap, and never for the sender. If you belong to a channel but no live co-member is eligible, the broadcast reaches nobody — it does not fall back to machine-wide delivery. Only a sender that belongs to **no** channel reaches every other live session on the machine. The human is never a broadcast target. Never use `"*"` for a task brief or a reply.

Named direct messages are unrestricted by membership. Every send applies the target's inbound policy, rate limits and queue admission.

## Compact before a new task

Request compaction of a target's context before its next task:

```json
{ "to": "worker-omp", "text": "Start the next task", "kind": "task", "reset": "compact" }
```

- The human or an orchestrator only, to **one named session**; `"*"`, `"human"`, stable-id sends and channel posts reject the flag with `bad_request`.
- omp adapters compact and then inject the message. OpenCode and Claude (and other adapters without the capability) deliver normally and report `reset=unsupported`; OpenCode compaction is tracked separately.
- A capable live target acknowledges receipt immediately and the send result reports `reset=pending`, not finished compaction. History then records `resetResult=compacted` or `resetResult=failed`; **failure still delivers the message**. `asenq log --id <msgId>` shows the final outcome.
- A pending reset has a 10-minute daemon-side cap. Expiry records failure and immediately releases the target's delivery gate, so deferred messages proceed even while the target stays live; disconnect ends the pending reset as failed and leaves deferred messages queued for reconnection. Held and queued sends keep the request and resolve capability only on actual delivery.

## Tracking work, held messages, handoff

- **Tracking is manual.** Use the `thread` field to group messages and `reply_to` to answer specific ones; a thread is a label, not a managed task. asenq never tracks, schedules or merges work.
- **Inbound policy**: `asenq inbound <name> accept|hold|refuse`. `hold` reserves agent-sent messages for a human decision; human-sent messages bypass hold, `refuse` rejects both. Listing, releasing (`asenq release <msgId>`) and dropping (`asenq drop <msgId>`) held messages are human-only; an agent cannot read a held message. A send result reports the target's actual state (delivered, held, queued, rejected), never an assumed success.
- **Handing work to a new session**: start it with an explicit name (`claude --name <name>`, or `ASENQ_NAME=<name> opencode` / `omp`) so the name is claimed. A session asenq does not recognise as the same identity cannot inherit a role, memberships or waiting messages; to move them onto it, use `asenq_replace` (or `asenq replace`) — see the `asenq-recover` skill.
