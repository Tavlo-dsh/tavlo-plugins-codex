import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { SubprocessHandle, SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'
import { AppServerClient, RpcError } from '../src/app-server.ts'

function connection(timeout = 1000) {
  const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough()
  let end!: (outcome: SubprocessOutcome) => void
  const done = new Promise<SubprocessOutcome>(resolve => { end = resolve })
  const terminate = vi.fn(() => { end({ exitCode: 0, signal: null } as SubprocessOutcome) })
  const handlers = { notification: vi.fn(), request: vi.fn(), failure: vi.fn() }
  const requests: Record<string, unknown>[] = []
  let input = ''
  stdin.on('data', chunk => {
    input += chunk.toString()
    let newline: number
    while ((newline = input.indexOf('\n')) >= 0) {
      requests.push(JSON.parse(input.slice(0, newline))); input = input.slice(newline + 1)
    }
  })
  const client = new AppServerClient({ stdin, stdout, stderr, done, terminate } as unknown as SubprocessHandle, handlers, timeout, () => {})
  return { client, stdout, stderr, requests, handlers, terminate, end }
}
describe('app-server wire transport', () => {
  it('handles fragmented and batched lines and out-of-order responses', async () => {
    const c = connection()
    const first = c.client.request('first', {}), second = c.client.request('second', {})
    c.stdout.write('{"id":2,"result":{"value":2}}\n{"id":1,')
    c.stdout.write('"result":{"value":1}}\n')
    expect(await first).toEqual({ value: 1 }); expect(await second).toEqual({ value: 2 })
    c.stdout.write('{"method":"event","params":{"text":"中"}}\r\n{"id":"approval","method":"ask","params":{}}\n')
    expect(c.handlers.notification).toHaveBeenCalledWith({ method: 'event', params: { text: '中' } })
    expect(c.handlers.request).toHaveBeenCalledWith({ id: 'approval', method: 'ask', params: {} })
    c.client.respond('approval', { decision: 'accept' })
    expect(c.requests.at(-1)).toEqual({ id: 'approval', result: { decision: 'accept' } })
    expect(c.requests[0]).not.toHaveProperty('jsonrpc')
    await c.client.close()
  })
  it('distinguishes RPC rejection from a process failure', async () => {
    const c = connection()
    const response = c.client.request('turn/start', {})
    const rejected = expect(response).rejects.toBeInstanceOf(RpcError)
    c.stdout.write('{"id":1,"error":{"code":-32600,"message":"invalid model"}}\n')
    await rejected
    expect(c.handlers.failure).not.toHaveBeenCalled()
    await c.client.close()
  })
  it('rejects every waiter and terminates on malformed JSON', async () => {
    const c = connection()
    const rejected = expect(c.client.request('pending', {})).rejects.toThrow('Invalid Codex RPC')
    c.stdout.write('not json\n')
    await rejected
    expect(c.handlers.failure).toHaveBeenCalledOnce()
    expect(c.terminate).toHaveBeenCalledOnce()
    await c.client.close()
  })
  it('times out a silent server instead of hanging forever', async () => {
    const c = connection(10)
    await expect(c.client.request('initialize', {})).rejects.toThrow('timed out: initialize')
    expect(c.terminate).toHaveBeenCalledOnce()
    await c.client.close()
  })
  it('reports bounded stderr diagnostics when a process exits', async () => {
    const c = connection()
    const rejected = expect(c.client.request('pending', {})).rejects.toThrow('fatal: test error')
    c.stderr.write('fatal: test error\n')
    c.end({ exitCode: 7, signal: null } as SubprocessOutcome)
    await rejected
    expect(c.handlers.failure).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('7') }))
    await c.client.close()
  })
})
