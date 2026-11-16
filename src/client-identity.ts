import { validateHeaderValue } from 'node:http'
import { createRequire } from 'node:module'

/** Identifies the actual Codex integration while retaining the host's name. */
export const DEFAULT_CLIENT_NAME = 'codex_dsh'

const { version } = createRequire(import.meta.url)('../package.json') as { version: string }

/** Codex uses clientInfo.name for both originator and its upstream User-Agent. */
export function codexInitializeParams(clientName = DEFAULT_CLIENT_NAME): Record<string, unknown> {
  if (clientName.trim().length === 0) throw new Error('Codex clientName 不能为空。')
  try { validateHeaderValue('originator', clientName) } catch {
    throw new Error('Codex clientName 必须是有效的 HTTP 请求头值，不能包含换行或不支持的字符。')
  }
  return {
    clientInfo: { name: clientName, title: 'Tavlo DSH', version },
    capabilities: { experimentalApi: true, requestAttestation: false },
  }
}
