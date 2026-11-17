/** Browser entry: native Codex controls and accounting on the host composer. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-commands/remote'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import { FastToggle } from './FastToggle.tsx'
import type { FastToggleInjected } from './FastToggle.tsx'
import { en, NS, zh } from './locales.ts'
import { FAST_STYLES } from './styles.ts'
import { NativeStats } from './NativeStats.tsx'

export const inject = ['slots', 'locale', 'remote', 'remote.commands', 'modelDirectories']

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'tavlo-codex: dictionaries')
  ctx.effect(() => {
    const style = document.createElement('style')
    style.textContent = FAST_STYLES
    document.head.append(style)
    return () => { style.remove() }
  }, 'tavlo-codex: speed switch styles')
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right', id: 'tavlo-codex-fast', order: 900, locale: NS,
    inject: (sessionId): FastToggleInjected => ({
      directory: ctx.modelDirectories.directoryFor(sessionId).store,
      selectFast: async enabled => {
        const response = await ctx.remote.commands.execute(sessionId, `/codex fast ${enabled ? 'on' : 'off'}`, [])
        if (!response.ok) throw new Error(response.error.message)
        if (!response.value) throw new Error(t('fast.unavailable'))
        if (response.value.result.kind === 'error') throw new Error(response.value.result.text)
      },
    }),
  }, FastToggle))
  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
    name: 'conversation.composer.dock', id: 'tavlo-codex-stats', order: 2, locale: NS,
    inject: sessionId => ({ directory: ctx.modelDirectories.directoryFor(sessionId).store }),
  }, NativeStats))
}
