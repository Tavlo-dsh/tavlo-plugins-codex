import type { Session } from '@deepseek-ai/dsh-session'
export { positiveInteger as isContextWindow } from './protocol.ts'
import { positiveInteger } from './protocol.ts'

export function publishContextWindow(
  session: Pick<Session, 'requestContext' | 'append'>, provider: string, model: string, contextWindow: number,
): void {
  if (!positiveInteger(contextWindow)) return
  const previous = session.requestContext()
  if (previous?.provider !== provider || previous.model !== model || previous.contextWindow === contextWindow) return
  session.append('request/context', { ...previous, contextWindow })
}
