/** Durable native-loop facts. Kept outside DSH's single-call usage/pressure slot. */
import { z } from 'zod'
import { appendPluginRecord, pluginRecordOf } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const usageSchema = z.object({
  inputTokens: count, outputTokens: count, totalTokens: count,
  cacheReadTokens: count, cacheWriteTokens: count, reasoningTokens: count,
})
export type Usage = z.infer<typeof usageSchema>
export const goalSchema = z.object({
  threadId: z.string(), objective: z.string().min(1).max(4000),
  status: z.enum(['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete']),
  tokenBudget: count.positive().nullable(), tokensUsed: count, timeUsedSeconds: count,
  createdAt: count, updatedAt: count,
})
export type NativeGoal = z.infer<typeof goalSchema>
export const nativeAgentSchema = z.object({
  threadId: z.string(), parentThreadId: z.string(), status: z.string(),
  task: z.string().optional(), model: z.string().optional(), reasoningEffort: z.string().optional(),
  message: z.string().optional(), path: z.string().optional(), activeTurnId: z.string().optional(),
  operation: z.string().optional(), interruptRequested: z.boolean().optional(),
})
export type NativeAgent = z.infer<typeof nativeAgentSchema>
const progressSchema = z.object({
  threadId: z.string(), turnId: z.string(), itemId: z.string(), type: z.string(), status: z.string(),
  output: z.string(), truncated: z.boolean(), messages: z.array(z.string()), patch: z.string().optional(),
})
export const zeroUsage = (): Usage => ({ inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 })
export const nativeStateSchema = z.object({
  version: z.literal(1), threadId: z.string().optional(), dshSessionId: z.string().optional(), turnId: z.string().optional(),
  usage: z.object({
    consumed: usageSchema, turnConsumed: usageSchema, nativeTotal: usageSchema.optional(), last: usageSchema.optional(),
    baseline: z.enum(['exact', 'inferred', 'reset']).optional(), turnId: z.string().optional(),
    contextWindow: count.positive().optional(), model: z.string().optional(),
  }),
  compaction: z.object({ status: z.enum(['idle', 'requested', 'running', 'completed', 'failed']), itemId: z.string().optional() }),
  mode: z.object({ selected: z.enum(['default', 'plan']), explicit: z.boolean(), capability: z.enum(['unknown', 'supported', 'unavailable']), error: z.string().optional() }).default({ selected: 'default', explicit: false, capability: 'unknown' }),
  plan: z.object({ turnId: z.string().optional(), explanation: z.string().optional(), steps: z.array(z.object({ step: z.string(), status: z.enum(['pending', 'inProgress', 'completed']) })), text: z.string(), final: z.boolean() }).default({ steps: [], text: '', final: false }),
  name: z.object({ title: z.string().optional(), nativeTitle: z.string().optional(), pinned: z.boolean(), error: z.string().optional() }).default({ pinned: false }),
  goal: goalSchema.nullable().default(null),
  goalControl: z.object({ capability: z.enum(['unknown', 'supported', 'unavailable']), continuation: z.literal('bounded'), error: z.string().optional() }).default({ capability: 'unknown', continuation: 'bounded' }),
  agents: z.record(z.string(), nativeAgentSchema).default({}),
  tools: z.record(z.string(), progressSchema).default({}),
  diff: z.object({ turnId: z.string(), text: z.string(), truncated: z.boolean() }).optional(),
  sentInputIds: z.array(z.string()).max(8192).default([]),
  steering: z.object({ id: z.string(), turnId: z.string(), text: z.string(), status: z.enum(['submitting', 'accepted', 'rejected', 'unknown']), error: z.string().optional() }).optional(),
  diagnostics: z.array(z.object({ id: z.string(), kind: z.string(), severity: z.enum(['info', 'warning', 'error']), message: z.string(), details: z.string().optional() })).max(100).default([]),
})
export type NativeState = z.infer<typeof nativeStateSchema>
export const initialNativeState = (): NativeState => nativeStateSchema.parse({ version: 1, usage: { consumed: zeroUsage(), turnConsumed: zeroUsage() }, compaction: { status: 'idle' } })
export const STATE_RECORD = 'plugin:tavlo-codex/state' as const

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap { 'plugin:tavlo-codex/state': NativeState }
}
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap { tavloCodex: NativeState }
}
export function foldNativeState(state: NativeState, event: SessionEvent): NativeState {
  const entry = pluginRecordOf(event)
  if (entry?.type !== STATE_RECORD) return state
  const parsed = nativeStateSchema.safeParse(entry.data)
  return parsed.success ? parsed.data : state
}
export function publishNativeState(session: Session, state: NativeState): void {
  appendPluginRecord(session, STATE_RECORD, nativeStateSchema.parse(state))
}
export const nativeStateProjection = {
  key: 'tavloCodex', stateVersion: 7, stateSchema: nativeStateSchema,
  init: initialNativeState, apply: foldNativeState,
  wire: { viewSchema: nativeStateSchema, view: (state: NativeState) => state, summary: false },
} satisfies ProjectionDefinition<'tavloCodex', NativeState>
