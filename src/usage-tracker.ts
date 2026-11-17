import { tokenUsage } from './events.ts'
import { zeroUsage } from './native-state.ts'
import type { NativeState, Usage } from './native-state.ts'
import { positiveInteger, record } from './protocol.ts'

const fields = Object.keys(zeroUsage()) as (keyof Usage)[]
const normalize = (raw: unknown): Usage | undefined => {
  const u = tokenUsage(raw)
  return u === undefined ? undefined : { ...zeroUsage(), ...u }
}
const add = (a: Usage, b: Usage): Usage => Object.fromEntries(fields.map(k => [k, a[k] + b[k]])) as Usage
const subtract = (a: Usage, b: Usage): Usage => Object.fromEntries(fields.map(k => [k, a[k] - b[k]])) as Usage
const contains = (a: Usage, b: Usage): boolean => fields.every(k => a[k] >= b[k])

/** A cumulative watermark, not a sum of notifications. Unknown resumed history is excluded. */
export class UsageTracker {
  private unknownBaseline: boolean
  private resetAllowed = false
  private activeTurnId: string | undefined
  private finishedTurn: { turnId: string; durationMs: number } | undefined
  constructor(private state: NativeState['usage'], newThread: boolean) {
    this.unknownBaseline = !newThread && state.nativeTotal === undefined
    this.finishedTurn = state.lastTurn
    if (newThread) this.resetThread()
  }
  get snapshot(): NativeState['usage'] { return structuredClone(this.state) }
  beginTurn(model: string): void {
    const changedModel = this.state.model !== undefined && this.state.model !== model
    this.resetAllowed = true
    this.activeTurnId = undefined
    this.finishedTurn = undefined
    this.state = { ...this.state, model, turnConsumed: zeroUsage() }
    if (changedModel) { this.clearContext(); delete this.state.lastTurn }
  }
  clearContext(): void { delete this.state.last; delete this.state.contextWindow }
  clearSample(): void { delete this.state.last }
  resetThread(): void {
    this.unknownBaseline = false
    this.resetAllowed = false
    this.activeTurnId = undefined
    this.finishedTurn = undefined
    this.state = { consumed: zeroUsage(), turnConsumed: zeroUsage(), nativeTotal: zeroUsage(), baseline: 'exact' }
  }
  rebaseUnknown(): void {
    this.unknownBaseline = true
    delete this.state.nativeTotal
    delete this.state.turnId
    delete this.state.lastTurn
    this.finishedTurn = undefined
    this.clearContext()
    this.state.turnConsumed = zeroUsage()
  }
  setActiveTurnId(turnId: string | undefined): void {
    this.activeTurnId = turnId
    if (turnId && this.state.turnId !== turnId) this.state = { ...this.state, turnId }
  }
  /** Pair output with native whole-turn duration, never a DSH mirrored tool step's timing. */
  finishTurn(turnId: string, durationMs: unknown): void {
    if (!positiveInteger(durationMs) || this.activeTurnId !== turnId || this.finishedTurn?.turnId === turnId) return
    this.finishedTurn = { turnId, durationMs }
    this.refreshTurnTiming()
  }
  private refreshTurnTiming(): void {
    if (this.finishedTurn && this.state.turnId === this.finishedTurn.turnId) {
      const outputTokens = this.state.turnConsumed.outputTokens
      if (positiveInteger(outputTokens)) {
        this.state = { ...this.state, lastTurn: { ...this.finishedTurn, outputTokens } }
      }
    }
  }
  update(raw: unknown, turnId: string | undefined, model: string, active: boolean): boolean {
    const wire = record(raw), total = normalize(wire.total), last = normalize(wire.last)
    if (total === undefined || last === undefined || !contains(total, last)) return false
    const previous = this.state.nativeTotal
    if (active && turnId !== undefined) {
      if (this.activeTurnId !== undefined && this.activeTurnId !== turnId) return false
      if (this.activeTurnId === undefined && this.state.turnId === turnId) return false
      this.activeTurnId = turnId
    }
    const lateCompletedTurn = !active && turnId === undefined
      && this.activeTurnId !== undefined && this.finishedTurn?.turnId === this.activeTurnId
    const effectiveTurnId = turnId ?? (lateCompletedTurn || active ? this.activeTurnId : undefined)
    const observedTurn = active || lateCompletedTurn || (turnId !== undefined && turnId === this.activeTurnId)
    let delta: Usage
    let baseline = this.state.baseline ?? 'exact'
    if (!observedTurn) {
      // Startup/idle observations establish the watermark without charging history.
      if (previous && !contains(total, previous)) return false
      delta = previous ? subtract(total, previous) : zeroUsage()
    } else if (this.unknownBaseline || previous === undefined) {
      delta = last
      baseline = 'inferred'
    } else if (!contains(total, previous)) {
      if (!this.resetAllowed) return false // stale notification in the same native turn
      delta = last
      baseline = 'reset'
    } else delta = subtract(total, previous)
    const contextWindow = positiveInteger(wire.modelContextWindow) ? wire.modelContextWindow : undefined
    const changed = fields.some(k => delta[k] !== 0)
      || fields.some(k => this.state.last?.[k] !== last[k])
      || this.state.contextWindow !== contextWindow
      || this.state.nativeTotal === undefined
      || fields.some(k => this.state.nativeTotal?.[k] !== total[k])
      || this.state.turnId !== effectiveTurnId || this.state.model !== model || this.state.baseline !== baseline
    if (!changed) return false
    this.resetAllowed = false
    this.unknownBaseline = false
    const { contextWindow: _oldContextWindow, ...withoutOldContextWindow } = this.state
    this.state = {
      ...withoutOldContextWindow, nativeTotal: total, last, baseline, model,
      consumed: add(this.state.consumed, delta),
      turnConsumed: observedTurn ? add(this.state.turnConsumed, delta) : this.state.turnConsumed,
      ...(effectiveTurnId ? { turnId: effectiveTurnId } : {}),
      ...(contextWindow === undefined ? {} : { contextWindow }),
    }
    this.refreshTurnTiming()
    return true
  }
}
