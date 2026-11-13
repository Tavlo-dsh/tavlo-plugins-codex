import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { locateCodex } from '../src/executable.ts'
import { codexSpawnSpec } from '../src/spawn.ts'

const temporary: string[] = []
afterEach(() => {
  for (const dir of temporary.splice(0)) {
    const target = resolve(dir)
    if (!target.startsWith(resolve(tmpdir()) + sep) || !target.includes('tavlo-codex-exe-')) throw new Error('unsafe test cleanup')
    rmSync(target, { recursive: true, force: true })
  }
})
describe('local executable discovery', () => {
  it('resolves Windows npm shims to a JS file and launches Node without a shell', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tavlo-codex-exe-')); temporary.push(dir)
    const entry = join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
    mkdirSync(join(dir, 'node_modules', '@openai', 'codex', 'bin'), { recursive: true })
    writeFileSync(entry, '')
    writeFileSync(join(dir, 'codex.cmd'), '@"%~dp0\\node.exe" "%~dp0\\node_modules\\@openai\\codex\\bin\\codex.js" %*')
    const executable = locateCodex({ platform: 'win32', configured: join(dir, 'codex.cmd'), env: {}, home: dir })
    expect(executable).toEqual({ path: entry, kind: 'script', source: 'config' })
    expect(codexSpawnSpec(executable!, dir, {}, 100).argv).toEqual([process.execPath, entry, 'app-server'])
  })
  it('fails explicitly for a missing configured path instead of using another installation', () => {
    expect(() => locateCodex({ platform: process.platform, configured: join(tmpdir(), 'missing-tavlo-codex-123456.exe'), env: process.env, home: tmpdir() })).toThrow('不是文件')
  })
})
