import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'
import type { AsenqData, Session, Channel } from '../types'
import { findSelf, statusLine, sharedWorkers, firstOrchestrator } from './format'

const PANE_ID = 'asenq'
const DEBOUNCE_MS = 300
const INITIAL_BACKOFF_MS = 1_000
const MAX_BACKOFF_MS = 30_000
const VERSION_MISMATCH_RE = /protocol|version/i

const dataAtom = atom(
  { plugin: 'asenq', key: 'data' } as const,
  { sessions: [], channels: [], online: false } as AsenqData,
)

type Timer = { cancel: () => void }

// Module-level state (reset on hot reload is acceptable, same as repo-pane pattern)
let argv: string[] = []
let claudeSessionId = ''
let debounceTimer: Timer | null = null
let versionMismatchToasted = false

async function loadArgv($: any): Promise<string[]> {
  const text = await $.fs.read(`${$.plugin.root}/asenq-cli.json`)
  const config = JSON.parse(text) as { argv: string[] }
  return config.argv
}

async function asenqRun($: any, args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return $.process.run([...argv, ...args], { timeoutMs: 10_000 })
}

async function fetchData($: any): Promise<AsenqData> {
  try {
    const [lsResult, chResult] = await Promise.all([
      asenqRun($, ['ls', '--json']),
      asenqRun($, ['channels', '--json']),
    ])
    if (lsResult.exitCode !== 0 || chResult.exitCode !== 0) {
      return { sessions: [], channels: [], online: false }
    }
    const sessions = JSON.parse(lsResult.stdout) as Session[]
    const channels = JSON.parse(chResult.stdout) as Channel[]
    return { sessions, channels, online: true }
  } catch {
    return { sessions: [], channels: [], online: false }
  }
}

async function refreshAndStatus($: any): Promise<void> {
  const data = await fetchData($)
  await update($, dataAtom, () => data)
  $.ui.status(statusLine(data, claudeSessionId))
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
      try {
        const tail = $.process.spawn({ argv: [...argv, 'tail'] })
        backoff = INITIAL_BACKOFF_MS
        for await (const chunk of tail) {
          if (chunk.stream === 'stderr') {
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
      await update($, dataAtom, (prev: AsenqData) => ({ ...prev, online: false }))
      $.ui.status('asenq offline')
      $.clock.after(backoff, () => attemptTail())
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS)
    })()
  }

  attemptTail()
}

async function handleRename($: any, oldName: string, newName: string): Promise<void> {
  if (!newName || newName === oldName) return
  const result = await asenqRun($, ['rename', oldName, newName])
  if (result.exitCode !== 0) {
    $.ui.toast(result.stderr.trim() || `rename failed (exit ${result.exitCode})`)
    return
  }
  await refreshAndStatus($)
}

async function handleRole($: any, name: string, role: string): Promise<void> {
  const result = await asenqRun($, ['role', name, role])
  if (result.exitCode !== 0) {
    $.ui.toast(result.stderr.trim() || `role change failed (exit ${result.exitCode})`)
    return
  }
  await refreshAndStatus($)
}

async function handleChannelRename($: any, oldName: string, newName: string): Promise<void> {
  if (!newName || newName === oldName) return
  const answer = await $.ui.ask(
    `Rename channel #${oldName} to #${newName}? Members get a note and the old name stops working.`,
    ['Rename', 'Cancel'],
  )
  if (answer !== 'Rename') return
  const result = await asenqRun($, ['channel', 'rename', oldName, newName])
  if (result.exitCode !== 0) {
    $.ui.toast(result.stderr.trim() || `channel rename failed (exit ${result.exitCode})`)
    return
  }
  await refreshAndStatus($)
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    try {
      argv = await loadArgv($)
    } catch {
      $.ui.status('asenq offline')
      return next(e)
    }

    claudeSessionId = await $.session.id()
    versionMismatchToasted = false

    await $.command.register({
      name: 'asenq',
      description: 'asenq sessions, roles and channels',
    })

    // Fetch initial data
    await refreshAndStatus($)

    const started = await next(e)

    // Start live tail after the session is ready
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
    const self = findSelf(data.sessions, claudeSessionId)

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
      return (
        <Box key={key} flexDirection="column">
          <Box>
            <Text bold>{s.name}</Text>
            <Text dimColor> {rolePart} {s.state}</Text>
          </Box>
          <Box>
            <Input
              key={`rename-${s.id}`}
              label="name"
              placeholder={s.name}
              value=""
              onSubmit={(v: string) => handleRename($, s.name, v.trim())}
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
      return (
        <Box key={`ch-${ch.name}`} flexDirection="column">
          <Box>
            <Text bold>#{ch.name}</Text>
            <Text dimColor> ({ch.count} members)</Text>
          </Box>
          <Box>
            <Input
              key={`chrename-${ch.name}`}
              label="rename"
              placeholder={ch.name}
              value=""
              onSubmit={(v: string) => handleChannelRename($, ch.name, v.trim())}
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
