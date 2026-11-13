/**
 * The mirror tool. Codex runs its own tools; DSH can only show and log calls that
 * go through a registered tool, so each Codex call is recorded as a `codex_tool` call
 * whose body runs nothing and waits for Codex to report the result.
 * @module tavlo-plugins-codex/codex-tool
 */

import { HarnessError } from '@deepseek-ai/dsh-llm'
import { defineTool, TOOL_ABORTED } from '@deepseek-ai/dsh-tools'
import type {
  FileDiff,
  ToolCallView,
  ToolDefinition,
  ToolResult,
  ToolResultView,
  ToolRunContext,
} from '@deepseek-ai/dsh-tools'
import { MIRROR_TOOL_NAME } from './constants.ts'
import type { MirrorArgs } from './mirror-args.ts'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ToolOutcome } from './events.ts'

/** What the tool needs from the plugin. */
export interface CodexToolDeps {
  waitForTool(exec: ToolRunContext): Promise<ToolOutcome>
}

const DIFF_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string', required: true },
    oldText: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
    newText: { type: 'string', required: true },
  },
} as const
const IMAGE_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    attachmentId: { type: 'string', required: true },
    mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], required: true },
    bytes: { type: 'integer', required: true },
    width: { type: 'integer', required: true }, height: { type: 'integer', required: true },
    name: { type: 'string' },
    originalDimensions: { type: 'object', additionalProperties: false, properties: { width: { type: 'integer', required: true }, height: { type: 'integer', required: true } } },
  },
} as const

function diffsOf(args: MirrorArgs): FileDiff[] {
  return (args.diffs ?? []).map((diff) => ({ ...diff }))
}

function presentCall(args: MirrorArgs): ToolCallView {
  if (args.command !== undefined) {
    return {
      card: 'terminal',
      title: args.command,
      ...(args.title === args.command ? {} : { description: args.title }),
    }
  }
  const locations = args.path === undefined ? undefined : [{ path: args.path }]
  const diffs = diffsOf(args)
  if (diffs.length > 0) return { card: 'diff', title: args.title, diffs, ...(locations === undefined ? {} : { locations }) }
  return {
    card: 'generic',
    title: args.title,
    kind: args.kind,
    rawInput: args.input,
    ...(locations === undefined ? {} : { locations }),
  }
}

function resultText(result: ToolResult): string {
  return result.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')
}

function presentResult(args: MirrorArgs, result: ToolResult): ToolResultView | undefined {
  if (result.isError) return undefined
  if (args.command !== undefined) return { card: 'terminal', output: resultText(result) }
  const diffs = diffsOf(args)
  return diffs.length > 0 ? { card: 'diff', diffs } : undefined
}

/** DSH aborts with a plain object, which would be logged as `[object Object]`. */
async function waitForOutcome(deps: CodexToolDeps, exec: ToolRunContext): Promise<ToolOutcome> {
  try {
    return await deps.waitForTool(exec)
  } catch (error: unknown) {
    if (!exec.signal.aborted) throw error
    const aborted = new HarnessError('tool call aborted', TOOL_ABORTED, { cause: error })
    aborted.name = 'AbortError'
    throw aborted
  }
}

/** Build the `codex_tool` definition. */
export function createCodexTool(deps: CodexToolDeps): ToolDefinition {
  return defineTool({
    name: MIRROR_TOOL_NAME,
    description: 'Records a tool call made by Codex. It runs nothing itself.',
    parameters: {
      tool: { type: 'string', required: true, description: "Codex's tool name." },
      title: { type: 'string', required: true, description: 'What the call does.' },
      kind: { type: 'string', required: true, description: 'The tool kind.' },
      command: { type: 'string', description: 'The shell command, for Bash.' },
      diffs: { type: 'array', items: DIFF_SCHEMA },
      path: { type: 'string', description: 'The file the call is about.' },
      input: { type: 'json', description: "Codex's raw input." },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { text: { type: 'string', required: true }, images: { type: 'array', items: IMAGE_SCHEMA } },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }, ...(value.images ?? []).map(attachment => ({ type: 'image' as const, attachment: attachment as unknown as ImageAttachmentRef }))],
    },
    async execute(_args, exec) {
      const outcome = await waitForOutcome(deps, exec)
      if (outcome.isError) throw new Error(outcome.text.length > 0 ? outcome.text : 'Codex 报告这次调用失败。')
      return { text: outcome.text, ...(outcome.images ? { images: [...outcome.images] } : {}) }
    },
    presentCall: (args) => presentCall(args as unknown as MirrorArgs),
    presentResult: (args, result) => presentResult(args as unknown as MirrorArgs, result),
  })
}
