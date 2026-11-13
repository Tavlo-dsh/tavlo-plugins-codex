/**
 * The model menu for Codex. The list comes from Codex itself
 * (`model/list`), is saved under DSH's home so the menu is complete right
 * after a restart, and offers the native default until it is known.
 * @module tavlo-plugins-codex/models
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { EffortLevel, ModelInfo } from './protocol.ts'
import type { AppServer } from './app-server.ts'
import { record, text } from './protocol.ts'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { LlmModelInfo, LlmModelReasoningInfo } from '@deepseek-ai/dsh-llm'
import { DEFAULT_MODEL_ID } from './constants.ts'
import { isContextWindow } from './context-window.ts'

/** One menu entry. */
export interface CodexModel {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly efforts?: readonly EffortLevel[]
  readonly inputModalities?: readonly ('text' | 'image')[]
}

const EFFORT_LEVELS: readonly EffortLevel[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']

const EFFORT_NAMES: Readonly<Record<EffortLevel, string>> = {
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
  ultra: 'Ultra',
}

/** Fetch Codex's complete native model catalog without creating a thread. */
export async function fetchCodexModels(server: Pick<AppServer, 'request'>): Promise<ModelInfo[]> {
  const models: ModelInfo[] = []
  let cursor: string | undefined
  const cursors = new Set<string>()
  do {
    const result = record(await server.request('model/list', { ...(cursor ? { cursor } : {}) }))
    for (const raw of Array.isArray(result.data) ? result.data : []) {
      const model = record(raw)
      if (!text(model.model)) continue
      models.push({
        model: text(model.model), displayName: text(model.displayName), description: text(model.description), hidden: model.hidden === true,
        ...(Array.isArray(model.inputModalities) ? { inputModalities: model.inputModalities.filter((m): m is string => typeof m === 'string') } : {}),
        supportedReasoningEfforts: (Array.isArray(model.supportedReasoningEfforts) ? model.supportedReasoningEfforts : []).map(raw => ({ reasoningEffort: text(record(raw).reasoningEffort) })),
      })
    }
    cursor = text(result.nextCursor) || undefined
    if (cursor && cursors.has(cursor)) throw new Error('Codex returned a repeated model-list cursor')
    if (cursor) cursors.add(cursor)
  } while (cursor)
  return models
}

/** Narrow a DSH effort id to one Codex accepts. */
export function isEffortLevel(value: string | undefined): value is EffortLevel {
  return value !== undefined && (EFFORT_LEVELS as readonly string[]).includes(value)
}

/** Shown until Codex has reported its own list. */
export const FALLBACK_MODELS: readonly CodexModel[] = [
  { id: DEFAULT_MODEL_ID, name: 'Default', description: 'Codex 设置里的模型' },
]

/** Codex's answer → menu entries. `default` always stays first. */
export function fromModelInfo(models: readonly ModelInfo[]): CodexModel[] {
  const entries = models.flatMap((model): CodexModel[] => {
    if (typeof model.model !== 'string' || model.model.length === 0 || model.hidden) return []
    const efforts = (model.supportedReasoningEfforts ?? []).map(option => option.reasoningEffort).filter(isEffortLevel)
    return [
      {
        id: model.model,
        name: model.displayName.length > 0 ? model.displayName : model.model,
        ...(model.description.length > 0 ? { description: model.description } : {}),
        ...(efforts.length > 0 ? { efforts } : {}),
        ...(model.inputModalities === undefined ? {} : { inputModalities: model.inputModalities.filter((m): m is 'text' | 'image' => m === 'text' || m === 'image') }),
      },
    ]
  })
  const first = FALLBACK_MODELS[0]
  const hasDefault = entries.some((entry) => entry.id === DEFAULT_MODEL_ID)
  return hasDefault || first === undefined ? entries : [first, ...entries]
}

function readModel(value: unknown): CodexModel | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { id, name, description, efforts, inputModalities } = value as Record<string, unknown>
  if (typeof id !== 'string' || id.length === 0 || typeof name !== 'string') return undefined
  const levels = Array.isArray(efforts)
    ? efforts.filter((level): level is EffortLevel => typeof level === 'string' && isEffortLevel(level))
    : []
  return {
    id,
    name,
    ...(typeof description === 'string' ? { description } : {}),
    ...(levels.length > 0 ? { efforts: levels } : {}),
    ...(Array.isArray(inputModalities) ? { inputModalities: inputModalities.filter((m): m is 'text' | 'image' => m === 'text' || m === 'image') } : {}),
  }
}

const CACHE_VERSION = 2

/** Parse the cache file; anything malformed reads as no cache. */
export function parseModelCache(text: string): CodexModel[] | undefined {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof data !== 'object' || data === null) return undefined
  const { version, models } = data as Record<string, unknown>
  if (version !== CACHE_VERSION || !Array.isArray(models)) return undefined
  const read = models.map(readModel)
  if (read.length === 0 || read.some((model) => model === undefined)) return undefined
  return read.filter((model) => model !== undefined)
}

/** The model list for one provider route. */
export class ModelCatalog {
  private models: readonly CodexModel[] = FALLBACK_MODELS
  private learned = false
  private defaultModel: string | undefined
  private readonly contextWindows = new Map<string, number>()
  private writing: Promise<void> = Promise.resolve()

  constructor(
    private readonly provider: string,
    private readonly cachePath: string,
    private readonly onUpdated: () => void,
    private readonly warn: (message: string) => void,
  ) {}

  /** Whether Codex's own list has been seen, in this run or a saved one. */
  get known(): boolean {
    return this.learned
  }

  /** Fill the menu from the saved list, unless Codex already answered. */
  async restore(): Promise<void> {
    let text: string
    try {
      text = await readFile(this.cachePath, 'utf8')
    } catch (error: unknown) {
      if ((error as { code?: unknown }).code !== 'ENOENT') this.warn(`could not read model cache: ${String(error)}`)
      return
    }
    const models = parseModelCache(text)
    if (models === undefined || this.learned) return
    this.models = models
    this.learned = true
    this.onUpdated()
  }

  /** Take Codex's list; saves and notifies only when it changed. */
  update(info: readonly ModelInfo[]): void {
    const models = fromModelInfo(info)
    if (models.length === 0) return
    const changed = JSON.stringify(models) !== JSON.stringify(this.models)
    this.models = models
    this.learned = true
    if (!changed) return
    this.onUpdated()
    this.save(models)
  }

  list(): LlmModelInfo[] {
    return this.models.map((model) => ({
      provider: this.provider,
      id: model.id,
      name: model.name,
      ...(model.description === undefined ? {} : { description: model.description }),
      inputModalities: this.modalities(model.id),
    }))
  }

  name(id: string): string {
    return this.models.find((model) => model.id === id)?.name ?? id
  }
  modalities(id: string): readonly ('text' | 'image')[] {
    return this.models.find(model => model.id === (id === DEFAULT_MODEL_ID ? this.defaultModel : id))?.inputModalities ?? ['text']
  }
  setDefault(model: string): void {
    if (this.defaultModel === model) return
    this.defaultModel = model
    this.onUpdated()
  }

  reasoning(id: string): LlmModelReasoningInfo | undefined {
    const efforts = this.models.find((model) => model.id === id)?.efforts
    if (efforts === undefined || efforts.length === 0) return undefined
    return { efforts: efforts.map((level) => ({ id: ReasoningEffortId(level), name: EFFORT_NAMES[level] })) }
  }

  /** Context capacity learned from Codex's native context report. */
  contextWindow(id: string): number | undefined {
    return this.contextWindows.get(id)
  }

  /** Store a provider route's actual context capacity and notify consumers. */
  updateContextWindow(id: string, contextWindow: number): void {
    if (!isContextWindow(contextWindow) || this.contextWindows.get(id) === contextWindow) return
    this.contextWindows.set(id, contextWindow)
    this.onUpdated()
  }

  private save(models: readonly CodexModel[]): void {
    const text = JSON.stringify({ version: CACHE_VERSION, models })
    this.writing = this.writing
      .then(async () => {
        const temporary = `${this.cachePath}.${randomUUID()}.tmp`
        await mkdir(dirname(this.cachePath), { recursive: true })
        try {
          await writeFile(temporary, text, 'utf8')
          await rename(temporary, this.cachePath)
        } catch (error: unknown) {
          await rm(temporary, { force: true })
          throw error
        }
      })
      .catch((error: unknown) => this.warn(`could not save model cache: ${String(error)}`))
  }
}
