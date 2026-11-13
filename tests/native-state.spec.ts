import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { foldNativeState, initialNativeState, nativeStateProjection, publishNativeState } from '../src/native-state.ts'

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
})
