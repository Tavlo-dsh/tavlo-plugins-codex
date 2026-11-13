/** JSONL, bidirectional JSON-RPC connection over a DSH-owned subprocess. */
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import type { RpcId, RpcNotification, RpcRequest } from './protocol.ts'
import { record } from './protocol.ts'

export interface AppServer {
  request(method: string, params: Record<string, unknown>): Promise<unknown>
  notify(method: string, params?: Record<string, unknown>): void
  respond(id: RpcId, result: unknown): void
  reject(id: RpcId, message: string): void
  close(): Promise<void>
}
export interface ServerHandlers {
  notification(message: RpcNotification): void
  request(message: RpcRequest): void
  failure(error: Error): void
}
/** A definitive RPC rejection: the caller may release input that was never accepted. */
export class RpcError extends Error {
  constructor(readonly code: number, message: string) { super(message); this.name = 'RpcError' }
}
interface Pending {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}
const MAX_LINE_BYTES = 32 * 1024 * 1024

export class AppServerClient implements AppServer {
  private sequence = 0
  private pending = new Map<RpcId, Pending>()
  private buffer = ''
  private stderr = ''
  private failed: Error | undefined
  private closing = false

  constructor(
    private readonly child: SubprocessHandle,
    private readonly handlers: ServerHandlers,
    private readonly timeoutMs: number,
    onStderr: (line: string) => void,
  ) {
    if (child.stdin === undefined || child.stdout === undefined) throw new Error('Codex requires piped stdin/stdout')
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.receive(chunk))
    child.stdout.on('error', (error: Error) => this.fail(error))
    child.stdin.on('error', (error: Error) => this.fail(error))
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-16_384)
      onStderr(chunk.trimEnd())
    })
    void child.done.then(
      outcome => this.fail(new Error(`Codex app-server exited (${outcome.exitCode ?? outcome.signal ?? 'unknown'}).${this.stderr.length > 0 ? `\n${this.stderr}` : ''}`)),
      error => this.fail(error instanceof Error ? error : new Error(String(error))),
    )
  }

  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.failed !== undefined) return Promise.reject(this.failed)
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error(`Codex RPC timed out: ${method}`)), this.timeoutMs)
      timer.unref()
      this.pending.set(id, { resolve, reject, timer })
      try { this.send({ id, method, params }) } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }
  notify(method: string, params: Record<string, unknown> = {}): void { this.send({ method, params }) }
  respond(id: RpcId, result: unknown): void { this.send({ id, result }) }
  reject(id: RpcId, message: string): void { this.send({ id, error: { code: -32601, message } }) }

  async close(): Promise<void> {
    if (!this.closing) {
      this.closing = true
      this.fail(new Error('Codex app-server connection closed'))
      this.child.stdin?.end()
      this.child.terminate()
    }
    await this.child.done.catch(() => undefined)
  }
  private send(message: unknown): void {
    if (this.failed !== undefined) throw this.failed
    this.child.stdin!.write(`${JSON.stringify(message)}\n`, error => { if (error) this.fail(error) })
  }
  private receive(chunk: string): void {
    if (this.failed !== undefined) return
    this.buffer += chunk
    let newline: number
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) { this.fail(new Error('Codex RPC message exceeds 32 MiB')); return }
      if (line.trim().length === 0) continue
      try { this.dispatch(record(JSON.parse(line))) } catch (error) {
        this.fail(new Error(`Invalid Codex RPC message: ${String(error)}`))
        return
      }
    }
    if (Buffer.byteLength(this.buffer) > MAX_LINE_BYTES) this.fail(new Error('Codex RPC message exceeds 32 MiB'))
  }
  private dispatch(message: Record<string, unknown>): void {
    const { id, method } = message
    const hasId = typeof id === 'number' || typeof id === 'string'
    if (typeof method === 'string') {
      const params = record(message.params)
      if (hasId) this.handlers.request({ id, method, params })
      else this.handlers.notification({ method, params })
      return
    }
    if (!hasId) throw new Error('missing response id or method')
    const pending = this.pending.get(id)
    if (pending === undefined) return
    this.pending.delete(id)
    clearTimeout(pending.timer)
    if ('error' in message) {
      const error = record(message.error)
      pending.reject(new RpcError(typeof error.code === 'number' ? error.code : -32603, String(error.message)))
    } else if ('result' in message) pending.resolve(message.result)
    else pending.reject(new Error('Codex RPC response has neither result nor error'))
  }
  private fail(error: Error): void {
    if (this.failed !== undefined) return
    this.failed = error
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error) }
    this.pending.clear()
    if (!this.closing) {
      this.handlers.failure(error)
      this.child.terminate()
    }
  }
}
