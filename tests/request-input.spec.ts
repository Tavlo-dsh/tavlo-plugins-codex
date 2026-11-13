import { describe, expect, it } from 'vitest'
import type { RequestMessage } from '@deepseek-ai/dsh-llm'
import { unseenUserInput } from '../src/request-input.ts'

const message = (content: readonly object[]): RequestMessage =>
  ({ id: 'm1', role: 'user', content, source: { kind: 'user' } }) as unknown as RequestMessage

describe('unseenUserInput image references', () => {
  it('preserves the complete attachment reference for the reader', () => {
    const ref = {
      attachmentId: 'sha256:image',
      mediaType: 'image/png',
      bytes: 69,
      width: 1,
      height: 1,
      name: 'screenshot.png',
      originalDimensions: { width: 2, height: 2 },
    }
    const input = unseenUserInput([message([{ type: 'image', attachment: ref }])], new Set(), new Set(['m1']))
    expect(input.blocks).toEqual([{ type: 'image', ref }])
    expect(input.blocks[0]).toHaveProperty('ref', ref)
    expect(input.ids).toEqual(['m1'])
  })

  it('drops a reference without integrity metadata', () => {
    expect(
      unseenUserInput(
        [message([{ type: 'image', attachment: { attachmentId: 'sha256:image', mediaType: 'image/png' } }])],
        new Set(),
        new Set(['m1']),
      ).blocks,
    ).toEqual([])
  })
})
