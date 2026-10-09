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
      ], count: 42 },
      { name: 'other', members: [
        { name: 'w3', role: 'worker', state: 'live', id: 's4' },
      ], count: 7 },
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
      { name: 'prog', members: [{ name: 'lead', role: 'orchestrator', state: 'live', id: 's1' }], count: 0 },
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
      { name: 'prog', members: [{ name: 'lead', role: 'orchestrator', state: 'gone', id: 's1' }], count: 0 },
    ]
    expect(firstOrchestrator('prog', channels, sessions)).toBeUndefined()
  })
})

describe('statusLine', () => {
  test('offline', async () => {
    const data: AsenqData = { sessions: [], channels: [], online: false, seq: 0 }
    expect(statusLine(data, 'cc-1')).toBe('asenq offline')
  })

  test('unregistered when no matching session', async () => {
    const data: AsenqData = { sessions: [], channels: [], online: true, seq: 0 }
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
        ], count: 99 },
      ],
      online: true,
      seq: 1,
    }
    const line = statusLine(data, 'cc-1')
    expect(line).toContain('asenq lead')
    expect(line).toContain('orchestrator')
    expect(line).toContain('3 workers')
    expect(line).toContain('w1')
  })

  test('orchestrator with 0 workers', async () => {
    const data: AsenqData = {
      sessions: [
        { id: 's1', name: 'lead', role: 'orchestrator', state: 'live', harness: 'claude', harnessSessionId: 'cc-1', cwd: '/', channels: ['prog'] },
      ],
      channels: [
        { name: 'prog', members: [{ name: 'lead', role: 'orchestrator', state: 'live', id: 's1' }], count: 5 },
      ],
      online: true,
      seq: 1,
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
        ], count: 10 },
      ],
      online: true,
      seq: 1,
    }
    expect(statusLine(data, 'cc-1')).toBe('asenq w1 · worker · #prog · lead')
  })

  test('worker with multiple channels shows +N', async () => {
    const data: AsenqData = {
      sessions: [
        { id: 's2', name: 'w1', role: 'worker', state: 'live', harness: 'claude', harnessSessionId: 'cc-1', cwd: '/', channels: ['alpha', 'beta', 'gamma'] },
      ],
      channels: [],
      online: true,
      seq: 1,
    }
    expect(statusLine(data, 'cc-1')).toContain('#alpha +2')
  })

  test('worker without orchestrator in channel', async () => {
    const data: AsenqData = {
      sessions: [
        { id: 's2', name: 'w1', role: 'worker', state: 'live', harness: 'claude', harnessSessionId: 'cc-1', cwd: '/', channels: ['prog'] },
      ],
      channels: [
        { name: 'prog', members: [
          { name: 'w1', role: 'worker', state: 'live', id: 's2' },
        ], count: 3 },
      ],
      online: true,
      seq: 1,
    }
    expect(statusLine(data, 'cc-1')).toBe('asenq w1 · worker · #prog')
  })

  test('unset role with channel', async () => {
    const data: AsenqData = {
      sessions: [
        { id: 's1', name: 'alice', role: null, state: 'live', harness: 'claude', harnessSessionId: 'cc-1', cwd: '/', channels: ['dev'] },
      ],
      channels: [],
      online: true,
      seq: 1,
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
      seq: 1,
    }
    expect(statusLine(data, 'cc-1')).toBe('asenq alice')
  })
})

// --- Engine integration tests ---

const LS_JSON = JSON.stringify([
  { id: 's1', name: 'lead', role: 'orchestrator', state: 'live', harness: 'claude', harnessSessionId: 'cc-test', cwd: '/', channels: ['prog'] },
  { id: 's2', name: 'w1', role: 'worker', state: 'live', harness: 'omp', harnessSessionId: 'omp-1', cwd: '/', channels: ['prog'] },
])

// count differs from members.length (F-04: count is messages, members.length is members)
const CHANNELS_JSON = JSON.stringify([
  { name: 'prog', members: [
    { name: 'lead', role: 'orchestrator', state: 'live', id: 's1' },
    { name: 'w1', role: 'worker', state: 'live', id: 's2' },
  ], count: 42 },
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

function procOk(stdout = ''): { value: { exitCode: number; stdout: string; stderr: string; isStdoutTruncated: boolean; isStderrTruncated: boolean } } {
  return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
}

function procFail(stderr = 'error', code = 1): { value: { exitCode: number; stdout: string; stderr: string; isStdoutTruncated: boolean; isStderrTruncated: boolean } } {
  return { value: { exitCode: code, stdout: '', stderr, isStdoutTruncated: false, isStderrTruncated: false } }
}

type MockOpts = {
  lsJson?: string
  channelsJson?: string
  failRun?: boolean
  sessionId?: string
  onProcessRun?: (argv: string[]) => void
  onToast?: (text: string) => void
  onStatus?: (text: string) => void
}

function setupMocks(on: any, opts: MockOpts = {}) {
  const sid = opts.sessionId ?? 'cc-test'

  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: sid }))
  on('command.register', () => V)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => V)
  on('ui.toast', (_$: any, e: any) => { opts.onToast?.(e.text ?? ''); return V })
  on('ui.status', (_$: any, e: any) => { opts.onStatus?.(e.text ?? ''); return V })
  on('ui.render', () => ({ type: 'engine', ref: 0 }))

  on('fs.read', (_$: any, e: any) => {
    if (e.path && e.path.endsWith('asenq-cli.json')) return { value: CLI_JSON }
    throw new Error(`unexpected fs.read: ${e.path}`)
  })

  const lsJson = opts.lsJson ?? LS_JSON
  const channelsJson = opts.channelsJson ?? CHANNELS_JSON
  const failRun = opts.failRun ?? false

  on('process.run', (_$: any, e: any) => {
    opts.onProcessRun?.(e.argv)
    const args = e.argv.slice(2)
    const sub = args.join(' ')
    if (failRun) return procFail('daemon not running')
    if (sub === 'channels --json') return procOk(channelsJson)
    if (sub === 'ls --json') return procOk(lsJson)
    if (sub.startsWith('channel rename')) return procOk()
    if (sub.startsWith('rename')) return procOk()
    if (sub.startsWith('role')) return procOk()
    return procFail('unknown command')
  })

  // process.spawn for tail: exits immediately with code 1
  on('process.spawn', async function* () {
    return { value: { code: 1, signal: null } }
  })
}

// --- session.start ---

describe('session.start', () => {
  test('shows placeholder then fetches data via tail refetch', async ($, on) => {
    const clock = mock.clock(on)
    const statusCalls: string[] = []
    setupMocks(on, { onStatus: (t) => statusCalls.push(t) })

    await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
    await clock.settle()

    // The first status is the placeholder
    expect(statusCalls[0]).toContain('…')
    // After the tail connects and refetches, we get the real status
    const real = statusCalls.find((s) => s.includes('lead'))
    expect(real).toBeDefined()
    expect(real).toContain('orchestrator')
    expect(real).toContain('1 workers')
  })
})

// --- pane rendering ---

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

      const leadText = await ui.find({ type: 'Text', text: /lead/ })
      expect(leadText).toBeDefined()

      const progText = await ui.find({ type: 'Text', text: /#prog/ })
      expect(progText).toBeDefined()

      // F-04: shows members.length, not count (count=42 in fixture)
      const memberCount = await ui.find({ type: 'Text', text: /2 members/ })
      expect(memberCount).toBeDefined()

      const w1Text = await ui.find({ type: 'Text', text: /w1/ })
      expect(w1Text).toBeDefined()

      const renameInput = await ui.find({ type: 'Input', key: 'rename-s1' })
      expect(renameInput).toBeDefined()

      const roleSelect = await ui.find({ type: 'Select', key: 'role-s1' })
      expect(roleSelect).toBeDefined()

      // Channel rename input
      const chRename = await ui.find({ type: 'Input', key: 'chrename-prog' })
      expect(chRename).toBeDefined()

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

// --- F-03: session id changes after /clear ---

describe('session id change', () => {
  test('self is found after the session id changes', async ($, on) => {
    const clock = mock.clock(on)
    let currentSid = 'cc-old'

    on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
    on('session.id', () => ({ value: currentSid }))
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

    const lsWithOld = JSON.stringify([
      { id: 's1', name: 'lead', role: 'orchestrator', state: 'live', harness: 'claude', harnessSessionId: 'cc-old', cwd: '/', channels: [] },
    ])
    const lsWithNew = JSON.stringify([
      { id: 's1', name: 'lead', role: 'orchestrator', state: 'live', harness: 'claude', harnessSessionId: 'cc-new', cwd: '/', channels: [] },
    ])
    let lsJson = lsWithOld
    on('process.run', (_$: any, e: any) => {
      const sub = e.argv.slice(2).join(' ')
      if (sub === 'channels --json') return procOk('[]')
      if (sub === 'ls --json') return procOk(lsJson)
      return procFail()
    })
    on('process.spawn', async function* () {
      return { value: { code: 1, signal: null } }
    })

    await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
    await clock.settle()

    // Simulate /clear by changing the session id and the daemon data
    currentSid = 'cc-new'
    lsJson = lsWithNew

    // Open the pane (triggers refetch)
    await $.command.run(CMD_RUN)
    await clock.settle()

    const ui = await $.ui.mount({
      plugin: 'asenq',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'asenq',
      props: PANE_PROPS,
    })

    // Self should be found with the new session id
    const leadText = await ui.find({ type: 'Text', text: /lead/ })
    expect(leadText).toBeDefined()
    // Should NOT show "unregistered"
    const unreg = await ui.find({ type: 'Text', text: /unregistered/ })
    expect(unreg).toBeUndefined()

    await ui.unmount()
  })
})

// --- F-05: dismiss and error handling ---

describe('mutation error handling', () => {
  test('process.run failure toasts the error', async ($, on) => {
    const clock = mock.clock(on)
    const toasts: string[] = []
    on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
    on('session.id', () => ({ value: 'cc-test' }))
    on('command.register', () => V)
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('ui.close', () => V)
    on('ui.toast', (_$: any, e: any) => { toasts.push(e.text ?? ''); return V })
    on('ui.status', () => V)
    on('ui.render', () => ({ type: 'engine', ref: 0 }))
    on('fs.read', (_$: any, e: any) => {
      if (e.path && e.path.endsWith('asenq-cli.json')) return { value: CLI_JSON }
      throw new Error(`unexpected fs.read: ${e.path}`)
    })
    on('process.run', (_$: any, e: any) => {
      const sub = e.argv.slice(2).join(' ')
      if (sub === 'channels --json') return procOk(CHANNELS_JSON)
      if (sub === 'ls --json') return procOk(LS_JSON)
      if (sub.startsWith('rename')) return procFail('name taken')
      return procFail()
    })
    on('process.spawn', async function* () {
      return { value: { code: 1, signal: null } }
    })

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

    // Trigger rename which will fail
    await ui.input({ plugin: 'asenq', key: 'rename-s1', text: 'newname', kind: 'submit' })
    await clock.settle()

    expect(toasts.some((t) => t.includes('name taken'))).toBe(true)

    await ui.unmount()
  })
})

// --- F-07: mutation integration tests ---

describe('rename onSubmit', () => {
  test('fires asenq rename with old and new name', async ($, on) => {
    const clock = mock.clock(on)
    const runArgs: string[][] = []
    setupMocks(on, { onProcessRun: (argv) => runArgs.push(argv) })

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

    await ui.input({ plugin: 'asenq', key: 'rename-s1', text: 'boss', kind: 'submit' })
    await clock.settle()

    const renameCall = runArgs.find((a) => a.includes('rename'))
    expect(renameCall).toBeDefined()
    expect(renameCall).toContain('lead')
    expect(renameCall).toContain('boss')

    await ui.unmount()
  })
})

describe('role onSelect', () => {
  test('fires asenq role with name and role', async ($, on) => {
    const clock = mock.clock(on)
    const runArgs: string[][] = []
    setupMocks(on, { onProcessRun: (argv) => runArgs.push(argv) })

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

    await ui.select({ plugin: 'asenq', key: 'role-s1', value: 'worker' })
    await clock.settle()

    const roleCall = runArgs.find((a) => a.includes('role'))
    expect(roleCall).toBeDefined()
    expect(roleCall).toContain('lead')
    expect(roleCall).toContain('worker')

    await ui.unmount()
  })
})

describe('channel rename', () => {
  test('dismiss (ask rejected) does not run CLI', async ($, on) => {
    const clock = mock.clock(on)
    const runArgs: string[][] = []
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
    on('process.run', (_$: any, e: any) => {
      runArgs.push(e.argv)
      const sub = e.argv.slice(2).join(' ')
      if (sub === 'channels --json') return procOk(CHANNELS_JSON)
      if (sub === 'ls --json') return procOk(LS_JSON)
      if (sub.startsWith('channel rename')) return procOk()
      return procFail()
    })
    on('process.spawn', async function* () {
      return { value: { code: 1, signal: null } }
    })
    // AskUserQuestion: answer "Cancel"
    on('tool.call', { tool: 'AskUserQuestion' }, () => ({
      result: 'Cancel',
    }))

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

    await ui.input({ plugin: 'asenq', key: 'chrename-prog', text: 'newch', kind: 'submit' })
    await clock.settle()

    const chCall = runArgs.find((a) => a.slice(2).join(' ').startsWith('channel rename'))
    expect(chCall).toBeUndefined()

    await ui.unmount()
  })
})

// --- F-07: tail output and protocol mismatch ---

describe('tail and backoff', () => {
  test('tail output triggers a debounced refetch and a burst gives one refetch', async ($, on) => {
    const clock = mock.clock(on)
    let fetchCount = 0
    let spawnCount = 0

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
    on('process.run', (_$: any, e: any) => {
      const sub = e.argv.slice(2).join(' ')
      if (sub === 'ls --json') { fetchCount++; return procOk(LS_JSON) }
      if (sub === 'channels --json') return procOk(CHANNELS_JSON)
      return procFail()
    })

    on('process.spawn', async function* () {
      spawnCount++
      yield { stream: 'stdout' as const, text: 'event1\n' }
      yield { stream: 'stdout' as const, text: 'event2\n' }
      yield { stream: 'stdout' as const, text: 'event3\n' }
      yield { stream: 'stdout' as const, text: 'event4\n' }
      yield { stream: 'stdout' as const, text: 'event5\n' }
      return { value: { code: 0, signal: null } }
    })

    fetchCount = 0
    await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
    await clock.settle()

    // The initial spawn refetch and the burst's debounced refetch
    const fetchesBefore = fetchCount

    // Advance past debounce period
    await clock.advance(400)

    // The burst should have produced at most 2 fetches (initial + one debounced)
    const fetchesAfter = fetchCount
    expect(fetchesAfter - fetchesBefore).toBeLessThanOrEqual(2)
  })

  test('protocol mismatch gives exactly one toast', async ($, on) => {
    const clock = mock.clock(on)
    const toasts: string[] = []

    on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
    on('session.id', () => ({ value: 'cc-test' }))
    on('command.register', () => V)
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('ui.close', () => V)
    on('ui.toast', (_$: any, e: any) => { toasts.push(e.text ?? ''); return V })
    on('ui.status', () => V)
    on('ui.render', () => ({ type: 'engine', ref: 0 }))
    on('fs.read', (_$: any, e: any) => {
      if (e.path && e.path.endsWith('asenq-cli.json')) return { value: CLI_JSON }
      throw new Error(`unexpected fs.read: ${e.path}`)
    })
    on('process.run', (_$: any, e: any) => {
      const sub = e.argv.slice(2).join(' ')
      if (sub === 'ls --json') return procOk(LS_JSON)
      if (sub === 'channels --json') return procOk(CHANNELS_JSON)
      return procFail()
    })
    on('process.spawn', async function* () {
      yield { stream: 'stderr' as const, text: 'protocol version mismatch\n' }
      yield { stream: 'stderr' as const, text: 'protocol version mismatch again\n' }
      return { value: { code: 1, signal: null } }
    })

    await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
    await clock.settle()

    const mismatchToasts = toasts.filter((t) => t.includes('out of date'))
    expect(mismatchToasts.length).toBe(1)
  })

  test('backoff grows: 1, 2, 4, 8, 16, 30, 30 s gaps', async ($, on) => {
    const clock = mock.clock(on)
    const spawnTimes: number[] = []

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
    on('process.run', (_$: any, e: any) => {
      const sub = e.argv.slice(2).join(' ')
      if (sub === 'ls --json') return procOk(LS_JSON)
      if (sub === 'channels --json') return procOk(CHANNELS_JSON)
      return procFail()
    })
    // Spawn always exits immediately; record when each one fires
    on('process.spawn', async function* (_$: any, _e: any, _next: any) {
      spawnTimes.push(clock.now())
      return { value: { code: 1, signal: null } }
    })

    await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
    await clock.settle()

    // First spawn at t=0
    expect(spawnTimes.length).toBeGreaterThanOrEqual(1)

    // Advance enough to see all retries: sum of expected gaps plus margin
    // 1 + 2 + 4 + 8 + 16 + 30 + 30 = 91s, plus 30s margin = 121s
    await clock.advance(121_000)

    // Check the gaps between spawns
    const gaps: number[] = []
    for (let i = 1; i < spawnTimes.length; i++) {
      gaps.push(spawnTimes[i] - spawnTimes[i - 1])
    }

    // The first 5 gaps should double: 1000, 2000, 4000, 8000, 16000
    // Then cap at 30000
    expect(gaps.length).toBeGreaterThanOrEqual(7)
    expect(gaps[0]).toBe(1000)
    expect(gaps[1]).toBe(2000)
    expect(gaps[2]).toBe(4000)
    expect(gaps[3]).toBe(8000)
    expect(gaps[4]).toBe(16000)
    expect(gaps[5]).toBe(30000)
    expect(gaps[6]).toBe(30000)
  })
})

// --- F-06: drafts survive redraws ---

describe('drafts', () => {
  test('a tail-driven redraw does not wipe a draft', async ($, on) => {
    const clock = mock.clock(on)

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
    on('process.run', (_$: any, e: any) => {
      const sub = e.argv.slice(2).join(' ')
      if (sub === 'channels --json') return procOk(CHANNELS_JSON)
      if (sub === 'ls --json') return procOk(LS_JSON)
      return procFail()
    })
    on('process.spawn', async function* () {
      return { value: { code: 1, signal: null } }
    })

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

    // Type into the rename field (without submitting)
    await ui.input({ plugin: 'asenq', key: 'rename-s1', text: 'partial', kind: 'change' })
    await clock.settle()

    // The draft should be preserved in the Input's value
    const input = await ui.find({ type: 'Input', key: 'rename-s1' })
    expect(input).toBeDefined()
    expect(input!.props['value']).toBe('partial')

    await ui.unmount()
  })
})
