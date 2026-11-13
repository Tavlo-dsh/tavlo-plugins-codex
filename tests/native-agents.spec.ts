import { describe, expect, it } from 'vitest'
import { NativeAgents } from '../src/native-agents.ts'
import { initialNativeState } from '../src/native-state.ts'
import type { NativeItem } from '../src/protocol.ts'

describe('native agent relationships and lifecycle', () => {
  function setup() {
    let state = { ...initialNativeState(), threadId: 'root' }
    const agents = new NativeAgents(() => state, patch => { state = { ...state, agents: patch } })
    return { agents, state: () => state }
  }
  it('keeps concurrent agents under stable ids and preserves resolved metadata', () => {
    const t = setup()
    const item: NativeItem = { type: 'collabAgentToolCall', id: 'spawn1', tool: 'spawnAgent', senderThreadId: 'root', receiverThreadIds: ['a', 'b'], prompt: 'review', model: 'model', reasoningEffort: 'high', agentsStates: { a: { status: 'running' }, b: { status: 'running' } } }
    t.agents.item(item, 'root', true)
    t.agents.item({ type: 'subAgentActivity', id: 'meta', kind: 'started', agentThreadId: 'a', agentPath: '/root/a', model: 'resolved-model' }, 'root', true)
    t.agents.item({ ...item, id: 'wait', tool: 'wait', agentsStates: { a: { status: 'completed', message: 'done' }, b: { status: 'errored', message: 'failed' } } }, 'root', true)
    // An already-completed old spawn is ignored, so it cannot regress a finished agent.
    t.agents.item(item, 'root', false)
    expect(Object.keys(t.state().agents)).toEqual(['a', 'b'])
    expect(t.state().agents.a).toMatchObject({ threadId: 'a', parentThreadId: 'root', model: 'resolved-model', task: 'review', status: 'completed', message: 'done' })
    expect(t.state().agents.b?.status).toBe('errored')
  })
  it('tracks nested threads and rejects events from unrelated roots and late turns', () => {
    const t = setup()
    t.agents.notification({ method: 'thread/started', params: { thread: { id: 'a', parentThreadId: 'root' } } })
    t.agents.notification({ method: 'thread/started', params: { thread: { id: 'nested', parentThreadId: 'a' } } })
    expect(t.agents.notification({ method: 'thread/started', params: { thread: { id: 'other', parentThreadId: 'unrelated' } } })).toBe(false)
    t.agents.notification({ method: 'turn/started', params: { threadId: 'nested', turn: { id: 't2' } } })
    t.agents.notification({ method: 'turn/completed', params: { threadId: 'nested', turn: { id: 't1', status: 'completed' } } })
    expect(t.state().agents.nested).toMatchObject({ parentThreadId: 'a', activeTurnId: 't2', status: 'running' })
    t.agents.disconnected()
    expect(t.state().agents.nested?.status).toBe('connectionLost')
    expect(t.state().agents.other).toBeUndefined()
  })
})
