/** DSH provider backed by the locally installed Codex app-server. */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { SessionTitleProviderId, normalizeSessionTitle } from '@deepseek-ai/dsh-session-title'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-goal'
import type {} from '@deepseek-ai/dsh-llm'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { CodexAdapter } from './adapter.ts'
import { AppServerClient } from './app-server.ts'
import { AuxiliaryRouter } from './auxiliary.ts'
import type { AuxiliaryConfig } from './auxiliary.ts'
import { CodexSession } from './codex-session.ts'
import type { PermissionAsk } from './codex-session.ts'
import { createCodexTool } from './codex-tool.ts'
import { MIRROR_TOOL_NAME, PLUGIN_HOME, PROVIDER } from './constants.ts'
import { publishContextWindow } from './context-window.ts'
import { locateCodexHere } from './executable.ts'
import type { CodexExecutable } from './executable.ts'
import { fetchCodexModels, ModelCatalog } from './models.ts'
import { hasFullAccess, nativePolicy } from './permissions.ts'
import type { EffectivePermissions, PermissionPresets } from './permissions.ts'
import type { DshAnswer, DshQuestion } from './questions.ts'
import { SessionRegistry } from './session-registry.ts'
import type { SessionStart } from './session-registry.ts'
import { codexSpawnSpec } from './spawn.ts'
import { initialNativeState, nativeStateProjectionWithDefaults, publishNativeState } from './native-state.ts'
import type { NativeState } from './native-state.ts'
import { codexCommand } from './commands.ts'
import { codexInitializeParams, DEFAULT_CLIENT_NAME } from './client-identity.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    tavloCodex: TavloCodex
    dshHomePath?: (...segments: string[]) => string
    userQuestions?: {
      ask(request: { questions: DshQuestion[]; agent?: Agent; signal?: AbortSignal }): Promise<DshAnswer>
    }
  }
}
export interface Config {
  executable: string
  clientName: string
  fastMode?: boolean
  inheritCredentials: boolean
  env: Record<string, string>
  requestTimeoutMs: number
  cancelGraceMs: number
  disposeGraceMs: number
  auxiliary: AuxiliaryConfig
}
const AUXILIARY_SCHEMA: z<AuxiliaryConfig> = z.object({
  enabled: z.boolean().default(true),
  routes: z.array(z.object({ provider: z.string().required(), model: z.string().required() })).default([]),
  discovery: z.boolean().default(true),
})

export default class TavloCodex extends Service {
  static inject = ['llm', 'agents', 'tools', 'subprocess', 'sessionProjections', 'commands']
  static Config: z<Config> = z.object({
    executable: z.string().default(''),
    clientName: z.string().default(DEFAULT_CLIENT_NAME),
    fastMode: z.boolean().description('Codex Fast 模式；不设置时沿用原生配置，会话内可用 /codex fast on|off 切换。'),
    inheritCredentials: z.boolean().default(true),
    env: z.dict(z.string()).default({}),
    requestTimeoutMs: z.natural().min(1).default(60_000),
    cancelGraceMs: z.natural().min(1).default(10_000),
    disposeGraceMs: z.natural().min(1).default(3_000),
    auxiliary: AUXILIARY_SCHEMA.default({}),
  })
  private readonly registry: SessionRegistry
  private readonly catalog: ModelCatalog
  private readonly executable: CodexExecutable | undefined
  private nativeStateHandle: ProjectionHandle<NativeState> | undefined
  private discoveryClient: AppServerClient | undefined
  private discoveryPromise: Promise<void> | undefined
  private readonly modelRestore: Promise<void>
  private discoveryStopped = false

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'tavloCodex')
    codexInitializeParams(config.clientName)
    this.executable = locateCodexHere(config.executable || undefined)
    if (this.executable) ctx.logger.info(`using Codex at ${this.executable.path}, client ${config.clientName ?? DEFAULT_CLIENT_NAME}`)
    else ctx.logger.warn('未找到本机 Codex。请安装 @openai/codex 并登录，或配置 executable。')
    const homePath = ctx.get('dshHomePath') ?? ((...parts: string[]) => join(homedir(), '.dsh', ...parts))
    this.catalog = new ModelCatalog(PROVIDER, homePath(PLUGIN_HOME, 'models.json'),
      () => ctx.emit('llm/models-updated', PROVIDER), message => ctx.logger.warn(message))
    this.modelRestore = this.catalog.restore()
    this.registry = new SessionRegistry({
      getAgent: id => ctx.agents.get(id as SessionId),
      ask: (agent, request, signal) => this.ask(agent, request, signal),
      warn: message => ctx.logger.warn(message),
      createSession: (agent, id, cwd, start) => this.createSession(agent, id, cwd, start),
    })
    ctx.effect(() => ctx.commands.register(codexCommand({
      fastMode: config.fastMode,
      state: agent => this.nativeStateHandle?.stateOf(agent.session) ?? initialNativeState(),
      resolve: agent => this.registry.resolveSession(agent.id),
      rename: (agent, title) => {
        const titles = ctx.get('sessionTitle')
        if (!titles) throw new Error('DSH session-title 服务不可用。')
        return titles.rename(agent.session, title).title
      },
    })), 'tavloCodex.command')
    const auxiliary = new AuxiliaryRouter(ctx.llm, config.auxiliary, PROVIDER)
    ctx.on('llm/adapters-updated', () => auxiliary.reset())
    ctx.llm.registerAdapter([PROVIDER], new CodexAdapter({
      catalog: this.catalog, auxiliary, ensureModels: () => this.discoverModels(),
      resolveSession: id => this.registry.resolveSession(id),
      currentTurnMessageIds: id => this.registry.currentTurnMessageIds(id),
    }))
    ctx.tools.register(createCodexTool({ waitForTool: exec => this.registry.waitForTool(exec) }), {
      when: ({ modelSelection }) => this.registry.isOwnRoute(modelSelection.provider),
    })
    ctx.on('session/event', (session, event) => {
      this.registry.observeEvent(session.id, event)
      if (event.type !== 'session/title' || event.data.source.kind === 'provider' && event.data.source.provider === 'tavlo-codex/native') return
      // Session append observers cannot recursively append another record.
      queueMicrotask(() => {
        const agent = ctx.agents.get(session.id), live = this.registry.peek(session.id)
        const selection = agent?.model.current()
        if (!agent || !live || selection?.provider !== PROVIDER) return
        void live.setName(event.data.title, event.data.source.kind === 'user', { messages: [], model: selection.model, reasoningEffort: selection.reasoningEffort, currentTurnMessageIds: new Set() })
          .catch(error => ctx.logger.warn(`Codex name synchronization failed: ${String(error)}`))
      })
    })
    ctx.on('agent/disposed', ({ agent }) => this.registry.disposeSession(agent.id))
    const refreshGoal = (sessionId: string): void => {
      void this.registry.peek(sessionId)?.refreshHostGoal().catch(error => ctx.logger.warn(`Codex goal synchronization failed: ${String(error)}`))
    }
    ctx.on('goal/changed', ({ agent }) => refreshGoal(agent.id))
    ctx.on('goal/activation-changed', ({ sessionId }) => refreshGoal(sessionId))
    ctx.effect(() => () => {
      this.discoveryStopped = true
      void this.discoveryClient?.close()
      void this.registry.disposeAll('tavlo-plugins-codex 已停止或重新加载，这条回复没有完成。')
    }, 'tavloCodex.sessions()')
  }
  protected async [Service.init](): Promise<void> {
    this.nativeStateHandle = await this.ctx.sessionProjections.register(nativeStateProjectionWithDefaults(this.config.fastMode))
    void this.discoverModels()
  }
  private discoverModels(): Promise<void> {
    if (!this.executable) return Promise.resolve()
    if (this.discoveryPromise) return this.discoveryPromise
    const operation = this.runModelDiscovery()
    this.discoveryPromise = operation
    void operation.then(() => {
      if (this.discoveryPromise === operation) this.discoveryPromise = undefined
    })
    return operation
  }
  private async runModelDiscovery(): Promise<void> {
    await this.modelRestore
    if (!this.executable || this.discoveryStopped) return
    let client: AppServerClient | undefined
    let reportedFailure = false
    try {
      const environment = { ...(this.config.inheritCredentials ? process.env : scrubbedParentEnv()), ...this.config.env }
      let activeClient: AppServerClient | undefined
      client = new AppServerClient(
        this.ctx.subprocess.spawn(codexSpawnSpec(this.executable, process.cwd(), environment, this.config.disposeGraceMs)),
        {
          notification() {},
          request: message => activeClient?.reject(message.id, 'Model discovery does not handle interactive requests'),
          failure: error => {
            reportedFailure = true
            if (!this.discoveryStopped) this.ctx.logger.warn(`could not discover Codex models: ${String(error)}`)
          },
        },
        this.config.requestTimeoutMs,
        line => this.ctx.logger.debug(`codex model discovery: ${line}`),
      )
      activeClient = client
      this.discoveryClient = client
      await client.request('initialize', codexInitializeParams(this.config.clientName))
      if (this.discoveryStopped) return
      const models = await fetchCodexModels(client)
      if (!this.discoveryStopped) this.catalog.update(models)
    } catch (error) {
      if (!reportedFailure && !this.discoveryStopped) this.ctx.logger.warn(`could not discover Codex models: ${String(error)}`)
    } finally {
      if (this.discoveryClient === client) this.discoveryClient = undefined
      await client?.close().catch(() => undefined)
    }
  }
  private ask(agent: Agent, request: PermissionAsk, signal: AbortSignal): Promise<ApprovalOutcome> {
    if (signal.aborted) return Promise.resolve('cancelled')
    if (hasFullAccess(this.ctx.get('permissionPresets') as PermissionPresets | undefined, agent.session, this.effectivePermissions(agent.session))) return Promise.resolve('allowed-once')
    const approval = this.ctx.get('approval')
    return approval === undefined ? Promise.resolve('unavailable') : approval.request({
      agent, toolName: MIRROR_TOOL_NAME, reason: request.reason, signal,
      ...(request.callId === undefined ? {} : { callId: request.callId as ToolRunContext['callId'] }),
    })
  }
  private effectivePermissions(session: Session): EffectivePermissions | undefined {
    const sandbox = this.ctx.get('sandboxPolicy') as { resolve(request: { session: Session }): { mode: string; additionalWritableRoots?: readonly string[] } } | undefined
    if (!sandbox) return undefined
    const policy = sandbox.resolve({ session }), approval = this.ctx.get('approval')
    return { sandbox: policy.mode, approval: approval?.overrideOf(session) ?? approval?.config.policy ?? 'ask', writableRoots: policy.additionalWritableRoots }
  }
  private createSession(agent: Agent, id: string, cwd: string, start: SessionStart): CodexSession {
    const ctxGoal = () => this.ctx.agents.get(agent.id) === agent && agent.model.current()?.provider === PROVIDER
      ? this.ctx.get('goals')?.get(agent) : undefined
    const projection = this.nativeStateHandle
    if (!projection) throw new Error('Codex 会话状态尚未就绪。')
    const state = structuredClone(projection.stateOf(agent.session))
    const hostTitle = this.ctx.get('sessionTitle')?.get(agent.session)
    if (hostTitle) state.name = { ...state.name, title: hostTitle.title, pinned: hostTitle.source.kind === 'user' }
    return new CodexSession({
      dshSessionId: id, cwd, provider: PROVIDER, clientName: this.config.clientName,
      fastMode: this.config.fastMode,
      sentMessageIds: start.sentMessageIds, inheritedReplay: start.inheritedReplay, after: start.after,
      cancelGraceMs: this.config.cancelGraceMs,
      nativeState: state,
      hostGoal: {
        current: () => ctxGoal(),
        settle: (ref, phase, reason) => {
          const service = this.ctx.get('goals'), current = ctxGoal()
          if (!service || !current || current.id !== ref.id || current.revision !== ref.revision || current.phase !== 'active') return
          if (phase === 'complete') service.complete(agent, current)
          else if (phase === 'paused') service.pause(agent, current)
          else service.block(agent, current, reason ?? { code: 'codex-blocked', message: 'Codex 目标受阻。' })
        },
      },
      publishNativeState: state => publishNativeState(agent.session, state, projection.stateOf(agent.session)),
      onNativeName: title => {
        const current = this.ctx.get('sessionTitle')?.get(agent.session)
        if (current?.source.kind === 'user' || current?.title === title) return
        const normalized = normalizeSessionTitle(title, 1024)
        if (normalized) agent.session.append('session/title', { title: normalized, messageSeqs: [], source: { kind: 'provider', provider: SessionTitleProviderId('tavlo-codex/native') } })
      },
      policy: () => nativePolicy(this.ctx.get('permissionPresets') as PermissionPresets | undefined, agent.session, cwd, this.effectivePermissions(agent.session)),
      startServer: handlers => {
        if (!this.executable) throw new Error('未找到本机 Codex。请运行 npm install -g @openai/codex，再用 codex login 登录。')
        const environment = { ...(this.config.inheritCredentials ? process.env : scrubbedParentEnv()), ...this.config.env }
        return new AppServerClient(
          this.ctx.subprocess.spawn(codexSpawnSpec(this.executable, cwd, environment, this.config.disposeGraceMs)),
          handlers, this.config.requestTimeoutMs, line => this.ctx.logger.debug(`codex: ${line}`),
        )
      },
      readImage: async (ref, signal) => {
        const attachments = this.ctx.get('attachments')
        if (attachments === undefined) throw new Error('attachment service is not available')
        return (await attachments.readImage(ref as Parameters<typeof attachments.readImage>[0], signal)).data
      },
      imageStore: () => {
        const attachments = this.ctx.get('attachments')
        return attachments ? { maxBytes: attachments.imageLimits.maxImageBytes, save: input => attachments.saveImage(input) } : undefined
      },
      askQuestion: (questions, signal) => this.ctx.get('userQuestions')?.ask({ questions, agent, signal }) ?? Promise.resolve(undefined),
      onModels: models => this.catalog.update(models),
      onDefaultModel: model => this.catalog.setDefault(model),
      onContextWindow: (model, capacity) => {
        this.catalog.updateContextWindow(model, capacity)
        if (this.ctx.agents.turnBoundaryOf(agent.session).openTurnStartSeq !== null) publishContextWindow(agent.session, PROVIDER, model, capacity)
      },
      warn: message => this.ctx.logger.warn(`codex: ${message}`),
    })
  }
}
