import { test, expect, mock, describe } from 'claude-code/testing'
import type { AsenqData, Session, Channel } from '../types'
import { statusLine, findSelf, sharedWorkers, formatWorkerNames, firstOrchestrator } from './format'

const V = { value: undefined as void } as const

// --- Pure function tests (no engine needed) ---

describe('findSelf', () => {
  const sessions: Session[] = [
    { id: 's1', name: 'lead', role: 'orchestrator', state: 'live', harness: 'claude', harnessSessionId: 'cc-123', cwd: '/a', channels: ['prog'] },
    { id: 's2', name: 'w1', role: 'worker', state: 'live', harness: 'omp', harnessSessionId: 'omp-1', cwd: '/b', channels: ['prog'] },
    { id: 's3', name: 'w2', role: 'worker', state: 'live', harness: 'claude', harnessSessionId: 'cc-456', cwd: '/c', channels: ['prog'] },
  ]

  test('matches by harness and harnessSessionId', async () => {
    const self = findSelf(sessions, 'cc-123')
    expect(self).toBeDefined()
    expect(self!.name).toBe('lead')
  })

  test('returns undefined when no match', async () => {
    expect(findSelf(sessions, 'cc-999')).toBeUndefined()
  })

  test('does not match non-claude sessions', async () => {
    expect(findSelf(sessions, 'omp-1')).toBeUndefined()
  })
})

describe('formatWorkerNames', () => {
  function w(name: string): Session {
    return { id: name, name, role: 'worker', state: 'live', harness: 'omp', harnessSessionId: '', cwd: '/', channels: [] }
  }

  test('empty list', async () => {
    expect(formatWorkerNames([])).toBe('')
  })

  test('short list stays whole', async () => {
    expect(formatWorkerNames([w('w1'), w('w2'), w('w3')])).toBe('w1, w2, w3')
  })

  test('long list gets +N', async () => {
    const workers = [w('worker-alpha'), w('worker-bravo'), w('worker-charlie'), w('worker-delta'), w('worker-echo'), w('worker-foxtrot'), w('worker-golf')]
    const result = formatWorkerNames(workers)
    expect(result).toContain('+')
    // The names part before +N should be <= ~40 chars
    const beforePlus = result.split(' +')[0]
    expect(beforePlus.length).toBeLessThanOrEqual(42)
  })

  test('single worker shows its name', async () => {
    expect(formatWorkerNames([w('my-worker')])).toBe('my-worker')
  })
})

describe('sharedWorkers', () => {
  test('returns only live workers sharing a channel with self', async () => {
    const self: Session = { id: 's1', name: 'lead', role: 'orchestrator', state: 'live', harness: 'claude', harnessSessionId: 'cc-1', cwd: '/', channels: ['prog'] }
    const sessions: Session[] = [
      self,
      { id: 's2', name: 'w1', role: 'worker', state: 'live', harness: 'omp', harnessSessionId: '', cwd: '/', channels: ['prog'] },
      { id: 's3', name: 'w2', role: 'worker', state: 'gone', harness: 'omp', harnessSessionId: '', cwd: '/', channels: ['prog'] },
      { id: 's4', name: 'w3', role: 'worker', state: 'live', harness: 'omp', harnessSessionId: '', cwd: '/', channels: ['other'] },
      { id: 's5', name: 'w4', role: null, state: 'live', harness: 'omp', harnessSessionId: '', cwd: '/', channels: ['prog'] },
    ]
    const channels: Channel[] = [
      { name: 'prog', members: [
        { name: 'lead', role: 'orchestrator', state: 'live', id: 's1' },
        { name: 'w1', role: 'worker', state: 'live', id: 's2' },
        { name: 'w2', role: 'worker', state: 'gone', id: 's3' },
        { name: 'w4', role: null, state: 'live', id: 's5' },
      ], count: 4 },
      { name: 'other', members: [
        { name: 'w3', role: 'worker', state: 'live', id: 's4' },
      ], count: 1 },
    ]
    const workers = sharedWorkers(self, sessions, channels)
    expect(workers.length).toBe(1)
    expect(workers[0].name).toBe('w1')
  })
})

describe('firstOrchestrator', () => {
  test('finds a live orchestrator in the channel', async () => {
    const sessions: Session[] = [
      { id: 's1', name: 'lead', role: 'orchestrator', state: 'live', harness: 'claude', harnessSessionId: '', cwd: '/', channels: ['prog'] },
    ]
    const channels: Channel[] = [
      { name: 'prog', members: [{ name: 'lead', role: 'orchestrator', state: 'live', id: 's1' }], count: 1 },
    ]
    const orch = firstOrchestrator('prog', channels, sessions)
    expect(orch).toBeDefined()
    expect(orch!.name).toBe('lead')
  })

  test('returns undefined when no orchestrator is live', async () => {
    const sessions: Session[] = [
      { id: 's1', name: 'lead', role: 'orchestrator', state: 'gone', harness: 'claude', harnessSessionId: '', cwd: '/', channels: ['prog'] },
    ]
    const channels: Channel[] = [
      { name: 'prog', members: [{ name: 'lead', role: 'orchestrator', state: 'gone', id: 's1' }], count: 1 },
    ]
    expect(firstOrchestrator('prog', channels, sessions)).toBeUndefined()
  })
})

describe('statusLine', () => {
  test('offline', async () => {
    const data: AsenqData = { sessions: [], channels: [], online: false }
    expect(statusLine(data, 'cc-1')).toBe('asenq offline')
  })

  test('unregistered when no matching session', async () => {
    const data: AsenqData = { sessions: [], channels: [], online: true }
    expect(statusLine(data, 'cc-1')).toBe('asenq unregistered')
  })

  test('orchestrator with workers', async () => {
    const data: AsenqData = {
      sessions: [
        { id: 's1', name: 'lead', role: 'orchestrator', state: 'live', harness: 'claude', harnessSessionId: 'cc-1', cwd: '/', channels: ['prog'] },
        { id: 's2', name: 'w1', role: 'worker', state: 'live', harness: 'omp', harnessSessionId: '', cwd: '/', channels: ['prog'] },
        { id: 's3', name: 'w2', role: 'worker', state: 'live', harness: 'omp', harnessSessionId: '', cwd: '/', channels: ['prog'] },
        { id: 's4', name: 'w3', role: 'worker', state: 'live', harness: 'omp', harnessSessionId: '', cwd: '/', channels: ['prog'] },
      ],
      channels: [
        { name: 'prog', members: [
          { name: 'lead', role: 'orchestrator', state: 'live', id: 's1' },
          { name: 'w1', role: 'worker', state: 'live', id: 's2' },
          { name: 'w2', role: 'worker', state: 'live', id: 's3' },
          { name: 'w3', role: 'worker', state: 'live', id: 's4' },
        ], count: 4 },
      ],
      online: true,
    }
    const line = statusLine(data, 'cc-1')
    expect(line).toContain('asenq lead')
    expect(line).toContain('orchestrator')
    expect(line).toContain('3 workers')
    expect(line).toContain('w1')
    expect(line).toContain('w2')
    expect(line).toContain('w3')
  })

  test('orchestrator with 0 workers', async () => {
    const data: AsenqData = {
      sessions: [
        { id: 's1', name: 'lead', role: 'orchestrator', state: 'live', harness: 'claude', harnessSessionId: 'cc-1', cwd: '/', channels: ['prog'] },
      ],
      channels: [
        { name: 'prog', members: [{ name: 'lead', role: 'orchestrator', state: 'live', id: 's1' }], count: 1 },
      ],
      online: true,
    }
    expect(statusLine(data, 'cc-1')).toBe('asenq lead · orchestrator · 0 workers')
  })

  test('worker with channel and orchestrator', async () => {
    const data: AsenqData = {
      sessions: [
        { id: 's1', name: 'lead', role: 'orchestrator', state: 'live', harness: 'claude', harnessSessionId: 'cc-0', cwd: '/', channels: ['prog'] },
        { id: 's2', name: 'w1', role: 'worker', state: 'live', harness: 'claude', harnessSessionId: 'cc-1', cwd: '/', channels: ['prog'] },
      ],
      channels: [
        { name: 'prog', members: [
          { name: 'lead', role: 'orchestrator', state: 'live', id: 's1' },
          { name: 'w1', role: 'worker', state: 'live', id: 's2' },
        ], count: 2 },
      ],
      online: true,
    }
    const line = statusLine(data, 'cc-1')
    expect(line).toBe('asenq w1 · worker · #prog · lead')
  })

  test('worker with multiple channels shows +N', async () => {
    const data: AsenqData = {
      sessions: [
        { id: 's2', name: 'w1', role: 'worker', state: 'live', harness: 'claude', harnessSessionId: 'cc-1', cwd: '/', channels: ['alpha', 'beta', 'gamma'] },
      ],
      channels: [],
      online: true,
    }
    const line = statusLine(data, 'cc-1')
    expect(line).toContain('#alpha +2')
  })

  test('worker without orchestrator in channel', async () => {
    const data: AsenqData = {
      sessions: [
        { id: 's2', name: 'w1', role: 'worker', state: 'live', harness: 'claude', harnessSessionId: 'cc-1', cwd: '/', channels: ['prog'] },
      ],
      channels: [
        { name: 'prog', members: [
          { name: 'w1', role: 'worker', state: 'live', id: 's2' },
        ], count: 1 },
      ],
      online: true,
    }
    const line = statusLine(data, 'cc-1')
    expect(line).toBe('asenq w1 · worker · #prog')
  })

  test('unset role with channel', async () => {
    const data: AsenqData = {
      sessions: [
        { id: 's1', name: 'alice', role: null, state: 'live', harness: 'claude', harnessSessionId: 'cc-1', cwd: '/', channels: ['dev'] },
      ],
      channels: [],
      online: true,
    }
    expect(statusLine(data, 'cc-1')).toBe('asenq alice · #dev')
  })

  test('unset role without channel', async () => {
    const data: AsenqData = {
      sessions: [
        { id: 's1', name: 'alice', role: null, state: 'live', harness: 'claude', harnessSessionId: 'cc-1', cwd: '/', channels: [] },
      ],
      channels: [],
      online: true,
    }
    expect(statusLine(data, 'cc-1')).toBe('asenq alice')
  })
})

// --- Engine integration tests ---

const LS_JSON = JSON.stringify([
  { id: 's1', name: 'lead', role: 'orchestrator', state: 'live', harness: 'claude', harnessSessionId: 'cc-test', cwd: '/', channels: ['prog'] },
  { id: 's2', name: 'w1', role: 'worker', state: 'live', harness: 'omp', harnessSessionId: 'omp-1', cwd: '/', channels: ['prog'] },
])

const CHANNELS_JSON = JSON.stringify([
  { name: 'prog', members: [
    { name: 'lead', role: 'orchestrator', state: 'live', id: 's1' },
    { name: 'w1', role: 'worker', state: 'live', id: 's2' },
  ], count: 2 },
])

const CLI_JSON = JSON.stringify({ argv: ['/usr/bin/node', '/path/to/cli.js'] })

const CMD_RUN = {
  command: 'asenq',
  args: '',
  origin: { kind: 'plugin' as const, name: 'asenq' },
  presentation: { isFullscreen: false, columns: 120 },
}

const PANE_PROPS = {
  title: 'asenq',
  isFocused: false,
  bodyColumns: 120,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
}

function setupMocks(on: any, opts?: { lsJson?: string; channelsJson?: string; failRun?: boolean }) {
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'cc-test' }))
  on('command.register', () => V)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => V)
  on('ui.toast', () => V)
  on('ui.status', () => V)
  on('ui.render', () => ({ type: 'engine', ref: 0 }))

  on('fs.read', (_$: any, e: any) => {
    if (e.path && e.path.endsWith('asenq-cli.json')) return { value: CLI_JSON }
    throw new Error(`unexpected fs.read: ${e.path}`)
  })

  const lsJson = opts?.lsJson ?? LS_JSON
  const channelsJson = opts?.channelsJson ?? CHANNELS_JSON
  const failRun = opts?.failRun ?? false
  const spawnEnds = opts?.spawnEnds ?? false

  on('process.run', (_$: any, e: any) => {
    const args = e.argv.slice(2) // strip the node and cli.js path
    const sub = args.join(' ')
    if (failRun) {
      return { value: { exitCode: 1, stdout: '', stderr: 'daemon not running', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (sub === 'channels --json') {
      return { value: { exitCode: 0, stdout: channelsJson, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (sub === 'ls --json') {
      return { value: { exitCode: 0, stdout: lsJson, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (sub.startsWith('rename') || sub.startsWith('role') || sub.startsWith('channel rename')) {
      return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    return { value: { exitCode: 1, stdout: '', stderr: 'unknown command', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  // process.spawn for tail: exits immediately with code 1
  // The tail retry uses $.clock.after controlled by mock.clock, so no retry fires
  // unless the test advances the clock past the backoff.
  on('process.spawn', async function* () {
    return { value: { code: 1, signal: null } }
  })
}

describe('session.start', () => {
  test('fetches data and sets status on start', async ($, on) => {
    const clock = mock.clock(on)
    const statusCalls: string[] = []

    on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
    on('session.id', () => ({ value: 'cc-test' }))
    on('command.register', () => V)
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('ui.close', () => V)
    on('ui.toast', () => V)
    on('ui.status', (_$: any, e: any) => {
      statusCalls.push(e.text ?? '')
      return V
    })
    on('ui.render', () => ({ type: 'engine', ref: 0 }))
    on('fs.read', (_$: any, e: any) => {
      if (e.path && e.path.endsWith('asenq-cli.json')) return { value: CLI_JSON }
      throw new Error(`unexpected fs.read: ${e.path}`)
    })
    on('process.run', (_$: any, e: any) => {
      const sub = e.argv.slice(2).join(' ')
      if (sub === 'channels --json') {
        return { value: { exitCode: 0, stdout: CHANNELS_JSON, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
      }
      if (sub === 'ls --json') {
        return { value: { exitCode: 0, stdout: LS_JSON, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
      }
      return { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
    // Spawn exits immediately; retry is via clock.after which mock controls
    on('process.spawn', async function* () {
      return { value: { code: 1, signal: null } }
    })

    await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
    await clock.settle()

    // The initial refreshAndStatus sets status before tail starts
    expect(statusCalls.length).toBeGreaterThan(0)
    // First status should be the orchestrator status set during refreshAndStatus
    expect(statusCalls[0]).toContain('asenq lead')
    expect(statusCalls[0]).toContain('orchestrator')
    expect(statusCalls[0]).toContain('1 workers')
  })
})

describe('pane rendering', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`renders session rows and channels on ${surface}`, async ($, on) => {
      const clock = mock.clock(on)
      setupMocks(on)

      await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
      await clock.settle()

      await $.command.run(CMD_RUN)
      await clock.settle()

      const ui = await $.ui.mount({
        plugin: 'asenq',
        surface,
        component: 'Pane',
        requestId: 'asenq',
        props: PANE_PROPS,
      })

      const tree = await ui.drawn()
      expect(tree.type).toBe('Box')

      // Self section
      const leadText = await ui.find({ type: 'Text', text: /lead/ })
      expect(leadText).toBeDefined()

      // Channel section
      const progText = await ui.find({ type: 'Text', text: /#prog/ })
      expect(progText).toBeDefined()

      // Other sessions
      const w1Text = await ui.find({ type: 'Text', text: /w1/ })
      expect(w1Text).toBeDefined()

      // Rename input for lead session
      const renameInput = await ui.find({ type: 'Input', key: 'rename-s1' })
      expect(renameInput).toBeDefined()

      // Role select for lead session
      const roleSelect = await ui.find({ type: 'Select', key: 'role-s1' })
      expect(roleSelect).toBeDefined()

      await ui.unmount()
    })
  }

  test('shows offline message when daemon is down', async ($, on) => {
    const clock = mock.clock(on)
    setupMocks(on, { failRun: true })

    await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
    await clock.settle()

    await $.command.run(CMD_RUN)
    await clock.settle()

    const ui = await $.ui.mount({
      plugin: 'asenq',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'asenq',
      props: PANE_PROPS,
    })

    const offlineText = await ui.find({ type: 'Text', text: /offline/ })
    expect(offlineText).toBeDefined()

    await ui.unmount()
  })
})
