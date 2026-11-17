import type { NativeAgent, NativeState } from './native-state.ts'
import type { NativeItem, RpcNotification } from './protocol.ts'
import { record, text } from './protocol.ts'

const terminal = new Set(['completed', 'failed', 'errored', 'shutdown', 'notFound', 'interrupted', 'systemError'])
export const runningAgent = (agent: NativeAgent): boolean => !terminal.has(agent.status) && !['idle', 'notLoaded', 'connectionLost'].includes(agent.status)

/** Native Codex owns dispatch; this reducer only keeps observable identities and relationships. */
export class NativeAgents {
  private readonly completedCalls = new Set<string>()
  constructor(private readonly state: () => NativeState, private readonly update: (agents: NativeState['agents']) => void) {}
  interruptRequested(id: string): void {
    const agent = this.state().agents[id]
    if (agent) this.patch(id, agent.parentThreadId, { interruptRequested: true })
  }
  snapshot(metadata: Record<string, unknown>, turns: unknown[]): void {
    const id = text(metadata.id), known = this.state().agents[id]
    if (!known) return
    const loaded = record(metadata.status).type !== 'notLoaded'
    const recent = turns.map(record), active = loaded ? recent.find(turn => turn.status === 'inProgress') : undefined
    const last = recent[0]
    const status = active ? 'running' : record(metadata.status).type === 'active' ? 'pendingInit'
      : last && last.status !== 'inProgress' ? text(last.status) : loaded ? 'idle' : 'connectionLost'
    const messages = recent.flatMap(turn => (Array.isArray(turn.items) ? turn.items : []).map(record))
      .filter(item => item.type === 'agentMessage').map(item => text(item.text)).filter(Boolean)
    this.patch(id, known.parentThreadId, {
      status, activeTurnId: active ? text(active.id) : '',
      ...(messages.length ? { message: messages.join('\n').slice(-32000) } : {}),
      ...(text(metadata.model) ? { model: text(metadata.model) } : {}),
      ...(text(metadata.reasoningEffort) ? { reasoningEffort: text(metadata.reasoningEffort) } : {}),
    }, true)
    // Recent history can contain a spawn missed during a connection interruption.
    for (const turn of [...recent].reverse()) for (const raw of Array.isArray(turn.items) ? turn.items : []) {
      const item = record(raw)
      if (text(item.id)) this.item(item as NativeItem, id, turn.status !== 'inProgress')
    }
  }
  private patch(id: string, parent: string, changes: Partial<NativeAgent>, canRestart = false): void {
    if (!id || id === this.state().threadId || !parent) return
    const previous = this.state().agents[id]
    if (!previous && Object.keys(this.state().agents).length >= 256) return
    const patch = { ...changes }
    if (previous && terminal.has(previous.status) && patch.status && !terminal.has(patch.status) && !canRestart) delete patch.status
    const next = { ...previous, threadId: id, parentThreadId: parent, status: previous?.status ?? 'pendingInit', ...patch }
    if (terminal.has(next.status) || ['idle', 'notLoaded', 'connectionLost'].includes(next.status)) next.activeTurnId = ''
    if (JSON.stringify(next) === JSON.stringify(previous)) return
    this.update({ ...this.state().agents, [id]: next })
  }
  item(item: NativeItem, sender: string, completed: boolean): void {
    if (item.type === 'collabAgentToolCall') {
      const key = `${sender}:${item.id}`
      if (this.completedCalls.has(key)) return
      if (completed) this.completedCalls.add(key)
      if (this.completedCalls.size > 2048) this.completedCalls.delete(this.completedCalls.values().next().value!)
      const source = text(item.senderThreadId) || sender
      const targets = new Set((Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : []).map(text).filter(Boolean))
      const states = record(item.agentsStates)
      for (const id of Object.keys(states)) targets.add(id)
      for (const id of targets) {
        const agent = record(states[id]), tool = text(item.tool), previous = this.state().agents[id]
        this.patch(id, previous?.parentThreadId ?? source, {
          operation: tool,
          ...(text(agent.status) ? { status: text(agent.status) } : !previous && /spawn|resume/.test(tool) ? { status: 'pendingInit' } : {}),
          ...(!previous?.task && text(item.prompt) ? { task: text(item.prompt).slice(0, 16000) } : {}),
          ...(!previous?.model && text(item.model) ? { model: text(item.model) } : {}),
          ...(!previous?.reasoningEffort && text(item.reasoningEffort) ? { reasoningEffort: text(item.reasoningEffort) } : {}),
          ...(typeof agent.message === 'string' ? { message: agent.message.slice(0, 32000) } : {}),
        }, /spawn|resume|sendInput|followupTask/.test(tool) && !completed)
      }
    } else if (item.type === 'subAgentActivity') {
      const id = text(item.agentThreadId), kind = text(item.kind)
      this.patch(id, this.state().agents[id]?.parentThreadId ?? sender, {
        status: kind === 'completed' ? 'completed' : kind === 'interrupted' ? 'interrupted' : 'running',
        ...(text(item.model) ? { model: text(item.model) } : {}),
        ...(text(item.reasoningEffort) ? { reasoningEffort: text(item.reasoningEffort) } : {}),
        ...(text(item.agentPath) ? { path: text(item.agentPath) } : {}),
      }, kind === 'started')
    }
  }
  notification({ method, params }: RpcNotification): boolean {
    const root = this.state().threadId, id = text(params.threadId), known = this.state().agents[id]
    if (method === 'thread/started') {
      const thread = record(params.thread), parent = text(thread.parentThreadId)
      if (parent !== root && !this.state().agents[parent]) return false
      this.patch(text(thread.id), parent, {
        status: text(record(thread.status).type) || 'pendingInit',
        ...(text(thread.preview) ? { task: text(thread.preview).slice(0, 16000) } : {}),
        ...(text(thread.model) ? { model: text(thread.model) } : {}),
        ...(text(thread.reasoningEffort) ? { reasoningEffort: text(thread.reasoningEffort) } : {}),
      })
      return true
    }
    if (id !== root && !known) return false
    if (method === 'item/started' || method === 'item/completed') {
      const item = record(params.item)
      if (text(item.id) && text(item.type)) this.item(item as NativeItem, id, method === 'item/completed')
    }
    if (known) {
      if (method === 'turn/started') this.patch(id, known.parentThreadId, { status: 'running', activeTurnId: text(record(params.turn).id), interruptRequested: false }, true)
      if (method === 'turn/completed') {
        const turn = record(params.turn)
        if (known.activeTurnId && text(turn.id) !== known.activeTurnId) return true
        this.patch(id, known.parentThreadId, { status: text(turn.status) === 'failed' ? 'errored' : text(turn.status), activeTurnId: '' })
      }
      if (method === 'thread/status/changed') this.patch(id, known.parentThreadId, { status: text(record(params.status).type) || known.status })
      if (method === 'thread/closed') this.patch(id, known.parentThreadId, { status: 'connectionLost', activeTurnId: '' })
      return true
    }
    return false
  }
  disconnected(): void {
    const agents = Object.fromEntries(Object.entries(this.state().agents).map(([id, agent]) => [id, runningAgent(agent) ? { ...agent, status: 'connectionLost', activeTurnId: '' } : agent]))
    if (JSON.stringify(agents) !== JSON.stringify(this.state().agents)) this.update(agents)
  }
}
