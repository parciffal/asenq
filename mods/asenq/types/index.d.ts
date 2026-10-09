export type Session = {
  id: string
  name: string
  role: 'orchestrator' | 'worker' | null
  state: 'live' | 'gone' | 'stale'
  harness: string
  harnessSessionId: string
  cwd: string
  channels: string[]
}

export type ChannelMember = {
  name: string
  role: 'orchestrator' | 'worker' | null
  state: 'live' | 'gone' | 'stale'
  id: string
}

export type Channel = {
  name: string
  members: ChannelMember[]
  count: number
}

export type AsenqData = {
  sessions: Session[]
  channels: Channel[]
  online: boolean
}

declare module 'claude-code' {
  interface PluginState {
    asenq: {
      data: AsenqData
    }
  }
}
