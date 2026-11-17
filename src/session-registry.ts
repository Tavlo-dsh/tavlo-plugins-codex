/**
 * Maps DSH sessions to their live Codex sessions and follows each session log to know
 * where DSH turns begin and end. Holds no framework state, so `index.ts` stays wiring.
 * Turn tracking follows dsh-ccgui.
 * @module tavlo-plugins-codex/session-registry
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { CodexSession, PermissionAsk } from './codex-session.ts'
import { MIRROR_TOOL_NAME, PROVIDER } from './constants.ts'
import type { ToolOutcome } from './events.ts'

/** What a new Codex session inherits from the one it replaces. */
export interface SessionStart {
  readonly sentMessageIds: ReadonlySet<string>
  readonly inheritedReplay?: CodexSession['checkpoint']
  /** Settles once the previous process has stopped. */
  readonly after: Promise<void>
}

/** DSH facilities the registry uses. */
export interface RegistryDeps {
  getAgent(sessionId: string): Agent | undefined
  ask(agent: Agent, request: PermissionAsk, signal: AbortSignal): Promise<ApprovalOutcome>
  warn(message: string): void
  createSession(agent: Agent, sessionId: string, cwd: string, start: SessionStart): CodexSession
}

/** The fields of a session log event the registry reads. */
export interface ObservedEvent {
  readonly type: string
  readonly data?: unknown
}

const NO_MESSAGES: ReadonlySet<string> = new Set()

/** Owns every live Codex session in this process. */
export class SessionRegistry {
  private readonly sessions = new Map<string, CodexSession>()
  private readonly stopping = new Map<string, Promise<void>>()
  private readonly turnMessages = new Map<string, Set<string>>()
  private readonly permissionChanges = new Set<string>()

  constructor(private readonly deps: RegistryDeps) {}

  /** Whether a provider route is this plugin's. */
  isOwnRoute(provider: string): boolean {
    return provider === PROVIDER
  }

  /**
   * Follow one session log event. Only messages logged since the latest `turn/start`
   * count as new, which keeps a prompt from being sent twice after a failed turn,
   * a replaced process or a restart.
   */
  observeEvent(sessionId: string, event: ObservedEvent): void {
    switch (event.type) {
      case 'permission/preset':
      case 'sandbox/mode':
      case 'approval/policy': {
        if (this.permissionChanges.has(sessionId)) return
        const session = this.sessions.get(sessionId)
        if (!session) return
        this.permissionChanges.add(sessionId)
        // A preset writes multiple knob events synchronously. Read the final
        // values outside append observers, where projection writes are legal.
        queueMicrotask(() => {
          this.permissionChanges.delete(sessionId)
          if (this.sessions.get(sessionId) !== session) return
          void session.refreshPermissions().catch(error => this.deps.warn(`Codex 权限同步失败：${String(error)}`))
        })
        return
      }
      case 'turn/start':
        this.turnMessages.set(sessionId, new Set())
        return
      case 'user/message': {
        const id = (event.data as { id?: unknown } | undefined)?.id
        if (typeof id === 'string') this.turnMessages.get(sessionId)?.add(id)
        return
      }
      case 'turn/end':
        this.turnMessages.delete(sessionId)
        this.sessions.get(sessionId)?.abandonTurn()
        return
      default:
    }
  }

  /** Ids of the user messages in a session's open turn; empty outside a turn. */
  currentTurnMessageIds(sessionId: string): ReadonlySet<string> {
    return this.turnMessages.get(sessionId) ?? NO_MESSAGES
  }
  peek(sessionId: string): CodexSession | undefined { return this.sessions.get(sessionId) }

  /**
   * Find or create the Codex session for a DSH session.
   * @returns a session; a dead one is returned until its failure has been read.
   */
  resolveSession(sessionId: string): CodexSession {
    const agent = this.deps.getAgent(sessionId)
    if (agent === undefined) throw new LlmError(`找不到会话 ${sessionId}。`, 'CODEX_START_FAILED')
    const current = this.sessions.get(sessionId)
    if (current !== undefined && !current.replaceable) return current
    this.stopSession(sessionId)
    const { cwd } = agent.session.header
    if (cwd === undefined) throw new LlmError('Codex 需要工作目录，但这个会话没有。', 'CODEX_START_FAILED')
    const session = this.deps.createSession(agent, sessionId, cwd, {
      sentMessageIds: current?.sentMessageIds ?? NO_MESSAGES,
      inheritedReplay: current?.checkpoint,
      after: this.stopping.get(sessionId) ?? Promise.resolve(),
    })
    this.sessions.set(sessionId, session)
    return session
  }

  /** Body of the mirror tool: wait for Codex's result of the call `exec` mirrors. */
  waitForTool(exec: ToolRunContext): Promise<ToolOutcome> {
    const { agent, callId, signal } = exec
    const session = agent === undefined ? undefined : this.sessions.get(agent.id)
    if (agent === undefined || session === undefined) {
      return Promise.reject(new Error(`${MIRROR_TOOL_NAME} 只记录 Codex 发出的调用，不能直接使用。`))
    }
    return session.waitForTool(callId, (request, askSignal) => this.deps.ask(agent, request, askSignal), signal)
  }

  /** Forget a DSH session and stop its Codex. */
  disposeSession(sessionId: string): void {
    this.turnMessages.delete(sessionId)
    this.stopSession(sessionId)
  }

  /** Stop every Codex; `reason` is shown to any turn this cuts off. */
  disposeAll(reason?: string): Promise<void> {
    for (const sessionId of [...this.sessions.keys()]) {
      this.turnMessages.delete(sessionId)
      this.stopSession(sessionId, reason)
    }
    return Promise.all(this.stopping.values()).then(() => undefined)
  }

  /** Stop the process only; the DSH session and its open turn carry on. */
  private stopSession(sessionId: string, reason?: string): void {
    const live = this.sessions.get(sessionId)
    if (live === undefined) return
    this.sessions.delete(sessionId)
    const stoppedSelf = live.dispose(reason).catch((error: unknown) => {
      this.deps.warn(`failed to stop Codex: ${String(error)}`)
    })
    // Chained so quick replacements still wait for the oldest process.
    const stopped: Promise<void> = Promise.all([this.stopping.get(sessionId), stoppedSelf]).then(() => {
      if (this.stopping.get(sessionId) === stopped) this.stopping.delete(sessionId)
    })
    this.stopping.set(sessionId, stopped)
  }
}
