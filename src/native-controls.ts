import { RpcError } from './app-server.ts'
import { goalSchema } from './native-state.ts'
import type { NativeGoal, NativeState } from './native-state.ts'
import { isEffortLevel } from './models.ts'
import { record, text } from './protocol.ts'
export type Mode = 'default' | 'plan'
export interface ControlsDeps {
  state(): NativeState
  update(patch: Partial<NativeState>): void
  request(method: string, params: Record<string, unknown>): Promise<unknown>
}
export function collaborationMode(mode: Mode, model: string, effort: string | null): object {
  return { mode, settings: { model, reasoning_effort: isEffortLevel(effort ?? '') ? effort : null, developer_instructions: null } }
}
export function unsupported(error: unknown): boolean {
  return error instanceof RpcError && (error.code === -32601 || (error.code === -32600 || error.code === -32602) && /experimental|unknown|unsupported|unrecognized|not found/i.test(error.message))
}
/** Current Codex normalizes its legacy `fast` alias to the `priority` tier. */
export function isFastTier(tier: unknown): boolean { return tier === 'fast' || tier === 'priority' }

/** Thread mutations never rewrite sandbox settings or retry an ambiguous model submission. */
export class NativeControls {
  constructor(private readonly deps: ControlsDeps) {}
  async setFast(enabled: boolean): Promise<void> {
    const serviceTier = enabled ? 'fast' : null
    try {
      await this.deps.request('thread/settings/update', { serviceTier })
      this.deps.update({ speed: { selected: enabled ? 'fast' : 'standard', effectiveTier: serviceTier, capability: 'supported' } })
    } catch (error) {
      this.deps.update({ speed: { ...this.deps.state().speed, ...(unsupported(error) ? { capability: 'unavailable' } : {}), error: String(error) } })
      throw error
    }
  }
  restoreSpeed(serviceTier: unknown): void {
    if (serviceTier === null || typeof serviceTier === 'string') {
      this.deps.update({ speed: { ...this.deps.state().speed, effectiveTier: isFastTier(serviceTier) ? 'fast' : serviceTier === 'default' ? null : serviceTier } })
    }
  }
  async setMode(mode: Mode, model: string, effort: string | null): Promise<void> {
    try {
      await this.deps.request('thread/settings/update', { collaborationMode: collaborationMode(mode, model, effort) })
      this.deps.update({ mode: { selected: mode, explicit: true, capability: 'supported' } })
    } catch (error) {
      this.deps.update({ mode: { ...this.deps.state().mode, ...(unsupported(error) ? { capability: 'unavailable' } : {}), error: String(error) } })
      throw error
    }
  }
  restoreMode(raw: unknown): void {
    const mode = record(raw).mode
    if ((mode === 'plan' || mode === 'default') && !this.deps.state().mode.explicit) this.deps.update({ mode: { selected: mode, explicit: true, capability: 'supported' } })
  }
  async setName(title: string, pinned: boolean): Promise<void> {
    const previous = this.deps.state().name
    if (!pinned && previous.pinned) return
    const normalized = title.replace(/\s+/g, ' ').trim()
    if (!normalized || Buffer.byteLength(normalized) > 1024) throw new Error('会话名称需非空且不超过 1024 UTF-8 字节。')
    if (previous.title === normalized && previous.nativeTitle === normalized && previous.pinned === pinned && !previous.error) return
    this.deps.update({ name: { ...previous, title: normalized, pinned: previous.pinned || pinned } })
    try {
      await this.deps.request('thread/name/set', { name: normalized })
      const current = this.deps.state().name
      if (current.title === normalized) this.deps.update({ name: { title: normalized, nativeTitle: normalized, pinned: current.pinned } })
    } catch (error) {
      this.deps.update({ name: { ...this.deps.state().name, error: String(error) } })
      throw error
    }
  }
  observeName(raw: unknown): string | undefined {
    const name = text(raw).trim()
    if (!name) return undefined
    const previous = this.deps.state().name
    if (previous.nativeTitle === name) return undefined
    this.deps.update({ name: { ...previous, nativeTitle: name, ...(!previous.pinned ? { title: name } : {}) } })
    return previous.pinned ? undefined : name
  }
  observeGoal(raw: unknown): void {
    if (raw === null) {
      this.deps.update({ goal: null, goalControl: { capability: 'supported', continuation: 'bounded' } })
      return
    }
    const parsed = goalSchema.safeParse(raw)
    if (!parsed.success) throw new Error('Codex 返回的目标状态格式无效。')
    const previous = this.deps.state().goal
    if (previous && previous.updatedAt > parsed.data.updatedAt) return
    if (previous && JSON.stringify(previous) === JSON.stringify(parsed.data)) return
    this.deps.update({ goal: parsed.data, goalControl: { capability: 'supported', continuation: 'bounded' } })
  }
  private goalError(error: unknown): void {
    this.deps.update({ goalControl: { ...this.deps.state().goalControl, ...(unsupported(error) ? { capability: 'unavailable' } : {}), error: String(error) } })
  }
  async getGoal(): Promise<NativeGoal | null> {
    try {
      const result = record(await this.deps.request('thread/goal/get', {}))
      this.observeGoal(result.goal)
      return this.deps.state().goal
    } catch (error) { this.goalError(error); throw error }
  }
  async setGoal(objective: string): Promise<void> {
    const normalized = objective.trim()
    if (!normalized || normalized.length > 4000) throw new Error('目标需非空且不超过 4000 字符。')
    await this.getGoal()
    try {
      // Creation itself never launches an unmanaged native turn.
      const result = record(await this.deps.request('thread/goal/set', { origin: 'user', objective: normalized, status: 'paused' }))
      this.observeGoal(result.goal)
    } catch (error) { this.goalError(error); throw error }
  }
  async changeGoal(action: 'pause' | 'resume' | 'clear' | 'budget', budget?: number | null, origin: 'user' | 'automatic' = 'user'): Promise<void> {
    const current = await this.getGoal()
    if (!current) throw new Error('当前没有原生目标。')
    if (action === 'resume' && (current.status === 'usageLimited' || current.status === 'budgetLimited' && current.tokenBudget !== null && current.tokensUsed >= current.tokenBudget)) throw new Error('原生目标已达到用量／预算限制；不能自动解除限制。')
    if (action === 'resume' && current.status === 'complete') throw new Error('此目标已完成；请显式设置新目标。')
    if (action === 'budget' && budget !== null && (typeof budget !== 'number' || !Number.isSafeInteger(budget) || budget < 1)) throw new Error('预算需为正整数或 none。')
    try {
      if (action === 'clear') {
        await this.deps.request('thread/goal/clear', { origin })
        await this.getGoal()
      } else {
        const mutation = action === 'budget' ? { tokenBudget: budget } : { status: action === 'resume' ? 'active' : 'paused' }
        const result = record(await this.deps.request('thread/goal/set', { origin, ...mutation }))
        this.observeGoal(result.goal)
      }
    } catch (error) { this.goalError(error); throw error }
  }
}
