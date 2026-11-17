/** Real DSH profile + real Codex, with a loopback model and no user credentials. */
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, open, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { locateCodexHere } from '../lib/executable.js'

const cli = process.env.DSH_CLI
assert(cli, 'Set DSH_CLI to the installed DSH lib/bin.js')
const native = locateCodexHere()
assert(native, 'Codex must be installed')
const root = await mkdtemp(join(tmpdir(), 'dsh-codex-goal-'))
const home = join(root, 'home'), codexHome = join(root, 'codex'), resultFile = join(root, 'result.json')
await mkdir(codexHome)
const env = { ...scrubbedParentEnv(), DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' }
let host, modelError, completed = false, blocked = false, modelCalls = 0
const run = args => new Promise((resolveRun, reject) => execFile(process.execPath, [cli, ...args],
  { cwd: root, env, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) =>
    error ? reject(new Error(`DSH command failed: ${stderr}`)) : resolveRun(stdout + stderr)))
const model = createServer(async (req, res) => {
  try {
    if (!req.url?.endsWith('/responses')) { res.writeHead(404).end(); return }
    let raw = ''; for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw), id = `goal-response-${++modelCalls}`
    const users = body.input.filter(item => item.role === 'user').map(item => JSON.stringify(item.content))
    const last = users.at(-1) ?? ''
    if (last.includes('HOST_GOAL_FAILURE_PROBE')) {
      res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'Intentional goal verification failure', type: 'server_error' } }))
      return
    }
    const send = event => res.write(`data: ${JSON.stringify(event)}\n\n`)
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    send({ type: 'response.created', response: { id, object: 'response', status: 'in_progress', output: [] } })
    if (last.includes('HOST_GOAL_PAUSE_PROBE')) return
    let output
    const blocking = last.includes('HOST_GOAL_BLOCK_PROBE')
    if (blocking && !blocked || last.includes('Round: 2/3') && !completed) {
      const direct = body.tools.find(tool => tool.name === 'update_goal')
      const namespace = body.tools.find(tool => tool.tools?.some(child => child.name === 'update_goal'))
      assert(direct || namespace, `Native update_goal tool missing: ${JSON.stringify(body.tools.map(tool => ({ name: tool.name, tools: tool.tools?.map(child => child.name) })))}`)
      if (blocking) blocked = true
      else completed = true
      output = [{ type: 'function_call', id: `fc-${id}`, call_id: `call-${id}`, name: 'update_goal', ...(namespace ? { namespace: namespace.name } : {}), arguments: JSON.stringify({ status: blocking ? 'blocked' : 'complete' }) }]
    } else {
      output = [{ id: `message-${id}`, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: completed ? 'HOST_GOAL_COMPLETE' : 'First round verified; one more round remains.', annotations: [] }] }]
    }
    for (const [index, item] of output.entries()) {
      send({ type: 'response.output_item.added', output_index: index, item })
      send({ type: 'response.output_item.done', output_index: index, item })
    }
    send({ type: 'response.completed', response: { id, object: 'response', status: 'completed', output, usage: { input_tokens: 100, output_tokens: 30, total_tokens: 130, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } })
    res.end()
  } catch (error) { modelError = error; res.destroy(error) }
})
try {
  await new Promise(resolveListen => model.listen(0, '127.0.0.1', resolveListen))
  await writeFile(join(codexHome, 'config.toml'), `model = "gpt-5.1-codex"
model_provider = "host_goal_test"
[model_providers.host_goal_test]
name = "Loopback goal test"
base_url = "http://127.0.0.1:${model.address().port}/v1"
wire_api = "responses"
env_key = "CODEX_HOST_GOAL_TEST_KEY"
supports_websockets = false
request_max_retries = 0
stream_max_retries = 0
stream_idle_timeout_ms = 90000
`)
  const source = resolve(process.argv[2] || '../.refs/verification/dsh-plugin-codex-app-server-0.2.1.tgz')
  const digest = createHash('sha256').update(await readFile(source)).digest('hex').slice(0, 16)
  const tarball = join(root, `codex-${digest}.tgz`)
  await copyFile(source, tarball)
  await writeFile(join(root, 'install.log'), await run(['plugin', '--profile', 'web', 'add', '--prod', tarball, '--reporter=append-only']))
  const patch = join(root, 'goal.patch.yml')
  await writeFile(patch, `- id: agent-default-model
  config:
    provider: codex
    model: default
- id: tavlo-codex
  config:
    executable: ${JSON.stringify(native.path)}
    inheritCredentials: false
    env:
      CODEX_HOME: ${JSON.stringify(codexHome)}
      CODEX_HOST_GOAL_TEST_KEY: local-test-only
    auxiliary:
      enabled: false
- insert:
    - id: codex-goal-verification
      name: ${JSON.stringify(resolve('scripts/fixtures/host-goal-driver.mjs'))}
      config:
        cwd: ${JSON.stringify(root)}
        result: ${JSON.stringify(resultFile)}
`)
  const composed = await run(['--profile', 'web', '--patch', patch, '--dump-config'])
  assert(composed.includes('id: codex-goal-verification') && !composed.includes('entry "codex-goal-verification" not found'), 'Verification plugin was not inserted')
  const log = await open(join(root, 'host.log'), 'w')
  host = spawn(process.execPath, [cli, '--profile', 'web', '--patch', patch, '--no-open', '--port', '0'], { cwd: root, env, windowsHide: true, stdio: ['ignore', log.fd, log.fd] })
  await log.close()
  const deadline = Date.now() + 90_000
  let result
  while (Date.now() < deadline) {
    if (modelError) throw modelError
    if (host.exitCode !== null) throw new Error(`DSH exited (${host.exitCode}); logs: ${root}`)
    try { result = JSON.parse(await readFile(resultFile, 'utf8')); break }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    await new Promise(resolveWait => setTimeout(resolveWait, 200))
  }
  assert(result?.passed, `Goal verification failed: ${JSON.stringify(result ?? { timeout: true })}; logs: ${root}`)
  const report = { ...result, modelCalls, paidModelCalls: 0, logs: root }
  await writeFile(resolve('../.refs/verification/codex-host-goal-result.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
} finally {
  if (host?.exitCode === null) {
    if (process.platform === 'win32') await new Promise(resolveKill => execFile('taskkill.exe', ['/PID', String(host.pid), '/T', '/F'], { windowsHide: true }, resolveKill))
    else host.kill('SIGTERM')
  }
  model.closeAllConnections()
  await new Promise(resolveClose => model.close(resolveClose))
}
