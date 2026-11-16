// Local CLI protocol check. Creates an isolated CODEX_HOME; sends no model turn.
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { AppServerClient } from '../lib/app-server.js'
import { locateCodexHere } from '../lib/executable.js'
import { fetchCodexModels } from '../lib/models.js'
import { codexSpawnSpec } from '../lib/spawn.js'
import { codexInitializeParams } from '../lib/client-identity.js'

const executable = locateCodexHere()
if (!executable) throw new Error('Install the local Codex CLI before running this check')
const directory = await mkdtemp(join(tmpdir(), 'tavlo-codex-smoke-'))
let client
try {
  const spec = codexSpawnSpec(executable, directory, { ...scrubbedParentEnv(), CODEX_HOME: directory }, 3000)
  const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: directory, env: spec.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const done = new Promise((resolveDone, reject) => {
    child.once('error', reject)
    child.once('exit', (exitCode, signal) => resolveDone({ exitCode, signal }))
  })
  client = new AppServerClient({ stdin: child.stdin, stdout: child.stdout, stderr: child.stderr, done, terminate: () => child.kill() }, {
    notification() {}, request: message => client.reject(message.id, 'No interactive requests in a smoke check'),
    failure: error => console.error(error.message),
  }, 15000, () => {})
  const initialized = await client.request('initialize', codexInitializeParams())
  const models = await fetchCodexModels(client)
  client.notify('initialized')
  const started = await client.request('thread/start', {
    cwd: directory, approvalPolicy: 'never', sandbox: 'read-only',
  })
  if (!started.thread?.id) throw new Error('Native thread/start did not return an id')
  const threadId = started.thread.id
  await client.request('thread/settings/update', { threadId, collaborationMode: { mode: 'plan', settings: { model: started.model, reasoning_effort: started.reasoningEffort ?? null, developer_instructions: null } } })
  await client.request('thread/name/set', { threadId, name: 'Isolated protocol smoke' })
  await client.request('thread/goal/get', { threadId })
  const goal = await client.request('thread/goal/set', { threadId, origin: 'user', objective: 'Protocol smoke only. Do not run model turns.', status: 'paused', tokenBudget: 1000 })
  if (goal.goal?.status !== 'paused') throw new Error('Expected a paused native goal')
  const budget = await client.request('thread/goal/set', { threadId, origin: 'user', tokenBudget: 2000 })
  if (budget.goal?.objective !== goal.goal.objective || budget.goal.tokensUsed !== goal.goal.tokensUsed) throw new Error('Budget update replaced native goal accounting')
  await client.request('thread/goal/clear', { threadId, origin: 'user' })
  const cleared = await client.request('thread/goal/get', { threadId })
  if (cleared.goal !== null) throw new Error('Goal was not cleared')
  console.log(JSON.stringify({ ok: true, userAgent: initialized.userAgent, modelCount: models.length, threadStarted: true, planMode: true, nativeName: true, pausedGoalAndBudget: true, modelTurnsSent: 0 }, null, 2))
} finally {
  await client?.close()
  const target = resolve(directory)
  if (!target.startsWith(resolve(tmpdir()) + sep) || !target.includes('tavlo-codex-smoke-')) throw new Error('Unsafe smoke cleanup path')
  await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
