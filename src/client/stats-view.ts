import type { NativeView } from '../native-state.ts'

export function compactTokens(value: number): string {
  if (value < 1000) return String(value)
  const divisor = value < 1_000_000 ? 1000 : 1_000_000
  return `${Number((value / divisor).toFixed(1))}${divisor === 1000 ? 'K' : 'M'}`
}

/** Do not round a partial hit/occupancy to a full 100%. */
export function percent(numerator: number, denominator: number): string {
  const rounded = Math.round(numerator / denominator * 1000) / 10
  if (numerator < denominator && rounded >= 100) return '>99.9'
  if (numerator > 0 && rounded === 0) return '<0.1'
  return String(rounded)
}

export function statsView(state: NativeView, selectedModel?: string) {
  const usage = state.usage, total = usage.consumed
  const observed = usage.nativeTotal !== undefined || total.totalTokens > 0
  const input = total.inputTokens + total.cacheReadTokens + total.cacheWriteTokens
  const sameModel = !selectedModel || !usage.model || selectedModel === usage.model
  const sample = sameModel ? usage.last : undefined
  const timing = sameModel ? usage.lastTurn : undefined
  return {
    observed, total: observed ? total.totalTokens : undefined,
    cache: observed && input > 0 ? percent(total.cacheReadTokens, input) : undefined,
    speed: timing ? Number((timing.outputTokens / (timing.durationMs / 1000)).toFixed(1)) : undefined,
    context: sample && usage.contextWindow ? {
      used: sample.totalTokens, capacity: usage.contextWindow,
      percent: percent(sample.totalTokens, usage.contextWindow),
      fraction: Math.min(1, sample.totalTokens / usage.contextWindow),
    } : undefined,
  }
}
