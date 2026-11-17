import { describe, expect, it, vi } from 'vitest'
import { HostGoalBridge, type HostGoal, type HostGoalRef } from '../src/host-goal.ts'
import { NativeControls } from '../src/native-controls.ts'
import { initialNativeState, type NativeGoal } from '../src/native-state.ts'

function fixture() {
  let state = { ...initialNativeState(), threadId: 'thread' }
  let host: HostGoal | undefined = { id: 'host', revision: 1, objective: 'Finish the migration', phase: 'active', activation: 'armed', roundsStarted: 1 }
  let native: NativeGoal | null = null
  let clock = 10
  const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === 'thread/goal/get') return { goal: native }
    if (method === 'thread/goal/clear') { native = null; return {} }
    if (method !== 'thread/goal/set') throw new Error(method)
    const previous = params.objective === undefined ? native : null
    native = { threadId: 'thread', objective: '', status: 'paused', tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: ++clock, ...previous, ...params, updatedAt: ++clock } as NativeGoal
    return { goal: native }
  })
  const controls = new NativeControls({ state: () => state, update: patch => { state = { ...state, ...patch } }, request })
  const settle = vi.fn((ref: HostGoalRef, phase: 'paused' | 'blocked' | 'complete') => {
    if (host?.id === ref.id && host.revision === ref.revision) host = { ...host, revision: host.revision + 1, phase, activation: 'disarmed' }
  })
  const bridge = new HostGoalBridge({ host: { current: () => host, settle }, state: () => state, controls, request,
    bind: hostGoal => { state = { ...state, hostGoal } },
  })
  return { bridge, request, settle, state: () => state, host: () => host, native: () => native,
    updateHost: (patch: Partial<HostGoal>) => { if (host) host = { ...host, ...patch } }, clearHost: () => { host = undefined },
    updateNative: (patch: Partial<NativeGoal>) => { if (native) native = { ...native, ...patch, updatedAt: ++clock } },
  }
}
const round = { id: 'host', revision: 1, round: 1 }

describe('DSH-owned goals over Codex native execution', () => {
  it('executes two host rounds without resetting usage or pausing the host at ordinary boundaries', async () => {
    const f = fixture()
    expect(await f.bridge.prepare(round)).toBe(true)
    expect(f.native()).toMatchObject({ objective: 'Finish the migration', status: 'active', tokenBudget: null })
    f.updateNative({ tokensUsed: 130 })
    await f.bridge.finish()
    expect(f.native()).toMatchObject({ status: 'paused', tokensUsed: 130 })
    expect(f.host()?.phase).toBe('active')
    f.updateHost({ roundsStarted: 2 })
    expect(await f.bridge.prepare({ ...round, round: 2 })).toBe(true)
    expect(f.native()?.tokensUsed).toBe(130)
    f.updateNative({ status: 'complete', tokensUsed: 260 })
    await f.bridge.finish()
    expect(f.host()?.phase).toBe('complete')
    expect(f.native()).toMatchObject({ status: 'complete', tokensUsed: 260 })
    expect(f.request.mock.calls.filter(([method, params]) => method === 'thread/goal/set' && params.objective !== undefined)).toHaveLength(1)
  })
  it('reports an explicit native pause once, without echoing subsequent technical pauses', async () => {
    const f = fixture(); await f.bridge.prepare(round)
    f.updateNative({ status: 'paused' }); await f.bridge.finish(); await f.bridge.finish()
    expect(f.host()?.phase).toBe('paused')
    expect(f.settle).toHaveBeenCalledTimes(1)
  })
  it('rejects old, unarmed and unadmitted round identities', async () => {
    const f = fixture()
    expect(await f.bridge.prepare({ ...round, revision: 2 })).toBe(false)
    expect(await f.bridge.prepare({ ...round, round: 2 })).toBe(false)
    f.updateHost({ activation: 'disarmed' })
    expect(await f.bridge.prepare(round)).toBe(false)
    expect(f.request).not.toHaveBeenCalled()
  })
  it('rechecks an edit made while the authoritative native read was in flight', async () => {
    const f = fixture(), original = f.request.getMockImplementation()!
    f.request.mockImplementationOnce(async (...args) => {
      f.updateHost({ revision: 2, objective: 'New objective' })
      return original(...args)
    })
    expect(await f.bridge.prepare(round)).toBe(false)
    expect(f.native()).toBeNull()
  })
  it('does not attribute an old round completion to an edited host goal', async () => {
    const f = fixture(); await f.bridge.prepare(round)
    f.updateHost({ revision: 2, objective: 'New objective' }); f.updateNative({ status: 'complete' })
    expect(f.bridge.invalidated()).toBe(true)
    await f.bridge.finish()
    expect(f.settle).not.toHaveBeenCalled()
    await f.bridge.sync()
    expect(f.native()).toMatchObject({ objective: 'New objective', status: 'paused' })
    expect(f.state().hostGoal).toMatchObject({ revision: 2 })
  })
  it.each(['blocked', 'budgetLimited', 'usageLimited'] as const)('returns native %s to the existing host goal', async status => {
    const f = fixture(); await f.bridge.prepare(round)
    f.updateNative({ status }); await f.bridge.finish()
    expect(f.host()?.phase).toBe('blocked')
    expect(f.native()?.status).toBe(status)
  })
  it.each(['budgetLimited', 'usageLimited'] as const)('cannot lift native %s by resuming the host with a new revision', async status => {
    const f = fixture(); await f.bridge.prepare(round)
    f.updateNative({ status, tokenBudget: status === 'budgetLimited' ? 100 : null, tokensUsed: 100 }); await f.bridge.finish()
    f.updateHost({ revision: 3, phase: 'active', activation: 'armed', roundsStarted: 2 })
    await f.bridge.sync()
    expect(await f.bridge.prepare({ id: 'host', revision: 3, round: 2 })).toBe(false)
    expect(f.host()?.phase).toBe('blocked')
    expect(f.native()).toMatchObject({ tokenBudget: status === 'budgetLimited' ? 100 : null, tokensUsed: 100, status })
  })
  it('clears only its own native binding when the host goal is cleared', async () => {
    const f = fixture(); await f.bridge.prepare(round); await f.bridge.finish()
    f.clearHost(); await f.bridge.sync()
    expect(f.native()).toBeNull(); expect(f.state().hostGoal).toBeNull()
    const other = fixture(); await other.bridge.prepare(round); await other.bridge.finish()
    other.updateNative({ objective: 'Independent native goal' }); other.clearHost(); await other.bridge.sync()
    expect(other.native()?.objective).toBe('Independent native goal')
    expect(other.state().hostGoal).toBeNull()
  })
  it('recovers a persisted native completion before admitting another host round', async () => {
    const f = fixture(); await f.bridge.prepare(round)
    f.updateNative({ status: 'complete' })
    expect(await f.bridge.prepare(round)).toBe(false)
    expect(f.host()?.phase).toBe('complete')
  })
  it('keeps normal sessions free of host-goal RPCs', async () => {
    const f = fixture(); f.clearHost()
    expect(await f.bridge.prepare()).toBe(true)
    expect(f.request).not.toHaveBeenCalled()
  })
  it('blocks the current goal on unsupported native control instead of silently ending every round', async () => {
    const f = fixture(); f.request.mockRejectedValueOnce(new Error('unsupported goal API'))
    await expect(f.bridge.prepare(round)).rejects.toThrow('unsupported')
    expect(f.host()?.phase).toBe('blocked')
  })
  it('blocks the matching host goal when its boundary state cannot be read', async () => {
    const f = fixture(); await f.bridge.prepare(round)
    f.request.mockRejectedValueOnce(new Error('native state unavailable'))
    await expect(f.bridge.finish()).rejects.toThrow('unavailable')
    expect(f.host()?.phase).toBe('blocked')
  })
  it('preserves the turn failure when Codex also marks the native goal blocked', async () => {
    const f = fixture(); await f.bridge.prepare(round)
    f.updateNative({ status: 'blocked' })
    await f.bridge.finish('Upstream model returned HTTP 500')
    expect(f.settle).toHaveBeenCalledExactlyOnceWith({ id: round.id, revision: round.revision }, 'blocked', { code: 'codex-turn-failed', message: 'Upstream model returned HTTP 500' })
    expect(f.host()?.phase).toBe('blocked')
  })
  it('pauses the host on normal unload and blocks a matching round on connection loss', async () => {
    const f = fixture(); await f.bridge.prepare(round); f.bridge.suspend()
    expect(f.host()?.phase).toBe('paused')
    const other = fixture(); await other.bridge.prepare(round); other.bridge.fail(new Error('process closed'))
    expect(other.host()?.phase).toBe('blocked')
  })
})
