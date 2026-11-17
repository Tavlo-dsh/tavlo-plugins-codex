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
  it('enables Fast and explicitly clears it without changing model, reasoning or permissions', async () => {
    const { controls, request, state } = setup()
    await controls.setFast(true)
    expect(request).toHaveBeenLastCalledWith('thread/settings/update', { serviceTier: 'fast' })
    expect(state().speed).toEqual({ selected: 'fast', effectiveTier: 'fast', capability: 'supported' })
    await controls.setFast(false)
    expect(request).toHaveBeenLastCalledWith('thread/settings/update', { serviceTier: null })
    expect(state().speed).toEqual({ selected: 'standard', effectiveTier: null, capability: 'supported' })
  })
  it('keeps the previous speed selection when the native API rejects a change', async () => {
    const { controls, request, state } = setup()
    await controls.setFast(true)
    request.mockRejectedValue(new RpcError(-32601, 'method not found'))
    await expect(controls.setFast(false)).rejects.toThrow('method not found')
    expect(state().speed).toMatchObject({ selected: 'fast', effectiveTier: 'fast', capability: 'unavailable' })
    expect(state().speed.error).toContain('method not found')
  })
  it('observes the native tier without replacing an explicit speed choice', async () => {
    const { controls, state } = setup()
    controls.restoreSpeed('priority')
    expect(state().speed).toMatchObject({ selected: 'inherit', effectiveTier: 'fast' })
    await controls.setFast(false)
    controls.restoreSpeed('default')
    controls.restoreSpeed(undefined)
    expect(state().speed).toMatchObject({ selected: 'standard', effectiveTier: null })
  })
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
  it.each(['complete', 'blocked', 'budgetLimited', 'usageLimited'])('does not replace a %s Goal with paused at a boundary', async status => {
    const f = setup()
    f.request.mockResolvedValue({ goal: { threadId: 'thread', objective: 'work', status, tokensUsed: 500, tokenBudget: 500, timeUsedSeconds: 12, createdAt: 1, updatedAt: 2 } })
    await f.controls.changeGoal('pause', undefined, 'automatic')
    expect(f.request.mock.calls.map(([method]) => method)).toEqual(['thread/goal/get'])
    expect(f.state().goal?.status).toBe(status)
  })
  it('rejects a second resume and clears a recovered read error without resetting usage', async () => {
    const f = setup()
    const goal = { threadId: 'thread', objective: 'work', status: 'active', tokensUsed: 500, tokenBudget: 1000, timeUsedSeconds: 12, createdAt: 1, updatedAt: 2 }
    f.controls.observeGoal(goal)
    f.request.mockRejectedValueOnce(new Error('temporary failure'))
    await expect(f.controls.getGoal()).rejects.toThrow('temporary failure')
    f.request.mockResolvedValue({ goal })
    await expect(f.controls.changeGoal('resume')).rejects.toThrow('已启用')
    expect(f.state().goalControl.error).toBeUndefined()
    expect(f.state().goal?.tokensUsed).toBe(500)
    expect(f.request.mock.calls.every(([method]) => method === 'thread/goal/get')).toBe(true)
  })
})

describe('Fast commands', () => {
  function command() {
    const state = initialNativeState()
    const agent = { status: 'idle', model: { current: () => ({ provider: 'codex', model: 'model', reasoningEffort: 'high' }) } } as unknown as Agent
    const setFast = vi.fn(async (_enabled: boolean) => {})
    const resolve = vi.fn(() => ({ setFast }) as never)
    const definition = codexCommand({ state: () => state, resolve, rename: () => '', fastMode: true })
    const invoke = (rawInput: string) => definition.handler({ agent, rawInput, signal: new AbortController().signal, attachments: [] } as unknown as CommandInvocation)
    return { state, agent, setFast, resolve, invoke }
  }
  it('exposes on/off and rejects invalid input without sending model messages', async () => {
    const t = command()
    expect(await t.invoke('fast on')).toMatchObject({ kind: 'success', text: expect.stringContaining('已开启') })
    expect(t.setFast).toHaveBeenLastCalledWith(true, expect.objectContaining({ model: 'model', reasoningEffort: 'high', messages: [] }))
    expect(await t.invoke('fast off')).toMatchObject({ kind: 'success', text: expect.stringContaining('已关闭') })
    expect(t.setFast).toHaveBeenLastCalledWith(false, expect.anything())
    expect(await t.invoke('fast typo')).toMatchObject({ kind: 'error' })
    expect(t.setFast).toHaveBeenCalledTimes(2)
  })
  it('reads status during a running task without starting or mutating a thread', async () => {
    const t = command()
    Object.assign(t.agent, { status: 'running' })
    expect(await t.invoke('fast')).toMatchObject({ kind: 'success', text: expect.stringContaining('插件默认开启') })
    t.state.speed.effectiveTier = 'fast'
    expect(await t.invoke('fast status')).toMatchObject({ kind: 'success', text: expect.stringContaining('已开启') })
    expect(await t.invoke('usage')).toMatchObject({ kind: 'success', text: expect.stringContaining('Fast：已开启') })
    expect(await t.invoke('fast off')).toMatchObject({ kind: 'error', text: expect.stringContaining('等待') })
    expect(t.resolve).not.toHaveBeenCalled()
  })
  it('reports native failures without claiming the setting was applied', async () => {
    const t = command()
    t.setFast.mockRejectedValue(new Error('Fast is unavailable'))
    expect(await t.invoke('fast on')).toMatchObject({ kind: 'error', text: expect.stringContaining('Fast is unavailable') })
    expect(t.state.speed.selected).toBe('inherit')
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
