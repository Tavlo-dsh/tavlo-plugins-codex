import { describe, expect, it, vi } from 'vitest'
import { NativeLifecycle } from '../src/native-lifecycle.ts'
import { NativeAgents } from '../src/native-agents.ts'
import { initialNativeState } from '../src/native-state.ts'

function fixture() {
  let state = { ...initialNativeState(), threadId: 'root' }
  const abort = new AbortController()
  const agents = new NativeAgents(() => state, patch => { state = { ...state, agents: patch } })
  const threads = new Map<string, { id: string; parentThreadId: string; status: { type: string } }>()
  const turns = new Map<string, unknown[]>()
  const request = vi.fn(async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    if (method === 'thread/list') return { data: [...threads.values()], nextCursor: null }
    if (method === 'thread/read') {
      const thread = threads.get(String(params.threadId)), rows = turns.get(String(params.threadId))
      return { thread: thread && { ...thread, status: { type: thread.status.type === 'active' && rows?.length && (rows[0] as { status: string }).status !== 'inProgress' ? 'idle' : thread.status.type } } }
    }
    if (method === 'thread/turns/list') return { data: turns.get(String(params.threadId)) ?? [] }
    return {}
  })
  const lifecycle = new NativeLifecycle({ state: () => state, agents, signal: abort.signal, request })
  const add = (id: string, parentThreadId = 'root', status = 'inProgress') => {
    threads.set(id, { id, parentThreadId, status: { type: 'active' } })
    turns.set(id, [{ id: `${id}-turn`, status, items: [{ type: 'agentMessage', text: `${id} result` }] }])
  }
  return { state: () => state, lifecycle, request, add, threads, turns, agents, abort }
}
describe('read-only child reconciliation', () => {
  it('discovers nested descendants out of order and excludes unrelated threads', async () => {
    const f = fixture()
    f.add('nested', 'child'); f.add('foreign', 'unrelated'); f.add('child')
    await f.lifecycle.refresh()
    expect(Object.keys(f.state().agents).sort()).toEqual(['child', 'nested'])
    expect(f.state().agents.nested).toMatchObject({ parentThreadId: 'child', activeTurnId: 'nested-turn', status: 'running' })
    expect(f.request.mock.calls.some(([method]) => method === 'thread/resume')).toBe(false)
  })
  it('does not finish stopping on acknowledgement; waits for terminal snapshots', async () => {
    const f = fixture(); f.add('child')
    let stopped = false
    const pending = f.lifecycle.stop(AbortSignal.timeout(2000)).then(() => { stopped = true })
    await vi.waitFor(() => expect(f.request.mock.calls.some(([method]) => method === 'turn/interrupt')).toBe(true))
    expect(stopped).toBe(false)
    f.turns.set('child', [{ id: 'child-turn', status: 'interrupted' }])
    await pending
    expect(f.state().agents.child).toMatchObject({ status: 'interrupted', activeTurnId: '', interruptRequested: true })
    expect(f.request.mock.calls.filter(([method]) => method === 'turn/interrupt')).toHaveLength(1)
  })
  it('restores unloaded in-progress history as disconnected without reactivating it', async () => {
    const f = fixture(); f.add('child'); f.threads.get('child')!.status.type = 'notLoaded'
    await f.lifecycle.stop(AbortSignal.timeout(1000))
    expect(f.state().agents.child).toMatchObject({ status: 'connectionLost', activeTurnId: '' })
    expect(f.request.mock.calls.some(([method]) => method === 'turn/interrupt' || method === 'thread/resume')).toBe(false)
  })
  it('stops when cancelled even if a child never reaches a terminal state', async () => {
    const f = fixture(); f.add('child')
    await expect(f.lifecycle.stop(AbortSignal.timeout(60))).rejects.toThrow()
  })
  it('waits for a starting child to acquire its turn before interrupting it', async () => {
    const f = fixture(); f.add('child'); f.turns.set('child', [])
    let ended = false
    const pending = f.lifecycle.stop(AbortSignal.timeout(2000)).then(() => { ended = true })
    await vi.waitFor(() => expect(f.state().agents.child?.status).toBe('pendingInit'))
    expect(ended).toBe(false)
    f.turns.set('child', [{ id: 'child-turn', status: 'inProgress' }])
    await vi.waitFor(() => expect(f.request.mock.calls.some(([method]) => method === 'turn/interrupt')).toBe(true))
    f.turns.set('child', [{ id: 'child-turn', status: 'interrupted' }])
    await pending
  })
  it('ignores stale snapshots if a terminal notification arrives during the read', async () => {
    const f = fixture(); f.add('child'); await f.lifecycle.refresh()
    const original = f.request.getMockImplementation()!
    f.request.mockImplementation(async (method, params) => {
      if (method === 'thread/turns/list') f.agents.notification({ method: 'turn/completed', params: { threadId: 'child', turn: { id: 'child-turn', status: 'completed' } } })
      return original(method, params)
    })
    await f.lifecycle.refresh()
    expect(f.state().agents.child).toMatchObject({ status: 'completed', activeTurnId: '' })
  })
  it('refuses changing child identities and malformed discovery results', async () => {
    const f = fixture(); f.add('child'); await f.lifecycle.refresh()
    f.threads.get('child')!.parentThreadId = 'elsewhere'
    await expect(f.lifecycle.refresh()).rejects.toThrow('identity')
    f.request.mockResolvedValue({})
    await expect(f.lifecycle.refresh()).rejects.toThrow('descendant')
  })
})
