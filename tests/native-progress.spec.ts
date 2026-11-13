import { describe, expect, it } from 'vitest'
import { MAX_TOOL_OUTPUT, NativeProgress } from '../src/native-progress.ts'
import { initialNativeState } from '../src/native-state.ts'

describe('bounded native tool progress', () => {
  function setup() {
    let state = { ...initialNativeState(), threadId: 'thread' }
    const progress = new NativeProgress(() => state, patch => { state = { ...state, ...patch } })
    const emit = (method: string, params: Record<string, unknown>) => progress.notification({ method, params: { threadId: 'thread', turnId: 'turn', ...params } })
    return { emit, progress, state: () => state }
  }
  it('bounds streamed command output and replaces it with final output instead of duplicating it', () => {
    const t = setup()
    t.emit('item/started', { item: { type: 'commandExecution', id: 'cmd', status: 'inProgress' } })
    t.emit('item/commandExecution/outputDelta', { itemId: 'cmd', delta: 'x'.repeat(MAX_TOOL_OUTPUT + 100) })
    expect(t.state().tools['thread:cmd']).toMatchObject({ output: 'x'.repeat(MAX_TOOL_OUTPUT), truncated: true })
    t.emit('item/completed', { item: { type: 'commandExecution', id: 'cmd', status: 'completed', aggregatedOutput: 'final' } })
    t.emit('item/commandExecution/outputDelta', { itemId: 'cmd', delta: 'late' })
    expect(t.state().tools['thread:cmd']).toMatchObject({ output: 'final', status: 'completed', truncated: false })
  })
  it('keeps MCP messages, patch updates and turn diffs separate; cancellation settles only open tools', () => {
    const t = setup()
    t.emit('item/mcpToolCall/progress', { itemId: 'mcp', message: 'working' })
    t.emit('item/mcpToolCall/progress', { itemId: 'mcp', message: 'working' })
    t.emit('item/fileChange/patchUpdated', { itemId: 'edit', changes: [{ path: 'a', diff: '+new' }] })
    t.emit('turn/diff/updated', { diff: 'combined diff' })
    expect(t.state().tools['thread:mcp']?.messages).toEqual(['working'])
    expect(t.state().tools['thread:edit']?.patch).toBe('a\n+new')
    expect(t.state().diff?.text).toBe('combined diff')
    t.progress.stop('interrupted')
    expect(t.state().tools['thread:mcp']?.status).toBe('interrupted')
  })
})
