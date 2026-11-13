import { describe, expect, it, vi } from 'vitest'
import type { Session } from '@deepseek-ai/dsh-session'
import { hasFullAccess, nativePolicy, permissionResult } from '../src/permissions.ts'
import { itemOutcome, tokenUsage } from '../src/events.ts'
import { mirrorArgs } from '../src/mirror-args.ts'
import { answerElicitation, toDshQuestions } from '../src/questions.ts'
import { fromModelInfo, parseModelCache } from '../src/models.ts'
import { AuxiliaryRouter } from '../src/auxiliary.ts'

describe('permissions and protocol mappings', () => {
  const session = {} as Session
  it('maps each host sandbox and refuses unknown sandboxes', () => {
    let spec = { sandbox: 'read-only', approval: 'ask' }
    const presets = { current: () => 'selected', resolve: () => spec }
    expect(nativePolicy(presets, session, '/workspace')).toEqual({ approvalPolicy: 'on-request', approvalsReviewer: 'user', sandboxPolicy: { type: 'readOnly', networkAccess: false } })
    spec = { sandbox: 'workspace-write', approval: 'never' }
    expect(nativePolicy(presets, session, '/workspace')).toMatchObject({ approvalPolicy: 'never', sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['/workspace'] } })
    expect(hasFullAccess(presets, session)).toBe(false)
    spec = { sandbox: 'danger-full-access', approval: 'never' }
    expect(hasFullAccess(presets, session)).toBe(true)
    expect(nativePolicy(presets, session, '/workspace')).toMatchObject({ sandboxPolicy: { type: 'dangerFullAccess' }, approvalPolicy: 'never' })
    expect(hasFullAccess({ ...presets, current: () => 'auto' }, session)).toBe(false)
    spec = { sandbox: 'unknown', approval: 'ask' }
    expect(() => nativePolicy(presets, session, '/workspace')).toThrow('无法')
    expect(nativePolicy(undefined, session, '/workspace')).toEqual({})
  })
  it('never writes persistent rules and scopes extra permissions to one turn', () => {
    const request = { method: 'item/commandExecution/requestApproval', id: 1, params: { proposedExecpolicyAmendment: ['node'] } }
    expect(permissionResult(request, 'allowed-once')).toEqual({ decision: 'accept' })
    expect(permissionResult(request, 'unavailable')).toEqual({ decision: 'decline' })
    expect(permissionResult(request, 'cancelled')).toEqual({ decision: 'cancel' })
    const permissions = { ...request, method: 'item/permissions/requestApproval', params: { permissions: { network: { enabled: true }, fileSystem: null } } }
    expect(permissionResult(permissions, 'allowed-once')).toEqual({ permissions: { network: { enabled: true } }, scope: 'turn' })
    expect(permissionResult(permissions, 'rejected')).toEqual({ permissions: {}, scope: 'turn' })
  })
  it('uses actual custom permission knobs instead of resolving the derived custom label', () => {
    const presets = { current: () => 'custom', resolve: vi.fn(() => { throw new Error('unknown preset') }) }
    expect(nativePolicy(presets, session, '/workspace', { sandbox: 'read-only', approval: 'never' })).toMatchObject({ sandboxPolicy: { type: 'readOnly' }, approvalPolicy: 'never' })
    expect(nativePolicy(presets, session, '/workspace', { sandbox: 'workspace-write', approval: 'ask', writableRoots: ['/extra'] })).toMatchObject({ sandboxPolicy: { writableRoots: ['/workspace', '/extra'] }, approvalPolicy: 'on-request' })
    expect(presets.resolve).not.toHaveBeenCalled()
    expect(() => nativePolicy({ ...presets, current: () => 'auto' }, session, '/workspace', { sandbox: 'danger-full-access', approval: 'never' })).toThrow('Auto')
  })
  it('maps failed commands and MCP error results to failed mirror calls', () => {
    expect(itemOutcome({ type: 'commandExecution', id: '1', exitCode: 2, aggregatedOutput: 'bad' })).toEqual({ text: 'bad', isError: true })
    expect(itemOutcome({ type: 'mcpToolCall', id: '1', result: { isError: true, content: [{ type: 'text', text: 'denied' }] } })).toEqual({ text: 'denied', isError: true })
    expect(tokenUsage({ inputTokens: 100, cachedInputTokens: 30, cacheWriteInputTokens: 10, outputTokens: 4 })).toMatchObject({ inputTokens: 60, cacheReadTokens: 30, cacheWriteTokens: 10, outputTokens: 4 })
  })
  it('renders terminal calls and exact file patch fragments', () => {
    expect(mirrorArgs({ type: 'commandExecution', id: 'cmd', command: 'pwd' })).toMatchObject({ kind: 'execute', command: 'pwd' })
    expect(mirrorArgs({ type: 'fileChange', id: 'edit', changes: [{ path: '/a', kind: { type: 'update' }, diff: '--- a\n+++ a\n@@ -1 +1 @@\n-old\n+new' }] }).diffs).toEqual([{ path: '/a', oldText: 'old', newText: 'new' }])
    expect(mirrorArgs({ type: 'fileChange', id: 'add', changes: [{ path: '/b', kind: { type: 'add' }, diff: '+created' }] }).diffs).toEqual([{ path: '/b', oldText: null, newText: 'created' }])
  })
  it('discovers native model ids/efforts and hides internal models', () => {
    expect(fromModelInfo([
      { model: 'model', displayName: 'Model', description: '', supportedReasoningEfforts: [{ reasoningEffort: 'xhigh' }, { reasoningEffort: 'future' }] },
      { model: 'hidden', displayName: '', description: '', hidden: true },
    ])).toEqual([{ id: 'default', name: 'Default', description: 'Codex 设置里的模型' }, { id: 'model', name: 'Model', efforts: ['xhigh'] }])
  })
  it('retains actual input modalities and invalidates the old all-image cache', () => {
    const models = fromModelInfo([{ model: 'text', displayName: 'Text', description: '', inputModalities: ['text'] }, { model: 'vision', displayName: 'Vision', description: '', inputModalities: ['text', 'image', 'audio'] }])
    expect(models[1]?.inputModalities).toEqual(['text'])
    expect(models[2]?.inputModalities).toEqual(['text', 'image'])
    expect(parseModelCache(JSON.stringify({ version: 2, models }))).toEqual(models)
    expect(parseModelCache(JSON.stringify({ version: 1, models }))).toBeUndefined()
  })
  it('does not ask for secret fields in a logged DSH question', () => {
    expect(toDshQuestions({ questions: [{ id: 'token', question: 'Password?', isSecret: true }] })).toEqual([])
  })
  it('converts flat MCP forms to typed content and declines unsupported nested forms', async () => {
    const ask = vi.fn(async () => ({ answers: [{ id: 'enabled', selected: ['true'] }, { id: 'count', selected: [], custom: '12' }] }))
    const params = { mode: 'form', message: 'Configure', requestedSchema: { type: 'object', properties: { enabled: { type: 'boolean' }, count: { type: 'integer' } }, required: ['count'] } }
    expect(await answerElicitation(params, ask, new AbortController().signal)).toEqual({ action: 'accept', content: { enabled: true, count: 12 }, _meta: null })
    expect(await answerElicitation({ ...params, requestedSchema: { type: 'object', properties: { nested: { type: 'object' } } } }, ask, new AbortController().signal)).toMatchObject({ action: 'decline' })
    expect(ask).toHaveBeenCalledOnce()
  })
  it('avoids recursive auxiliary routing between Claude and Codex', async () => {
    const llm = { listProviders: () => [{ id: 'claude-code' }, { id: 'codex' }], listModels: vi.fn(), stream: vi.fn() }
    const router = new AuxiliaryRouter(llm, { enabled: true, routes: [], discovery: true }, 'codex')
    await expect(async () => { for await (const _ of router.stream({ provider: 'codex', model: 'default', messages: [] })) { /* consume */ } }).rejects.toThrow('没有可用于辅助请求')
    expect(llm.listModels).not.toHaveBeenCalled()
  })
})
