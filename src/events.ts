import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { NativeItem } from './protocol.ts'
import { record, text } from './protocol.ts'

export interface ToolOutcome { text: string; isError: boolean; images?: readonly ImageAttachmentRef[] }
export const TOOL_TYPES = new Set(['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'collabAgentToolCall', 'webSearch', 'imageView', 'imageGeneration'])
export function itemOutcome(item: NativeItem): ToolOutcome {
  const result = record(item.result), error = record(item.error)
  const isError = ['failed', 'declined'].includes(text(item.status)) || item.success === false || result.isError === true || item.error != null || (typeof item.exitCode === 'number' && item.exitCode !== 0)
  if (item.type === 'imageGeneration' || item.type === 'imageView') return { text: item.type === 'imageView' ? 'Codex viewed image.' : 'Codex image generation completed.', isError: isError || item.failure != null }
  let output = text(item.aggregatedOutput) || text(error.message)
  const content = Array.isArray(result.content) ? result.content : Array.isArray(item.contentItems) ? item.contentItems : []
  if (!output && content.length) output = content.map(raw => text(record(raw).text)).filter(Boolean).join('\n')
  return { text: output || JSON.stringify(item), isError }
}
/** `last` is the latest model request, while `total` is cumulative across the thread. */
export function tokenUsage(raw: unknown): TokenUsage | undefined {
  const usage = record(raw)
  const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
  if (!count(usage.inputTokens) || !count(usage.outputTokens)) return undefined
  for (const key of ['cachedInputTokens', 'cacheWriteInputTokens', 'reasoningOutputTokens', 'totalTokens']) {
    if (usage[key] !== undefined && !count(usage[key])) return undefined
  }
  const cached = typeof usage.cachedInputTokens === 'number' ? usage.cachedInputTokens : 0
  const written = typeof usage.cacheWriteInputTokens === 'number' ? usage.cacheWriteInputTokens : 0
  if (cached + written > usage.inputTokens || (typeof usage.reasoningOutputTokens === 'number' && usage.reasoningOutputTokens > usage.outputTokens)) return undefined
  return {
    inputTokens: usage.inputTokens - cached - written, outputTokens: usage.outputTokens,
    totalTokens: usage.inputTokens + usage.outputTokens,
    cacheReadTokens: cached, cacheWriteTokens: written,
    ...(typeof usage.reasoningOutputTokens === 'number' ? { reasoningTokens: usage.reasoningOutputTokens } : {}),
  }
}
