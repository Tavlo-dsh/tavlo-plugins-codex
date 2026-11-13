import { describe, expect, it, vi } from 'vitest'
import { NativeControls } from '../src/native-controls.ts'
import { initialNativeState } from '../src/native-state.ts'
import { RpcError } from '../src/app-server.ts'
import { codexCommand } from '../src/commands.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'

function setup() {
  let state = initialNativeState()
  const request = vi.fn(async (_method: string, _params: Record<string, unknown>): Promise<unknown> => ({}))
  const controls = new NativeControls({ state: () => state, update: patch => { state = { ...state, ...patch } }, request })
  return { controls, request, state: () => state }
}
describe('native thread controls', () => {
  it('gets the authoritative Goal before updating status/budget, never resubmitting the objective', async () => {
    const t = setup()
    let goal = { threadId: 'thread', objective: 'old', status: 'paused', tokensUsed: 500, tokenBudget: 1000, timeUsedSeconds: 12, createdAt: 1, updatedAt: 2 }
    t.request.mockImplementation(async (method, params) => {
      if (method === 'thread/goal/clear') return { cleared: true }
      if (method === 'thread/goal/set') goal = { ...goal, ...params, updatedAt: goal.updatedAt + 1 }
      return { goal }
    })
    await t.controls.changeGoal('resume')
    expect(t.request.mock.calls.map(([method]) => method)).toEqual(['thread/goal/get', 'thread/goal/set'])
    expect(t.request.mock.calls[1]?.[1]).toEqual({ origin: 'user', status: 'active' })
    expect(t.state().goal?.tokensUsed).toBe(500)
    await t.controls.changeGoal('budget', 2000)
    expect(t.request.mock.calls.at(-1)?.[1]).toEqual({ origin: 'user', tokenBudget: 2000 })
    expect(t.state().goal?.tokensUsed).toBe(500)
    goal = { ...goal, status: 'budgetLimited', tokenBudget: 500 }
    await expect(t.controls.changeGoal('resume')).rejects.toThrow('限制')
    goal = { ...goal, status: 'usageLimited', tokenBudget: 5000 }
    await expect(t.controls.changeGoal('resume')).rejects.toThrow('限制')
  })
  it('replaces a Goal only through explicit set and rejects stale or malformed notifications', async () => {
    const t = setup()
    const old = { threadId: 'thread', objective: 'old', status: 'paused', tokensUsed: 500, tokenBudget: null, timeUsedSeconds: 12, createdAt: 1, updatedAt: 5 }
    t.request.mockImplementation(async (method, params) => ({ goal: method === 'thread/goal/get' ? old : { ...old, ...params, tokensUsed: 0, updatedAt: 6 } }))
    await t.controls.setGoal('new goal')
    expect(t.request.mock.calls[1]?.[1]).toEqual({ origin: 'user', objective: 'new goal', status: 'paused' })
    t.controls.observeGoal({ ...old, updatedAt: 1 })
    expect(t.state().goal?.objective).toBe('new goal')
    expect(() => t.controls.observeGoal({ ...old, tokensUsed: -1 })).toThrow('格式')
    t.controls.observeGoal(null)
    expect(t.state().goal).toBeNull()
  })
  it('switches Plan without changing permissions, preserving selected model and effort', async () => {
    const { controls, request, state } = setup()
    await controls.setMode('plan', 'native-model', 'high')
    expect(request).toHaveBeenCalledWith('thread/settings/update', { collaborationMode: { mode: 'plan', settings: { model: 'native-model', reasoning_effort: 'high', developer_instructions: null } } })
    expect(state().mode.selected).toBe('plan')
    await controls.setMode('default', 'other', 'medium')
    expect(state().mode.selected).toBe('default')
  })
  it('records unsupported capability without silently selecting Default', async () => {
    const { controls, request, state } = setup()
    await controls.setMode('plan', 'model', null)
    request.mockRejectedValue(new RpcError(-32601, 'method not found'))
    await expect(controls.setMode('default', 'model', null)).rejects.toThrow('method not found')
    expect(state().mode).toMatchObject({ selected: 'plan', capability: 'unavailable' })
  })
  it('pins manual names, avoids automatic overwrite and duplicate native echoes', async () => {
    const { controls, request, state } = setup()
    await controls.setName('  Manual   name ', true)
    await controls.setName('Automatic', false)
    expect(controls.observeName('Native automatic')).toBeUndefined()
    expect(state().name).toMatchObject({ title: 'Manual name', nativeTitle: 'Native automatic', pinned: true })
    await controls.setName('Manual name', true)
    expect(controls.observeName('Manual name')).toBeUndefined()
    expect(request).toHaveBeenCalledTimes(2)
    request.mockRejectedValue(new Error('rename failed'))
    await expect(controls.setName('New manual', true)).rejects.toThrow('rename failed')
    expect(state().name).toMatchObject({ title: 'New manual', pinned: true, error: 'Error: rename failed' })
  })
  it('restores native mode only when no explicit local selection exists', async () => {
    const { controls, state } = setup()
    controls.restoreMode({ mode: 'plan' })
    expect(state().mode.selected).toBe('plan')
    await controls.setMode('default', 'model', null)
    controls.restoreMode({ mode: 'plan' })
    expect(state().mode.selected).toBe('default')
  })
})

describe('Plan command confirmation', () => {
  function command() {
    const state = initialNativeState()
    state.mode.selected = 'plan'; state.plan.final = true; state.plan.text = 'Plan A'
    const followup = vi.fn()
    const agent = { status: 'idle', model: { current: () => ({ provider: 'codex', model: 'model', reasoningEffort: 'high' }) }, followup } as unknown as Agent
    const setMode = vi.fn(async (mode: 'default' | 'plan') => { state.mode.selected = mode })
    const definition = codexCommand({ state: () => state, resolve: () => ({ setMode }) as never, rename: () => '' })
    const invoke = (rawInput: string) => definition.handler({ agent, rawInput, signal: new AbortController().signal, attachments: [] } as unknown as CommandInvocation)
    return { invoke, setMode, followup, state }
  }
  it('returns to Default before submitting the user-confirmed execution and refuses duplicate execution', async () => {
    const t = command()
    expect(await t.invoke('execute')).toMatchObject({ kind: 'success' })
    expect(t.setMode.mock.invocationCallOrder[0]).toBeLessThan(t.followup.mock.invocationCallOrder[0]!)
    expect(await t.invoke('execute')).toMatchObject({ kind: 'error' })
    expect(t.followup).toHaveBeenCalledTimes(1)
  })
  it('keeps Plan after declining and never submits when mode switching fails', async () => {
    const t = command()
    expect(await t.invoke('keep')).toMatchObject({ kind: 'success' })
    expect(t.state.mode.selected).toBe('plan')
    expect(t.setMode).not.toHaveBeenCalled()
    t.setMode.mockRejectedValue(new Error('mode failed'))
    expect(await t.invoke('execute')).toMatchObject({ kind: 'error' })
    expect(t.followup).not.toHaveBeenCalled()
  })
})
