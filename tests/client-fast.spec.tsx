// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import type { Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import { SessionId } from '@deepseek-ai/dsh-session'
import { FastToggle, type FastToggleProps } from '../src/client/FastToggle.tsx'
import { initialNativeState, type NativeView } from '../src/native-state.ts'
import { speedView } from '../src/client/speed-view.ts'
import { zh } from '../src/client/locales.ts'

// Keep the component tests about interaction/state; the browser smoke uses the host's real primitives.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Toast: ({ text }: ComponentProps<typeof Toast>) => <div role="alert">{text}</div>,
}))
afterEach(cleanup)

function fixture() {
  let state: NativeView | undefined = initialNativeState()
  let selection: { next: { provider: string; model: string } | null; lastUsed: null } = {
    next: { provider: 'codex', model: 'default' }, lastUsed: null,
  }
  let writable = true
  let snapshot: Pick<SessionSnapshot, 'running' | 'subagent' | 'removed' | 'openState'> = {
    running: false, subagent: null, removed: false, openState: 'open',
  }
  let models: ReturnType<FastToggleProps['directory']['getSnapshot']> = {
    current: null, pending: null, routable: true, groups: [], failures: [], status: 'ready', error: null,
  }
  const listeners = new Set<() => void>()
  const selectFast = vi.fn<(enabled: boolean) => Promise<void>>().mockResolvedValue(undefined)
  const props: FastToggleProps = {
    sessionId: SessionId('first'),
    useProjection: ((key: string) => key === 'tavloCodex' ? state : selection) as FastToggleProps['useProjection'],
    useSession: selector => selector(snapshot as SessionSnapshot),
    useAccess: vi.fn(() => writable),
    directory: {
      getSnapshot: () => models,
      subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
      set: next => { models = next; listeners.forEach(listener => listener()) },
      update: mutator => { const next = { ...models }; mutator(next); props.directory.set(next) },
    },
    selectFast,
    t: (key, args) => (zh[key as keyof typeof zh] ?? key).replace('{message}', String(args?.message ?? '')),
  }
  return {
    props, selectFast,
    state: (next: NativeView | undefined) => { state = next },
    selection: (provider: string | null) => { selection = { next: provider ? { provider, model: 'default' } : null, lastUsed: null } },
    session: (next: Partial<typeof snapshot>) => { snapshot = { ...snapshot, ...next } },
    access: (next: boolean) => { writable = next },
  }
}

describe('speed display', () => {
  it('preserves an unknown inherited default until there is an observation or explicit choice', () => {
    expect(speedView(initialNativeState())).toEqual({ checked: false, inherited: true })
  })
  it.each([
    ['fast', false, null, true], ['standard', true, 'fast', false],
    ['inherit', true, undefined, true], ['inherit', false, 'fast', false],
    ['inherit', undefined, 'fast', true], ['inherit', undefined, 'priority', true],
    ['inherit', undefined, null, false], ['inherit', undefined, 'default', false],
  ] as const)('resolves %s / default %s / tier %s', (selected, fastModeDefault, effectiveTier, checked) => {
    expect(speedView({ ...initialNativeState(), fastModeDefault,
      speed: { selected, effectiveTier, capability: 'supported' },
    })).toEqual({ checked, inherited: false })
  })
})

describe('Fast switch', () => {
  it('appears for Codex, including an unused conversation whose default comes from the model directory', () => {
    const f = fixture()
    const view = render(<FastToggle {...f.props} />)
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false')
    expect(screen.getByRole('switch').getAttribute('aria-label')).toBe('Codex Fast 模式，使用 Codex 默认设置')
    expect(screen.getByRole('switch').querySelector('path')).toBeTruthy()
    expect(screen.getByRole('status').textContent).toBe('默认')
    expect(f.props.useAccess).toHaveBeenCalledWith('commands/execute')
    f.selection('claude')
    view.rerender(<FastToggle {...f.props} />)
    expect(screen.queryByRole('switch')).toBeNull()
    f.selection(null)
    act(() => f.props.directory.update(value => { value.current = { provider: 'codex', model: 'default' } }))
    expect(screen.getByRole('switch')).toBeTruthy()
    f.state(undefined)
    view.rerender(<FastToggle {...f.props} />)
    expect(screen.queryByRole('switch')).toBeNull()
  })
  it('waits for the projection, prevents duplicate clicks, and sends the inverse current selection', async () => {
    const f = fixture()
    const request = Promise.withResolvers<void>()
    f.selectFast.mockReturnValueOnce(request.promise)
    const view = render(<FastToggle {...f.props} />)
    fireEvent.click(screen.getByRole('switch'))
    fireEvent.click(screen.getByRole('switch'))
    expect(f.selectFast).toHaveBeenCalledExactlyOnceWith(true)
    expect((screen.getByRole('switch') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false')
    expect(screen.getByRole('status').textContent).toBe('切换中…')
    await act(async () => { request.resolve(); await request.promise })
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false')
    f.state({ ...initialNativeState(), speed: { selected: 'fast', capability: 'supported' } })
    view.rerender(<FastToggle {...f.props} />)
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('switch').getAttribute('aria-label')).toBe('Codex Fast 模式，已开启')
    await act(async () => { fireEvent.click(screen.getByRole('switch')) })
    expect(f.selectFast).toHaveBeenLastCalledWith(false)
  })
  it('shows the native error, preserves the previous choice, and allows a retry', async () => {
    const f = fixture()
    f.state({ ...initialNativeState(), speed: { selected: 'fast', capability: 'supported' } })
    f.selectFast.mockRejectedValueOnce(new Error('service tier unavailable'))
    render(<FastToggle {...f.props} />)
    await act(async () => { fireEvent.click(screen.getByRole('switch')) })
    expect(screen.getByRole('alert').textContent).toContain('service tier unavailable')
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true')
    expect((screen.getByRole('switch') as HTMLButtonElement).disabled).toBe(false)
  })
  it.each(['running', 'access', 'model'] as const)('refuses clicks while blocked by %s', reason => {
    const f = fixture()
    if (reason === 'running') f.session({ running: true })
    if (reason === 'access') f.access(false)
    if (reason === 'model') f.props.directory.update(value => { value.pending = { provider: 'codex', model: 'other' } })
    render(<FastToggle {...f.props} />)
    expect((screen.getByRole('switch') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('switch'))
    expect(f.selectFast).not.toHaveBeenCalled()
  })
  it.each([{ removed: true }, { openState: 'loading' as const }, { subagent: { address: {} } }])('hides unavailable sessions: %j', unavailable => {
    const f = fixture()
    f.session(unavailable as Partial<SessionSnapshot>)
    render(<FastToggle {...f.props} />)
    expect(screen.queryByRole('switch')).toBeNull()
  })
  it('isolates a pending request and late error from the next session', async () => {
    const f = fixture(), next = fixture()
    const request = Promise.withResolvers<void>()
    f.selectFast.mockReturnValue(request.promise)
    const view = render(<FastToggle {...f.props} />)
    fireEvent.click(screen.getByRole('switch'))
    view.rerender(<FastToggle {...next.props} sessionId={SessionId('second')} />)
    expect((screen.getByRole('switch') as HTMLButtonElement).disabled).toBe(false)
    await act(async () => { request.reject(new Error('previous session failure')); await request.promise.catch(() => {}) })
    expect(screen.queryByRole('alert')).toBeNull()
    await act(async () => { fireEvent.click(screen.getByRole('switch')) })
    expect(next.selectFast).toHaveBeenCalledExactlyOnceWith(true)
  })
})
