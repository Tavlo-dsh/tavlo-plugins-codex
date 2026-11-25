import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { appendPluginRecord, Session, SessionId } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { foldNativeState, initialNativeState, nativeStateProjection, nativeStateProjectionWithDefaults, publishNativeState, STATE_RECORD } from '../src/native-state.ts'

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
      publishNativeState(session, state, handle.stateOf(session))
      expect(handle.stateOf(session)).toEqual(state)
      expect(ctx.sessionProjections.snapshot(session).values.tavloCodex).toMatchObject({ threadId: 'thread', usage: state.usage, speed: state.speed })
      expect(ctx.sessionProjections.summaryKeys().has('tavloCodex')).toBe(false)
      const checkpoint = ctx.sessionProjections.checkpoint(session)
      expect(checkpoint).toBeDefined()
      // Restoration is tested using the persisted event bytes, not only a mocked fold.
      const restored = Session.create(SessionId('restored'), JSON.parse(JSON.stringify(session.snapshotEvents())))
      expect(handle.stateOf(restored)).toEqual(state)
      expect(restored.surface.nodes).toHaveLength(0)
    } finally { await ctx.fiber.dispose() }
  })
  it('replays mixed legacy and incremental records without duplicating unchanged tool output', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(SessionProjectionRegistry)
      const handle = await ctx.sessionProjections.register(nativeStateProjection)
      const session = Session.create(SessionId('long-history'))
      const state = initialNativeState()
      const output = 'retained output'.repeat(4096)
      state.tools.first = { threadId: 'thread', turnId: 'turn', itemId: 'first', type: 'commandExecution', status: 'completed', output, truncated: false, messages: [] }
      state.diff = { turnId: 'turn', text: output, truncated: false }
      state.turnId = 'turn'
      appendPluginRecord(session, STATE_RECORD, state)
      const publish = () => publishNativeState(session, state, handle.stateOf(session))
      for (let turn = 1; turn <= 50; turn++) {
        state.usage.consumed.totalTokens = turn
        publish()
      }
      const wire = ctx.sessionProjections.snapshot(session).values.tavloCodex
      expect(wire).not.toHaveProperty('tools')
      expect(wire).not.toHaveProperty('diff')
      const incremental = JSON.stringify(session.snapshotEvents().slice(1))
      expect(incremental).not.toContain(output)
      expect(incremental.length).toBeLessThan(output.length * 2)
      state.tools.second = { ...state.tools.first, itemId: 'second', output: 'new' }
      delete state.tools.first
      delete state.diff
      delete state.turnId
      publish()
      state.tools.second.output = 'updated'
      publish()
      const count = session.snapshotEvents().length
      publish()
      expect(session.snapshotEvents()).toHaveLength(count)
      const reopened = Session.create(SessionId('long-history-reopened'), JSON.parse(JSON.stringify(session.snapshotEvents())))
      expect(handle.stateOf(reopened)).toStrictEqual(state)
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
      publishNativeState(session, state, handle.stateOf(session))
      expect(ctx.sessionProjections.snapshot(session).values.tavloCodex).toEqual({
        ...nativeStateProjection.wire.view(state), ...(fastMode === undefined ? {} : { fastModeDefault: fastMode }),
      })
      expect(handle.stateOf(session)).toEqual(state)
      expect(JSON.stringify(session.snapshotEvents())).not.toContain('fastModeDefault')
    } finally { await ctx.fiber.dispose() }
  })
})
