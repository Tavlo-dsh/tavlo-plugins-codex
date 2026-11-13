import { describe, expect, it } from 'vitest'
import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import { initialNativeState } from '../src/native-state.ts'
import { UsageTracker } from '../src/usage-tracker.ts'
import { tokenUsage } from '../src/events.ts'

const sample = (inputTokens: number, outputTokens = 10, cachedInputTokens = 0, cacheWriteInputTokens = 0) => ({
  inputTokens, outputTokens, totalTokens: inputTokens + outputTokens,
  cachedInputTokens, cacheWriteInputTokens, reasoningOutputTokens: Math.min(2, outputTokens),
})
const wire = (total: ReturnType<typeof sample>, last = total, modelContextWindow: number | null = 200000) => ({ total, last, modelContextWindow })
const tracker = (fresh = true) => new UsageTracker(initialNativeState().usage, fresh)

describe('native consumption and latest context', () => {
  it('confirms the installed DSH assembler replaces usage within one step', () => {
    const assembler = new BlockAssembler()
    assembler.push({ type: 'usage', usage: { inputTokens: 100, outputTokens: 10 } })
    assembler.push({ type: 'usage', usage: { inputTokens: 200, outputTokens: 20 } })
    expect(assembler.usage).toEqual({ inputTokens: 200, outputTokens: 20 })
  })
  it('counts three requests once while retaining only the last context sample', () => {
    const t = tracker(); t.beginTurn('model')
    expect(t.update(wire(sample(100, 10, 20, 10)), 't1', 'model', true)).toBe(true)
    expect(t.update(wire(sample(300, 30, 60, 30), sample(200, 20, 40, 20)), 't1', 'model', true)).toBe(true)
    expect(t.update(wire(sample(600, 60, 120, 60), sample(300, 30, 60, 30)), 't1', 'model', true)).toBe(true)
    expect(t.update(wire(sample(600, 60, 120, 60), sample(300, 30, 60, 30)), 't1', 'model', true)).toBe(false)
    expect(t.snapshot.consumed).toEqual({ inputTokens: 420, outputTokens: 60, cacheReadTokens: 120, cacheWriteTokens: 60, reasoningTokens: 2, totalTokens: 660 })
    expect(t.snapshot.last?.totalTokens).toBe(330)
  })
  it('rejects invalid counts and inconsistent cache/reasoning buckets', () => {
    for (const value of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) expect(tokenUsage(sample(value))).toBeUndefined()
    expect(tokenUsage(sample(10, 1, 8, 5))).toBeUndefined()
    expect(tokenUsage({ ...sample(10, 1), reasoningOutputTokens: 2 })).toBeUndefined()
    const t = tracker(); t.beginTurn('model')
    expect(t.update(wire(sample(10), sample(20)), 't', 'model', true)).toBe(false)
    expect(t.snapshot.consumed.totalTokens).toBe(0)
  })
  it('resumes from a durable watermark without charging it again', () => {
    const original = tracker(); original.beginTurn('model')
    original.update(wire(sample(100)), 't1', 'model', true)
    const resumed = new UsageTracker(original.snapshot, false)
    expect(resumed.update(wire(sample(100)), 't1', 'model', false)).toBe(false)
    resumed.beginTurn('model'); resumed.setActiveTurnId('t2')
    resumed.update(wire(sample(300, 30), sample(200, 20)), 't2', 'model', true)
    expect(resumed.snapshot.consumed.totalTokens).toBe(330)
    expect(resumed.snapshot.turnConsumed.totalTokens).toBe(220)
  })
  it('uses an idle resume notification as the baseline and marks unknown active history', () => {
    const resumed = tracker(false)
    resumed.update(wire(sample(9000, 900), sample(100)), 'old', 'model', false)
    expect(resumed.snapshot.consumed.totalTokens).toBe(0)
    resumed.beginTurn('model'); resumed.setActiveTurnId('new')
    resumed.update(wire(sample(9100, 910), sample(100)), 'new', 'model', true)
    expect(resumed.snapshot.turnConsumed.totalTokens).toBe(110)
    const unknown = tracker(false); unknown.beginTurn('model')
    unknown.update(wire(sample(9100, 910), sample(100)), 'new', 'model', true)
    expect(unknown.snapshot.consumed.totalTokens).toBe(110)
    expect(unknown.snapshot.baseline).toBe('inferred')
  })
  it('ignores stale turn samples and handles a confirmed counter reset only once', () => {
    const t = tracker(); t.beginTurn('model'); t.setActiveTurnId('t1')
    t.update(wire(sample(100)), 't1', 'model', true)
    t.beginTurn('model'); t.setActiveTurnId('t2')
    expect(t.update(wire(sample(80)), 't1', 'model', true)).toBe(false)
    expect(t.update(wire(sample(20, 2)), 't2', 'model', true)).toBe(true)
    expect(t.snapshot.baseline).toBe('reset')
    expect(t.update(wire(sample(10, 1)), 't2', 'model', true)).toBe(false)
    expect(t.snapshot.consumed.totalTokens).toBe(132)
  })
  it('keeps queued-turn consumption and rebases forked native history', () => {
    const t = tracker(); t.beginTurn('model')
    t.update(wire(sample(100)), 't1', 'model', true)
    t.beginTurn('model'); t.setActiveTurnId('t2')
    t.update(wire(sample(300, 30), sample(200, 20)), 't2', 'model', true)
    expect(t.snapshot.consumed.totalTokens).toBe(330)
    expect(t.snapshot.turnConsumed.totalTokens).toBe(220)
    t.rebaseUnknown(); t.beginTurn('other'); t.setActiveTurnId('fork-turn')
    t.update(wire(sample(1300, 130), sample(50, 5)), 'fork-turn', 'other', true)
    expect(t.snapshot.consumed.totalTokens).toBe(385)
    expect(t.snapshot.turnConsumed.totalTokens).toBe(55)
    t.beginTurn('new-model')
    expect(t.snapshot.last).toBeUndefined()
    expect(t.snapshot.contextWindow).toBeUndefined()
  })
})
