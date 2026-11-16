import { describe, expect, it } from 'vitest'
import { classifyFailure, NativeDiagnostics } from '../src/native-diagnostics.ts'
import { initialNativeState } from '../src/native-state.ts'

describe('native diagnostics', () => {
  it('classifies authentication, quotas, model and generic failures without reporting success', () => {
    expect(classifyFailure('unauthorized', 'expired token')).toMatchObject({ id: 'auth', severity: 'error' })
    expect(classifyFailure('usageLimitExceeded', 'budget reached')).toMatchObject({ id: 'quota', severity: 'error' })
    expect(classifyFailure('modelNotFound', 'missing')).toMatchObject({ id: 'model', severity: 'error' })
    expect(classifyFailure('serverOverloaded', 'temporary')).toMatchObject({ id: 'turn', severity: 'error' })
  })
  it('reports provider client rejection separately from invalid credentials', () => {
    const upstream = 'AgentRouter: unauthorized client detected, contact support for assistance'
    const diagnostic = classifyFailure('unauthorized', upstream)
    expect(diagnostic).toMatchObject({ id: 'client', severity: 'error', details: upstream })
    expect(diagnostic.message).toContain('clientName')
    expect(diagnostic.message).not.toContain('登录')
    expect(classifyFailure('unauthorized', 'invalid API key')).toMatchObject({ id: 'auth' })
  })
  it('retains only relevant diagnostics, deduplicates ids and clears recovered MCP/quota', () => {
    let state = initialNativeState()
    const diagnostics = new NativeDiagnostics(() => state, entries => { state = { ...state, diagnostics: entries } })
    const notification = (method: string, params: Record<string, unknown>) => diagnostics.notification({ method, params })
    notification('configWarning', { summary: 'Config is invalid', path: '/private/config.toml' })
    notification('mcpServer/startupStatus/updated', { name: 'git', status: 'failed', error: 'MCP unavailable' })
    notification('mcpServer/startupStatus/updated', { name: 'git', status: 'ready' })
    notification('account/rateLimits/updated', { rateLimits: { rateLimitReachedType: 'rate_limit_reached' } })
    notification('account/rateLimits/updated', { rateLimits: { rateLimitReachedType: null, primary: { usedPercent: 0 } } })
    diagnostics.set(classifyFailure('unauthorized', 'no token'))
    diagnostics.set(classifyFailure('unauthorized', 'no token'))
    expect(state.diagnostics).toHaveLength(2)
    expect(state.diagnostics.map(d => d.id)).toEqual(['configWarning:global', 'auth'])
    expect(state.diagnostics[0]?.details).toBeUndefined()
  })
})
