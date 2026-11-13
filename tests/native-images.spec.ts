import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { importNativeImage } from '../src/native-images.ts'
import { createCodexTool } from '../src/codex-tool.ts'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7XcAAAAASUVORK5CYII='
const ref = { attachmentId: AttachmentId('stored-image'), mediaType: 'image/png' as const, width: 1, height: 1, bytes: Buffer.from(png, 'base64').length }
const args = { tool: 'imageGeneration', title: 'Generate image', kind: 'other', input: {} }
describe('native output images', () => {
  it('imports direct bytes and renders a durable image block through the actual tool schema', async () => {
    const save = vi.fn(async () => ref)
    const image = await importNativeImage({ id: 'i', type: 'imageGeneration', result: `data:image/png;base64,${png}` }, { maxBytes: 1024, save })
    expect(image).toEqual(ref)
    expect(save.mock.calls[0]).toBeDefined()
    const tool = createCodexTool({ waitForTool: async () => ({ text: 'done', isError: false, images: [image] }) })
    const result = await tool.execute(args, { signal: new AbortController().signal } as ToolRunContext)
    expect(tool.output.render(args, result as never)).toEqual([{ type: 'text', text: 'done' }, { type: 'image', attachment: ref }])
  })
  it('copies a local image before the native file is removed and reports file-id-only results', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tavlo-image-test-')), path = join(dir, 'native.png')
    try {
      await writeFile(path, Buffer.from(png, 'base64'))
      const save = vi.fn(async (input: { data: Uint8Array }) => { expect(Buffer.from(input.data).toString('base64')).toBe(png); return ref })
      expect(await importNativeImage({ id: 'i', type: 'imageGeneration', savedPath: path }, { maxBytes: 1024, save })).toEqual(ref)
      await expect(importNativeImage({ id: 'i', type: 'imageGeneration', fileId: 'remote' }, { maxBytes: 1024, save })).rejects.toThrow('fileId')
      await expect(importNativeImage({ id: 'i', type: 'imageGeneration', result: png }, { maxBytes: 1, save })).rejects.toThrow('base64')
      await expect(importNativeImage({ id: 'i', type: 'imageView', path: 'relative.png' }, { maxBytes: 1024, save })).rejects.toThrow('绝对')
      expect(save).toHaveBeenCalledTimes(1)
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
})
