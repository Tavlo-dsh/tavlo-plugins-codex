import type { NativeState } from './native-state.ts'
import type { RpcNotification } from './protocol.ts'
import { record, text } from './protocol.ts'

export const MAX_TOOL_OUTPUT = 64 * 1024
export function boundedOutput(value: string): { text: string; truncated: boolean } {
  return { text: value.slice(-MAX_TOOL_OUTPUT), truncated: value.length > MAX_TOOL_OUTPUT }
}
const done = new Set(['completed', 'failed', 'interrupted', 'declined', 'connectionLost'])
export class NativeProgress {
  constructor(private readonly state: () => NativeState, private readonly update: (patch: Partial<NativeState>, final: boolean) => void) {}
  notification({ method, params: p }: RpcNotification): void {
    const threadId = text(p.threadId), turnId = text(p.turnId), itemId = text(p.itemId)
    if (threadId !== this.state().threadId && !this.state().agents[threadId]) return
    if (method === 'turn/diff/updated') {
      if (threadId !== this.state().threadId) return
      const output = boundedOutput(text(p.diff))
      this.update({ diff: { turnId, ...output } }, false)
      return
    }
    const rawItem = record(p.item), id = itemId || text(rawItem.id)
    if (!id) return
    const key = `${threadId}:${id}`, previous = this.state().tools[key]
    const delta = method === 'item/commandExecution/outputDelta' || method === 'item/fileChange/outputDelta'
    const mcp = method === 'item/mcpToolCall/progress', patch = method === 'item/fileChange/patchUpdated'
    const item = (method === 'item/started' || method === 'item/completed') && ['commandExecution', 'mcpToolCall', 'fileChange'].includes(text(rawItem.type))
    if (!delta && !mcp && !patch && !item) return
    if (previous && done.has(previous.status)) return
    if (!previous && Object.keys(this.state().tools).length >= 128) {
      const oldest = Object.entries(this.state().tools).find(([, value]) => done.has(value.status))
      if (!oldest) return
      const tools = { ...this.state().tools }; delete tools[oldest[0]]
      this.update({ tools }, false)
    }
    const output = boundedOutput(delta ? (previous?.output ?? '') + text(p.delta) : typeof rawItem.aggregatedOutput === 'string' ? rawItem.aggregatedOutput : previous?.output ?? '')
    const messages = mcp ? [...(previous?.messages ?? []).filter(message => message !== text(p.message)), text(p.message).slice(0, 4000)].slice(-32) : previous?.messages ?? []
    const changes = Array.isArray(p.changes) ? p.changes : Array.isArray(rawItem.changes) ? rawItem.changes : undefined
    const changeText = changes?.map(change => `${text(record(change).path)}\n${text(record(change).diff)}`).join('\n')
    const next = {
      threadId, turnId, itemId: id, type: text(rawItem.type) || previous?.type || (mcp ? 'mcpToolCall' : patch ? 'fileChange' : 'commandExecution'),
      status: method === 'item/completed' ? text(rawItem.status) || 'completed' : previous?.status ?? 'inProgress',
      output: output.text, truncated: typeof rawItem.aggregatedOutput === 'string' ? output.truncated : output.truncated || previous?.truncated === true,
      messages, ...(changeText !== undefined ? { patch: boundedOutput(changeText).text } : previous?.patch ? { patch: previous.patch } : {}),
    }
    this.update({ tools: { ...this.state().tools, [key]: next } }, method === 'item/completed')
  }
  stop(status: 'interrupted' | 'connectionLost'): void {
    const tools = Object.fromEntries(Object.entries(this.state().tools).map(([key, item]) => [key, done.has(item.status) ? item : { ...item, status }]))
    this.update({ tools }, true)
  }
}
