import type { FileDiff, ToolCallKind } from '@deepseek-ai/dsh-tools'
import type { NativeItem } from './protocol.ts'
import { record, text } from './protocol.ts'
export interface MirrorArgs {
  readonly tool: string
  readonly title: string
  readonly kind: ToolCallKind
  readonly command?: string
  readonly diffs?: readonly FileDiff[]
  readonly path?: string
  readonly input: unknown
}

/** Diff cards show the exact patch fragments supplied by Codex, without reading files after an edit. */
function patchFragments(diff: string): { oldText: string; newText: string } {
  const oldLines: string[] = [], newLines: string[] = []
  for (const line of diff.split('\n')) {
    if (/^(---|\+\+\+|@@|diff |index |\\)/.test(line)) continue
    if (line.startsWith('-')) oldLines.push(line.slice(1))
    else if (line.startsWith('+')) newLines.push(line.slice(1))
    else if (line.startsWith(' ')) { oldLines.push(line.slice(1)); newLines.push(line.slice(1)) }
  }
  return { oldText: oldLines.join('\n'), newText: newLines.join('\n') }
}
export function mirrorArgs(item: NativeItem): MirrorArgs {
  const base = { tool: item.type, title: item.type, kind: 'other' as ToolCallKind, input: item.type === 'imageGeneration' ? { ...item, ...(typeof item.result === 'string' ? { result: '[image payload stored as attachment]' } : {}) } : item }
  switch (item.type) {
    case 'commandExecution': return { ...base, title: text(item.command), command: text(item.command), kind: 'execute' }
    case 'fileChange': {
      const diffs: FileDiff[] = (Array.isArray(item.changes) ? item.changes : []).map(raw => {
        const change = record(raw), kind = record(change.kind)
        const fragments = patchFragments(text(change.diff))
        return { path: text(change.path), oldText: kind.type === 'add' ? null : fragments.oldText, newText: fragments.newText }
      })
      return { ...base, title: `Edit ${diffs.map(diff => diff.path).join(', ')}`, kind: 'edit', diffs, ...(diffs[0] ? { path: diffs[0].path } : {}) }
    }
    case 'mcpToolCall': return { ...base, title: `${text(item.server)} · ${text(item.tool)}` }
    case 'webSearch': return { ...base, title: `Search ${text(item.query)}`, kind: 'fetch' }
    case 'imageView': return { ...base, title: `View ${text(item.path)}`, kind: 'read', path: text(item.path) }
    case 'collabAgentToolCall': return { ...base, title: `${text(item.tool)} ${text(item.prompt).slice(0, 100)}`.trim() }
    case 'requestUserInput': return { ...base, title: 'Codex 向用户提问' }
    case 'approval': return { ...base, title: text(item.reason) || 'Codex 请求审批' }
    default: return base
  }
}
