/**
 * Finds the Codex executable installed on this machine, so the app-server runs the
 * same `codex` (version, settings, login) the user runs in a terminal.
 * @module tavlo-plugins-codex/executable
 */

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, extname, isAbsolute, join, resolve } from 'node:path'

/** A runnable Codex entry point. */
export interface CodexExecutable {
  /** Absolute native binary or Node entry point. */
  readonly path: string
  /** A native binary runs directly; a script needs Node. */
  readonly kind: 'native' | 'script'
  /** How it was found, for logs. */
  readonly source: 'config' | 'path' | 'well-known'
}

/** Inputs, injectable for tests. */
export interface LocateOptions {
  readonly configured?: string | undefined
  readonly platform: NodeJS.Platform
  readonly env: NodeJS.ProcessEnv
  readonly home: string
}

const SCRIPT_EXTENSIONS: ReadonlySet<string> = new Set(['.js', '.cjs', '.mjs'])

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function classify(path: string, source: CodexExecutable['source']): CodexExecutable {
  const kind = SCRIPT_EXTENSIONS.has(extname(path).toLowerCase()) ? 'script' : 'native'
  return { path, kind, source }
}

/**
 * Read the program an npm / pnpm `.cmd` shim runs. Shims name it relative to their own
 * directory through `%dp0%` or `%~dp0`; the last quoted `.exe` or script path wins,
 * because the interpreter (`node.exe`) comes before the script it runs.
 */
export function shimTarget(shimPath: string, content: string): string | undefined {
  const dir = dirname(shimPath)
  const quoted = [...content.matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? '')
  const candidates = quoted
    .filter((text) => /%~?dp0%?/i.test(text))
    .map((text) => resolve(dir, text.replace(/%~?dp0%?\\?/gi, '').replaceAll('\\', '/')))
    .filter((path) => {
      const ext = extname(path).toLowerCase()
      return ext === '.exe' || SCRIPT_EXTENSIONS.has(ext)
    })
  return candidates.findLast((path) => isFile(path))
}

function windowsCandidates(dir: string, env: NodeJS.ProcessEnv): string[] {
  const exts = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((ext) => ext.length > 0)
  return exts.map((ext) => join(dir, `codex${ext.toLowerCase()}`))
}

function resolveFound(path: string, platform: NodeJS.Platform): string | undefined {
  if (platform === 'win32') {
    const ext = extname(path).toLowerCase()
    if (ext === '.exe') return path
    if (ext === '.cmd' || ext === '.bat') return shimTarget(path, readFileSync(path, 'utf8'))
    return undefined
  }
  // npm links `codex` to the package's real entry; follow it so a script is recognised.
  try {
    return realpathSync(path)
  } catch {
    return undefined
  }
}

function searchPath(options: LocateOptions): string | undefined {
  const pathValue = options.env.PATH ?? options.env.Path ?? ''
  for (const dir of pathValue.split(delimiter)) {
    if (dir.length === 0) continue
    const names = options.platform === 'win32' ? windowsCandidates(dir, options.env) : [join(dir, 'codex')]
    for (const name of names) {
      if (!isFile(name)) continue
      const target = resolveFound(name, options.platform)
      if (target !== undefined) return target
    }
  }
  return undefined
}

function wellKnown(options: LocateOptions): string | undefined {
  const exe = options.platform === 'win32' ? 'codex.exe' : 'codex'
  const candidates = [join(options.home, '.local', 'bin', exe), join(options.home, '.codex', 'local', exe)]
  return candidates.find((path) => isFile(path))
}

/**
 * Find the local Codex.
 * @returns the executable, or undefined when Codex is not installed locally.
 * @throws when a configured path does not exist: silently running another Codex would hide the mistake.
 */
export function locateCodex(options: LocateOptions): CodexExecutable | undefined {
  const { configured } = options
  if (configured !== undefined && configured.length > 0) {
    const path = isAbsolute(configured) ? configured : resolve(configured)
    if (!existsSync(path) || !isFile(path)) throw new Error(`配置的 Codex 路径不是文件：${path}`)
    const ext = extname(path).toLowerCase()
    const target = SCRIPT_EXTENSIONS.has(ext) ? path : resolveFound(path, options.platform)
    if (target === undefined) throw new Error(`无法解析 Codex 可执行文件：${path}；请指定 codex.exe 或 bin/codex.js`)
    return classify(target, 'config')
  }
  const onPath = searchPath(options)
  if (onPath !== undefined) return classify(onPath, 'path')
  const known = wellKnown(options)
  return known === undefined ? undefined : classify(known, 'well-known')
}

/** Locate with the real process environment. */
export function locateCodexHere(configured?: string): CodexExecutable | undefined {
  return locateCodex({ configured, platform: process.platform, env: process.env, home: homedir() })
}
