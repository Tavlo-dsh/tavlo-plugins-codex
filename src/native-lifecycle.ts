/** Read-only reconciliation: never resume a child merely to observe it. */
import { setTimeout as delay } from 'node:timers/promises'
import type { NativeState } from './native-state.ts'
import { record, text } from './protocol.ts'
import { runningAgent, type NativeAgents } from './native-agents.ts'

export interface LifecycleDeps {
  state(): NativeState
  agents: NativeAgents
  request(method: string, params: Record<string, unknown>): Promise<unknown>
  signal: AbortSignal
}

export class NativeLifecycle {
  private chain: Promise<void> = Promise.resolve()
  constructor(private readonly deps: LifecycleDeps) {}

  refresh(): Promise<void> {
    const next = this.chain.then(() => this.scan())
    this.chain = next.catch(() => undefined)
    return next
  }

  private async scan(): Promise<void> {
    const { signal, agents, request } = this.deps
    signal.throwIfAborted()
    const root = this.deps.state().threadId
    if (!root) return
    // A parent can finish before its spawn event reaches this client. Discover
    // persisted descendants too, including nested children, before declaring idle.
    const candidates: Record<string, unknown>[] = []
    const cursors = new Set<string>()
    let cursor: string | undefined
    do {
      const page = record(await request('thread/list', { ancestorThreadId: root, sourceKinds: ['subAgent', 'subAgentReview', 'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther'], limit: 100, ...(cursor ? { cursor } : {}) }))
      signal.throwIfAborted()
      if (!Array.isArray(page.data)) throw new Error('Codex did not return a descendant thread list')
      candidates.push(...page.data.map(record))
      if (candidates.length > 256) throw new Error('Codex descendant limit exceeded')
      cursor = text(page.nextCursor) || undefined
      if (cursor && cursors.has(cursor)) throw new Error('Codex descendant cursor repeated')
      if (cursor) cursors.add(cursor)
    } while (cursor)
    // Thread list ordering does not guarantee parents precede their children.
    for (let pass = 0; pass <= candidates.length; pass++) {
      let added = false
      for (const thread of candidates) {
        const id = text(thread.id), parent = text(thread.parentThreadId)
        if (!id || this.deps.state().agents[id] || (parent !== root && !this.deps.state().agents[parent])) continue
        agents.notification({ method: 'thread/started', params: { thread } })
        added = true
      }
      if (!added) break
    }
    for (const agent of Object.values(this.deps.state().agents)) {
      signal.throwIfAborted()
      const metadata = record(record(await request('thread/read', { threadId: agent.threadId, includeTurns: false })).thread)
      if (metadata.id !== agent.threadId || metadata.parentThreadId !== agent.parentThreadId) throw new Error('Codex child identity changed')
      const response = record(await request('thread/turns/list', { threadId: agent.threadId, limit: 3, sortDirection: 'desc', itemsView: 'full' }))
      if (!Array.isArray(response.data)) throw new Error('Codex did not return child turns')
      signal.throwIfAborted()
      // A terminal event arriving during a read is newer than that snapshot.
      if (this.deps.state().agents[agent.threadId] === agent) agents.snapshot(metadata, response.data)
    }
  }

  /** An interrupt acknowledgement is not proof that the child has stopped. */
  async stop(signal: AbortSignal): Promise<void> {
    const requested = new Set<string>()
    for (;;) {
      signal.throwIfAborted()
      await this.refresh()
      signal.throwIfAborted()
      const known = Object.values(this.deps.state().agents)
      const active = known.filter(agent => agent.activeTurnId)
      if (!known.some(runningAgent)) return
      for (const agent of active) {
        const key = `${agent.threadId}:${agent.activeTurnId}`
        if (requested.has(key)) continue
        requested.add(key)
        await this.deps.request('turn/interrupt', { threadId: agent.threadId, turnId: agent.activeTurnId })
        this.deps.agents.interruptRequested(agent.threadId)
      }
      await delay(50, undefined, { signal })
    }
  }
}
