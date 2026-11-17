// Real Codex, isolated home, loopback model. No user credentials or paid calls.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { AppServerClient } from '../lib/app-server.js'
import { CodexSession } from '../lib/codex-session.js'
import { locateCodexHere } from '../lib/executable.js'
import { codexSpawnSpec } from '../lib/spawn.js'
import { initialNativeState } from '../lib/native-state.js'

const executable = locateCodexHere()
assert.ok(executable)
const directory = await mkdtemp(join(tmpdir(), 'tavlo-codex-lifecycle-'))
const timeout = AbortSignal.timeout(90_000)
const calls = [], warnings = [], requests = [], sessions = [], discovered = new Set()
let server, session, killNative, latest = initialNativeState(), parentSpawned = false, modelFailure
const http = createServer(async (req, res) => {
  try {
    if (!req.url?.endsWith('/responses')) { res.writeHead(404).end(); return }
    let body = ''; for await (const chunk of req) body += chunk
    const input = JSON.parse(body), id = `response-${requests.length + 1}`
    requests.push(input)
    const send = value => res.write(`data: ${JSON.stringify(value)}\n\n`)
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    send({ type: 'response.created', response: { id, object: 'response', status: 'in_progress', output: [] } })
    const users = input.input.filter(item => item.role === 'user').map(item => JSON.stringify(item.content))
    const last = users.at(-1) ?? ''
    // Children remain active until the parent's boundary interrupts them.
    if (last.includes('CHILD_LIFECYCLE_PROBE')) return
    const names = input.tools?.map(tool => tool.name ?? tool.function?.name) ?? []
    let output
    if (last.includes('PARENT_LIFECYCLE_PROBE') && !parentSpawned) {
      parentSpawned = true
      const namespace = input.tools.find(tool => tool.name === 'multi_agent_v1')
      const spawnTool = namespace?.tools?.find(tool => tool.name === 'spawn_agent')
      assert.ok(names.includes('spawn_agent') || spawnTool, `spawn_agent missing: ${JSON.stringify(namespace ?? names)}`)
      output = ['a', 'b'].map(name => ({ type: 'function_call', id: `fc-${id}-${name}`, call_id: `call-${id}-${name}`, name: 'spawn_agent', ...(spawnTool ? { namespace: 'multi_agent_v1' } : {}),
        arguments: JSON.stringify({ task_name: `probe_${name}`, message: `CHILD_LIFECYCLE_PROBE ${name}. Wait for parent cancellation.`, fork_turns: 'none' }) }))
    } else {
      output = [{ id: `message-${id}`, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'LIFECYCLE_OK', annotations: [] }] }]
    }
    for (const [index, item] of output.entries()) {
      send({ type: 'response.output_item.added', output_index: index, item })
      send({ type: 'response.output_item.done', output_index: index, item })
    }
    send({ type: 'response.completed', response: { id, object: 'response', status: 'completed', output, usage: { input_tokens: 100, output_tokens: 30, total_tokens: 130, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } })
    res.end()
  } catch (error) { modelFailure = error; res.destroy(error) }
})
const options = () => ({ model: 'default', messages: [], currentTurnMessageIds: new Set(), signal: timeout })
function createSession() {
  session = new CodexSession({
    dshSessionId: 'isolated-lifecycle', cwd: directory, provider: 'codex', sentMessageIds: new Set(latest.sentInputIds), nativeState: latest,
    after: Promise.resolve(), cancelGraceMs: 10_000, policy: () => ({ approvalPolicy: 'never', approvalsReviewer: 'user', sandboxPolicy: { type: 'readOnly', networkAccess: false } }),
    publishNativeState: state => { latest = structuredClone(state) }, onModels() {}, onContextWindow() {}, askQuestion: async () => undefined,
    readImage: async () => { throw new Error('No images') }, warn: message => warnings.push(message),
    startServer(handlers) {
      const spec = codexSpawnSpec(executable, directory, { ...scrubbedParentEnv(), CODEX_HOME: directory, CODEX_LIFECYCLE_TEST_KEY: 'local-test-only' }, 3000)
      const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: directory, env: spec.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
      const done = new Promise((resolveDone, reject) => { child.once('error', reject); child.once('exit', (exitCode, signal) => resolveDone({ exitCode, signal })) })
      killNative = async () => { child.kill(); await done }
      server = new AppServerClient({ stdin: child.stdin, stdout: child.stdout, stderr: child.stderr, done, terminate: () => child.kill() }, handlers, 15_000, () => {})
      const request = server.request.bind(server)
      server.request = async (method, params) => {
        calls.push({ method, params })
        const result = await request(method, params)
        if (method === 'thread/list') for (const thread of result.data ?? []) discovered.add(thread.id)
        return result
      }
      return server
    },
  })
  sessions.push(session)
  return session
}
async function round(id, content) {
  let request = { ...options(), messages: [{ id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: content }] }], currentTurnMessageIds: new Set([id]) }
  for (;;) {
    const chunks = []
    for await (const chunk of session.stream(request)) chunks.push(chunk)
    if (modelFailure) throw modelFailure
    const tools = chunks.filter(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call').map(chunk => chunk.block)
    for (const tool of tools) await session.waitForTool(tool.id, async () => 'denied', timeout)
    const finish = chunks.at(-1)?.reason?.kind
    if (finish !== 'tool-calls') { assert.equal(finish, 'stop'); return }
    request = options()
  }
}
try {
  await new Promise(resolveListen => http.listen(0, '127.0.0.1', resolveListen))
  await writeFile(join(directory, 'config.toml'), `model = "gpt-5.1-codex"
model_provider = "lifecycle_test"
[features]
multi_agent = true
[model_providers.lifecycle_test]
name = "Loopback lifecycle test"
base_url = "http://127.0.0.1:${http.address().port}/v1"
wire_api = "responses"
env_key = "CODEX_LIFECYCLE_TEST_KEY"
supports_websockets = false
request_max_retries = 0
stream_max_retries = 0
stream_idle_timeout_ms = 90000
`)
  createSession()
  await session.goal('set', options(), 'Verify two explicitly resumed rounds; pause at every boundary.')
  await session.goal('budget', options(), 10000)
  await session.goal('resume', options())
  await round('goal-1', 'GOAL_FIRST_PROBE. Reply LIFECYCLE_OK without tools.')
  assert.equal(latest.goal.status, 'paused')
  const firstUsage = latest.goal.tokensUsed
  await session.goal('resume', options())
  await round('goal-2', 'GOAL_SECOND_PROBE. Reply LIFECYCLE_OK without tools.')
  assert.equal(latest.goal.status, 'paused')
  assert.ok(latest.goal.tokensUsed > firstUsage, 'Goal usage should accumulate over both native rounds')
  assert.equal(latest.goal.tokenBudget, 10000)
  const goalUsage = latest.goal.tokensUsed, threadId = latest.threadId
  // A lost process can leave the persisted native goal active. Rejoining must
  // pause it before the next explicit user round, preserving all usage.
  await session.goal('resume', options())
  const startsBeforeRecovery = calls.filter(call => call.method === 'turn/start').length
  await killNative()
  await session.dispose()
  createSession()
  await session.goal('get', options())
  assert.equal(latest.goal.status, 'paused')
  assert.equal(latest.goal.tokensUsed, goalUsage)
  assert.equal(calls.filter(call => call.method === 'turn/start').length, startsBeforeRecovery)
  await session.dispose()
  createSession()
  await session.goal('get', options())
  assert.equal(latest.threadId, threadId)
  assert.equal(latest.goal.status, 'paused')
  assert.equal(latest.goal.tokensUsed, goalUsage)
  assert.equal(latest.goal.tokenBudget, 10000)
  await session.goal('clear', options())
  assert.equal(latest.goal, null)
  await round('parent', 'PARENT_LIFECYCLE_PROBE. Explicitly spawn two child agents with task names probe_a and probe_b, then finish your own turn without waiting for them. This verifies child cancellation.')
  const agents = Object.values(latest.agents)
  assert.equal(agents.length, 2, 'Both native child agents must be discovered')
  assert.ok(agents.every(agent => discovered.has(agent.threadId)), 'The native descendant query must find both children')
  assert.ok(agents.every(agent => !agent.activeTurnId && ['interrupted', 'completed', 'shutdown', 'connectionLost'].includes(agent.status)))
  assert.ok(calls.some(call => call.method === 'turn/interrupt' && call.params.threadId !== threadId))
  assert.ok(!calls.some(call => call.method === 'thread/resume' && call.params.threadId !== threadId), 'Observation must not resume child threads')
  const stateBeforeRestart = structuredClone(latest.agents)
  await session.dispose()
  createSession()
  await session.goal('get', options())
  assert.deepEqual(Object.keys(latest.agents).sort(), Object.keys(stateBeforeRestart).sort())
  assert.ok(Object.values(latest.agents).every(agent => !agent.activeTurnId))
  console.log(JSON.stringify({ ok: true, goalRounds: 2, firstUsage, goalUsage, restartPreservesBudget: true, activeGoalRecoveryPauses: true, sameThread: true, nativeChildren: agents.length,
    children: Object.values(latest.agents).map(({ status, activeTurnId }) => ({ status, activeTurnId })), childResumeCalls: 0, paidModelCalls: 0, warnings }, null, 2))
} finally {
  for (const item of sessions) await item.dispose()
  http.closeAllConnections()
  await new Promise(resolveClose => http.close(resolveClose))
  const target = resolve(directory)
  if (!target.startsWith(resolve(tmpdir()) + sep) || !target.includes('tavlo-codex-lifecycle-')) throw new Error('Unsafe cleanup path')
  await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
