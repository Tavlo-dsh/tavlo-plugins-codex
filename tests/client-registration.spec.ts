// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { apply } from '../src/client/index.ts'
import type { FastToggleInjected } from '../src/client/FastToggle.tsx'
import { NS, zh } from '../src/client/locales.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({ Toast: () => null }))

function setup() {
  const cleanups: (() => void)[] = []
  const unregister = vi.fn()
  const execute = vi.fn().mockResolvedValue({ ok: true, value: { result: { kind: 'success', text: 'OK' } } })
  const directory = {}
  const contributions: { name: string; id: string; inject(id: ReturnType<typeof SessionId>): FastToggleInjected }[] = []
  const ctx = {
    effect: (effect: () => (() => void)) => { cleanups.push(effect()) },
    locale: { register: vi.fn(() => unregister), bind: () => (key: keyof typeof zh) => zh[key] },
    slots: {
      inject: vi.fn((_name: string, register: () => void) => register()),
      register: vi.fn((entry: typeof contributions[number]) => { contributions.push(entry) }),
    },
    remote: { commands: { execute } },
    modelDirectories: { directoryFor: vi.fn(() => ({ store: directory })) },
  }
  apply(ctx as unknown as Context)
  return { ctx, execute, contribution: contributions.find(entry => entry.id === 'tavlo-codex-fast')!, contributions, directory, unregister, dispose: () => cleanups.reverse().forEach(dispose => dispose()) }
}

describe('Fast client registration', () => {
  it('uses the published toolbar extension and cleans up its styles and locale', () => {
    const f = setup()
    try {
      expect(f.ctx.slots.inject).toHaveBeenCalledWith('conversation.input.right', expect.any(Function))
      expect(f.contribution.name).toBe('conversation.input.right')
      expect(f.contributions.find(entry => entry.id === 'tavlo-codex-stats')?.name).toBe('conversation.composer.dock')
      expect(f.ctx.locale.register).toHaveBeenCalledWith(NS, expect.objectContaining({ zh }))
      expect(document.head.querySelector('style')?.textContent).toContain('tavlo-codex-fast-row')
    } finally { f.dispose() }
    expect(document.head.querySelector('style')).toBeNull()
    expect(f.unregister).toHaveBeenCalledOnce()
  })
  it('executes on/off for the selected session and shares its model directory', async () => {
    const f = setup()
    try {
      const id = SessionId('target-session')
      const injected = f.contribution.inject(id)
      expect(injected.directory).toBe(f.directory)
      await injected.selectFast(true)
      await injected.selectFast(false)
      expect(f.execute.mock.calls).toEqual([[id, '/codex fast on', []], [id, '/codex fast off', []]])
    } finally { f.dispose() }
  })
  it.each([
    [{ ok: false, error: { message: 'access denied' } }, 'access denied'],
    [{ ok: true, value: undefined }, zh['fast.unavailable']],
    [{ ok: true, value: { result: { kind: 'error', text: 'native API refused' } } }, 'native API refused'],
  ])('reports an unsuccessful command: %j', async (response, message) => {
    const f = setup()
    try {
      f.execute.mockResolvedValue(response)
      await expect(f.contribution.inject(SessionId('target')).selectFast(true)).rejects.toThrow(message as string)
    } finally { f.dispose() }
  })
})
