/** Narrow wire types for the Codex v2 app-server protocol (verified with CLI 0.167.2). */
export type RpcId = string | number
export interface RpcRequest { id: RpcId; method: string; params: Record<string, unknown> }
export interface RpcNotification { method: string; params: Record<string, unknown> }
export type EffortLevel = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'
export interface ModelInfo {
  model: string
  displayName: string
  description: string
  hidden?: boolean
  supportedReasoningEfforts?: { reasoningEffort: string; description?: string }[]
  inputModalities?: readonly string[]
}
export type UserInput = { type: 'text'; text: string; text_elements: [] } | { type: 'image'; url: string }

/** Keep unknown optional fields intact so new CLI versions remain usable. */
export interface NativeItem extends Record<string, unknown> { id: string; type: string }
export function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
export function text(value: unknown): string { return typeof value === 'string' ? value : '' }
export function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}
/** Prefer the native duration, falling back to the protocol's second-based turn timestamps. */
export function turnDurationMs(turn: unknown): number | undefined {
  const value = record(turn)
  if (positiveInteger(value.durationMs)) return value.durationMs
  const { startedAt, completedAt } = value
  if (!positiveInteger(startedAt) || !positiveInteger(completedAt) || completedAt <= startedAt) return undefined
  const duration = (completedAt - startedAt) * 1000
  return Number.isSafeInteger(duration) && duration > 0 ? duration : undefined
}
