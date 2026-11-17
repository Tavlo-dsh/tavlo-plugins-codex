import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { foldNativeState, initialNativeState, nativeStateProjection, nativeStateProjectionWithDefaults, publishNativeState } from '../src/native-state.ts'

describe('native state through real DSH persistence and projections', () => {
  it('publishes a client snapshot and recovers a checkpoint without touching the model surface', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(SessionProjectionRegistry)
      const handle = await ctx.sessionProjections.register(nativeStateProjection)
      const session = Session.create(SessionId('native-state-test'))
      const state = initialNativeState()
      state.threadId = 'thread'
      state.usage.consumed.totalTokens = 330
      state.usage.lastTurn = { turnId: 'turn', outputTokens: 30, durationMs: 1500 }
      state.speed = { selected: 'fast', effectiveTier: 'fast', capability: 'supported' }
      publishNativeState(session, state)
      expect(handle.stateOf(session)).toEqual(state)
      expect(ctx.sessionProjections.snapshot(session).values.tavloCodex).toEqual(state)
      expect(ctx.sessionProjections.summaryKeys().has('tavloCodex')).toBe(false)
      const checkpoint = ctx.sessionProjections.checkpoint(session)
      expect(checkpoint).toBeDefined()
      // Restoration is tested using the persisted event bytes, not only a mocked fold.
      const restored = Session.create(SessionId('restored'), JSON.parse(JSON.stringify(session.snapshotEvents())))
      expect(handle.stateOf(restored)).toEqual(state)
      expect(restored.surface.nodes).toHaveLength(0)
    } finally { await ctx.fiber.dispose() }
  })
  it('ignores malformed old records without changing the last known state', () => {
    const previous = initialNativeState()
    const malformed = { type: 'plugin:tavlo-codex/state', ignorable: true, data: { version: 99 }, seq: 0, time: 0 } as never
    expect(foldNativeState(previous, malformed)).toBe(previous)
  })
  it('loads pre-Fast records with inherited speed instead of dropping their state', () => {
    const previous = initialNativeState()
    const { speed: _speed, ...legacy } = previous
    const event = { type: 'plugin:tavlo-codex/state', ignorable: true, data: { ...legacy, threadId: 'old-thread' }, seq: 0, time: 0 } as never
    expect(foldNativeState(previous, event)).toMatchObject({ threadId: 'old-thread', speed: { selected: 'inherit', capability: 'unknown' } })
  })
  it.each([true, false, undefined])('exposes the deployment default %s without persisting it in history', async fastMode => {
    const ctx = new Context()
    try {
      await ctx.plugin(SessionProjectionRegistry)
      const handle = await ctx.sessionProjections.register(nativeStateProjectionWithDefaults(fastMode))
      const session = Session.create(SessionId('default-speed-test'))
      const state = initialNativeState()
      publishNativeState(session, state)
      expect(ctx.sessionProjections.snapshot(session).values.tavloCodex).toEqual({
        ...state, ...(fastMode === undefined ? {} : { fastModeDefault: fastMode }),
      })
      expect(handle.stateOf(session)).toEqual(state)
      expect(JSON.stringify(session.snapshotEvents())).not.toContain('fastModeDefault')
    } finally { await ctx.fiber.dispose() }
  })
})
