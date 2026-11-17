// Real local Codex + a loopback Responses stub; no credentials or paid model calls.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { AppServerClient } from '../lib/app-server.js'
import { CodexSession } from '../lib/codex-session.js'
import { locateCodexHere } from '../lib/executable.js'
import { codexSpawnSpec } from '../lib/spawn.js'
import { initialNativeState } from '../lib/native-state.js'

const executable = locateCodexHere()
assert.ok(executable, 'Install the local Codex CLI first')
const directory = await mkdtemp(join(tmpdir(), 'tavlo-codex-permissions-'))
const requests = [], calls = [], warnings = []
let session, rolloutPath, currentState
const http = createServer(async (req, res) => {
  if (!req.url?.endsWith('/responses')) { res.writeHead(404).end(); return }
  let body = ''
  for await (const chunk of req) body += chunk
  const input = JSON.parse(body)
  const id = `response-${requests.length + 1}`
  const send = value => res.write(`data: ${JSON.stringify(value)}\n\n`)
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  send({ type: 'response.created', response: { id, object: 'response', status: 'in_progress', output: [] } })
  requests.push({ approval() {
    const names = input.tools?.map(tool => tool.name ?? tool.function?.name) ?? []
    const name = names.includes('exec_command') ? 'exec_command' : 'shell_command'
    assert.ok(names.includes(name), `No native command tool: ${names.join(', ')}`)
    const args = { [name === 'exec_command' ? 'cmd' : 'command']: 'Write-Output PERMISSION_PROBE', sandbox_permissions: 'require_escalated', justification: 'Isolated local permission-transition check.' }
    const item = { type: 'function_call', id: `fc-${id}`, call_id: `call-${id}`, name, arguments: JSON.stringify(args) }
    send({ type: 'response.output_item.added', output_index: 0, item })
    send({ type: 'response.output_item.done', output_index: 0, item })
    send({ type: 'response.completed', response: { id, object: 'response', status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 } } })
    res.end()
  }, finish() {
    const item = { id: `message-${id}`, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'PERMISSIONS_OK', annotations: [] }] }
    send({ type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } })
    send({ type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'PERMISSIONS_OK' })
    send({ type: 'response.output_item.done', output_index: 0, item })
    send({ type: 'response.completed', response: { id, object: 'response', status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } })
    res.end()
  } })
})
const timeout = AbortSignal.timeout(60_000)
async function waitFor(predicate) {
  while (!predicate()) await delay(25, undefined, { signal: timeout })
}
try {
  await new Promise(resolveListen => http.listen(0, '127.0.0.1', resolveListen))
  const port = http.address().port
  await writeFile(join(directory, 'config.toml'), `model = "gpt-5.1-codex"
model_provider = "permission_test"
[model_providers.permission_test]
name = "Loopback permission test"
base_url = "http://127.0.0.1:${port}/v1"
wire_api = "responses"
env_key = "CODEX_PERMISSION_TEST_KEY"
supports_websockets = false
request_max_retries = 0
stream_max_retries = 0
stream_idle_timeout_ms = 60000
`)
  let policy = { approvalPolicy: 'on-request', approvalsReviewer: 'user', sandboxPolicy: { type: 'readOnly', networkAccess: false } }
  session = new CodexSession({
    dshSessionId: 'isolated-permission-check', cwd: directory, provider: 'codex', sentMessageIds: new Set(),
    nativeState: initialNativeState(), after: Promise.resolve(), cancelGraceMs: 10_000,
    policy: () => policy, publishNativeState: state => { currentState = state },
    readImage: async () => { throw new Error('No images in this test') },
    onModels() {}, onContextWindow() {}, askQuestion: async () => undefined, warn: message => warnings.push(message),
    startServer(handlers) {
      const spec = codexSpawnSpec(executable, directory, { ...scrubbedParentEnv(), CODEX_HOME: directory, CODEX_PERMISSION_TEST_KEY: 'local-test-only' }, 3000)
      const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: directory, env: spec.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
      const done = new Promise((resolveDone, reject) => {
        child.once('error', reject)
        child.once('exit', (exitCode, signal) => resolveDone({ exitCode, signal }))
      })
      const client = new AppServerClient({ stdin: child.stdin, stdout: child.stdout, stderr: child.stderr, done, terminate: () => child.kill() }, handlers, 15_000, () => {})
      const request = client.request.bind(client)
      client.request = async (method, params) => {
        calls.push({ method, params })
        const result = await request(method, params)
        if (method === 'thread/start') rolloutPath = result.thread?.path
        return result
      }
      return client
    },
  })
  const chunks = []
  const running = (async () => {
    for await (const chunk of session.stream({ model: 'default', messages: [{ id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Reply PERMISSIONS_OK without tools.' }] }], currentTurnMessageIds: new Set(['u1']), signal: timeout })) chunks.push(chunk)
  })()
  // Keep errors observed even while the test waits for the local HTTP request.
  let runError
  void running.catch(error => { runError = error })
  await waitFor(() => requests.length >= 1 || runError)
  if (runError) throw runError
  policy = { approvalPolicy: 'never', approvalsReviewer: 'user', sandboxPolicy: { type: 'dangerFullAccess' } }
  await session.refreshPermissions()
  await waitFor(() => requests.length >= 2 || runError)
  if (runError) throw runError
  policy = { approvalPolicy: 'never', approvalsReviewer: 'user', sandboxPolicy: { type: 'readOnly', networkAccess: false } }
  await session.refreshPermissions()
  await waitFor(() => requests.length >= 3 || runError)
  if (runError) throw runError
  requests[2].finish()
  await running
  assert.equal(chunks.at(-1)?.reason?.kind, 'stop')
  const starts = calls.filter(call => call.method === 'turn/start')
  assert.equal(starts.length, 3)
  assert.equal(starts.filter(call => JSON.stringify(call.params.input).includes('Reply PERMISSIONS_OK')).length, 1)
  assert.equal(new Set(starts.map(call => call.params.threadId)).size, 1)
  assert.deepEqual([...session.sentMessageIds], ['u1'])

  // Exercise an actual native approval request already handed to the DSH side.
  policy = { approvalPolicy: 'on-request', approvalsReviewer: 'user', sandboxPolicy: { type: 'readOnly', networkAccess: false } }
  await session.refreshPermissions()
  const toolChunks = []
  const toolStep = (async () => {
    for await (const chunk of session.stream({ model: 'default', messages: [{ id: 'u2', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Exercise the isolated approval path.' }] }], currentTurnMessageIds: new Set(['u2']), signal: timeout })) toolChunks.push(chunk)
  })()
  void toolStep.catch(error => { runError = error })
  await waitFor(() => requests.length >= 4 || runError)
  if (runError) throw runError
  requests[3].approval()
  await toolStep
  const tool = toolChunks.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')?.block
  assert.ok(tool, 'Native command should be mirrored')
  let approvalSignal
  const waiting = session.waitForTool(tool.id, (_request, signal) => {
    approvalSignal = signal
    return new Promise(() => {}) // Deliberately ignore cancellation to test containment.
  }, timeout)
  void waiting.catch(error => { runError = error })
  await waitFor(() => approvalSignal || runError)
  if (runError) throw runError
  policy = { approvalPolicy: 'never', approvalsReviewer: 'user', sandboxPolicy: { type: 'dangerFullAccess' } }
  await session.refreshPermissions()
  assert.equal(approvalSignal.aborted, true)
  assert.equal((await waiting).isError, true)
  await waitFor(() => requests.length >= 5 || runError)
  if (runError) throw runError
  requests[4].finish()
  const finalChunks = []
  for await (const chunk of session.stream({ model: 'default', messages: [], currentTurnMessageIds: new Set(), signal: timeout })) finalChunks.push(chunk)
  assert.equal(finalChunks.at(-1)?.reason?.kind, 'stop')
  assert.equal(calls.filter(call => call.method === 'turn/start').length, 5)
  assert.equal(new Set(calls.filter(call => call.method === 'turn/start').map(call => call.params.threadId)).size, 1)
  assert.deepEqual([...session.sentMessageIds], ['u1', 'u2'])
  await session.dispose()
  assert.ok(rolloutPath, 'Native thread should return its rollout path')
  const contexts = (await readFile(rolloutPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line)).filter(row => row.type === 'turn_context')
    .map(row => ({ approval: row.payload.approval_policy, sandbox: row.payload.sandbox_policy.type }))
  assert.deepEqual(contexts, [
    { approval: 'on-request', sandbox: 'read-only' },
    { approval: 'never', sandbox: 'danger-full-access' },
    { approval: 'never', sandbox: 'read-only' },
    { approval: 'on-request', sandbox: 'read-only' },
    { approval: 'never', sandbox: 'danger-full-access' },
  ])
  console.log(JSON.stringify({ ok: true, realNativeTurns: 5, paidModelCalls: 0, contexts, sameThread: true, originalInputSubmittedOnce: true, pendingApprovalCancelled: true, finalStatus: finalChunks.at(-1).reason.kind, diagnostics: currentState.diagnostics.filter(entry => entry.id === 'permissions'), warnings }, null, 2))
} finally {
  await session?.dispose()
  http.closeAllConnections()
  await new Promise(resolveClose => http.close(resolveClose))
  const target = resolve(directory)
  if (!target.startsWith(resolve(tmpdir()) + sep) || !target.includes('tavlo-codex-permissions-')) throw new Error('Unsafe cleanup path')
  await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
