/** DSH owns goal identity and scheduling; Codex executes one admitted round. */
import type { NativeControls } from './native-controls.ts'
import type { NativeGoal, NativeState } from './native-state.ts'
import { record } from './protocol.ts'

export interface HostGoalRef { id: string; revision: number }
export interface HostGoal extends HostGoalRef {
  objective: string
  phase: 'active' | 'paused' | 'blocked' | 'complete'
  activation: 'armed' | 'disarmed'
  roundsStarted: number
}
export interface HostGoalRound extends HostGoalRef { round: number }
export interface HostGoalPort {
  current(): HostGoal | undefined
  settle(ref: HostGoalRef, phase: 'paused' | 'blocked' | 'complete', reason?: { code: string; message: string }): void
}
interface Deps {
  host?: HostGoalPort
  state(): NativeState
  bind(binding: NativeState['hostGoal']): void
  controls: NativeControls
  request(method: string, params: Record<string, unknown>): Promise<unknown>
}
const same = (a: HostGoalRef | null | undefined, b: HostGoalRef | null | undefined): boolean => !!a && !!b && a.id === b.id && a.revision === b.revision

export class HostGoalBridge {
  private chain: Promise<void> = Promise.resolve()
  private round: HostGoalRef | undefined
  reporting = false
  synchronizing = false
  constructor(private readonly deps: Deps) {}
  current(): HostGoal | undefined { return this.deps.host?.current() }
  managed(): boolean { return !!this.current() || !!this.deps.state().hostGoal }
  invalidated(): boolean {
    const goal = this.current()
    return !!this.round && (!same(this.round, goal) || goal?.phase !== 'active' || goal.activation !== 'armed')
  }
  accepts(round: HostGoalRound): boolean {
    const goal = this.current()
    return same(round, goal) && goal?.phase === 'active' && goal.activation === 'armed' && round.round > 0 && round.round === goal.roundsStarted
  }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const next = this.chain.then(async () => {
      this.synchronizing = true
      try { return await action() }
      finally { this.synchronizing = false }
    })
    this.chain = next.then(() => undefined, () => undefined)
    return next
  }
  private settle(ref: HostGoalRef, phase: 'paused' | 'blocked' | 'complete', reason?: { code: string; message: string }): void {
    const current = this.current()
    if (!same(ref, current) || current?.phase !== 'active') return
    this.reporting = true
    try { this.deps.host?.settle(ref, phase, reason) }
    finally { this.reporting = false }
  }
  private report(ref: HostGoalRef, goal: NativeGoal | null, allowPause: boolean): void {
    const binding = this.deps.state().hostGoal
    if (!same(ref, binding)) return
    if (!goal) {
      this.settle(ref, 'blocked', { code: 'codex-goal-cleared', message: 'Codex 原生目标已清除，请检查目标后恢复。' })
      return
    }
    if (goal.objective !== binding?.objective || goal.createdAt !== binding.nativeCreatedAt) return
    if (goal.status === 'complete') this.settle(ref, 'complete')
    else if (goal.status === 'paused' && allowPause) this.settle(ref, 'paused')
    else if (['blocked', 'budgetLimited', 'usageLimited'].includes(goal.status)) {
      this.settle(ref, 'blocked', { code: goal.status === 'budgetLimited' ? 'codex-token-budget' : goal.status === 'usageLimited' ? 'codex-usage-limit' : 'codex-blocked', message: goal.status === 'budgetLimited'
        ? 'Codex 原生目标已达到 token 预算；增加 DSH 轮数不会解除此限制。'
        : goal.status === 'usageLimited' ? 'Codex 已达到原生用量限制。' : 'Codex 报告目标受阻，请查看本轮回复。' })
    }
  }
  private async write(params: Record<string, unknown>): Promise<void> {
    const result = record(await this.deps.request('thread/goal/set', { origin: 'user', ...params }))
    this.deps.controls.observeGoal(result.goal)
  }
  /** Synchronize without creating an unowned native continuation. */
  sync(): Promise<void> {
    return this.serial(async () => {
      const requested = this.current()
      try { await this.syncNow(false) }
      catch (error) {
        if (requested) this.settle(requested, 'blocked', { code: 'codex-goal-sync', message: String(error).slice(0, 1000) })
        throw error
      }
    })
  }
  private async syncNow(activate: boolean): Promise<boolean> {
    let host = this.current()
    const binding = this.deps.state().hostGoal
    if (!host && !binding) return true
    let native = await this.deps.controls.getGoal()
    if (!host) {
      if (binding && native?.objective === binding.objective && native.createdAt === binding.nativeCreatedAt) await this.deps.controls.changeGoal('clear')
      this.deps.bind(null)
      return !this.current()
    }
    if (!same(host, this.current())) return false
    if (same(host, binding)) {
      this.report(host, native, false)
      host = this.current()
      if (!host) return false
    }
    // Completed historical DSH goals do not claim a fresh native thread.
    if (!binding && host.phase === 'complete') return true
    const captured = host
    if (!binding || binding.id !== host.id || binding.objective !== host.objective || !native || native.objective !== host.objective) {
      if (!host.objective.trim() || host.objective.length > 4000) throw new Error('Codex 目标需非空且不超过 4000 字符。')
      await this.write({ objective: host.objective, status: 'paused', tokenBudget: null })
      native = this.deps.state().goal
    }
    if (!native) throw new Error('Codex 没有返回目标。')
    this.deps.bind({ id: host.id, revision: host.revision, objective: host.objective, nativeCreatedAt: native.createdAt })
    if (!same(captured, this.current())) return false
    const active = activate && host.phase === 'active' && host.activation === 'armed'
    if (active && (native.status === 'usageLimited' || native.status === 'budgetLimited' || native.tokenBudget !== null && native.tokensUsed >= native.tokenBudget)) {
      this.settle(host, 'blocked', { code: 'codex-budget-limit', message: 'Codex 已达到原生预算／用量限制，不能仅通过恢复 DSH 目标解除。' })
      return false
    }
    // A UI pause/resume edge must not erase a native limit before prepare checks it.
    if (!active && ['usageLimited', 'budgetLimited'].includes(native.status) && host.phase !== 'complete') return true
    const status = active ? 'active' : host.phase === 'complete' ? 'complete' : host.phase === 'blocked' ? 'blocked' : 'paused'
    if (native.status !== status) await this.write({ status })
    return same(captured, this.current())
  }
  prepare(source?: HostGoalRound): Promise<boolean> {
    return this.serial(async () => {
      if (source && !this.accepts(source)) return false
      const requested = this.current()
      try {
        const stable = await this.syncNow(true)
        if (!stable || source && !this.accepts(source)) {
          if (source) return false
          throw new Error('目标状态在准备期间发生变化，请重试当前输入。')
        }
        const current = this.current()
        this.round = current?.phase === 'active' && current.activation === 'armed' ? { id: current.id, revision: current.revision } : undefined
        return true
      } catch (error) {
        if (requested) this.settle(requested, 'blocked', { code: 'codex-goal-sync', message: String(error).slice(0, 1000) })
        throw error
      }
    })
  }
  /** Re-read authority before reporting; automatic boundary pauses never echo to DSH. */
  finish(failure?: string): Promise<void> {
    const round = this.round
    this.round = undefined
    return this.serial(async () => {
      try {
        const goal = await this.deps.controls.getGoal()
        if (round) {
          // Native failures may already mark the goal blocked. Keep the actual
          // turn error instead of settling first with the generic blocker.
          if (failure) this.settle(round, 'blocked', { code: 'codex-turn-failed', message: failure.slice(0, 1000) })
          else this.report(round, goal, true)
        }
        if (this.deps.state().goal?.status === 'active') await this.deps.controls.changeGoal('pause', undefined, 'automatic')
      } catch (error) {
        if (round) this.settle(round, 'blocked', { code: 'codex-goal-sync', message: String(error).slice(0, 1000) })
        throw error
      }
    })
  }
  fail(error: Error): void {
    const round = this.round
    this.round = undefined
    if (round) this.settle(round, 'blocked', { code: 'codex-connection-lost', message: error.message.slice(0, 1000) })
  }
  suspend(): void {
    const current = this.current()
    if (current && this.deps.state().hostGoal) this.settle(current, 'paused')
    this.round = undefined
  }
}
