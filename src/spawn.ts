import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { CodexExecutable } from './executable.ts'

/** No shell: npm .cmd shims are resolved to their JS entry point before spawning. */
export function codexSpawnSpec(
  executable: CodexExecutable,
  cwd: string,
  env: NodeJS.ProcessEnv,
  graceMs: number,
): SubprocessSpawnSpec {
  const overlay = { ...env }
  for (const name of Object.keys(scrubbedParentEnv())) if (!(name in env)) overlay[name] = undefined
  return {
    argv: [...(executable.kind === 'script' ? [process.execPath, executable.path] : [executable.path]), 'app-server'],
    cwd, env: overlay, graceMs,
    stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
  }
}
