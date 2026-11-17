import { describe, expect, it } from 'vitest'
import type { RequestMessage } from '@deepseek-ai/dsh-llm'
import { unseenUserInput } from '../src/request-input.ts'
import { GoalId } from '@deepseek-ai/dsh-goal'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

const message = (content: readonly object[]): RequestMessage =>
  ({ id: 'm1', role: 'user', content, source: { kind: 'user' } }) as unknown as RequestMessage

describe('unseenUserInput image references', () => {
  it('forwards only a host-authorized goal round belonging to the current turn, exactly once', () => {
    const goal = createUserMessage({ content: [{ type: 'text', text: 'Continue the goal' }], source: { kind: 'goal', goalId: GoalId('g'), revision: 3, round: 2 } })
    const request: RequestMessage = { ...goal, role: 'user' }
    const accepts = (round: { id: string; revision: number; round: number }) => round.id === 'g' && round.revision === 3 && round.round === 2
    expect(unseenUserInput([request], new Set(), new Set([goal.id]), accepts)).toMatchObject({ ids: [goal.id], goalRound: { id: 'g', revision: 3, round: 2 } })
    expect(unseenUserInput([request], new Set([goal.id]), new Set([goal.id]), accepts).blocks).toEqual([])
    expect(unseenUserInput([request], new Set(), new Set(), accepts).blocks).toEqual([])
    expect(unseenUserInput([request], new Set(), new Set([goal.id])).blocks).toEqual([])
  })
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
