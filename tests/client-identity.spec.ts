import { describe, expect, it } from 'vitest'
import { codexInitializeParams } from '../src/client-identity.ts'
import TavloCodex from '../src/index.ts'
import type { Config } from '../src/index.ts'

describe('Codex client configuration', () => {
  it('defaults an existing empty plugin configuration to the Codex DSH identity', () => {
    expect(TavloCodex.Config({} as Config).clientName).toBe('codex_dsh')
    expect(codexInitializeParams('provider_approved_dsh')).toMatchObject({
      clientInfo: { name: 'provider_approved_dsh', title: 'Tavlo DSH' },
    })
  })
  it('inherits native speed unless a boolean Fast default is explicitly configured', () => {
    expect(TavloCodex.Config({} as Config).fastMode).toBeUndefined()
    expect(TavloCodex.Config({ fastMode: true } as Config).fastMode).toBe(true)
    expect(TavloCodex.Config({ fastMode: false } as Config).fastMode).toBe(false)
    expect(() => TavloCodex.Config({ fastMode: 'fast' } as unknown as Config)).toThrow()
  })
  it.each(['', '   ', 'codex_dsh\r\nAuthorization: injected', 'codex_dsh\u0000', '客户端'])(
    'rejects invalid client identity %j before building a handshake', name => {
      expect(() => codexInitializeParams(name)).toThrow('clientName')
    },
  )
})
