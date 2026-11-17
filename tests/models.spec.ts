import { describe, expect, it, vi } from 'vitest'
import { fetchCodexModels, ModelCatalog } from '../src/models.ts'
import { CodexAdapter } from '../src/adapter.ts'

// These tests exercise discovery and catalog updates, not disk persistence.
// Keep asynchronous cache writes from leaving files behind after the worker exits.
vi.mock('node:fs/promises', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs/promises')>(),
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
}))

describe('Codex model discovery', () => {
  it('loads every native model page without starting a thread and refreshes the provider catalog', async () => {
    const request = vi.fn(async (_method: string, params: Record<string, unknown>) => params.cursor === 'page-2'
      ? { data: [{ model: 'gpt-next', displayName: 'GPT Next', description: 'Latest', inputModalities: ['text', 'image'], supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }], nextCursor: null }
      : { data: [{ model: 'gpt-main', displayName: 'GPT Main', description: 'Default model', inputModalities: ['text'] }], nextCursor: 'page-2' })
    const updated = vi.fn()
    const catalog = new ModelCatalog('codex', 'models-test.json', updated, vi.fn())

    catalog.update(await fetchCodexModels({ request }))

    expect(request.mock.calls).toEqual([
      ['model/list', {}],
      ['model/list', { cursor: 'page-2' }],
    ])
    expect(catalog.list().map(model => model.id)).toEqual(['default', 'gpt-main', 'gpt-next'])
    expect(catalog.list()[2]).toMatchObject({ name: 'GPT Next', inputModalities: ['text', 'image'] })
    expect(catalog.reasoning('gpt-next')?.efforts.map(option => option.id)).toEqual(['high'])
    expect(updated).toHaveBeenCalledOnce()
  })

  it('refuses a repeated page cursor instead of looping forever', async () => {
    const request = vi.fn(async () => ({ data: [{ model: 'gpt-main' }], nextCursor: 'same' }))
    await expect(fetchCodexModels({ request })).rejects.toThrow('repeated model-list cursor')
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('waits for discovery before returning the first uncached provider catalog', async () => {
    const catalog = new ModelCatalog('codex', 'models-test.json', vi.fn(), vi.fn())
    const ensureModels = vi.fn(async () => catalog.update([
      { model: 'gpt-native', displayName: 'GPT Native', description: '', supportedReasoningEfforts: [] },
    ]))
    const adapter = new CodexAdapter({
      catalog, ensureModels, auxiliary: {} as never,
      resolveSession: () => { throw new Error('not used') }, currentTurnMessageIds: () => new Set(),
    })

    await expect(adapter.listModels('codex')).resolves.toEqual([
      expect.objectContaining({ provider: 'codex', id: 'default' }),
      expect.objectContaining({ provider: 'codex', id: 'gpt-native', name: 'GPT Native' }),
    ])
    expect(ensureModels).toHaveBeenCalledOnce()
  })
})
