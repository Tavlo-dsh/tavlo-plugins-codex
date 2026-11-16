import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RequestMessage, StreamChunk } from '@deepseek-ai/dsh-llm'
import { CodexSession } from '../src/codex-session.ts'
import type { AskFn, CodexSessionDeps, StepRequest } from '../src/codex-session.ts'
import type { AppServer, ServerHandlers } from '../src/app-server.ts'
import { RpcError } from '../src/app-server.ts'
import { nativeReplayState } from '../src/request-input.ts'
import { record } from '../src/protocol.ts'
import { initialNativeState } from '../src/native-state.ts'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionRegistry } from '../src/session-registry.ts'

const user = (id = 'u1', content: object[] = [{ type: 'text', text: 'hello' }]): RequestMessage =>
  ({ id, role: 'user', content, source: { kind: 'user' } }) as unknown as RequestMessage
const options = (messages: RequestMessage[] = [user()], extra: Partial<StepRequest> = {}): StepRequest => ({
  messages, model: 'default', currentTurnMessageIds: new Set(['u1', 'u2']), ...extra,
})
async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []; for await (const chunk of stream) out.push(chunk); return out
}
class FakeServer implements AppServer {
  calls: { method: string; params: Record<string, unknown> }[] = []
  answers: { id: string | number; result: unknown }[] = []
  closed = false
  onStart?: (params: Record<string, unknown>) => Promise<unknown>
  onAnswer?: (id: string | number, result: unknown) => void
  counter = 0
  goalState: Record<string, unknown> | null = null
  childTurns = new Map<string, unknown[]>()
  onSteer?: () => Promise<unknown>
  constructor(readonly handlers: ServerHandlers) {}
  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ method, params })
    if (method === 'thread/read' && this.childTurns.has(String(params.threadId))) return { thread: { id: params.threadId, parentThreadId: 'thread', status: { type: 'active' } } }
    if (method === 'thread/turns/list') return { data: this.childTurns.get(String(params.threadId)) ?? [] }
    if (method === 'turn/steer') return this.onSteer ? this.onSteer() : { turnId: params.expectedTurnId }
    if (method === 'thread/goal/get') return { goal: this.goalState }
    if (method === 'thread/goal/clear') { this.goalState = null; return { cleared: true } }
    if (method === 'thread/goal/set') {
      this.goalState = { threadId: 'thread', objective: 'goal', status: 'paused', tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, ...this.goalState, ...params, updatedAt: Number(this.goalState?.updatedAt ?? 0) + 1 }
      return { goal: this.goalState }
    }
    if (method === 'thread/start' || method === 'thread/resume' || method === 'thread/fork') return { thread: { id: method === 'thread/fork' ? 'fork' : 'thread' }, model: 'configured-model', reasoningEffort: 'medium' }
    if (method === 'account/read') return { account: { type: 'chatgpt' } }
    if (method === 'windowsSandbox/readiness') return { status: 'ready' }
    if (method === 'model/list') return { data: [{ model: 'configured-model', displayName: 'Native', description: '', inputModalities: ['text', 'image'], supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }], nextCursor: null }
    if (method === 'turn/start') {
      if (this.onStart) return this.onStart(params)
      this.counter++
      return { turn: { id: `turn${this.counter}` } }
    }
    return {}
  }
  notify(method: string, params: Record<string, unknown> = {}): void { this.calls.push({ method, params }) }
  respond(id: string | number, result: unknown): void { this.answers.push({ id, result }); this.onAnswer?.(id, result) }
  reject(id: string | number, message: string): void { this.answers.push({ id, result: { error: message } }) }
  async close(): Promise<void> { this.closed = true }
  emit(method: string, params: Record<string, unknown> = {}): void {
    this.handlers.notification({ method, params: { threadId: 'thread', turnId: `turn${this.counter}`, ...params } })
  }
  item(method: 'started' | 'completed', item: Record<string, unknown>): void { this.emit(`item/${method}`, { item }) }
  end(status = 'completed'): void { this.emit('turn/completed', { turn: { id: `turn${this.counter}`, status } }) }
  ask(method: string, itemId: string, extra: Record<string, unknown> = {}): void {
    this.handlers.request({ method, id: `req-${this.answers.length}`, params: { threadId: 'thread', turnId: `turn${this.counter}`, itemId, ...extra } })
  }
}
const sessions: CodexSession[] = []
afterEach(async () => { for (const session of sessions.splice(0)) await session.dispose() })
function setup(overrides: Partial<CodexSessionDeps> = {}): { session: CodexSession; server: () => FakeServer; deps: CodexSessionDeps } {
  let server: FakeServer
  const deps: CodexSessionDeps = {
    dshSessionId: 'dsh', cwd: '/workspace', provider: 'codex', sentMessageIds: new Set(), after: Promise.resolve(), cancelGraceMs: 100,
    nativeState: initialNativeState(), publishNativeState: vi.fn(),
    startServer: handlers => (server = new FakeServer(handlers)), policy: () => ({}), readImage: async () => new Uint8Array([1, 2]),
    onModels: vi.fn(), onContextWindow: vi.fn(), askQuestion: vi.fn(async () => undefined), warn: vi.fn(), ...overrides,
  }
  const session = new CodexSession(deps); sessions.push(session)
  return { session, server: () => server, deps }
}
async function started(server: () => FakeServer): Promise<void> { await vi.waitFor(() => expect(server().counter).toBeGreaterThan(0)) }

describe('native Codex conversation', () => {
  it.each([undefined, 'provider_approved_dsh'])(
    'uses the configured Codex client identity (%s) in the real session handshake', async clientName => {
      const { session, server } = setup({ clientName })
      const stream = collect(session.stream(options()))
      await started(server)
      expect(server().calls.find(call => call.method === 'initialize')?.params).toMatchObject({
        clientInfo: { name: clientName ?? 'codex_dsh', title: 'Tavlo DSH' },
        capabilities: { experimentalApi: true, requestAttestation: false },
      })
      server().end()
      await stream
    },
  )
  it('steers exactly once and never resubmits the acknowledged message as queued input', async () => {
    const { session, server } = setup()
    const first = collect(session.stream(options())); await started(server)
    server().item('started', { type: 'commandExecution', id: 'cmd' }); await first
    await session.steer('u2', 'focus on tests')
    await session.steer('u2', 'focus on tests')
    expect(server().calls.filter(c => c.method === 'turn/steer')).toHaveLength(1)
    expect(session.state.steering).toMatchObject({ id: 'u2', turnId: 'turn1', status: 'accepted' })
    server().item('completed', { type: 'commandExecution', id: 'cmd', exitCode: 0 })
    await session.waitForTool('thread:cmd', vi.fn(), new AbortController().signal)
    const next = collect(session.stream(options([user('u2')])))
    server().end(); await next
    expect(server().calls.filter(c => c.method === 'turn/start')).toHaveLength(1)
    await expect(session.steer('u3', 'late')).rejects.toThrow('活跃')
  })
  it('distinguishes definitive steering rejection from an ambiguous transport outcome', async () => {
    const { session, server } = setup()
    const first = collect(session.stream(options())); await started(server)
    server().item('started', { type: 'commandExecution', id: 'cmd' }); await first
    server().onSteer = async () => { throw new RpcError(-32600, 'turn already completed') }
    await expect(session.steer('u2', 'follow up')).rejects.toThrow('already completed')
    expect(session.sentMessageIds.has('u2')).toBe(false)
    expect(session.state.steering?.status).toBe('rejected')
    server().onSteer = async () => { throw new Error('transport lost') }
    await expect(session.steer('u2', 'follow up')).rejects.toThrow('transport lost')
    expect(session.state.steering?.status).toBe('unknown')
    expect(session.state.sentInputIds).toContain('u2')
    const replacement = setup({ nativeState: session.state })
    expect(replacement.session.sentMessageIds.has('u2')).toBe(true)
    expect(server().closed).toBe(true)
  })
  it('releases steering reservations when cancelled while persisting the pre-submit receipt', async () => {
    const controller = new AbortController()
    const { session, server } = setup({ publishNativeState: state => {
      if (state.steering?.status === 'submitting') controller.abort(new Error('cancel before steer submit'))
    } })
    const first = collect(session.stream(options())); await started(server)
    server().item('started', { type: 'commandExecution', id: 'cmd' }); await first
    await expect(session.steer('u2', 'follow up', controller.signal)).rejects.toThrow('cancel before steer submit')
    expect(server().calls.some(c => c.method === 'turn/steer')).toBe(false)
    expect(session.state.steering?.status).toBe('rejected')
    expect(session.state.sentInputIds).not.toContain('u2')
    expect(session.replaceable).toBe(false)
    await session.steer('u2', 'retry after cancellation')
    expect(session.state.steering?.status).toBe('accepted')
    server().end()
  })
  it('waits for image attachment persistence even when the native turn finishes first', async () => {
    let finishSave!: () => void
    const image = { attachmentId: AttachmentId('image'), mediaType: 'image/png' as const, bytes: 1, width: 1, height: 1 }
    const save = vi.fn(() => new Promise<typeof image>(resolve => { finishSave = () => resolve(image) }))
    const { session, server } = setup({ imageStore: () => ({ maxBytes: 1024, save }) })
    const first = collect(session.stream(options())); await started(server)
    server().item('completed', { type: 'imageGeneration', id: 'image', status: 'completed', result: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7XcAAAAASUVORK5CYII=' })
    await first
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    const waiting = session.waitForTool('thread:image', vi.fn(), new AbortController().signal)
    server().end(); finishSave()
    expect(await waiting).toMatchObject({ isError: false, images: [image] })
    await collect(session.stream(options([])))
  })
  it('refuses image input before reading attachments when native image capability is absent', async () => {
    const readImage = vi.fn()
    const { session, server } = setup({ readImage })
    const messages = [user('u1', [{ type: 'image', attachment: { attachmentId: 'img', mediaType: 'image/png', bytes: 1, width: 1, height: 1 } }])]
    await expect(collect(session.stream(options(messages, { model: 'text-only' })))).rejects.toThrow('图片输入能力')
    expect(readImage).not.toHaveBeenCalled()
    expect(session.sentMessageIds.size).toBe(0)
    expect(server().calls.some(c => c.method === 'turn/start')).toBe(false)
  })
  it('reads child details, steers only active known children, and propagates a parent boundary interrupt', async () => {
    const { session, server } = setup()
    const first = collect(session.stream(options())); await started(server)
    server().childTurns.set('child', [{ id: 'child-turn', status: 'inProgress', items: [{ type: 'agentMessage', text: 'reviewing' }] }])
    server().item('started', { type: 'collabAgentToolCall', id: 'spawn', tool: 'spawnAgent', senderThreadId: 'thread', receiverThreadIds: ['child'], agentsStates: { child: { status: 'running' } } })
    await first
    expect(session.state.agents.child).toMatchObject({ parentThreadId: 'thread', status: 'running' })
    await expect(session.agentDetail('unrelated', options([]))).rejects.toThrow('已知')
    expect(await session.agentDetail('child', options([]))).toContain('reviewing')
    await session.agentInput('child', 'focus on tests', options([]))
    expect(server().calls.at(-1)).toMatchObject({ method: 'turn/steer', params: { threadId: 'child', expectedTurnId: 'child-turn', input: [{ text: 'focus on tests' }] } })
    server().item('completed', { type: 'collabAgentToolCall', id: 'spawn', tool: 'spawnAgent' })
    await session.waitForTool('thread:spawn', vi.fn(), new AbortController().signal)
    const next = collect(session.stream(options([])))
    server().end(); await next
    expect(server().calls.some(c => c.method === 'turn/interrupt' && c.params.threadId === 'child')).toBe(true)
    expect(session.state.agents.child?.interruptRequested).toBe(true)
    server().emit('turn/completed', { threadId: 'child', turn: { id: 'child-turn', status: 'interrupted' } })
    expect(session.state.agents.child?.status).toBe('interrupted')
  })
  it('preserves Goal usage and pauses it at the DSH-facing boundary instead of treating a turn as completion', async () => {
    const { session, server } = setup()
    await session.goal('set', options([]), 'finish migration')
    expect(session.state.goal?.status).toBe('paused')
    expect(server().counter).toBe(0)
    await session.goal('resume', options([]))
    const first = collect(session.stream(options()))
    await started(server)
    const goal = { ...server().goalState!, status: 'active', tokensUsed: 120, updatedAt: 5 }
    server().goalState = goal
    server().emit('thread/goal/updated', { goal })
    server().end(); await first
    expect(session.state.goal).toMatchObject({ objective: 'finish migration', status: 'paused', tokensUsed: 120 })
    expect(server().calls.findLast(c => c.method === 'thread/goal/set')?.params).toMatchObject({ origin: 'automatic', status: 'paused' })
    expect(server().calls.findLast(c => c.method === 'thread/goal/set')?.params).not.toHaveProperty('objective')
    server().emit('turn/started', { turn: { id: 'unmanaged-continuation' } })
    await vi.waitFor(() => expect(server().calls.some(c => c.method === 'turn/interrupt' && c.params.turnId === 'unmanaged-continuation')).toBe(true))
    await session.goal('clear', options([]))
    expect(session.state.goal).toBeNull()
  })
  it('uses the final revised Plan body and retains structured step state', async () => {
    const { session, server } = setup()
    await session.setMode('plan', options([]))
    expect(server().calls.find(c => c.method === 'initialize')?.params).toMatchObject({ capabilities: { experimentalApi: true } })
    const result = collect(session.stream(options()))
    await started(server)
    expect(server().calls.find(c => c.method === 'turn/start')?.params).toMatchObject({ collaborationMode: { mode: 'plan', settings: { model: 'configured-model', reasoning_effort: 'medium' } } })
    server().emit('turn/plan/updated', { explanation: 'first', plan: [{ step: 'Implement', status: 'inProgress' }] })
    server().emit('item/plan/delta', { itemId: 'plan', delta: 'Old draft' })
    expect(session.state.plan.text).toBe('Old draft')
    server().item('completed', { type: 'plan', id: 'plan', text: 'Revised final plan' })
    server().item('completed', { type: 'plan', id: 'plan', text: 'Revised final plan' })
    server().end()
    const chunks = await result
    expect(chunks.filter(c => c.type === 'text-delta').map(c => c.text).join('')).toBe('Revised final plan')
    expect(session.state.plan).toMatchObject({ final: true, text: 'Revised final plan', steps: [{ step: 'Implement', status: 'inProgress' }] })
    await session.setMode('default', options([], { model: 'other', reasoningEffort: 'high' }))
    expect(server().calls.at(-1)?.params).toMatchObject({ collaborationMode: { mode: 'default', settings: { model: 'other', reasoning_effort: 'high' } } })
  })
  it('keeps native consumption across tool steps and queued turns without projecting aggregate host usage', async () => {
    const { session, server, deps } = setup()
    const sample = (inputTokens: number, outputTokens: number) => ({ inputTokens, outputTokens })
    const usage = (total: object, last: object) => server().emit('thread/tokenUsage/updated', { tokenUsage: { total, last, modelContextWindow: 200000 } })
    const first = collect(session.stream(options()))
    await started(server)
    usage(sample(100, 10), sample(100, 10))
    server().item('started', { type: 'commandExecution', id: 'cmd', command: 'pwd' })
    expect((await first).some(c => c.type === 'usage')).toBe(false)
    usage(sample(300, 30), sample(200, 20))
    server().item('completed', { type: 'commandExecution', id: 'cmd', exitCode: 0 })
    await session.waitForTool('thread:cmd', vi.fn(), new AbortController().signal)
    const second = collect(session.stream(options([user('u2')])))
    server().end()
    await vi.waitFor(() => expect(server().counter).toBe(2))
    usage(sample(600, 60), sample(300, 30))
    server().end(); await second
    expect(session.state.usage.consumed.totalTokens).toBe(660)
    expect(session.state.usage.turnConsumed.totalTokens).toBe(330)
    expect(session.state.usage.last?.totalTokens).toBe(330)
    expect(deps.publishNativeState).toHaveBeenCalled()
  })
  it('tracks compaction lifecycle and clears a stale context sample until native refresh', async () => {
    const { session, server } = setup()
    const first = collect(session.stream(options())); await started(server)
    server().emit('thread/tokenUsage/updated', { tokenUsage: { total: { inputTokens: 100, outputTokens: 10 }, last: { inputTokens: 100, outputTokens: 10 }, modelContextWindow: 200000 } })
    await expect(session.compact(options([]))).rejects.toThrow('当前任务')
    server().item('started', { type: 'contextCompaction', id: 'compact1' })
    expect(session.state.compaction.status).toBe('running')
    expect(session.state.usage.last).toBeUndefined()
    expect(session.state.usage.contextWindow).toBe(200000)
    server().item('completed', { type: 'contextCompaction', id: 'compact1' })
    expect(session.state.compaction.status).toBe('completed')
    server().end(); await first
    await session.compact(options([]))
    expect(server().calls.at(-1)).toMatchObject({ method: 'thread/compact/start', params: { threadId: 'thread' } })
    server().emit('turn/started', { turn: { id: 'manual-compact' } })
    server().emit('item/started', { turnId: 'manual-compact', item: { type: 'contextCompaction', id: 'compact2' } })
    server().emit('item/completed', { turnId: 'manual-compact', item: { type: 'contextCompaction', id: 'compact2' } })
    server().emit('turn/completed', { turn: { id: 'manual-compact', status: 'completed' } })
    expect(session.state.compaction.status).toBe('completed')
    expect((await collect(session.stream(options([])))).at(-1)).toMatchObject({ reason: { kind: 'stop' } })
  })
  it('initializes once, streams text without completion duplication, and records a replay boundary', async () => {
    const { session, server, deps } = setup()
    const result = collect(session.stream(options()))
    await started(server)
    server().emit('item/agentMessage/delta', { itemId: 'm', delta: 'hello' })
    server().item('completed', { type: 'agentMessage', id: 'm', text: 'hello world' })
    server().emit('thread/tokenUsage/updated', { tokenUsage: { last: { inputTokens: 100, cachedInputTokens: 20, outputTokens: 8, totalTokens: 108 }, total: { inputTokens: 100, cachedInputTokens: 20, outputTokens: 8 }, modelContextWindow: 200000 } })
    server().end()
    const chunks = await result
    expect(chunks.filter(c => c.type === 'text-delta').map(c => c.text).join('')).toBe('hello world')
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' }, replayState: { response: { codexSessionId: 'thread', codexTurnId: 'turn1', dshSessionId: 'dsh' } } })
    expect(chunks.some(c => c.type === 'usage')).toBe(false)
    expect(deps.publishNativeState).toHaveBeenLastCalledWith(expect.objectContaining({ usage: expect.objectContaining({ consumed: expect.objectContaining({ totalTokens: 108 }), last: expect.objectContaining({ totalTokens: 108 }) }) }))
    expect(deps.onContextWindow).toHaveBeenCalledWith('default', 200000)
    expect(server().calls.slice(0, 3).map(c => c.method)).toContain('initialize')
    expect(server().calls.slice(0, 3).map(c => c.method)).toContain('initialized')
    expect(server().calls.some(c => c.method === 'thread/start')).toBe(true)
    expect(server().calls.find(c => c.method === 'turn/start')?.params).toMatchObject({ model: 'configured-model', effort: 'medium', input: [{ type: 'text', text: 'hello', text_elements: [] }] })
    await collect(session.stream(options()))
    expect(server().calls.filter(c => c.method === 'turn/start')).toHaveLength(1)
  })

  it('mirrors a command, answers approval only once, and continues the same native turn', async () => {
    const { session, server } = setup()
    const first = collect(session.stream(options()))
    await started(server)
    const command = { type: 'commandExecution', id: 'cmd', command: 'git status', status: 'inProgress' }
    server().item('started', command)
    const chunks = await first
    expect(chunks.at(-1)).toMatchObject({ reason: { kind: 'tool-calls' } })
    expect(chunks.find(c => c.type === 'block-end')).toMatchObject({ block: { name: 'codex_tool', id: 'thread:cmd' } })
    server().ask('item/commandExecution/requestApproval', 'cmd', { command: 'git status', proposedExecpolicyAmendment: ['git'] })
    const ask = vi.fn(async () => 'allowed-once' as const)
    const waited = session.waitForTool('thread:cmd', ask, new AbortController().signal)
    await vi.waitFor(() => expect(server().answers).toHaveLength(1))
    expect(server().answers[0]?.result).toEqual({ decision: 'accept' })
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ callId: 'thread:cmd' }), expect.any(AbortSignal))
    server().item('completed', { ...command, status: 'completed', aggregatedOutput: 'clean', exitCode: 0 })
    expect(await waited).toEqual({ text: 'clean', isError: false })
    const next = collect(session.stream(options([])))
    server().item('completed', { type: 'agentMessage', id: 'answer', text: 'done' })
    server().end()
    expect((await next).at(-1)).toMatchObject({ reason: { kind: 'stop' } })
    expect(server().calls.filter(c => c.method === 'turn/start')).toHaveLength(1)
  })

  it('services standalone user-input requests through a synthetic mirror call', async () => {
    const askQuestion = vi.fn(async () => ({ answers: [{ id: 'choice', selected: ['A'], custom: 'extra' }] }))
    const { session, server } = setup({ askQuestion })
    const first = collect(session.stream(options()))
    await started(server)
    server().ask('item/tool/requestUserInput', 'question', { questions: [{ id: 'choice', question: 'Which?', header: 'Choice', options: [{ label: 'A', description: 'First' }] }] })
    await first
    const result = await session.waitForTool('thread:question', vi.fn(), new AbortController().signal)
    expect(result.isError).toBe(false)
    expect(server().answers[0]?.result).toEqual({ answers: { choice: { answers: ['A', 'extra'] } } })
    expect(askQuestion).toHaveBeenCalledWith([expect.objectContaining({ id: 'choice', question: 'Which?' })], expect.any(AbortSignal))
    server().end()
  })

  it('handles child-thread approval while a parent agent card waits', async () => {
    const { session, server } = setup()
    const first = collect(session.stream(options()))
    await started(server)
    server().item('started', { type: 'collabAgentToolCall', id: 'agent', tool: 'wait' })
    await first
    server().ask('item/fileChange/requestApproval', 'edit', { threadId: 'child', turnId: 'child-turn' })
    const ask = vi.fn<AskFn>(async () => 'rejected' as const)
    const waiting = session.waitForTool('thread:agent', ask, new AbortController().signal)
    await vi.waitFor(() => expect(server().answers).toHaveLength(1))
    expect(ask.mock.calls[0]?.[0]).not.toHaveProperty('callId')
    expect(server().answers[0]?.result).toEqual({ decision: 'decline' })
    server().item('completed', { type: 'collabAgentToolCall', id: 'agent', status: 'completed' })
    await waiting
    server().end()
  })

  it('resumes its own thread and forks inherited history through the saved turn', async () => {
    for (const owner of ['dsh', 'parent']) {
      const reply = { role: 'assistant', content: [], source: { provider: 'codex', replayState: nativeReplayState('old-thread', owner, 'old-turn') } } as unknown as RequestMessage
      const state = initialNativeState()
      state.agents.child = { threadId: 'child', parentThreadId: 'old-thread', status: 'completed' }
      state.tools.tool = { threadId: 'old-thread', turnId: 'old-turn', itemId: 'tool', type: 'commandExecution', status: 'completed', output: 'previous output', truncated: false, messages: [] }
      state.diff = { turnId: 'old-turn', text: 'previous diff', truncated: false }
      const { session, server } = setup({ nativeState: state })
      const result = collect(session.stream(options([reply, user()])))
      await vi.waitFor(() => expect(server().calls.some(c => c.method === 'turn/start')).toBe(true))
      const call = server().calls.find(c => c.method === (owner === 'dsh' ? 'thread/resume' : 'thread/fork'))
      expect(call?.params).toMatchObject({ threadId: 'old-thread', excludeTurns: true })
      if (owner === 'parent') expect(call?.params.lastTurnId).toBe('old-turn')
      expect(Object.keys(session.state.agents)).toEqual(owner === 'parent' ? [] : ['child'])
      expect(Object.keys(session.state.tools)).toEqual(owner === 'parent' ? [] : ['tool'])
      expect(session.state.diff).toEqual(owner === 'parent' ? undefined : state.diff)
      server().emit('turn/completed', { threadId: owner === 'parent' ? 'fork' : 'thread', turn: { id: 'turn1', status: 'completed' } })
      await result
    }
  })

  it('releases input on definitive model rejection and retries the same message', async () => {
    const { session, server } = setup()
    const initial = collect(session.stream(options()))
    await started(server); server().end(); await initial
    server().onStart = async () => { throw new RpcError(-32600, 'model unavailable') }
    await expect(collect(session.stream(options([user('u2')], { model: 'missing' })))).rejects.toThrow('model unavailable')
    expect(session.sentMessageIds.has('u1')).toBe(true)
    expect(session.sentMessageIds.has('u2')).toBe(false)
    server().onStart = undefined
    const retry = collect(session.stream(options([user('u2')])))
    await vi.waitFor(() => expect(server().counter).toBe(2)); server().end(); await retry
    expect(session.sentMessageIds.has('u2')).toBe(true)
  })

  it('does not submit partially prepared images after cancellation, and permits retry', async () => {
    let release!: (data: Uint8Array) => void
    const readImage = vi.fn(() => new Promise<Uint8Array>(resolve => { release = resolve }))
    const { session, server } = setup({ readImage })
    const controller = new AbortController()
    const messages = [user('u1', [{ type: 'image', attachment: { attachmentId: 'img', mediaType: 'image/png', bytes: 1, width: 1, height: 1 } }])]
    const result = collect(session.stream(options(messages, { signal: controller.signal })))
    await vi.waitFor(() => expect(readImage).toHaveBeenCalledOnce())
    controller.abort(); release(new Uint8Array([1]))
    expect((await result).at(-1)).toMatchObject({ reason: { kind: 'aborted' } })
    expect(server().calls.some(c => c.method === 'turn/start')).toBe(false)
    expect(session.sentMessageIds.size).toBe(0)
    readImage.mockResolvedValue(new Uint8Array([1]))
    const retry = collect(session.stream(options(messages)))
    await started(server); server().end(); await retry
    const input = record(server().calls.find(c => c.method === 'turn/start')?.params).input
    expect(input).toEqual([{ type: 'image', url: 'data:image/png;base64,AQ==' }])
  })

  it('interrupts an in-flight turn, drops late events, and waits before the next turn', async () => {
    const { session, server } = setup()
    const controller = new AbortController()
    const first = collect(session.stream(options(undefined, { signal: controller.signal })))
    await started(server)
    server().emit('item/agentMessage/delta', { itemId: 'm', delta: 'partial' })
    controller.abort()
    expect((await first).at(-1)).toMatchObject({ reason: { kind: 'aborted' } })
    expect(server().calls.some(c => c.method === 'turn/interrupt')).toBe(true)
    server().emit('item/agentMessage/delta', { itemId: 'm', delta: 'stale' })
    const second = collect(session.stream(options([user('u2')])))
    expect(server().counter).toBe(1)
    server().end('interrupted')
    await vi.waitFor(() => expect(server().counter).toBe(2)); server().end()
    expect((await second).some(c => c.type === 'text-delta' && c.text.includes('stale'))).toBe(false)
  })

  it('marks process death readable and retains submitted ids/checkpoint', async () => {
    const { session, server } = setup()
    const result = collect(session.stream(options()))
    const rejected = expect(result).rejects.toThrow('crashed')
    await started(server); server().handlers.failure(new Error('crashed')); await rejected
    expect(session.replaceable).toBe(true)
    expect(session.sentMessageIds.has('u1')).toBe(true)
    expect(session.checkpoint?.codexSessionId).toBe('thread')
    expect(server().closed).toBe(true)
  })

  it('queues newly typed input until the previous native turn completes', async () => {
    const { session, server } = setup()
    const first = collect(session.stream(options()))
    await started(server)
    server().item('started', { type: 'commandExecution', id: 'cmd', command: 'pwd' })
    await first
    server().item('completed', { type: 'commandExecution', id: 'cmd', exitCode: 0, aggregatedOutput: '/workspace' })
    await session.waitForTool('thread:cmd', vi.fn(), new AbortController().signal)
    const second = collect(session.stream(options([user('u2', [{ type: 'text', text: 'follow up' }])])))
    await vi.waitFor(() => expect(server().calls.filter(c => c.method === 'turn/start')).toHaveLength(1))
    server().end()
    await vi.waitFor(() => expect(server().counter).toBe(2))
    expect(server().calls.filter(c => c.method === 'turn/start')[1]?.params.input).toEqual([{ type: 'text', text: 'follow up', text_elements: [] }])
    server().end()
    expect((await second).at(-1)).toMatchObject({ reason: { kind: 'stop' } })
    expect([...session.sentMessageIds]).toEqual(['u1', 'u2'])
  })

  it('does not replay ambiguously submitted input after a transport failure', async () => {
    const { session, server } = setup()
    const first = collect(session.stream(options()))
    await started(server); server().end(); await first
    server().onStart = async () => { throw new Error('connection lost before acknowledgement') }
    await expect(collect(session.stream(options([user('u2')])))).rejects.toThrow('connection lost')
    expect(session.sentMessageIds.has('u2')).toBe(true)
    expect(session.replaceable).toBe(true)
    expect(server().closed).toBe(true)
  })

  it('replaces a failed process only after teardown, resumes its checkpoint and never replays submitted input', async () => {
    let durable = initialNativeState()
    const created: ReturnType<typeof setup>[] = []
    const registry = new SessionRegistry({
      getAgent: () => ({ session: { header: { cwd: '/workspace' } } }) as Agent,
      ask: async () => 'unavailable', warn: vi.fn(),
      createSession: (_agent, _id, _cwd, start) => {
        const entry = setup({ ...start, nativeState: durable, publishNativeState: state => { durable = structuredClone(state) } })
        created.push(entry)
        return entry.session
      },
    })
    const first = registry.resolveSession('dsh')
    const interrupted = collect(first.stream(options()))
    const rejected = expect(interrupted).rejects.toThrow('transport lost')
    await started(created[0]!.server)
    created[0]!.server().handlers.failure(new Error('transport lost'))
    await rejected
    let release!: () => void
    const teardown = new Promise<void>(resolve => { release = resolve })
    const dispose = first.dispose.bind(first)
    vi.spyOn(first, 'dispose').mockImplementation(async reason => { await teardown; await dispose(reason) })

    const replacement = registry.resolveSession('dsh')
    expect(replacement).not.toBe(first)
    const continued = collect(replacement.stream(options([user(), user('u2', [{ type: 'text', text: 'fresh input' }])])))
    await Promise.resolve()
    expect(created[1]!.server()).toBeUndefined()
    release()
    await started(created[1]!.server)
    const calls = created[1]!.server().calls
    expect(calls.find(c => c.method === 'thread/resume')?.params.threadId).toBe('thread')
    expect(calls.some(c => c.method === 'thread/start')).toBe(false)
    expect(calls.filter(c => c.method === 'turn/start').map(c => c.params.input)).toEqual([
      [{ type: 'text', text: 'fresh input', text_elements: [] }],
    ])
    expect([...replacement.sentMessageIds]).toEqual(['u1', 'u2'])
    created[1]!.server().end()
    await continued
    await registry.disposeAll()
  })

  it('terminates an unresponsive native turn after cancellation grace expires', async () => {
    const { session, server } = setup({ cancelGraceMs: 10 })
    const controller = new AbortController()
    const first = collect(session.stream(options(undefined, { signal: controller.signal })))
    await started(server); controller.abort(); await first
    await vi.waitFor(() => expect(server().closed).toBe(true))
    await expect(collect(session.stream(options([user('u2')])))).rejects.toThrow('停止回合超时')
    expect(session.replaceable).toBe(true)
    expect(server().calls.filter(c => c.method === 'turn/start')).toHaveLength(1)
  })

  it('returns a native failed turn as a DSH failure and rejects unsupported client requests', async () => {
    const { session, server } = setup()
    const result = collect(session.stream(options()))
    await started(server)
    server().ask('item/tool/call', 'dynamic')
    expect(server().answers[0]?.result).toHaveProperty('error')
    server().emit('item/agentMessage/delta', { threadId: 'child', itemId: 'child-msg', delta: 'private child text' })
    server().emit('turn/completed', { turn: { id: 'turn1', status: 'failed', error: { message: 'provider unavailable' } } })
    const chunks = await result
    expect(chunks.at(-1)).toMatchObject({ reason: { kind: 'error', failure: { message: 'provider unavailable' } } })
    expect(chunks.some(c => c.type === 'text-delta')).toBe(false)
  })
  it('classifies native failed turns separately from completed content', async () => {
    const { session, server } = setup()
    const result = collect(session.stream(options())); await started(server)
    server().end('failed')
    expect((await result).at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error' } })
    expect(session.state.diagnostics).toContainEqual(expect.objectContaining({ id: 'turn', severity: 'error' }))
  })
})
