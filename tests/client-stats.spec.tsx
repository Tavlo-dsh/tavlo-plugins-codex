// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import type { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { initialNativeState, type NativeView } from '../src/native-state.ts'
import { NativeStats, type NativeStatsProps } from '../src/client/NativeStats.tsx'
import { compactTokens, percent, statsView } from '../src/client/stats-view.ts'
import { zh } from '../src/client/locales.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Tooltip: ({ children }: ComponentProps<typeof Tooltip>) => children,
  IconDatabaseOutlineRegular: () => <svg aria-hidden="true" />,
  IconGaugeOutlineRegular: () => <svg aria-hidden="true" />,
  useDismissOnOutsidePointer: () => {},
}))
afterEach(cleanup)

function observed(): NativeView {
  const state = initialNativeState()
  state.threadId = 'thread'
  state.usage = {
    ...state.usage, model: 'default', baseline: 'exact', contextWindow: 200000,
    consumed: { inputTokens: 1000, cacheReadTokens: 8000, cacheWriteTokens: 1000, outputTokens: 2000, reasoningTokens: 1000, totalTokens: 12000 },
    last: { inputTokens: 1000, cacheReadTokens: 7000, cacheWriteTokens: 1000, outputTokens: 1000, reasoningTokens: 500, totalTokens: 10000 },
    lastTurn: { turnId: 't1', outputTokens: 2000, durationMs: 40000 },
  }
  return state
}
function fixture() {
  let state: NativeView | undefined = observed()
  let model = { provider: 'codex', model: 'default' }
  const props: NativeStatsProps = {
    useProjection: ((key: string) => key === 'tavloCodex' ? state : { next: model }) as NativeStatsProps['useProjection'],
    useSession: selector => selector({ subagent: null, removed: false, openState: 'open' } as never),
    directory: { getSnapshot: () => null as never, subscribe: () => () => {}, set: () => {}, update: () => {} },
    t: (key, args) => (zh[key as keyof typeof zh] ?? key).replace(/\{(\w+)\}/g, (_, name: string) => String(args?.[name] ?? '')),
  }
  // A shared, stable directory snapshot, as provided by the actual host.
  const models = { current: null, pending: null }
  props.directory.getSnapshot = () => models as ReturnType<NativeStatsProps['directory']['getSnapshot']>
  return { props, state: (next: NativeView | undefined) => { state = next }, model: (next: typeof model) => { model = next } }
}

describe('native statistics readings', () => {
  it('separates cumulative consumption/cache from latest context and whole-turn speed', () => {
    expect(statsView(observed(), 'default')).toEqual({
      observed: true, total: 12000, cache: '80', speed: 50,
      context: { used: 10000, capacity: 200000, percent: '5', fraction: .05 },
    })
    expect(compactTokens(12000)).toBe('12K')
    expect(compactTokens(51400)).toBe('51.4K')
    expect(compactTokens(1250000)).toBe('1.3M')
  })
  it('does not claim a full hit, empty context or measured speed when values are unknown', () => {
    expect(percent(99999, 100000)).toBe('>99.9')
    expect(percent(1, 200000)).toBe('<0.1')
    expect(percent(100000, 100000)).toBe('100')
    expect(statsView(initialNativeState())).toMatchObject({ observed: false, total: undefined, cache: undefined, speed: undefined, context: undefined })
    const zero = initialNativeState(); zero.usage.nativeTotal = { ...zero.usage.consumed }
    expect(statsView(zero)).toMatchObject({ total: 0, cache: undefined })
  })
  it('suppresses stale context and speed after model changes while retaining consumption', () => {
    expect(statsView(observed(), 'other')).toMatchObject({ total: 12000, cache: '80', context: undefined, speed: undefined })
  })
  it('shows all requested readings from an already-persisted projection', () => {
    const f = fixture()
    render(<NativeStats {...f.props} />)
    expect(screen.getByRole('button', { name: /12K tok · 缓存 80%/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /均速 50 tok\/s/ }).getAttribute('aria-label')).toContain('包含工具执行和等待')
    expect(screen.getByRole('button', { name: /上下文 5%/ }).getAttribute('aria-label')).toContain('10000 / 200000')
  })
  it('opens the same kind of detail cards as the host statistics controls', () => {
    const f = fixture()
    render(<NativeStats {...f.props} />)
    fireEvent.click(screen.getByRole('button', { name: /均速 50 tok\/s/ }))
    expect(screen.getByRole('dialog', { name: '回合速度' }).textContent).toContain('回合输出2,000 tok')
    expect(screen.getByRole('dialog', { name: '回合速度' }).textContent).toContain('包含工具执行和等待')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: '回合速度' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /12K tok · 缓存 80%/ }))
    expect(screen.getByRole('dialog', { name: 'Token 用量' }).textContent).toContain('未缓存输入1,000 tok')
    expect(screen.getByRole('dialog', { name: 'Token 用量' }).textContent).toContain('缓存读取8,000 tok')

    fireEvent.click(screen.getByRole('button', { name: /上下文 5%/ }))
    expect(screen.queryByRole('dialog', { name: 'Token 用量' })).toBeNull()
    expect(screen.getByRole('dialog', { name: '上下文占用' }).textContent).toContain('当前占用10,000 tok')
    expect(screen.getByRole('dialog', { name: '上下文占用' }).textContent).toContain('窗口容量200,000 tok')
  })
  it('keeps totals after compaction while showing the missing context sample explicitly', () => {
    const f = fixture(), state = observed()
    const view = render(<NativeStats {...f.props} />)
    delete state.usage.last
    state.compaction.status = 'running'
    f.state(state); view.rerender(<NativeStats {...f.props} />)
    expect(screen.getByRole('button', { name: /12K tok/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /上下文/ }).getAttribute('aria-label')).toContain('正在压缩')
    expect(screen.queryByRole('button', { name: /上下文 5%/ })).toBeNull()
  })
  it('explains missing legacy timing and an inferred resume baseline', () => {
    const f = fixture(), state = observed()
    delete state.usage.lastTurn
    state.usage.baseline = 'inferred'
    f.state(state)
    render(<NativeStats {...f.props} />)
    expect(screen.getByRole('button', { name: /均速 —/ }).getAttribute('aria-label')).toContain('旧记录无法补算速度')
    expect(screen.getByRole('button', { name: /12K tok/ }).getAttribute('aria-label')).toContain('历史用量未计入')
  })
  it('hides for other providers, missing projections and unused conversations', () => {
    const f = fixture()
    f.model({ provider: 'claude', model: 'default' })
    const view = render(<NativeStats {...f.props} />)
    expect(screen.queryAllByRole('button')).toHaveLength(0)
    f.model({ provider: 'codex', model: 'default' }); f.state(undefined)
    view.rerender(<NativeStats {...f.props} />)
    expect(screen.queryAllByRole('button')).toHaveLength(0)
    f.state(initialNativeState()); view.rerender(<NativeStats {...f.props} />)
    expect(screen.queryAllByRole('button')).toHaveLength(0)
  })
})
