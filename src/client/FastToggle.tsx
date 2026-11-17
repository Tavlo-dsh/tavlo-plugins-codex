/** Codex-only, session-scoped Fast switch immediately left of the model selector. */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ModelSelectInjected } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-agent'
import type { NS } from './locales.ts'
import { speedView } from './speed-view.ts'

export interface FastToggleInjected {
  directory: ModelSelectInjected['directory']
  selectFast(enabled: boolean): Promise<void>
}
export type FastToggleProps = Pick<PropsRuntime<'conversation.input.right'>,
  'sessionId' | 'useProjection' | 'useSession' | 'useAccess'>
  & PropsLocale<typeof NS> & FastToggleInjected

export function FastToggle(props: FastToggleProps) {
  return <SessionFastToggle key={props.sessionId} {...props} />
}

function SessionFastToggle({ useProjection, useSession, useAccess, directory, selectFast, t }: FastToggleProps) {
  const state = useProjection('tavloCodex')
  const selection = useProjection('modelSelection')
  const models = useSyncExternalStore(listener => directory.subscribe(listener), () => directory.getSnapshot())
  const running = useSession(snapshot => snapshot.running)
  const unavailable = useSession(snapshot => snapshot.subagent !== null || snapshot.removed || snapshot.openState !== 'open')
  const writable = useAccess('commands/execute')
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<{ seq: number; text: string } | null>(null)
  const sequence = useRef(0)
  const root = useRef<HTMLDivElement>(null)
  const submitting = useRef(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  if (!state || (selection?.next ?? models.current ?? selection?.lastUsed)?.provider !== 'codex' || unavailable) return null

  const { checked, inherited } = speedView(state)
  const disabled = running || pending || models.pending !== null || !writable
  const select = (enabled: boolean): void => {
    if (disabled || submitting.current) return
    submitting.current = true
    setPending(true)
    void selectFast(enabled).catch((error: unknown) => {
      if (mounted.current) setFailure({ seq: ++sequence.current, text: t('fast.failed', { message: error instanceof Error ? error.message : String(error) }) })
    }).finally(() => {
      submitting.current = false
      if (mounted.current) setPending(false)
    })
  }
  const title = running ? t('fast.running') : inherited ? t('fast.inheritedDescription') : t('fast.description')
  const accessible = inherited
    ? t('fast.accessibleInherited')
    : t(checked ? 'fast.accessibleOn' : 'fast.accessibleOff')
  const status = pending ? t('fast.pending') : inherited ? t('fast.inherited') : null
  return <div
    ref={root}
    className="tavlo-codex-fast-row"
    data-checked={checked}
    data-inherited={inherited}
    aria-busy={pending}
  >
    <button
      type="button"
      role="switch"
      className="tavlo-codex-fast-switch"
      aria-checked={checked}
      aria-label={accessible}
      aria-busy={pending}
      disabled={disabled}
      title={title}
      onClick={() => { select(!checked) }}
    >
      <LightningIcon />
    </button>
    {status && <span className="tavlo-codex-fast-status" role="status">{status}</span>}
    {failure && <Toast key={failure.seq} text={failure.text} anchor={root.current?.closest<HTMLElement>('[data-composer-card]') ?? null} onDone={() => { setFailure(null) }} />}
  </div>
}

function LightningIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
    <path d="M9.2 1.35 3.45 8.7h3.18l-.72 5.95 5.64-7.9H8.42l.78-5.4Z" />
  </svg>
}
