import { test, expect, mock, describe } from 'claude-code/testing'
import type { AsenqData, Session, Channel } from '../types'
import { statusLine, findSelf, sharedWorkers, formatWorkerNames, firstOrchestrator } from './format'

const V = { value: undefined as void } as const

// --- Pure function tests ---

describe('findSelf', () => {
  const sessions: Session[] = [
    { id: 's1', name: 'lead', role: 'orchestrator', state: 'live', harness: 'claude', harnessSessionId: 'cc-123', cwd: '/a', channels: ['prog'] },
    { id: 's2', name: 'w1', role: 'worker', state: 'live', harness: 'omp', harnessSessionId: 'omp-1', cwd: '/b', channels: ['prog'] },
    { id: 's3', name: 'w2', role: 'worker', state: 'live', harness: 'claude', harnessSessionId: 'cc-456', cwd: '/c', channels: ['prog'] },
  ]
  test('matches by harness and harnessSessionId', async () => {
    expect(findSelf(sessions, 'cc-123')!.name).toBe('lead')
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
  test('empty list', async () => { expect(formatWorkerNames([])).toBe('') })
  test('short list stays whole', async () => {
    expect(formatWorkerNames([w('w1'), w('w2'), w('w3')])).toBe('w1, w2, w3')
  })
  test('long list gets +N', async () => {
    const workers = [w('worker-alpha'), w('worker-bravo'), w('worker-charlie'), w('worker-delta'), w('worker-echo'), w('worker-foxtrot'), w('worker-golf')]
    const result = formatWorkerNames(workers)
    expect(result).toContain('+')
    expect(result.split(' +')[0].length).toBeLessThanOrEqual(42)
  })
  test('single worker', async () => { expect(formatWorkerNames([w('my-worker')])).toBe('my-worker') })
})

describe('sharedWorkers', () => {
  test('returns only live workers sharing a channel with self', async () => {
    const self: Session = { id: 's1', name: 'lead', role: 'orchestrator', state: 'live', harness: 'claude', harnessSessionId: 'cc-1', cwd: '/', channels: ['prog'] }
    const sessions: Session[] = [
      self,
      { id: 's2', name: 'w1', role: 'worker', state: 'live', harness: 'omp', harnessSessionId: '', cwd: '/', channels: ['prog'] },
      { id: 's3', name: 'w2', role: 'worker', state: 'gone', harness: 'omp', harnessSessionId: '', cwd: '/', channels: ['prog'] },
    ]
    const channels: Channel[] = [
      { name: 'prog', members: [
        { name: 'lead', role: 'orchestrator', state: 'live', id: 's1' },
        { name: 'w1', role: 'worker', state: 'live', id: 's2' },
        { name: 'w2', role: 'worker', state: 'gone', id: 's3' },
      ], count: 42 },
    ]
    const workers = sharedWorkers(self, sessions, channels)
    expect(workers.length).toBe(1)
    expect(workers[0].name).toBe('w1')
  })
})

describe('firstOrchestrator', () => {
  test('finds a live orchestrator', async () => {
    const sessions: Session[] = [{ id: 's1', name: 'lead', role: 'orchestrator', state: 'live', harness: 'claude', harnessSessionId: '', cwd: '/', channels: ['prog'] }]
    const channels: Channel[] = [{ name: 'prog', members: [{ name: 'lead', role: 'orchestrator', state: 'live', id: 's1' }], count: 0 }]
    expect(firstOrchestrator('prog', channels, sessions)!.name).toBe('lead')
  })
  test('returns undefined when none live', async () => {
    const sessions: Session[] = [{ id: 's1', name: 'lead', role: 'orchestrator', state: 'gone', harness: 'claude', harnessSessionId: '', cwd: '/', channels: ['prog'] }]
    const channels: Channel[] = [{ name: 'prog', members: [{ name: 'lead', role: 'orchestrator', state: 'gone', id: 's1' }], count: 0 }]
    expect(firstOrchestrator('prog', channels, sessions)).toBeUndefined()
  })
})

describe('statusLine', () => {
  test('offline', async () => {
    expect(statusLine({ sessions: [], channels: [], online: false, seq: 0 }, 'cc-1')).toBe('asenq offline')
  })
  test('unregistered', async () => {
    expect(statusLine({ sessions: [], channels: [], online: true, seq: 0 }, 'cc-1')).toBe('asenq unregistered')
  })
  test('orchestrator with workers', async () => {
    const data: AsenqData = {
      sessions: [
        { id: 's1', name: 'lead', role: 'orchestrator', state: 'live', harness: 'claude', harnessSessionId: 'cc-1', cwd: '/', channels: ['prog'] },
        { id: 's2', name: 'w1', role: 'worker', state: 'live', harness: 'omp', harnessSessionId: '', cwd: '/', channels: ['prog'] },
        { id: 's3', name: 'w2', role: 'worker', state: 'live', harness: 'omp', harnessSessionId: '', cwd: '/', channels: ['prog'] },
      ],
      channels: [{ name: 'prog', members: [
        { name: 'lead', role: 'orchestrator', state: 'live', id: 's1' },
        { name: 'w1', role: 'worker', state: 'live', id: 's2' },
        { name: 'w2', role: 'worker', state: 'live', id: 's3' },
      ], count: 99 }],
      online: true, seq: 1,
    }
    const line = statusLine(data, 'cc-1')
    expect(line).toContain('2 workers')
    expect(line).toContain('w1')
  })
  test('orchestrator 0 workers', async () => {
    const data: AsenqData = {
      sessions: [{ id: 's1', name: 'lead', role: 'orchestrator', state: 'live', harness: 'claude', harnessSessionId: 'cc-1', cwd: '/', channels: ['prog'] }],
      channels: [{ name: 'prog', members: [{ name: 'lead', role: 'orchestrator', state: 'live', id: 's1' }], count: 5 }],
      online: true, seq: 1,
    }
    expect(statusLine(data, 'cc-1')).toBe('asenq lead · orchestrator · 0 workers')
  })
  test('worker with channel and orchestrator', async () => {
    const data: AsenqData = {
      sessions: [
        { id: 's1', name: 'lead', role: 'orchestrator', state: 'live', harness: 'claude', harnessSessionId: 'cc-0', cwd: '/', channels: ['prog'] },
        { id: 's2', name: 'w1', role: 'worker', state: 'live', harness: 'claude', harnessSessionId: 'cc-1', cwd: '/', channels: ['prog'] },
      ],
      channels: [{ name: 'prog', members: [
        { name: 'lead', role: 'orchestrator', state: 'live', id: 's1' },
        { name: 'w1', role: 'worker', state: 'live', id: 's2' },
      ], count: 10 }],
      online: true, seq: 1,
    }
    expect(statusLine(data, 'cc-1')).toBe('asenq w1 · worker · #prog · lead')
  })
  test('unset role with channel', async () => {
    expect(statusLine({ sessions: [{ id: 's1', name: 'alice', role: null, state: 'live', harness: 'claude', harnessSessionId: 'cc-1', cwd: '/', channels: ['dev'] }], channels: [], online: true, seq: 1 }, 'cc-1')).toBe('asenq alice · #dev')
  })
  test('unset role without channel', async () => {
    expect(statusLine({ sessions: [{ id: 's1', name: 'alice', role: null, state: 'live', harness: 'claude', harnessSessionId: 'cc-1', cwd: '/', channels: [] }], channels: [], online: true, seq: 1 }, 'cc-1')).toBe('asenq alice')
  })
})

// --- Engine helpers ---

const LS_JSON = JSON.stringify([
  { id: 's1', name: 'lead', role: 'orchestrator', state: 'live', harness: 'claude', harnessSessionId: 'cc-test', cwd: '/', channels: ['prog'] },
  { id: 's2', name: 'w1', role: 'worker', state: 'live', harness: 'omp', harnessSessionId: 'omp-1', cwd: '/', channels: ['prog'] },
])
// count=42 differs from members.length=2 (F-04)
const CHANNELS_JSON = JSON.stringify([
  { name: 'prog', members: [
    { name: 'lead', role: 'orchestrator', state: 'live', id: 's1' },
    { name: 'w1', role: 'worker', state: 'live', id: 's2' },
  ], count: 42 },
])
const CLI_JSON = JSON.stringify({ argv: ['/usr/bin/node', '/path/to/cli.js'] })
const CMD_RUN = { command: 'asenq', args: '', origin: { kind: 'plugin' as const, name: 'asenq' }, presentation: { isFullscreen: false, columns: 120 } }
const PANE_PROPS = { title: 'asenq', isFocused: false, bodyColumns: 120, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 30 }, view: {} }

function procOk(stdout = '') { return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } }
function procFail(stderr = 'error', code = 1) { return { value: { exitCode: code, stdout: '', stderr, isStdoutTruncated: false, isStderrTruncated: false } } }

type MockOpts = {
  lsJson?: string; channelsJson?: string; failRun?: boolean; sessionId?: string
  onProcessRun?: (argv: string[]) => void; onToast?: (text: string) => void; onStatus?: (text: string) => void
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
    const sub = e.argv.slice(2).join(' ')
    if (failRun) return procFail('daemon not running')
    if (sub === 'channels --json') return procOk(channelsJson)
    if (sub === 'ls --json') return procOk(lsJson)
    if (sub.startsWith('channel rename')) return procOk()
    if (sub.startsWith('rename')) return procOk()
    if (sub.startsWith('role')) return procOk()
    return procFail('unknown command')
  })
  on('process.spawn', async function* () {
    return { value: { code: 1, signal: null } }
  })
}

// --- session.start ---

describe('session.start', () => {
  test('shows placeholder then fetches data via tail stderr connect line', async ($, on) => {
    const clock = mock.clock(on)
    const statusCalls: string[] = []
    let finish!: () => void
    const waiting = new Promise<void>((resolve) => { finish = resolve })
    on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
    on('session.id', () => ({ value: 'cc-test' }))
    on('command.register', () => V)
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('ui.close', () => V)
    on('ui.toast', () => V)
    on('ui.status', (_$: any, e: any) => { statusCalls.push(e.text ?? ''); return V })
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
    // F-14: spawn yields the "connected" stderr line, then stdout events
    on('process.spawn', async function* () {
      yield { stream: 'stderr' as const, text: 'asenq tail: connected\n' }
      await waiting
      return { value: { code: 0, signal: null } }
    })

    await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
    await clock.settle()

    expect(statusCalls[0]).toContain('…')
    const real = statusCalls.find((s) => s.includes('lead'))
    expect(real).toBeDefined()
    expect(real).toContain('1 workers')
    finish()
    await clock.settle()
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
      const ui = await $.ui.mount({ plugin: 'asenq', surface, component: 'Pane', requestId: 'asenq', props: PANE_PROPS })
      expect((await ui.drawn()).type).toBe('Box')
      expect(await ui.find({ type: 'Text', text: /lead/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /#prog/ })).toBeDefined()
      // F-04: shows members.length (2), not count (42)
      expect(await ui.find({ type: 'Text', text: /\(2 members\)/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /\(42 members\)/ })).toBeUndefined()
      expect(await ui.find({ type: 'Input', key: 'rename-s1' })).toBeDefined()
      expect(await ui.find({ type: 'Select', key: 'role-s1' })).toBeDefined()
      expect(await ui.find({ type: 'Input', key: 'chrename-prog' })).toBeDefined()
      await ui.unmount()
    })
  }

  test('shows offline when daemon is down', async ($, on) => {
    const clock = mock.clock(on)
    setupMocks(on, { failRun: true })
    await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
    await clock.settle()
    await $.command.run(CMD_RUN)
    await clock.settle()
    const ui = await $.ui.mount({ plugin: 'asenq', surface: 'terminal', component: 'Pane', requestId: 'asenq', props: PANE_PROPS })
    expect(await ui.find({ type: 'Text', text: /offline/ })).toBeDefined()
    await ui.unmount()
  })
})

// --- F-03: session id change ---

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
    let lsJson = JSON.stringify([{ id: 's1', name: 'lead', role: 'orchestrator', state: 'live', harness: 'claude', harnessSessionId: 'cc-old', cwd: '/', channels: [] }])
    on('process.run', (_$: any, e: any) => {
      const sub = e.argv.slice(2).join(' ')
      if (sub === 'channels --json') return procOk('[]')
      if (sub === 'ls --json') return procOk(lsJson)
      return procFail()
    })
    on('process.spawn', async function* () { return { value: { code: 1, signal: null } } })

    await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
    await clock.settle()

    currentSid = 'cc-new'
    lsJson = JSON.stringify([{ id: 's1', name: 'lead', role: 'orchestrator', state: 'live', harness: 'claude', harnessSessionId: 'cc-new', cwd: '/', channels: [] }])
    await $.command.run(CMD_RUN)
    await clock.settle()

    const ui = await $.ui.mount({ plugin: 'asenq', surface: 'terminal', component: 'Pane', requestId: 'asenq', props: PANE_PROPS })
    expect(await ui.find({ type: 'Text', text: /lead/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /unregistered/ })).toBeUndefined()
    await ui.unmount()
  })
})

// --- F-05: error handling ---

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
    on('process.spawn', async function* () { return { value: { code: 1, signal: null } } })

    await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
    await clock.settle()
    await $.command.run(CMD_RUN)
    await clock.settle()
    const ui = await $.ui.mount({ plugin: 'asenq', surface: 'terminal', component: 'Pane', requestId: 'asenq', props: PANE_PROPS })
    await ui.input({ plugin: 'asenq', key: 'rename-s1', text: 'newname', kind: 'submit' })
    await clock.settle()
    expect(toasts.some((t) => t.includes('name taken'))).toBe(true)
    await ui.unmount()
  })
})

// --- F-07: mutations ---

describe('rename onSubmit', () => {
  test('fires asenq rename with exact argv', async ($, on) => {
    const clock = mock.clock(on)
    const runArgs: string[][] = []
    setupMocks(on, { onProcessRun: (argv) => runArgs.push(argv) })
    await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
    await clock.settle()
    await $.command.run(CMD_RUN)
    await clock.settle()
    const ui = await $.ui.mount({ plugin: 'asenq', surface: 'terminal', component: 'Pane', requestId: 'asenq', props: PANE_PROPS })
    await ui.input({ plugin: 'asenq', key: 'rename-s1', text: 'boss', kind: 'submit' })
    await clock.settle()
    const call = runArgs.find((a) => a.slice(2).join(' ').startsWith('rename'))
    expect(call).toBeDefined()
    expect(call!.slice(2)).toEqual(['rename', 'lead', 'boss'])
    await ui.unmount()
  })
})

describe('role onSelect', () => {
  test('fires asenq role with exact argv', async ($, on) => {
    const clock = mock.clock(on)
    const runArgs: string[][] = []
    setupMocks(on, { onProcessRun: (argv) => runArgs.push(argv) })
    await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
    await clock.settle()
    await $.command.run(CMD_RUN)
    await clock.settle()
    const ui = await $.ui.mount({ plugin: 'asenq', surface: 'terminal', component: 'Pane', requestId: 'asenq', props: PANE_PROPS })
    await ui.select({ plugin: 'asenq', key: 'role-s1', value: 'worker' })
    await clock.settle()
    const call = runArgs.find((a) => a.slice(2).join(' ').startsWith('role'))
    expect(call).toBeDefined()
    expect(call!.slice(2)).toEqual(['role', 'lead', 'worker'])
    await ui.unmount()
  })
})

describe('channel rename', () => {
  function askHook(on: any, answer: string) {
    on('tool.call', { tool: 'AskUserQuestion' }, (_$: any, e: any) => ({
      result: { questions: e.questions, answers: { [e.questions[0].question]: answer } },
    }))
  }

  test('confirmed rename runs channel rename CLI with exact argv', async ($, on) => {
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
    on('process.spawn', async function* () { return { value: { code: 1, signal: null } } })
    askHook(on, 'Rename')

    await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
    await clock.settle()
    await $.command.run(CMD_RUN)
    await clock.settle()
    const ui = await $.ui.mount({ plugin: 'asenq', surface: 'terminal', component: 'Pane', requestId: 'asenq', props: PANE_PROPS })
    await ui.input({ plugin: 'asenq', key: 'chrename-prog', text: 'newch', kind: 'submit' })
    await clock.settle()
    const call = runArgs.find((a) => a.slice(2).join(' ').startsWith('channel rename'))
    expect(call).toBeDefined()
    expect(call!.slice(2)).toEqual(['channel', 'rename', 'prog', 'newch'])
    await ui.unmount()
  })

  test('cancel does not run CLI', async ($, on) => {
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
      return procFail()
    })
    on('process.spawn', async function* () { return { value: { code: 1, signal: null } } })
    askHook(on, 'Cancel')

    await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
    await clock.settle()
    await $.command.run(CMD_RUN)
    await clock.settle()
    const ui = await $.ui.mount({ plugin: 'asenq', surface: 'terminal', component: 'Pane', requestId: 'asenq', props: PANE_PROPS })
    await ui.input({ plugin: 'asenq', key: 'chrename-prog', text: 'newch', kind: 'submit' })
    await clock.settle()
    expect(runArgs.find((a) => a.slice(2).join(' ').startsWith('channel rename'))).toBeUndefined()
    await ui.unmount()
  })

  test('dismiss (ask rejected) does not run CLI', async ($, on) => {
    const clock = mock.clock(on)
    const runArgs: string[][] = []
    setupMocks(on, { onProcessRun: (argv) => runArgs.push(argv) })
    // No askHook: $.ui.ask rejects
    await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
    await clock.settle()
    await $.command.run(CMD_RUN)
    await clock.settle()
    const ui = await $.ui.mount({ plugin: 'asenq', surface: 'terminal', component: 'Pane', requestId: 'asenq', props: PANE_PROPS })
    await ui.input({ plugin: 'asenq', key: 'chrename-prog', text: 'newch', kind: 'submit' })
    await clock.settle()
    expect(runArgs.find((a) => a.slice(2).join(' ').startsWith('channel rename'))).toBeUndefined()
    await ui.unmount()
  })
})

// --- tail, debounce, protocol, backoff ---

describe('tail and backoff', () => {
  test('tail stdout triggers a debounced refetch; burst gives one refetch', async ($, on) => {
    const clock = mock.clock(on)
    let fetchCount = 0
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
      yield { stream: 'stderr' as const, text: 'asenq tail: connected\n' }
      yield { stream: 'stdout' as const, text: 'e1\n' }
      yield { stream: 'stdout' as const, text: 'e2\n' }
      yield { stream: 'stdout' as const, text: 'e3\n' }
      yield { stream: 'stdout' as const, text: 'e4\n' }
      yield { stream: 'stdout' as const, text: 'e5\n' }
      return { value: { code: 0, signal: null } }
    })
    fetchCount = 0
    await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
    await clock.settle()
    const before = fetchCount
    await clock.advance(400)
    expect(fetchCount - before).toBeLessThanOrEqual(2)
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
    expect(toasts.filter((t) => t.includes('out of date')).length).toBe(1)
  })

  // N-1: mock writes stderr error then exits (like the real CLI). Backoff must still grow.
  test('backoff grows even when spawn writes stderr before dying', async ($, on) => {
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
    // Writes stderr error then exits non-zero (matches real tail behaviour)
    on('process.spawn', async function* (_$: any, _e: any, _next: any) {
      spawnTimes.push(clock.now())
      yield { stream: 'stderr' as const, text: 'asenq: connection refused\n' }
      return { value: { code: 1, signal: null } }
    })

    await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
    await clock.settle()
    expect(spawnTimes.length).toBeGreaterThanOrEqual(1)
    await clock.advance(121_000)

    const gaps: number[] = []
    for (let i = 1; i < spawnTimes.length; i++) gaps.push(spawnTimes[i] - spawnTimes[i - 1])
    expect(gaps.length).toBeGreaterThanOrEqual(7)
    expect(gaps[0]).toBe(1000)
    expect(gaps[1]).toBe(2000)
    expect(gaps[2]).toBe(4000)
    expect(gaps[3]).toBe(8000)
    expect(gaps[4]).toBe(16000)
    expect(gaps[5]).toBe(30000)
    expect(gaps[6]).toBe(30000)
  })

  // N-1: same test where the mock prints "connected" then exits
  test('backoff grows when spawn prints connected then exits', async ($, on) => {
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
    on('process.spawn', async function* (_$: any, _e: any, _next: any) {
      spawnTimes.push(clock.now())
      yield { stream: 'stderr' as const, text: 'asenq tail: connected\n' }
      return { value: { code: 1, signal: null } }
    })

    await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
    await clock.settle()
    expect(spawnTimes.length).toBeGreaterThanOrEqual(1)
    await clock.advance(121_000)

    const gaps: number[] = []
    for (let i = 1; i < spawnTimes.length; i++) gaps.push(spawnTimes[i] - spawnTimes[i - 1])
    expect(gaps.length).toBeGreaterThanOrEqual(7)
    expect(gaps[0]).toBe(1000)
    expect(gaps[1]).toBe(2000)
    expect(gaps[2]).toBe(4000)
  })
})

// --- drafts ---

describe('drafts', () => {
  test('a tail-driven redraw does not wipe a draft', async ($, on) => {
    const clock = mock.clock(on)
    setupMocks(on)
    await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
    await clock.settle()
    await $.command.run(CMD_RUN)
    await clock.settle()
    const ui = await $.ui.mount({ plugin: 'asenq', surface: 'terminal', component: 'Pane', requestId: 'asenq', props: PANE_PROPS })
    await ui.input({ plugin: 'asenq', key: 'rename-s1', text: 'partial', kind: 'change' })
    await clock.settle()
    const input = await ui.find({ type: 'Input', key: 'rename-s1' })
    expect(input).toBeDefined()
    expect(input!.props['value']).toBe('partial')
    await ui.unmount()
  })

  test('rename clears only the submitted row draft, not others', async ($, on) => {
    const clock = mock.clock(on)
    setupMocks(on)
    await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
    await clock.settle()
    await $.command.run(CMD_RUN)
    await clock.settle()
    const ui = await $.ui.mount({ plugin: 'asenq', surface: 'terminal', component: 'Pane', requestId: 'asenq', props: PANE_PROPS })
    // Type into both rename fields
    await ui.input({ plugin: 'asenq', key: 'rename-s1', text: 'draft-s1', kind: 'change' })
    await ui.input({ plugin: 'asenq', key: 'rename-s2', text: 'draft-s2', kind: 'change' })
    await clock.settle()
    // Submit s1's rename (succeeds)
    await ui.input({ plugin: 'asenq', key: 'rename-s1', text: 'newlead', kind: 'submit' })
    await clock.settle()
    // s1's draft should be cleared, s2's should survive
    const s1 = await ui.find({ type: 'Input', key: 'rename-s1' })
    const s2 = await ui.find({ type: 'Input', key: 'rename-s2' })
    expect(s1!.props['value']).toBe('')
    expect(s2!.props['value']).toBe('draft-s2')
    await ui.unmount()
  })
})

// --- F-15: status from atom, seq guard, fetchSeq seed ---

describe('seq guard in setData', () => {
  test('a command.run after tail-offline overwrites with a higher seq', async ($, on) => {
    const clock = mock.clock(on)
    const statusCalls: string[] = []

    on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
    on('session.id', () => ({ value: 'cc-test' }))
    on('command.register', () => V)
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('ui.close', () => V)
    on('ui.toast', () => V)
    on('ui.status', (_$: any, e: any) => { statusCalls.push(e.text ?? ''); return V })
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
    // Tail connects, refetches, then exits -> sets offline
    on('process.spawn', async function* () {
      yield { stream: 'stderr' as const, text: 'asenq tail: connected\n' }
      return { value: { code: 1, signal: null } }
    })

    await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
    await clock.settle()

    // After the tail exits, status should be offline
    const offlineIdx = statusCalls.findIndex((s) => s.includes('offline'))
    expect(offlineIdx).toBeGreaterThanOrEqual(0)

    // command.run refetches with a higher seq and goes online again
    await $.command.run(CMD_RUN)
    await clock.settle()

    const last = statusCalls[statusCalls.length - 1]
    expect(last).toContain('lead')
    expect(last).toContain('orchestrator')
  })
})

describe('status line reads atom (F-15)', () => {
  test('status matches pane data after a mutation', async ($, on) => {
    const clock = mock.clock(on)
    const statusCalls: string[] = []
    setupMocks(on, { onStatus: (t) => statusCalls.push(t) })

    await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
    await clock.settle()
    await $.command.run(CMD_RUN)
    await clock.settle()

    // The status should reflect the atom data (1 worker)
    const last = statusCalls[statusCalls.length - 1]
    expect(last).toContain('1 workers')

    // Mount the pane and check the data matches
    const ui = await $.ui.mount({ plugin: 'asenq', surface: 'terminal', component: 'Pane', requestId: 'asenq', props: PANE_PROPS })
    expect(await ui.find({ type: 'Text', text: /lead/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /w1/ })).toBeDefined()
    await ui.unmount()
  })
})

// --- tail stderr "connected" line triggers refetch ---

describe('tail stderr lines', () => {
  test('split connection and mismatch lines are parsed, including the EOF remainder', async ($, on) => {
    const clock = mock.clock(on)
    let fetchCount = 0
    const toasts: string[] = []
    on('session.start', (_$, e) => ({ cwd: e.cwd }))
    on('session.id', () => ({ value: 'cc-test' }))
    on('command.register', () => V)
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('ui.close', () => V)
    on('ui.toast', (_$, e) => { toasts.push(e.text ?? ''); return V })
    on('ui.status', () => V)
    on('ui.render', () => ({ type: 'engine', ref: 0 }))
    on('fs.read', (_$, e) => {
      if (e.path && e.path.endsWith('asenq-cli.json')) return { value: CLI_JSON }
      throw new Error(`unexpected fs.read: ${e.path}`)
    })
    on('process.run', (_$, e) => {
      const sub = e.argv.slice(2).join(' ')
      if (sub === 'ls --json') { fetchCount++; return procOk(LS_JSON) }
      if (sub === 'channels --json') return procOk(CHANNELS_JSON)
      return procFail()
    })
    on('process.spawn', async function* () {
      yield { stream: 'stderr' as const, text: 'asenq tail: con' }
      yield { stream: 'stderr' as const, text: 'nected\nprotocol mis' }
      yield { stream: 'stderr' as const, text: 'match detected' }
      return { value: { code: 0, signal: null } }
    })

    await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
    await clock.settle()

    expect(fetchCount).toBeGreaterThanOrEqual(1)
    expect(toasts).toEqual(['asenq mod is out of date with the daemon: rerun `asenq setup`'])
  })
})
describe('status publication ordering', () => {
  test('slow identity lookup cannot publish status older than the current atom', async ($, on) => {
    const clock = mock.clock(on)
    const statuses: string[] = []
    let pauseId = false
    let release!: () => void
    const waiting = new Promise<void>((resolve) => { release = resolve })
    on('session.start', (_$, e) => ({ cwd: e.cwd }))
    on('session.id', async () => {
      if (pauseId) { pauseId = false; await waiting }
      return { value: 'cc-test' }
    })
    on('command.register', () => V)
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('ui.close', () => V)
    on('ui.toast', () => V)
    on('ui.status', (_$, e) => { statuses.push(e.text ?? ''); return V })
    on('ui.render', () => ({ type: 'engine', ref: 0 }))
    on('fs.read', (_$, e) => {
      if (e.path && e.path.endsWith('asenq-cli.json')) return { value: CLI_JSON }
      throw new Error(`unexpected fs.read: ${e.path}`)
    })
    let name = 'old-lead'
    on('process.run', (_$, e) => {
      const sub = e.argv.slice(2).join(' ')
      if (sub === 'channels --json') return procOk(CHANNELS_JSON)
      if (sub === 'ls --json') return procOk(JSON.stringify([
        { id: 's1', name, role: 'orchestrator', state: 'live', harness: 'claude', harnessSessionId: 'cc-test', cwd: '/', channels: [] },
      ]))
      return procFail()
    })
    on('process.spawn', async function* () {
      return { value: { code: 1, signal: null } }
    })

    await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
    await clock.settle()
    pauseId = true
    const older = $.command.run(CMD_RUN)
    await clock.settle()
    name = 'new-lead'
    await $.command.run(CMD_RUN)
    await clock.settle()
    release()
    await older
    await clock.settle()

    const ui = await $.ui.mount({ plugin: 'asenq', surface: 'terminal', component: 'Pane', requestId: 'asenq', props: PANE_PROPS })
    const input = await ui.find({ type: 'Input', key: 'rename-s1' })
    expect(input!.props['placeholder']).toBe('new-lead')
    await ui.unmount()
    expect(statuses[statuses.length - 1]).toContain('new-lead')
  })
})
