import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'
import type { AsenqData, Session, Channel, Drafts } from '../types'
import { findSelf, statusLine } from './format'

const PANE_ID = 'asenq'
const DEBOUNCE_MS = 300
const INITIAL_BACKOFF_MS = 1_000
const MAX_BACKOFF_MS = 30_000
const STABLE_MS = 5_000
const VERSION_MISMATCH_RE = /protocol|version/i
const CONNECTED_RE = /^asenq tail: connected$/m

const EMPTY: AsenqData = { sessions: [], channels: [], online: false, seq: 0 }

const dataAtom = atom(
  { plugin: 'asenq', key: 'data' } as const,
  EMPTY,
)

const draftsAtom = atom(
  { plugin: 'asenq', key: 'drafts' } as const,
  {} as Drafts,
)

type Timer = { cancel: () => void }

// Module-level state (reset on hot reload is acceptable, same as repo-pane pattern)
let argv: string[] = []
let debounceTimer: Timer | null = null
let versionMismatchToasted = false
let fetchSeq = 0

async function loadArgv($: any): Promise<string[]> {
  const text = await $.fs.read(`${$.plugin.root}/asenq-cli.json`)
  const config = JSON.parse(text) as { argv: string[] }
  return config.argv
}

async function asenqRun($: any, args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return $.process.run([...argv, ...args], { timeoutMs: 10_000 })
}

async function fetchData($: any): Promise<AsenqData> {
  const seq = ++fetchSeq
  try {
    const [lsResult, chResult] = await Promise.all([
      asenqRun($, ['ls', '--json']),
      asenqRun($, ['channels', '--json']),
    ])
    if (lsResult.exitCode !== 0 || chResult.exitCode !== 0) {
      return { ...EMPTY, seq }
    }
    const sessions = JSON.parse(lsResult.stdout) as Session[]
    const channels = JSON.parse(chResult.stdout) as Channel[]
    return { sessions, channels, online: true, seq }
  } catch {
    return { ...EMPTY, seq }
  }
}

/** Reads the session id fresh each time (F-03: survives /clear and /resume). */
async function sessionId($: any): Promise<string> {
  return $.session.id()
}

/** Writes data to the atom only if seq >= the stored seq (last-write-wins by sequence). */
async function setData($: any, data: AsenqData): Promise<void> {
  await update($, dataAtom, (prev: AsenqData) =>
    data.seq >= prev.seq ? data : prev,
  )
}

/** F-15: compute status from what the atom holds, so status and pane agree. */
async function updateStatus($: any): Promise<void> {
  const data = await read($, dataAtom)
  const id = await sessionId($)
  $.ui.status(statusLine(data, id))
}

async function refreshAndStatus($: any): Promise<void> {
  const data = await fetchData($)
  await setData($, data)
  await updateStatus($)
}

function debouncedRefetch($: any): void {
  if (debounceTimer) debounceTimer.cancel()
  debounceTimer = $.clock.after(DEBOUNCE_MS, async () => {
    debounceTimer = null
    await refreshAndStatus($)
  })
}

function startTail($: any): void {
  let backoff = INITIAL_BACKOFF_MS

  function attemptTail(): void {
    void (async () => {
      let stableTimer: Timer | null = null
      try {
        const tail = $.process.spawn({ argv: [...argv, 'tail'] })

        let gotChunk = false
        stableTimer = $.clock.after(STABLE_MS, () => { backoff = INITIAL_BACKOFF_MS })

        for await (const chunk of tail) {
          if (!gotChunk) {
            gotChunk = true
            backoff = INITIAL_BACKOFF_MS
            stableTimer.cancel()
            stableTimer = null
          }
          if (chunk.stream === 'stderr') {
            // F-14: "asenq tail: connected" line triggers a refetch
            if (CONNECTED_RE.test(chunk.text)) {
              void refreshAndStatus($)
              continue
            }
            if (!versionMismatchToasted && VERSION_MISMATCH_RE.test(chunk.text)) {
              versionMismatchToasted = true
              $.ui.toast('asenq mod is out of date with the daemon: rerun `asenq setup`')
            }
            continue
          }
          debouncedRefetch($)
        }
      } catch {
        // spawn failed
      }
      // tail ended or failed: go offline, retry with backoff
      if (stableTimer) { stableTimer.cancel(); stableTimer = null }
      const offlineData: AsenqData = { ...EMPTY, seq: ++fetchSeq }
      await setData($, offlineData)
      await updateStatus($)
      $.clock.after(backoff, () => attemptTail())
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS)
    })()
  }

  attemptTail()
}

async function handleRename($: any, draftKey: string, oldName: string, newName: string): Promise<void> {
  if (!newName || newName === oldName) return
  try {
    const result = await asenqRun($, ['rename', oldName, newName])
    if (result.exitCode !== 0) {
      $.ui.toast(result.stderr.trim() || `rename failed (exit ${result.exitCode})`)
      return
    }
    // F-06 nit: clear only the submitted row's draft
    await update($, draftsAtom, (prev: Drafts) => {
      const next = { ...prev }
      delete next[draftKey]
      return next
    })
    await refreshAndStatus($)
  } catch (err) {
    $.ui.toast(String(err))
  }
}

async function handleRole($: any, name: string, role: string): Promise<void> {
  try {
    const result = await asenqRun($, ['role', name, role])
    if (result.exitCode !== 0) {
      $.ui.toast(result.stderr.trim() || `role change failed (exit ${result.exitCode})`)
      return
    }
    await refreshAndStatus($)
  } catch (err) {
    $.ui.toast(String(err))
  }
}

async function handleChannelRename($: any, draftKey: string, oldName: string, newName: string): Promise<void> {
  if (!newName || newName === oldName) return
  try {
    let answer: string
    try {
      answer = await $.ui.ask(
        `Rename #${oldName} to #${newName}? Members get a note and the old name stops working — continue?`,
        ['Rename', 'Cancel'],
      )
    } catch {
      // Dialog dismissed -> treat as Cancel (F-05)
      return
    }
    if (answer !== 'Rename') return
    const result = await asenqRun($, ['channel', 'rename', oldName, newName])
    if (result.exitCode !== 0) {
      $.ui.toast(result.stderr.trim() || `channel rename failed (exit ${result.exitCode})`)
      return
    }
    // F-06 nit: clear only the submitted row's draft
    await update($, draftsAtom, (prev: Drafts) => {
      const next = { ...prev }
      delete next[draftKey]
      return next
    })
    await refreshAndStatus($)
  } catch (err) {
    $.ui.toast(String(err))
  }
}

function setDraft($: any, key: string, value: string): void {
  void update($, draftsAtom, (prev: Drafts) => ({ ...prev, [key]: value }))
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    try {
      argv = await loadArgv($)
    } catch {
      $.ui.status('asenq offline')
      return next(e)
    }

    versionMismatchToasted = false
    // F-13: seed fetchSeq from the persisted atom so a reload doesn't drop writes
    const stored = await read($, dataAtom)
    fetchSeq = stored.seq

    await $.command.register({
      name: 'asenq',
      description: 'asenq sessions, roles and channels',
    })

    // Show placeholder status immediately (F-02: don't block on CLI)
    $.ui.status('asenq …')

    const started = await next(e)

    // Start live tail (the stderr "connected" line triggers the initial fetch)
    startTail($)

    return started
  })

  on('command.run', { command: 'asenq' }, async ($) => {
    await refreshAndStatus($)
    await $.ui.open({ id: PANE_ID, title: 'asenq' })
    return { text: 'asenq pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const { Box, Text, Input, Select } = $.ui.resolve(e)
    const data = await read($, dataAtom)
    const id = await sessionId($)
    const self = findSelf(data.sessions, id)
    const drafts = await read($, draftsAtom)

    if (!data.online) {
      return (
        <Box flexDirection="column">
          <Text dimColor>asenq daemon is offline.</Text>
        </Box>
      )
    }

    const roleOptions = [
      { label: 'orchestrator', value: 'orchestrator' },
      { label: 'worker', value: 'worker' },
      { label: 'unset', value: 'unset' },
    ] as const

    function sessionRow(s: Session, key: string) {
      const rolePart = s.role ?? 'unset'
      const renameKey = `rename-${s.id}`
      return (
        <Box key={key} flexDirection="column">
          <Box>
            <Text bold>{s.name}</Text>
            <Text dimColor> {rolePart} {s.state}</Text>
          </Box>
          <Box>
            <Input
              key={renameKey}
              label="name"
              placeholder={s.name}
              value={drafts[renameKey] ?? ''}
              onInput={(v: string) => setDraft($, renameKey, v)}
              onSubmit={(v: string) => handleRename($, renameKey, s.name, v.trim())}
            />
          </Box>
          <Box>
            <Select
              key={`role-${s.id}`}
              label="role"
              options={[...roleOptions]}
              value={s.role ?? 'unset'}
              onSelect={(v: string) => handleRole($, s.name, v)}
            />
          </Box>
        </Box>
      )
    }

    function channelSection(ch: Channel) {
      const chKey = `chrename-${ch.name}`
      return (
        <Box key={`ch-${ch.name}`} flexDirection="column">
          <Box>
            <Text bold>#{ch.name}</Text>
            <Text dimColor> ({ch.members.length} members)</Text>
          </Box>
          <Box>
            <Input
              key={chKey}
              label="rename"
              placeholder={ch.name}
              value={drafts[chKey] ?? ''}
              onInput={(v: string) => setDraft($, chKey, v)}
              onSubmit={(v: string) => handleChannelRename($, chKey, ch.name, v.trim())}
            />
          </Box>
          {ch.members.map((m) => (
            <Box key={`chm-${ch.name}-${m.id}`}>
              <Text dimColor>  </Text>
              <Text>{m.name}</Text>
              <Text dimColor> {m.role ?? 'unset'} {m.state}</Text>
            </Box>
          ))}
        </Box>
      )
    }

    // Build sections
    const selfChannels = self
      ? data.channels.filter((ch) => self.channels.includes(ch.name))
      : []
    const otherSessions = data.sessions.filter(
      (s) => s.state === 'live' && (!self || s.id !== self.id),
    )

    return (
      <Box flexDirection="column">
        {/* Section 1: This session */}
        <Text bold dimColor>This session</Text>
        {self ? (
          sessionRow(self, `self-${self.id}`)
        ) : (
          <Text dimColor>unregistered</Text>
        )}

        {/* Section 2: Channels */}
        {selfChannels.length > 0 && (
          <Box flexDirection="column">
            <Text bold dimColor>Channels</Text>
            {selfChannels.map((ch) => channelSection(ch))}
          </Box>
        )}

        {/* Section 3: Other live sessions */}
        {otherSessions.length > 0 && (
          <Box flexDirection="column">
            <Text bold dimColor>Other sessions</Text>
            {otherSessions.map((s) => sessionRow(s, `other-${s.id}`))}
          </Box>
        )}
      </Box>
    )
  })
}
