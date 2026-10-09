import type { Session, Channel, AsenqData } from '../types'

/** Finds this session's row: harness === "claude" and harnessSessionId matches. */
export function findSelf(sessions: Session[], claudeSessionId: string): Session | undefined {
  return sessions.find(
    (s) => s.harness === 'claude' && s.harnessSessionId === claudeSessionId,
  )
}

/** Returns live workers that share at least one channel with `self`. */
export function sharedWorkers(
  self: Session,
  sessions: Session[],
  channels: Channel[],
): Session[] {
  const selfChannelNames = new Set(self.channels)
  const channelMembers = new Map<string, Set<string>>()
  for (const ch of channels) {
    if (!ch.members) continue
    channelMembers.set(ch.name, new Set(ch.members.map((m) => m.id)))
  }
  const coworkerIds = new Set<string>()
  for (const chName of selfChannelNames) {
    const members = channelMembers.get(chName)
    if (!members) continue
    for (const id of members) {
      if (id !== self.id) coworkerIds.add(id)
    }
  }
  return sessions.filter(
    (s) => s.role === 'worker' && s.state === 'live' && coworkerIds.has(s.id),
  )
}

/** Formats the worker names list with a +N suffix when it passes ~40 chars. */
export function formatWorkerNames(workers: Session[]): string {
  if (workers.length === 0) return ''
  const names: string[] = []
  let len = 0
  for (const w of workers) {
    if (names.length > 0 && len + 2 + w.name.length > 40) {
      return `${names.join(', ')} +${workers.length - names.length}`
    }
    names.push(w.name)
    len += (names.length > 1 ? 2 : 0) + w.name.length
  }
  return names.join(', ')
}

/** Finds the first live orchestrator in a channel. */
export function firstOrchestrator(
  channelName: string,
  channels: Channel[],
  sessions: Session[],
): Session | undefined {
  const ch = channels.find((c) => c.name === channelName)
  if (!ch || !ch.members) return undefined
  for (const member of ch.members) {
    if (member.role === 'orchestrator' && member.state === 'live') {
      return sessions.find((s) => s.id === member.id)
    }
  }
  return undefined
}

/** Builds the status line for the current state. */
export function statusLine(data: AsenqData, claudeSessionId: string): string {
  if (!data.online) return 'asenq offline'

  const self = findSelf(data.sessions, claudeSessionId)
  if (!self) return 'asenq unregistered'

  if (self.role === 'orchestrator') {
    const workers = sharedWorkers(self, data.sessions, data.channels)
    const names = formatWorkerNames(workers)
    const workerPart = names
      ? `${workers.length} workers: ${names}`
      : `0 workers`
    return `asenq ${self.name} · orchestrator · ${workerPart}`
  }

  if (self.role === 'worker') {
    const parts = [`asenq ${self.name}`, 'worker']
    if (self.channels.length > 0) {
      let channelPart = `#${self.channels[0]}`
      if (self.channels.length > 1) channelPart += ` +${self.channels.length - 1}`
      parts.push(channelPart)
      const orch = firstOrchestrator(self.channels[0], data.channels, data.sessions)
      if (orch) parts.push(orch.name)
    }
    return parts.join(' · ')
  }

  // Unset role
  let text = `asenq ${self.name}`
  if (self.channels.length > 0) text += ` · #${self.channels[0]}`
  return text
}
