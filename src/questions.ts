import { record, text } from './protocol.ts'
export interface DshQuestion {
  id: string
  question: string
  header?: string
  options?: { label: string; description?: string }[]
  multiSelect?: boolean
}
export interface DshAnswer { answers: readonly { id: string; selected: readonly string[]; custom?: string }[] }
export type AskQuestions = (questions: DshQuestion[], signal: AbortSignal) => Promise<DshAnswer | undefined>

export function toDshQuestions(input: Record<string, unknown>): DshQuestion[] {
  if (!Array.isArray(input.questions)) return []
  return input.questions.flatMap(raw => {
    const q = record(raw)
    if (!text(q.id) || !text(q.question) || q.isSecret === true) return []
    const options = Array.isArray(q.options) ? q.options.flatMap(raw => {
      const option = record(raw)
      return text(option.label) ? [{ label: text(option.label), description: text(option.description) }] : []
    }) : []
    return [{ id: text(q.id), question: text(q.question), header: text(q.header), ...(options.length ? { options } : {}) }]
  })
}
export function toCodexAnswers(answer: DshAnswer | undefined): { answers: Record<string, { answers: string[] }> } {
  const answers: Record<string, { answers: string[] }> = Object.create(null)
  for (const item of answer?.answers ?? []) {
    answers[item.id] = { answers: [...item.selected, ...(item.custom ? [item.custom] : [])] }
  }
  return { answers }
}

/** A conservative bridge for flat MCP forms. Nested schemas stay with the MCP UI. */
export async function answerElicitation(
  params: Record<string, unknown>, ask: AskQuestions, signal: AbortSignal,
): Promise<unknown> {
  const decline = { action: 'decline', content: null, _meta: null }
  if (params.mode === 'url') {
    const answer = await ask([{
      id: 'url', question: `${text(params.message)}\n${text(params.url)}\n请完成页面上的操作后选择“已完成”。`,
      options: [{ label: '已完成' }, { label: '取消' }],
    }], signal)
    return { ...decline, action: answer?.answers.find(item => item.id === 'url')?.selected.includes('已完成') ? 'accept' : 'decline' }
  }
  const schema = record(params.requestedSchema)
  if (schema.type !== 'object') return decline
  const properties = Object.entries(record(schema.properties))
  const questions: DshQuestion[] = []
  for (const [id, raw] of properties) {
    const field = record(raw)
    if (!['string', 'boolean', 'number', 'integer'].includes(text(field.type)) || field.format === 'password') return decline
    const choices = Array.isArray(field.enum) ? field.enum : field.type === 'boolean' ? [true, false] : []
    questions.push({
      id, question: `${text(params.message)}\n${text(field.title) || id}${text(field.description) ? `\n${text(field.description)}` : ''}`,
      ...(choices.length ? { options: choices.map(value => ({ label: String(value) })) } : {}),
    })
  }
  if (!questions.length) return decline
  const response = await ask(questions, signal)
  if (response === undefined) return decline
  const answers = toCodexAnswers(response).answers
  const content: Record<string, unknown> = Object.create(null)
  const required = new Set(Array.isArray(schema.required) ? schema.required : [])
  for (const [id, raw] of properties) {
    const field = record(raw)
    const value = answers[id]?.answers[0]
    if (value === undefined || value === '') { if (required.has(id)) return decline; continue }
    let parsed: unknown = value
    if (field.type === 'boolean') {
      if (value !== 'true' && value !== 'false') return decline
      parsed = value === 'true'
    } else if (field.type === 'integer' || field.type === 'number') {
      parsed = Number(value)
      if (!Number.isFinite(parsed) || (field.type === 'integer' && !Number.isSafeInteger(parsed))) return decline
    }
    if (Array.isArray(field.enum) && !field.enum.includes(parsed)) return decline
    content[id] = parsed
  }
  return { action: 'accept', content, _meta: null }
}
