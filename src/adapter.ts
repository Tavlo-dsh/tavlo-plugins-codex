/**
 * Presents Codex to DSH as a model provider: it appears in the model menu and the
 * DSH agent loop drives it step by step, while the real work happens inside Codex.
 * @module tavlo-plugins-codex/adapter
 */

import { LlmAdapter, LlmError, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  PreparedAdapterCall,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { AuxiliaryRouter } from './auxiliary.ts'
import type { CodexSession } from './codex-session.ts'
import { PROVIDER_LABEL } from './constants.ts'
import type { ModelCatalog } from './models.ts'

/**
 * DSH 0.2 has no per-provider external-compaction flag. Its compaction backend
 * calls resolveModel(), while the UI reads the prepared request's context.
 * Keep the existing host guard here; prepareCall() publishes only Codex's
 * reported capacity, so this guard never becomes the displayed denominator.
 */
const HOST_COMPACTION_GUARD = 1_000_000_000

/** A retry would resend a prompt Codex may already have acted on. */
const NO_RETRY: ResolvedRetryPolicy = resolveRetryPolicy({ mode: 'normal', maxRetries: 0 }, 'tavlo-plugins-codex')

/** What the adapter needs from the plugin. */
export interface AdapterDeps {
  readonly catalog: ModelCatalog
  /** Resolve the initial model catalog before the host snapshots this provider. */
  readonly ensureModels: () => Promise<void>
  /** Routes auxiliary requests Codex refuses to another provider. */
  readonly auxiliary: AuxiliaryRouter
  /** The live Codex session for a DSH session; throws when it cannot run. */
  resolveSession(sessionId: string): CodexSession
  /** Ids of the user messages in the session's open turn. */
  currentTurnMessageIds(sessionId: string): ReadonlySet<string>
}

/** Routes DSH model requests to Codex sessions. */
export class CodexAdapter extends LlmAdapter {
  constructor(private readonly deps: AdapterDeps) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: PROVIDER_LABEL }
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    return NO_RETRY
  }

  override async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    if (!this.deps.catalog.known) await this.deps.ensureModels()
    return this.deps.catalog.list()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const reasoning = this.deps.catalog.reasoning(model)
    return Promise.resolve({
      provider,
      id: model,
      name: this.deps.catalog.name(model),
      inputModalities: this.deps.catalog.modalities(model),
      context: { contextWindow: HOST_COMPACTION_GUARD },
      ...(reasoning === undefined ? {} : { reasoning }),
    })
  }

  override async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    signal?.throwIfAborted()
    const { context: _guard, ...info } = await this.resolveModel(provider, model)
    signal?.throwIfAborted()
    const contextWindow = this.deps.catalog.contextWindow(model)
    return {
      model: { ...info, ...(contextWindow === undefined ? {} : { context: { contextWindow } }) },
      stream: (options) => this.stream(options),
    }
  }

  /**
   * Run one DSH step on the session's Codex. Auxiliary requests (titles, summaries)
   * expect a stateless model; sending one here would land in the user's real Codex
   * conversation, so the auxiliary router hands it to another provider instead.
   * @yields stream chunks.
   */
  override async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    const { model, reasoningEffort, sessionId, messages, signal, purpose } = options
    if (purpose !== undefined) {
      yield* this.deps.auxiliary.stream(options)
      return
    }
    if (sessionId === undefined) {
      throw new LlmError('Codex 只能在会话里使用，不支持一次性模型请求。', 'UNSUPPORTED_OPTION')
    }
    const session = this.deps.resolveSession(sessionId)
    yield* session.stream({
      messages,
      signal,
      model,
      reasoningEffort,
      currentTurnMessageIds: this.deps.currentTurnMessageIds(sessionId),
    })
  }
}
