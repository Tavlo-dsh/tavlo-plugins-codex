/** One persistent Codex app-server and native thread for one DSH conversation. */
import { LlmError, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { FinishReason, RequestMessage, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { AppServer, ServerHandlers } from './app-server.ts'
import { RpcError } from './app-server.ts'
import { AsyncQueue, abortReason, untilAborted } from './async-queue.ts'
import { DEFAULT_MODEL_ID, MIRROR_TOOL_NAME } from './constants.ts'
import { itemOutcome, TOOL_TYPES } from './events.ts'
import type { ToolOutcome } from './events.ts'
import { mirrorArgs } from './mirror-args.ts'
import { isEffortLevel } from './models.ts'
import { APPROVAL_METHODS, permissionReason, permissionResult } from './permissions.ts'
import type { ModelInfo, NativeItem, RpcNotification, RpcRequest, UserInput as NativeInput } from './protocol.ts'
import { positiveInteger, record, text, turnDurationMs } from './protocol.ts'
import { answerElicitation, toCodexAnswers, toDshQuestions } from './questions.ts'
import type { AskQuestions } from './questions.ts'
import { nativeReplayState, readNativeReplay, unseenUserInput } from './request-input.ts'
import type { ImageRef, UserInput } from './request-input.ts'
import { StepBlocks } from './stream-blocks.ts'
import { initialNativeState, nativeStateSchema } from './native-state.ts'
import type { NativeState } from './native-state.ts'
import { UsageTracker } from './usage-tracker.ts'
import { NativeControls, collaborationMode } from './native-controls.ts'
import type { Mode } from './native-controls.ts'
import { NativeAgents, runningAgent } from './native-agents.ts'
import { importNativeImage } from './native-images.ts'
import type { NativeImageStore } from './native-images.ts'
import { boundedOutput, NativeProgress } from './native-progress.ts'
import { classifyFailure, NativeDiagnostics } from './native-diagnostics.ts'
import { fetchCodexModels } from './models.ts'
import { codexInitializeParams } from './client-identity.ts'

export interface PermissionAsk { readonly reason: string; readonly callId?: string }
export type AskFn = (request: PermissionAsk, signal: AbortSignal) => Promise<ApprovalOutcome>
export interface StepRequest {
  readonly messages: readonly RequestMessage[]
  readonly signal?: AbortSignal
  readonly model: string
  readonly reasoningEffort?: string
  readonly currentTurnMessageIds: ReadonlySet<string>
}
export interface CodexSessionDeps {
  readonly dshSessionId: string
  readonly cwd: string
  readonly provider: string
  readonly clientName?: string
  readonly fastMode?: boolean
  readonly now?: () => number
  readonly sentMessageIds: ReadonlySet<string>
  readonly inheritedReplay?: ReturnType<typeof readNativeReplay>
  readonly nativeState: NativeState
  publishNativeState(state: NativeState): void
  onNativeName?(name: string): void
  readonly cancelGraceMs: number
  readonly after: Promise<void>
  startServer(handlers: ServerHandlers): AppServer
  policy(): Record<string, unknown>
  readImage(ref: ImageRef, signal: AbortSignal): Promise<Uint8Array>
  imageStore?(): NativeImageStore | undefined
  onModels(models: readonly ModelInfo[]): void
  onDefaultModel?(model: string): void
  onContextWindow(model: string, capacity: number): void
  askQuestion: AskQuestions
  warn(message: string): void
}
type ReaderEvent =
  | { type: 'text' | 'reasoning'; text: string }
  | { type: 'tool'; key: string; item: NativeItem }
  | { type: 'end'; reason: FinishReason }
  | { type: 'failure'; error: Error }
interface Call { outcome?: ToolOutcome; settling?: boolean; synthetic: boolean }
interface PendingRequest { message: RpcRequest; key: string }
interface QueuedInput { input: UserInput; request: StepRequest }
interface PermissionBoundary { turnId: string; completed(status: string): void }
const NEVER = new AbortController().signal
const PERMISSION_CONTINUATION = 'DSH 已按用户刚刚选择的权限停止上一原生回合，并用新的沙箱和审批设置接续同一任务。请根据线程历史继续尚未完成的工作；不要重新执行已完成的操作。中断时尚未确认结果的操作应先检查实际状态，再决定是否重试。'
const ABORTED: FinishReason = { kind: 'aborted', failure: { message: '已停止', code: 'ABORTED' } }

/** Broadcast notification whose aborting waiters are actually removed. */
class Changes {
  private waiters = new Set<() => void>()
  notify(): void { for (const wake of [...this.waiters]) wake() }
  next(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(abortReason(signal))
    return new Promise((resolve, reject) => {
      const clean = (): void => { this.waiters.delete(wake); signal.removeEventListener('abort', abort) }
      const wake = (): void => { clean(); resolve() }
      const abort = (): void => { clean(); reject(abortReason(signal)) }
      this.waiters.add(wake)
      signal.addEventListener('abort', abort, { once: true })
    })
  }
}

export class CodexSession {
  private server: AppServer | undefined
  private threadId: string | undefined
  private turnId: string | undefined
  private turnStartedAt: number | undefined
  private defaultModel: string | undefined
  private defaultEffort: string | null = null
  private appliedModel = DEFAULT_MODEL_ID
  private readonly sent: Set<string>
  private readonly reserved = new Set<string>()
  private readonly events = new AsyncQueue<ReaderEvent>()
  private readonly changes = new Changes()
  private readonly calls = new Map<string, Call>()
  private requests: PendingRequest[] = []
  private queued: QueuedInput[] = []
  private readonly streamed = new Map<string, string>()
  private busy = false
  private turnAbort = new AbortController()
  private readonly lifetime = new AbortController()
  private cancellation: Promise<void> | undefined
  private finishCancellation: (() => void) | undefined
  private failure: Error | undefined
  private failureRead = false
  private nativeState: NativeState
  private readonly usageTracker: UsageTracker
  private startupUsage: RpcNotification[] = []
  private initialization: Promise<void> | undefined
  private controlling = false
  private readonly controls: NativeControls
  private goalBoundary: Promise<void> = Promise.resolve()
  private childrenBoundary: Promise<void> = Promise.resolve()
  private readonly agents: NativeAgents
  private modelsReady: Promise<void> = Promise.resolve()
  private nativeModels: readonly ModelInfo[] = []
  private readonly progress: NativeProgress
  private readonly diagnostics: NativeDiagnostics
  private readonly now: () => number
  private progressTimer: ReturnType<typeof setTimeout> | undefined
  private appliedPolicy: string | undefined
  private activeRequest: StepRequest | undefined
  private permissionUpdates: Promise<void> = Promise.resolve()
  private permissionSyncing = false
  private permissionBoundary: PermissionBoundary | undefined
  private permissionAbort = new AbortController()

  constructor(private readonly deps: CodexSessionDeps) {
    this.sent = new Set(deps.sentMessageIds)
    this.nativeState = structuredClone(deps.nativeState ?? initialNativeState())
    for (const id of this.nativeState.sentInputIds) this.sent.add(id)
    this.usageTracker = new UsageTracker(this.nativeState.usage, false)
    this.controls = new NativeControls({
      state: () => this.nativeState,
      update: patch => this.updateState(patch),
      request: (method, params) => this.server!.request(method, { ...params, threadId: this.threadId }),
    })
    this.agents = new NativeAgents(() => this.nativeState, agents => this.updateState({ agents }))
    this.progress = new NativeProgress(() => this.nativeState, (patch, final) => final ? this.updateState(patch) : this.deferState(patch))
    this.diagnostics = new NativeDiagnostics(() => this.nativeState, diagnostics => this.updateState({ diagnostics }))
    this.now = deps.now ?? Date.now
  }
  get sentMessageIds(): ReadonlySet<string> { return this.sent }
  get state(): NativeState { return structuredClone(this.nativeState) }
  get replaceable(): boolean { return this.failure !== undefined && this.failureRead }
  get checkpoint(): ReturnType<typeof readNativeReplay> {
    return this.threadId === undefined ? this.deps.inheritedReplay : {
      codexSessionId: this.threadId, dshSessionId: this.deps.dshSessionId,
      ...(this.turnId === undefined ? {} : { codexTurnId: this.turnId }),
    }
  }

  /** Native permissions are frozen per turn: interrupt, then continue once. */
  refreshPermissions(): Promise<void> {
    const update = this.permissionUpdates.then(() => this.syncPermissions())
    this.permissionUpdates = update.catch(() => undefined)
    return update
  }
  private async syncPermissions(): Promise<void> {
    if (!this.server || !this.threadId || this.failure || this.cancellation) return
    const signal = AbortSignal.any([this.lifetime.signal, this.turnAbort.signal])
    this.permissionSyncing = true
    let boundary: PermissionBoundary | undefined
    try {
      const policy = this.deps.policy()
      if (JSON.stringify(policy) === this.appliedPolicy) return
      // A settings event may race the response to turn/start. Never interrupt
      // an unknown id or start a second turn until that submission settles.
      while (this.busy && !this.turnId) await this.changes.next(signal)
      signal.throwIfAborted()
      let status: string | undefined
      if (this.busy && this.turnId) {
        const ended = new Promise<string>(resolve => { boundary = { turnId: this.turnId!, completed: resolve } })
        this.permissionBoundary = boundary
        this.diagnostics.set({ id: 'permissions', kind: 'permissions', severity: 'info', message: '权限已变更，正在停止旧回合并按新设置接续。' })
        this.permissionAbort.abort(new Error('Codex 权限已变更，取消旧回合输入请求。'))
        this.cancelRequests()
        this.stopChildren()
        const deadline = AbortSignal.any([signal, AbortSignal.timeout(this.deps.cancelGraceMs)])
        const interrupted = this.server.request('turn/interrupt', { threadId: this.threadId, turnId: boundary!.turnId })
          .catch(error => {
            // The turn may have naturally finished just before the interrupt.
            // Only its observed terminal event makes this race unambiguous.
            if (!this.busy && error instanceof RpcError) return
            throw error
          })
        const [terminal] = await untilAborted(Promise.all([ended, interrupted]), deadline)
        // turn/completed can extend these chains; capture them only after it.
        await untilAborted(Promise.all([this.childrenBoundary, this.goalBoundary]), deadline)
        status = terminal
      }
      signal.throwIfAborted()
      // Coalesce further selections made while the old turn was stopping.
      const latest = this.deps.policy()
      await untilAborted(this.server.request('thread/settings/update', { threadId: this.threadId, ...latest }), signal)
      signal.throwIfAborted()
      this.appliedPolicy = JSON.stringify(latest)
      if (status === 'interrupted' && this.activeRequest) {
        this.permissionBoundary = undefined
        await this.submit({ ids: [], blocks: [{ type: 'text', text: PERMISSION_CONTINUATION }] }, this.activeRequest, signal, true)
      }
      this.diagnostics.set({ id: 'permissions', kind: 'permissions', severity: 'info', message: 'Codex 已应用当前会话的沙箱与审批设置。' })
    } catch (error) {
      if (signal.aborted) return
      const failure = new LlmError(`Codex 运行中权限同步失败，已停止进程：${String(error)}`, 'CODEX_PERMISSION_UPDATE_FAILED')
      this.diagnostics.set({ id: 'permissions', kind: 'permissions', severity: 'error', message: failure.message })
      this.die(failure)
      throw failure
    } finally {
      if (this.permissionBoundary === boundary) this.permissionBoundary = undefined
      this.permissionSyncing = false
      this.changes.notify()
    }
  }

  async compact(request: StepRequest): Promise<void> {
    return this.control(request, async () => {
    this.updateState({ compaction: { status: 'requested' } })
    try { await this.server!.request('thread/compact/start', { threadId: this.threadId }) }
    catch (error) {
      this.updateState({ compaction: { status: 'failed' } })
      throw error
    }
    })
  }
  async setMode(mode: Mode, request: StepRequest): Promise<void> {
    await this.control(request, () => this.controls.setMode(mode, this.selectedModel(request.model), this.selectedEffort(request.reasoningEffort)))
  }
  async setFast(enabled: boolean, request: StepRequest): Promise<void> {
    await this.control(request, () => this.controls.setFast(enabled))
  }
  async setName(title: string, pinned: boolean, request: StepRequest): Promise<void> {
    await this.control(request, () => this.controls.setName(title, pinned), true)
  }
  async goal(action: 'get' | 'set' | 'pause' | 'resume' | 'clear' | 'budget', request: StepRequest, value?: string | number | null): Promise<void> {
    await this.control(request, async () => {
      if (action === 'get') await this.controls.getGoal()
      else if (action === 'set') await this.controls.setGoal(typeof value === 'string' ? value : '')
      else await this.controls.changeGoal(action, typeof value === 'number' || value === null ? value : undefined)
    }, action === 'pause' || action === 'clear' || action === 'get')
    if (action === 'pause' || action === 'clear') this.abandonTurn()
  }
  async steer(id: string, message: string, signal: AbortSignal = NEVER): Promise<void> {
    signal.throwIfAborted(); this.throwIfDead()
    if (this.sent.has(id)) return
    if (!this.server || !this.busy || !this.turnId || this.cancellation || this.controlling || this.permissionSyncing) throw new Error('没有可追加消息的活跃 Codex 回合；普通输入会排队到下一轮。')
    if (!id || !message.trim()) throw new Error('追加消息不能为空。')
    const turnId = this.turnId
    this.sent.add(id)
    let submitted = false
    try {
      this.updateState({ sentInputIds: [...this.sent].slice(-8192), steering: { id, turnId, text: message, status: 'submitting' } })
      signal.throwIfAborted()
      submitted = true
      const result = record(await this.server.request('turn/steer', { threadId: this.threadId, expectedTurnId: turnId, clientUserMessageId: id, input: [{ type: 'text', text: message, text_elements: [] }] }))
      if (text(result.turnId) !== turnId) throw new Error('Codex steer 应答与目标回合不一致；提交结果不确定。')
      this.updateState({ steering: { id, turnId, text: message, status: 'accepted' } })
    } catch (error) {
      if (!submitted || error instanceof RpcError) this.sent.delete(id)
      this.updateState({ sentInputIds: [...this.sent].slice(-8192), steering: { id, turnId, text: message, status: !submitted || error instanceof RpcError ? 'rejected' : 'unknown', error: String(error) } })
      if (submitted && !(error instanceof RpcError)) this.die(error instanceof Error ? error : new Error(String(error)))
      throw error
    }
  }
  async agentDetail(id: string, request: StepRequest): Promise<string> {
    return this.control(request, () => this.readAgent(id).then(({ turns }) => turns.map(turn => {
      const t = record(turn)
      const messages = (Array.isArray(t.items) ? t.items : []).flatMap(raw => {
        const item = record(raw)
        return item.type === 'agentMessage' ? [text(item.text).slice(0, 8000)] : []
      })
      return `${text(t.id)}: ${text(t.status)}\n${messages.join('\n')}`
    }).join('\n')), true)
  }
  async agentInput(id: string, message: string | undefined, request: StepRequest): Promise<void> {
    await this.control(request, async () => {
      const { turns } = await this.readAgent(id)
      const active = turns.map(record).find(t => t.status === 'inProgress')
      if (!active || !text(active.id)) throw new Error('此子代理没有可操作的活跃回合。')
      if (message !== undefined) {
        if (!message.trim()) throw new Error('补充消息不能为空。')
        await this.server!.request('turn/steer', { threadId: id, expectedTurnId: active.id, input: [{ type: 'text', text: message, text_elements: [] }] })
      } else {
        await this.server!.request('turn/interrupt', { threadId: id, turnId: active.id })
        this.updateState({ agents: { ...this.nativeState.agents, [id]: { ...this.nativeState.agents[id]!, interruptRequested: true } } })
      }
    }, true)
  }
  private async readAgent(id: string): Promise<{ turns: unknown[] }> {
    const known = this.nativeState.agents[id]
    if (!known) throw new Error('这不是当前会话已知的原生子代理。')
    const metadata = record(record(await this.server!.request('thread/read', { threadId: id, includeTurns: false })).thread)
    if (text(metadata.id) !== id || (metadata.parentThreadId && metadata.parentThreadId !== known.parentThreadId)) throw new Error('子代理身份／父会话不一致。')
    const result = record(await this.server!.request('thread/turns/list', { threadId: id, limit: 3, sortDirection: 'desc', itemsView: 'full' }))
    const turns = Array.isArray(result.data) ? result.data : []
    const active = turns.map(record).find(t => t.status === 'inProgress')
    const status = text(record(metadata.status).type) || known.status
    this.updateState({ agents: { ...this.nativeState.agents, [id]: { ...known, status, ...(active ? { activeTurnId: text(active.id) } : {}),
      ...(text(metadata.model) ? { model: text(metadata.model) } : {}),
      ...(text(metadata.reasoningEffort) ? { reasoningEffort: text(metadata.reasoningEffort) } : {}),
    } } })
    return { turns }
  }
  private stopChildren(): void {
    if (!this.server || this.failure !== undefined) return
    this.childrenBoundary = this.childrenBoundary.then(async () => {
      for (const agent of Object.values(this.nativeState.agents).filter(runningAgent)) {
        const { turns } = await this.readAgent(agent.threadId)
        const active = turns.map(record).find(t => t.status === 'inProgress')
        if (!active) continue
        await this.server!.request('turn/interrupt', { threadId: agent.threadId, turnId: active.id })
        this.updateState({ agents: { ...this.nativeState.agents, [agent.threadId]: { ...this.nativeState.agents[agent.threadId]!, interruptRequested: true } } })
      }
    })
    void this.childrenBoundary.catch(error => this.die(new Error(`Codex 子代理边界中断失败：${String(error)}`)))
  }
  private pauseGoalAtBoundary(): void {
    if (this.nativeState.goal?.status !== 'active') return
    this.goalBoundary = this.goalBoundary.then(async () => {
      const goal = await this.controls.getGoal()
      if (goal?.status === 'active') await this.controls.changeGoal('pause', undefined, 'automatic')
    })
    void this.goalBoundary.catch(error => this.die(new Error(`Codex 目标边界暂停失败，已停止进程防止失管续跑：${String(error)}`)))
  }
  private async control<T>(request: StepRequest, action: () => Promise<T>, allowActive = false): Promise<T> {
    if (this.controlling || this.permissionSyncing || (!allowActive && (this.busy || this.events.size || ['requested', 'running'].includes(this.nativeState.compaction.status)))) throw new Error('请先等待 Codex 当前任务结束，再修改会话。')
    this.controlling = true
    try {
      await this.ensureInitialized(request, request.signal ?? NEVER)
      request.signal?.throwIfAborted()
      this.throwIfDead()
      return await action()
    } finally { this.controlling = false }
  }
  private updateState(patch: Partial<NativeState>): void {
    clearTimeout(this.progressTimer); this.progressTimer = undefined
    this.nativeState = { ...this.nativeState, ...patch }
    this.deps.publishNativeState(this.nativeState)
  }
  private deferState(patch: Partial<NativeState>): void {
    this.nativeState = { ...this.nativeState, ...patch }
    this.progressTimer ??= setTimeout(() => {
      this.progressTimer = undefined
      try { this.deps.publishNativeState(this.nativeState) } catch (error) { this.deps.warn(String(error)) }
    }, 100)
    this.progressTimer.unref()
  }
  private selectedModel(model: string): string { return model === DEFAULT_MODEL_ID ? this.defaultModel ?? DEFAULT_MODEL_ID : model }
  private selectedEffort(effort: string | undefined): string | null { return isEffortLevel(effort) ? effort : this.defaultEffort }
  private speedParams(): { serviceTier?: string | null } {
    const selected = this.nativeState.speed.selected
    const enabled = selected === 'inherit' ? this.deps.fastMode : selected === 'fast'
    return enabled === undefined ? {} : { serviceTier: enabled ? 'fast' : null }
  }
  private elapsedTurnDuration(): number | undefined {
    const startedAt = this.turnStartedAt
    this.turnStartedAt = undefined
    if (startedAt === undefined) return undefined
    const duration = Math.round(this.now() - startedAt)
    return Number.isSafeInteger(duration) && duration > 0 ? duration : undefined
  }

  private async ensureInitialized(request: StepRequest, signal: AbortSignal): Promise<void> {
    if (this.initialization === undefined) this.initialization = this.initialize(request, signal)
    await this.initialization
  }

  async *stream(request: StepRequest): AsyncGenerator<StreamChunk> {
    const signal = request.signal ?? NEVER
    try {
      signal.throwIfAborted()
      this.throwIfDead()
      if (this.controlling) throw new Error('Codex 会话设置正在更新，请稍后重试。')
      await this.cancellation
      signal.throwIfAborted()
      await this.ensureInitialized(request, signal)
      await this.permissionUpdates
      signal.throwIfAborted()
      const seen = new Set([...this.sent, ...this.reserved])
      const input = unseenUserInput(request.messages, seen, request.currentTurnMessageIds)
      if (input.blocks.length || input.ids.length) {
        if (this.busy || this.events.size > 0) {
          for (const id of input.ids) this.reserved.add(id)
          this.queued.push({ input, request })
        } else await this.submit(input, request, signal)
      }
      if (!this.busy && this.events.size === 0) {
        yield { type: 'finish', reason: { kind: 'stop' }, ...this.replay() }
        return
      }
      yield* this.readStep(signal)
    } catch (error) {
      if (signal.aborted) {
        this.abandonTurn()
        yield { type: 'finish', reason: ABORTED, ...this.replay() }
      } else { if (this.failure !== undefined) this.failureRead = true; throw error }
    }
  }

  async waitForTool(callId: string, ask: AskFn, signal: AbortSignal): Promise<ToolOutcome> {
    const combined = AbortSignal.any([signal, this.turnAbort.signal, this.lifetime.signal])
    const onAbort = (): void => this.abandonTurn()
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) this.abandonTurn()
    try {
      for (;;) {
        combined.throwIfAborted()
        this.throwIfDead()
        const pending = this.requests.shift()
        if (pending !== undefined) { await this.answer(pending, callId, ask, combined); continue }
        const call = this.calls.get(callId)
        if (call?.outcome !== undefined) return call.outcome
        if (!this.busy && !call?.settling) throw new Error('Codex 回合结束，未收到这次工具调用的结果。')
        await this.changes.next(combined)
      }
    } catch (error) {
      if (this.failure !== undefined) this.failureRead = true
      throw error
    } finally { signal.removeEventListener('abort', onAbort) }
  }

  abandonTurn(): void {
    this.permissionAbort.abort(new Error('Codex turn interrupted'))
    if (this.failure === undefined) this.pauseGoalAtBoundary()
    this.stopChildren()
    this.progress.stop('interrupted')
    this.queued = []
    this.reserved.clear()
    this.events.clear()
    this.turnAbort.abort(new Error('Codex turn interrupted'))
    this.cancelRequests()
    if (!this.busy || this.cancellation !== undefined) { this.changes.notify(); return }
    this.cancellation = new Promise(resolve => {
      const timer = setTimeout(() => { this.die(new Error('Codex 停止回合超时，已结束进程。')); resolve() }, this.deps.cancelGraceMs)
      timer.unref()
      this.finishCancellation = () => { clearTimeout(timer); resolve() }
    })
    this.interrupt()
    this.changes.notify()
  }
  async dispose(reason?: string): Promise<void> {
    this.die(new LlmError(reason ?? 'Codex 会话已关闭。', 'CODEX_STOPPED'))
    await this.server?.close()
  }

  private async initialize(request: StepRequest, signal: AbortSignal): Promise<void> {
    await this.deps.after
    signal.throwIfAborted()
    this.throwIfDead()
    const server = this.deps.startServer({
      notification: message => this.notification(message),
      request: message => this.serverRequest(message),
      failure: error => this.die(error),
    })
    this.server = server
    const cancelStartup = (): void => { void server.close() }
    signal.addEventListener('abort', cancelStartup, { once: true })
    try {
      await server.request('initialize', codexInitializeParams(this.deps.clientName))
      signal.throwIfAborted()
      server.notify('initialized')
      void server.request('account/read', { refreshToken: false }).then(value => {
        if (this.failure !== undefined) return
        const account = record(value), type = text(record(account.account).type)
        if (!type && account.requiresOpenaiAuth === true) this.diagnostics.set({ id: 'auth', kind: 'auth', severity: 'warning', message: 'Codex 账户未登录；请运行 codex login。' })
        else this.diagnostics.remove('auth')
      }).catch(error => { if (this.failure === undefined) this.diagnostics.set({ id: 'auth', kind: 'auth', severity: 'warning', message: '无法确认 Codex 登录状态；请检查本机登录与工作区路由。', details: String(error).slice(0, 2000) }) })
      void server.request('windowsSandbox/readiness', {}).then(value => {
        if (this.failure !== undefined) return
        if (text(record(value).status) === 'updateRequired') this.diagnostics.set({ id: 'windows-sandbox', kind: 'sandbox', severity: 'warning', message: 'Windows sandbox 需要更新；请在本机 Codex 中完成 setup。' })
      }).catch(error => this.deps.warn(`Windows sandbox readiness unavailable: ${String(error)}`))
      const resume = this.deps.inheritedReplay ?? readNativeReplay(request.messages, this.deps.provider)
        ?? (this.nativeState.threadId ? { codexSessionId: this.nativeState.threadId, dshSessionId: this.nativeState.dshSessionId ?? this.deps.dshSessionId, codexTurnId: this.nativeState.turnId } : undefined)
      const fork = resume !== undefined && resume.dshSessionId !== this.deps.dshSessionId
      // A fork without a native boundary could silently include newer parent turns.
      if (fork && !resume.codexTurnId) throw new Error('这条历史没有 Codex 回合边界，无法安全分叉。请从已完成的 Codex 回复分叉。')
      const policy = this.deps.policy()
      const { sandboxPolicy, ...common } = policy
      const sandbox = record(sandboxPolicy).type
      const params: Record<string, unknown> = {
        ...common,
        ...this.speedParams(),
        cwd: this.deps.cwd,
        ...(sandbox === undefined ? {} : { sandbox: sandbox === 'dangerFullAccess' ? 'danger-full-access' : sandbox === 'workspaceWrite' ? 'workspace-write' : 'read-only' }),
        ...(resume === undefined ? {} : { threadId: resume.codexSessionId, excludeTurns: true }),
        ...(fork ? { lastTurnId: resume.codexTurnId } : {}),
      }
      const response = record(await server.request(resume === undefined ? 'thread/start' : fork ? 'thread/fork' : 'thread/resume', params))
      this.threadId = text(record(response.thread).id) || undefined
      if (this.threadId === undefined) throw new Error('Codex did not return a thread id')
      this.turnId = resume?.codexTurnId
      if (resume === undefined) {
        this.usageTracker.resetThread()
      } else if (fork || this.nativeState.threadId !== resume.codexSessionId) this.usageTracker.rebaseUnknown()
      if (fork) {
        const { diff: _inheritedDiff, ...state } = this.nativeState
        this.nativeState = { ...state, agents: {}, tools: {} }
      }
      this.nativeState = { ...this.nativeState, threadId: this.threadId, dshSessionId: this.deps.dshSessionId, usage: this.usageTracker.snapshot, compaction: { status: 'idle' } }
      this.defaultModel = text(response.model) || undefined
      if (this.defaultModel) this.deps.onDefaultModel?.(this.defaultModel)
      this.defaultEffort = text(response.reasoningEffort) || null
      this.controls.restoreSpeed(response.serviceTier)
      await this.controls.getGoal().catch(error => this.deps.warn(`Codex goal state unavailable: ${String(error)}`))
      if (this.nativeState.goal?.status === 'active') await this.controls.changeGoal('pause', undefined, 'automatic')
      this.controls.restoreMode(response.collaborationMode)
      const nativeName = this.controls.observeName(record(response.thread).name)
      if (nativeName) this.deps.onNativeName?.(nativeName)
      this.appliedModel = request.model
      for (const notification of this.startupUsage.splice(0)) {
        if (notification.params.threadId === this.threadId) this.recordUsage(notification.params, false)
      }
      this.deps.publishNativeState(this.nativeState)
      if (this.nativeState.name.title && this.nativeState.name.title !== this.nativeState.name.nativeTitle) {
        await this.controls.setName(this.nativeState.name.title, this.nativeState.name.pinned)
          .catch(error => this.deps.warn(`Codex name synchronization failed: ${String(error)}`))
      }
      signal.throwIfAborted()
      // Model discovery is optional metadata; a CLI without model/list can still run.
      this.modelsReady = this.loadModels(server).catch(error => this.deps.warn(`could not list Codex models: ${String(error)}`))
    } catch (error) {
      this.die(error instanceof Error ? error : new Error(String(error)))
      await server.close()
      throw error
    } finally { signal.removeEventListener('abort', cancelStartup) }
  }
  private async loadModels(server: AppServer): Promise<void> {
    const models = await fetchCodexModels(server)
    if (!this.lifetime.signal.aborted) { this.nativeModels = models; this.deps.onModels(models) }
  }

  private async submit(input: UserInput, request: StepRequest, signal: AbortSignal, permissionContinuation = false): Promise<void> {
    if (!permissionContinuation) await this.permissionUpdates
    signal.throwIfAborted()
    this.throwIfDead()
    if (['requested', 'running'].includes(this.nativeState.compaction.status)) throw new Error('Codex 正在压缩上下文，请稍后重试。')
    for (const id of input.ids) this.reserved.add(id)
    let submitted = false
    try {
      if (input.blocks.some(block => block.type === 'image')) {
        await this.modelsReady
        signal.throwIfAborted()
        const model = this.nativeModels.find(m => m.model === this.selectedModel(request.model))
        if (!model?.inputModalities?.includes('image')) throw new Error('此 Codex 模型未声明图片输入能力；请选择支持 image 的模型后重试。')
      }
      const content: NativeInput[] = []
      for (const block of input.blocks) {
        signal.throwIfAborted()
        if (block.type === 'text') content.push({ type: 'text', text: block.text, text_elements: [] })
        else {
          const data = await this.deps.readImage(block.ref, signal)
          signal.throwIfAborted()
          content.push({ type: 'image', url: `data:${block.ref.mediaType};base64,${Buffer.from(data).toString('base64')}` })
        }
      }
      signal.throwIfAborted()
      this.throwIfDead()
      const policy = this.deps.policy()
      this.turnAbort = new AbortController()
      this.permissionAbort = new AbortController()
      this.activeRequest = { ...request, messages: [], currentTurnMessageIds: new Set() }
      this.appliedPolicy = JSON.stringify(policy)
      this.busy = true
      this.turnId = undefined
      this.turnStartedAt = undefined
      this.appliedModel = request.model
      this.usageTracker.beginTurn(request.model)
      this.nativeState = { ...this.nativeState, usage: this.usageTracker.snapshot }
      this.deps.publishNativeState(this.nativeState)
      this.streamed.clear()
      if (!permissionContinuation) this.calls.clear()
      this.updateState({ plan: { steps: [], text: '', final: false } })
      for (const id of input.ids) this.sent.add(id)
      this.updateState({ sentInputIds: [...this.sent].slice(-8192) })
      submitted = true
      const onAbort = (): void => this.abandonTurn()
      signal.addEventListener('abort', onAbort, { once: true })
      try {
        this.turnStartedAt = this.now()
        const result = record(await this.server!.request('turn/start', {
          threadId: this.threadId, input: content, ...policy,
          ...this.speedParams(),
          ...(request.model === DEFAULT_MODEL_ID ? (this.defaultModel ? { model: this.defaultModel } : {}) : { model: request.model }),
          effort: this.selectedEffort(request.reasoningEffort),
          ...(this.nativeState.mode.explicit ? { collaborationMode: collaborationMode(this.nativeState.mode.selected, this.selectedModel(request.model), this.selectedEffort(request.reasoningEffort)) } : {}),
        }))
        this.turnId ??= text(record(result.turn).id) || undefined
        if (!this.turnId) throw new Error('Codex did not return a turn id')
        this.changes.notify()
        this.usageTracker.setActiveTurnId(this.turnId)
        this.nativeState = { ...this.nativeState, turnId: this.turnId, usage: this.usageTracker.snapshot }
        this.deps.publishNativeState(this.nativeState)
        if (this.cancellation !== undefined) this.interrupt()
        signal.throwIfAborted()
      } finally { signal.removeEventListener('abort', onAbort) }
    } catch (error) {
      this.turnStartedAt = undefined
      // Transport failure is ambiguous: Codex might already be acting on the prompt.
      if (!submitted || error instanceof RpcError) {
        for (const id of input.ids) this.sent.delete(id)
        this.updateState({ sentInputIds: [...this.sent].slice(-8192) })
      }
      if (submitted && error instanceof RpcError) { this.busy = false; this.completeCancellation() }
      else if (submitted && !signal.aborted) this.die(error instanceof Error ? error : new Error(String(error)))
      throw error
    } finally { for (const id of input.ids) this.reserved.delete(id) }
  }

  private notification({ method, params: p }: RpcNotification): void {
    if (this.threadId === undefined && method === 'thread/tokenUsage/updated') {
      if (this.startupUsage.length >= 8) this.startupUsage.shift()
      this.startupUsage.push({ method, params: p })
      return
    }
    if (this.failure !== undefined) return
    this.diagnostics.notification({ method, params: p })
    if (this.busy && this.cancellation === undefined && !(typeof p.turnId === 'string' && p.threadId === this.threadId && this.turnId && p.turnId !== this.turnId)) this.progress.notification({ method, params: p })
    if (this.agents.notification({ method, params: p })) return
    if (p.threadId !== this.threadId) return
    if (method === 'thread/settings/updated') {
      this.controls.restoreSpeed(record(p.threadSettings).serviceTier)
      return
    }
    if (method === 'thread/name/updated') {
      const name = this.controls.observeName(p.threadName)
      if (name) this.deps.onNativeName?.(name)
      return
    }
    if (method === 'thread/goal/updated' || method === 'thread/goal/cleared') {
      try { this.controls.observeGoal(method.endsWith('/cleared') ? null : p.goal) }
      catch (error) { this.deps.warn(String(error)) }
      return
    }
    if (method === 'turn/started') {
      if (!this.busy && !['requested', 'running'].includes(this.nativeState.compaction.status)) {
        const id = text(record(p.turn).id)
        if (id) void this.server?.request('turn/interrupt', { threadId: this.threadId, turnId: id }).catch(error => this.die(error instanceof Error ? error : new Error(String(error))))
        this.pauseGoalAtBoundary()
        return
      }
      if (this.busy && this.turnId === undefined) this.turnId = text(record(p.turn).id) || undefined
      if (this.nativeState.compaction.status === 'requested') this.turnId = text(record(p.turn).id) || this.turnId
      this.usageTracker.setActiveTurnId(this.turnId)
      if (this.cancellation !== undefined) this.interrupt()
      this.changes.notify()
      return
    }
    if ((method === 'item/started' || method === 'item/completed') && record(p.item).type === 'contextCompaction') {
      if (typeof p.turnId === 'string' && this.turnId && p.turnId !== this.turnId) return
      this.usageTracker.clearSample()
      this.nativeState = { ...this.nativeState, usage: this.usageTracker.snapshot, compaction: {
        status: method === 'item/started' ? 'running' : 'completed', itemId: text(record(p.item).id),
      } }
      this.deps.publishNativeState(this.nativeState)
      return
    }
    if (typeof p.turnId === 'string' && this.turnId && p.turnId !== this.turnId) return
    if (method === 'turn/completed') {
      const turn = record(p.turn)
      if (this.turnId && text(turn.id) !== this.turnId) return
      this.turnId = text(turn.id) || this.turnId
      if (this.busy && this.turnId) {
        this.usageTracker.setActiveTurnId(this.turnId)
        const wallClockDuration = this.elapsedTurnDuration()
        this.usageTracker.finishTurn(this.turnId, turnDurationMs(turn) ?? wallClockDuration)
      }
      this.nativeState = { ...this.nativeState, ...(this.turnId ? { turnId: this.turnId } : {}),
        usage: this.usageTracker.snapshot,
        ...(['requested', 'running'].includes(this.nativeState.compaction.status) ? { compaction: { status: turn.status === 'completed' ? 'completed' : 'failed' } } : {}) }
      this.deps.publishNativeState(this.nativeState)
      if (!this.busy) { this.changes.notify(); return }
      this.pauseGoalAtBoundary()
      this.stopChildren()
      this.busy = false
      this.cancelRequests()
      for (const call of this.calls.values()) if (!call.settling) call.outcome ??= { text: 'Codex 回合已结束，没有返回工具结果。', isError: true }
      const permissionBoundary = this.permissionBoundary
      if (permissionBoundary && permissionBoundary.turnId === this.turnId) permissionBoundary.completed(text(turn.status))
      if (this.cancellation !== undefined) this.completeCancellation()
      else if (permissionBoundary && permissionBoundary.turnId === this.turnId && turn.status === 'interrupted') {
        // Keep the DSH operation open; syncPermissions will resume this thread
        // without resending the user's input or discarding completed tools.
      }
      else {
        const status = text(turn.status)
        const failureMessage = text(record(turn.error).message)
        if (status === 'failed') this.diagnostics.set(classifyFailure(record(turn.error).codexErrorInfo, failureMessage))
        const reason: FinishReason = status === 'completed' ? { kind: 'stop' } : status === 'interrupted' ? ABORTED
          : { kind: 'error', failure: { message: failureMessage || `Codex 回合失败（${status}）`, code: 'CODEX_TURN_FAILED' } }
        this.events.push({ type: 'end', reason })
      }
      this.changes.notify()
      return
    }
    if (method === 'thread/tokenUsage/updated') {
      this.recordUsage(p, this.busy && this.cancellation === undefined)
      return
    } else if (method === 'turn/plan/updated') {
      if (!this.busy || this.cancellation !== undefined) return
      const parsed = nativeStateSchema.shape.plan.safeParse({ ...this.nativeState.plan, turnId: text(p.turnId), explanation: typeof p.explanation === 'string' ? p.explanation : undefined, steps: p.plan })
      if (parsed.success) this.updateState({ plan: parsed.data })
    } else if (method === 'item/plan/delta') {
      if (!this.busy || this.cancellation !== undefined || this.nativeState.plan.final) return
      this.updateState({ plan: { ...this.nativeState.plan, text: this.nativeState.plan.text + text(p.delta) } })
    } else if (method === 'item/agentMessage/delta' || method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta') {
      if (!this.busy || this.cancellation !== undefined) return
      const kind = method.includes('/reasoning/') ? 'reasoning' : 'text'
      const key = `${text(p.itemId)}:${kind}`
      this.streamed.set(key, (this.streamed.get(key) ?? '') + text(p.delta))
      this.events.push({ type: kind, text: text(p.delta) })
    } else if (method === 'item/started' || method === 'item/completed') {
      if (!this.busy || this.cancellation !== undefined) return
      const raw = record(p.item)
      if (!text(raw.id) || !text(raw.type)) return
      const item = raw as NativeItem
      if (item.type === 'plan' && method === 'item/completed') {
        if (!this.nativeState.plan.final) {
          this.updateState({ plan: { ...this.nativeState.plan, text: text(item.text), final: true } })
          this.events.push({ type: 'text', text: text(item.text) })
        }
        this.changes.notify()
        return
      }
      const key = this.callKey(p.threadId, item.id)
      if (TOOL_TYPES.has(item.type)) {
        if (!this.calls.has(key)) {
          this.calls.set(key, { synthetic: false })
          this.events.push({ type: 'tool', key, item })
        }
        if (method === 'item/completed' && !this.calls.get(key)!.outcome && !this.calls.get(key)!.settling) {
          const call = this.calls.get(key)!, outcome = itemOutcome(item)
          if (item.type === 'commandExecution') {
            const progress = this.nativeState.tools[key]
            const output = typeof item.aggregatedOutput === 'string' ? boundedOutput(item.aggregatedOutput) : progress ? { text: progress.output, truncated: progress.truncated } : undefined
            if (output) outcome.text = `${output.truncated ? '[Earlier output truncated]\n' : ''}${output.text}`
          }
          if ((item.type === 'imageGeneration' || item.type === 'imageView') && !outcome.isError) {
            call.settling = true
            const store = this.deps.imageStore?.()
            void (store ? importNativeImage(item, store) : Promise.reject(new Error('DSH 图片附件库不可用。'))).then(image => {
              call.outcome = { ...outcome, images: [image] }
            }, error => { call.outcome = { ...outcome, text: `${outcome.text}\n图片预览不可用：${String(error)}` } }).finally(() => { call.settling = false; this.changes.notify() })
          } else call.outcome = outcome
        }
      } else if (method === 'item/completed' && ['agentMessage', 'plan', 'reasoning'].includes(item.type)) {
        const kind = item.type === 'reasoning' ? 'reasoning' : 'text'
        const full = item.type === 'reasoning' ? (Array.isArray(item.summary) && item.summary.length ? item.summary : Array.isArray(item.content) ? item.content : []).map(text).join('\n') : text(item.text)
        const previous = this.streamed.get(`${item.id}:${kind}`) ?? ''
        // Completed-only records are common for web/older clients. Emit only the missing suffix.
        if (full.startsWith(previous)) this.events.push({ type: kind, text: full.slice(previous.length) })
      }
    } else if (method === 'error' && p.willRetry !== true) {
      if (!this.busy || this.cancellation !== undefined) return
      // The authoritative failure arrives in turn/completed; retain useful diagnostics.
      this.deps.warn(text(record(p.error).message) || 'Codex reported an error')
    }
    this.changes.notify()
  }

  private recordUsage(p: Record<string, unknown>, active: boolean): void {
    const usage = record(p.tokenUsage)
    if (this.usageTracker.update(usage, text(p.turnId) || undefined, this.appliedModel, active)) {
      this.nativeState = { ...this.nativeState, usage: this.usageTracker.snapshot }
      this.deps.publishNativeState(this.nativeState)
      if (positiveInteger(usage.modelContextWindow)) this.deps.onContextWindow(this.appliedModel, usage.modelContextWindow)
    }
  }

  private serverRequest(message: RpcRequest): void {
    const supported = APPROVAL_METHODS.has(message.method) || message.method === 'item/tool/requestUserInput' || message.method === 'mcpServer/elicitation/request'
    if (!supported) { this.server?.reject(message.id, `Unsupported client request: ${message.method}`); return }
    if (!this.busy || this.cancellation !== undefined || this.failure !== undefined || this.permissionBoundary) {
      this.respondCancelled(message)
      return
    }
    const p = message.params
    if (p.threadId === this.threadId && typeof p.turnId === 'string' && this.turnId && p.turnId !== this.turnId) {
      this.respondCancelled(message); return
    }
    const key = this.callKey(p.threadId, text(p.itemId) || `request-${message.id}`)
    if (!this.calls.has(key)) {
      this.calls.set(key, { synthetic: true })
      this.events.push({ type: 'tool', key, item: {
        ...p, id: key, type: message.method === 'item/tool/requestUserInput' || message.method === 'mcpServer/elicitation/request' ? 'requestUserInput' : 'approval',
      } })
    }
    this.requests.push({ message, key })
    this.changes.notify()
  }
  private async answer(pending: PendingRequest, callId: string, ask: AskFn, outerSignal: AbortSignal): Promise<void> {
    const signal = AbortSignal.any([outerSignal, this.permissionAbort.signal])
    const { message, key } = pending
    let result: unknown
    let failed = false
    try {
      if (message.method === 'item/tool/requestUserInput') {
        const questions = toDshQuestions(message.params)
        const answer = questions.length ? await untilAborted(this.deps.askQuestion(questions, signal), signal) : undefined
        result = toCodexAnswers(answer)
        failed = answer === undefined
      } else if (message.method === 'mcpServer/elicitation/request') {
        result = await untilAborted(answerElicitation(message.params, this.deps.askQuestion, signal), signal)
        failed = record(result).action !== 'accept'
      } else {
        const outcome = await untilAborted(ask({ reason: permissionReason(message), ...(key === callId ? { callId } : {}) }, signal), signal)
        result = permissionResult(message, signal.aborted ? 'cancelled' : outcome)
        failed = outcome !== 'allowed-once'
      }
      if (signal.aborted) this.respondCancelled(message)
      else this.server?.respond(message.id, result)
    } catch (error) {
      this.respondCancelled(message)
      failed = true
      if (!signal.aborted) this.deps.warn(`Codex request failed: ${String(error)}`)
    }
    const call = this.calls.get(key)
    if (call?.synthetic) call.outcome = { text: failed ? 'DSH 未允许或未能完成这次请求。' : 'DSH 已回答这次请求。', isError: failed }
    this.changes.notify()
  }
  private respondCancelled(message: RpcRequest): void {
    const result = message.method === 'item/tool/requestUserInput' ? { answers: {} }
      : message.method === 'mcpServer/elicitation/request' ? { action: 'cancel', content: null, _meta: null }
        : permissionResult(message, 'cancelled')
    try { this.server?.respond(message.id, result) } catch { /* transport is already gone */ }
  }
  private cancelRequests(): void {
    for (const pending of this.requests.splice(0)) this.respondCancelled(pending.message)
  }
  private interrupt(): void {
    if (!this.turnId || !this.server || !this.busy) return
    void this.server.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId }).catch(error => this.deps.warn(`Codex interrupt failed: ${String(error)}`))
  }
  private completeCancellation(): void {
    this.finishCancellation?.()
    this.finishCancellation = undefined
    this.cancellation = undefined
  }
  private die(error: Error): void {
    if (this.failure !== undefined) return
    this.failure = error
    this.busy = false
    try { this.progress.stop('connectionLost') } catch { /* session disposed */ }
    try { this.agents.disconnected() } catch { /* the DSH session may already be disposed */ }
    if (['requested', 'running'].includes(this.nativeState.compaction.status)) {
      this.nativeState = { ...this.nativeState, compaction: { status: 'failed' } }
      try { this.deps.publishNativeState(this.nativeState) } catch { /* session may already be disposed */ }
    }
    this.turnAbort.abort(error)
    this.lifetime.abort(error)
    this.cancelRequests()
    this.completeCancellation()
    this.events.push({ type: 'failure', error })
    this.changes.notify()
    void this.server?.close()
  }
  private throwIfDead(): void {
    if (this.failure !== undefined) { this.failureRead = true; throw this.failure }
  }
  private callKey(threadId: unknown, itemId: string): string { return `${text(threadId)}:${itemId}` }
  private replay(): { replayState?: ReturnType<typeof nativeReplayState> } {
    return this.threadId === undefined ? {} : { replayState: nativeReplayState(this.threadId, this.deps.dshSessionId, this.turnId) }
  }
  private async *readStep(signal: AbortSignal): AsyncGenerator<StreamChunk> {
    const blocks = new StepBlocks()
    const onAbort = (): void => this.abandonTurn()
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      for (;;) {
        const event = await this.events.next(signal)
        if (event.type === 'text' || event.type === 'reasoning') yield* blocks.delta(event.type, event.text)
        else if (event.type === 'tool') {
          yield* blocks.toolCall({ id: ToolCallId(event.key), name: MIRROR_TOOL_NAME, arguments: JSON.stringify(mirrorArgs(event.item)) })
          yield { type: 'finish', reason: { kind: 'tool-calls' }, ...this.replay() }
          return
        } else if (event.type === 'end') {
          await this.goalBoundary
          await this.childrenBoundary
          const next = this.queued.shift()
          if (next && event.reason.kind === 'stop') { await this.submit(next.input, next.request, signal); continue }
          yield* blocks.close()
          yield { type: 'finish', reason: event.reason, ...this.replay() }
          return
        } else if (event.type === 'failure') { this.failureRead = true; throw event.error }
      }
    } catch (error) {
      if (!signal.aborted) throw error
      yield* blocks.close()
      yield { type: 'finish', reason: ABORTED, ...this.replay() }
    } finally { signal.removeEventListener('abort', onAbort) }
  }
}
