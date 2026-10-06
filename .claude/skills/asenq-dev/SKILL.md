---
name: asenq-dev
description: Repository-only guide for changing asenq itself. Use when implementing a feature or fix inside the asenq source tree, bumping the wire protocol, writing daemon or TUI tests, or running asenq's own test suite. Not shipped or installed by setup.
version: 1.0.0
tags: [asenq, development, testing, protocol, tui]
---

# Developing asenq

This skill lives in the repository only. It is never installed by `asenq setup` and must not be packed or referenced from the shipped skills.

## Isolation

The live daemon, MCP servers and hooks of a running machine execute from one checkout. Never build, test, lint, format or check out that checkout — a broken build there breaks every session.

- Do all work in a separate git worktree of this repository on its own branch. Where dependencies are needed, provision them in the worktree (a symlink to the main checkout's `node_modules` is often enough), and verify provisioning before running anything.
- Tools resolve paths from the session's working directory, not from a shell's `cd`. Use **absolute paths under your worktree** for every file read, edit and write, and pass an explicit working directory to shell commands.
- Never restart, stop or start the machine's live daemon, and never run `asenq setup`, while developing here.

## Wire protocol

If your change alters the wire protocol, bump `PROTOCOL` in `src/shared/protocol.ts` by **exactly 1** over the current `origin/main` at the moment you open or update the pull request — not over your branch's older base. A change that does not alter the wire protocol must not bump it.

## Tests

`npm test` (TypeScript build + `node --test`) is the gate; there is no CI. Test **external behavior** only.

- **Daemon seam**: build the daemon with `startEnv()` (a temp `ASENQ_HOME`, an in-process daemon, a manual clock and background timers disabled). Advance time with `env.clock.advance(ms)` and drive sweeps and other timers by hand (`env.daemon.sweep()`); never sleep on a real clock.
- **Delivery acknowledgment barrier**: an adapter's `nextDelivery()` proves the delivery was *received*, not that the daemon finished the delivery. Subscribe with `env.watch(isStatus(msgId, "delivered"))` before triggering the send, then await that event before asserting inbox, unread or queued state. A revival or retry is only durable once the delivered event lands.
- **Rendered TUI rows**: TUI tests render real frames and assert on visible rows and hit rows. A logical list entry may span several rows sharing one stable key; only the visible last row of the newest incoming message marks a conversation read — scrolled-away or hidden rows must not. Every frame row must fit the terminal width and height.
- Assert through the public protocol (daemon requests, adapter pushes, rendered frames). Do not test implementation details, forward values, or bare non-throwing calls.

## PTY and terminal

- When driving the real TUI through a PTY, keep **draining** the PTY master continuously while waiting for the child to exit. On macOS, terminal-kit's `grabInput(false)` calls `stdin.setRawMode(false)`, which can block until pending terminal output is consumed; a wait without a reader looks like a hang. Treat PTY `EIO` as EOF, then collect the exit status.
- Decode incremental PTY bytes as UTF-8 and flush the remaining output after exit, or box-drawing glyphs and audit text can appear corrupted.

## Checklist

1. Confirm you are in an isolated worktree on your own branch, with absolute paths.
2. Make the smallest change that satisfies the behavior; match surrounding style.
3. Bump `PROTOCOL` only if the wire changed.
4. `npm test` green in the worktree.
5. Rebase onto the current `origin/main` and re-run `npm test` before opening the pull request.
