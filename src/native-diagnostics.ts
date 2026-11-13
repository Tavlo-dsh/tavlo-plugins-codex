import type { NativeState } from './native-state.ts'
import type { RpcNotification } from './protocol.ts'
import { record, text } from './protocol.ts'

type Entry = NativeState['diagnostics'][number]
export function classifyFailure(code: unknown, message: string): Entry {
  const kind = typeof code === 'string' ? code : 'other', lower = `${kind} ${message}`.toLowerCase()
  if (/unauthorized|authentication|not logged in|login required/.test(lower)) return { id: 'auth', kind, severity: 'error', message: 'Codex 认证失败。请使用本机 Codex CLI 登录并重试。', details: message.slice(0, 2000) }
  if (/usage.?limit|rate.?limit|quota|credits|budget/.test(lower)) return { id: 'quota', kind, severity: 'error', message: 'Codex 额度或速率限制已触发；检查账户用量和恢复时间。', details: message.slice(0, 2000) }
  if (/model.*not.*found|modelnotfound/.test(lower)) return { id: 'model', kind, severity: 'error', message: 'Codex 当前模型不可用；检查模型选择后重试。', details: message.slice(0, 2000) }
  return { id: 'turn', kind, severity: 'error', message: 'Codex 原生回合未完成。', details: message.slice(0, 2000) }
}
export class NativeDiagnostics {
  constructor(private readonly state: () => NativeState, private readonly update: (entries: NativeState['diagnostics']) => void) {}
  set(entry: Entry): void {
    const current = this.state().diagnostics, next = [...current.filter(old => old.id !== entry.id), entry].slice(-100)
    if (JSON.stringify(current) !== JSON.stringify(next)) this.update(next)
  }
  notification({ method, params: p }: RpcNotification): void {
    if (typeof p.threadId === 'string' && this.state().threadId !== undefined && p.threadId !== this.state().threadId && !this.state().agents[p.threadId]) return
    if (method === 'warning' || method === 'configWarning' || method === 'guardianWarning') {
      const id = text(p.threadId) || 'global', message = text(p.message) || text(p.summary) || text(p.title) || text(p.kind)
      if (message) this.set({ id: `${method}:${id}`, kind: method, severity: 'warning', message: message.slice(0, 4000), ...(text(p.details) ? { details: text(p.details).slice(0, 2000) } : {}) })
    } else if (method === 'mcpServer/startupStatus/updated') {
      const name = text(p.name), status = text(p.status)
      if (status === 'failed') this.set({ id: `mcp:${name}`, kind: 'mcp', severity: 'warning', message: `MCP server ${name || 'unknown'} failed to start.`, ...(text(p.error) ? { details: text(p.error).slice(0, 2000) } : {}) })
      else if (status === 'ready') this.remove(`mcp:${name}`)
    } else if (method === 'windowsSandbox/setupCompleted') {
      this.set({ id: 'windows-sandbox', kind: 'sandbox', severity: p.success === true ? 'info' : 'error', message: p.success === true ? 'Windows sandbox setup completed.' : 'Windows sandbox setup failed.', ...(text(p.error) ? { details: text(p.error).slice(0, 2000) } : {}) })
    } else if (method === 'account/rateLimits/updated') {
      const limits = record(p.rateLimits), reached = text(limits.rateLimitReachedType)
      if (reached) this.set({ id: 'quota', kind: 'quota', severity: 'warning', message: `Codex account limit reached: ${reached}.` })
      else if ([limits.primary, limits.secondary].some(window => typeof record(window).usedPercent === 'number')
        && [limits.primary, limits.secondary].every(window => window == null || typeof record(window).usedPercent === 'number' && Number(record(window).usedPercent) < 100)) this.remove('quota')
    }
  }
  remove(id: string): void { const next = this.state().diagnostics.filter(entry => entry.id !== id); if (next.length !== this.state().diagnostics.length) this.update(next) }
}
