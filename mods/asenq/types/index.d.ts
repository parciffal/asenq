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
  state: 'live' | 'gone' | 'stale' | 'removed'
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
  /** Monotonic sequence number; a fetch with a lower seq never overwrites a higher one. */
  seq: number
}

/** Per-element draft state for rename inputs. Keyed by element key. */
export type Drafts = Record<string, string>

declare module 'claude-code' {
  interface PluginState {
    asenq: {
      data: AsenqData
      drafts: Drafts
    }
  }
}
