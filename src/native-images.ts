/** Import native image bytes into DSH, so process-local paths never become durable previews. */
import { open } from 'node:fs/promises'
import { basename, isAbsolute } from 'node:path'
import type { ImageAttachmentRef, ImageMediaType, SaveImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { NativeItem } from './protocol.ts'
import { text } from './protocol.ts'

export interface NativeImageStore {
  readonly maxBytes: number
  save(input: SaveImageAttachment): Promise<ImageAttachmentRef>
}
function mediaType(bytes: Buffer): ImageMediaType | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg'
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif'
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp'
  return undefined
}
export async function importNativeImage(item: NativeItem, store: NativeImageStore): Promise<ImageAttachmentRef> {
  let bytes: Buffer, name = 'codex-image'
  const path = text(item.savedPath) || (item.type === 'imageView' ? text(item.path) : '')
  if (path) {
    if (!isAbsolute(path)) throw new Error('Codex 返回了非绝对图片路径。')
    const file = await open(path, 'r')
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.size < 1 || stat.size > store.maxBytes) throw new Error('原生图片为空、非普通文件或超过附件限制。')
      bytes = Buffer.alloc(stat.size + 1)
      let offset = 0
      while (offset < bytes.length) {
        const read = await file.read(bytes, offset, bytes.length - offset, null)
        if (!read.bytesRead) break
        offset += read.bytesRead
      }
      if (offset !== stat.size) throw new Error('原生图片在读取过程中发生变化。')
      bytes = bytes.subarray(0, offset)
      name = basename(path)
    } finally { await file.close() }
  } else {
    const result = text(item.result), data = result.replace(/^data:image\/(png|jpeg|webp|gif);base64,/, '')
    if (!data) throw new Error(item.fileId ? 'Codex 仅返回 fileId，当前协议没有可用的图片下载接口。' : 'Codex 未返回可预览的图片。')
    if (data.length > Math.ceil(store.maxBytes / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) throw new Error('图片结果不是受支持的有界 base64 数据。')
    bytes = Buffer.from(data, 'base64')
    if (bytes.toString('base64') !== data || bytes.length > store.maxBytes) throw new Error('图片 base64 或大小无效。')
  }
  const type = mediaType(bytes)
  if (!type) throw new Error('原生输出不是受支持的 PNG、JPEG、WebP 或 GIF 图片。')
  return store.save({ data: bytes, mediaType: type, name })
}
