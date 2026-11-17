/** Composer readings come from Codex's durable accounting, not DSH's single-call token meter. */
import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  IconDatabaseOutlineRegular,
  IconGaugeOutlineRegular,
  Tooltip,
  useDismissOnOutsidePointer,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-agent'
import type { FastToggleInjected } from './FastToggle.tsx'
import type { NS } from './locales.ts'
import { compactTokens, statsView } from './stats-view.ts'

export type NativeStatsProps = Pick<PropsRuntime<'conversation.composer.dock'>, 'useProjection' | 'useSession'>
  & Pick<FastToggleInjected, 'directory'> & PropsLocale<typeof NS>

type StatId = 'speed' | 'usage' | 'context'

function useStatDialog() {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLSpanElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const anchorName = `--tavlo-codex-stat-${useId().replaceAll(':', '')}`
  useDismissOnOutsidePointer(rootRef, open, setOpen, panelRef)
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    const onClick = (event: MouseEvent): void => {
      if (event.target instanceof Node
        && !rootRef.current?.contains(event.target)
        && !panelRef.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('click', onClick, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('click', onClick, true)
    }
  }, [open])
  return { open, setOpen, rootRef, panelRef, anchorName }
}

function StatCard({ stat, icon, label, text, title, titleValue, children }: {
  stat: StatId
  icon: ReactNode
  label: string
  text: string
  title: string
  titleValue: string
  children: ReactNode
}) {
  const { open, setOpen, rootRef, panelRef, anchorName } = useStatDialog()
  return <span
    ref={rootRef}
    style={{ anchorName }}
    className="tavlo-codex-stat-anchor"
    data-composer-stat={`tavlo-codex-${stat}`}
  >
    <Tooltip label={text} side="top" delayMs={200} portal onlyWhenClipped disabled={open}>
      <button
        type="button"
        className="tavlo-codex-stat"
        data-codex-stat={stat}
        aria-label={text}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => { setOpen(!open) }}
      >
        {icon}<span>{label}</span>
      </button>
    </Tooltip>
    {open && createPortal(
      <div
        ref={panelRef}
        className="tavlo-codex-stat-panel"
        data-codex-stat-panel={stat}
        role="dialog"
        aria-label={title}
        style={{ positionAnchor: anchorName }}
      >
        <div className="tavlo-codex-stat-title">
          <span className="tavlo-codex-stat-title-label">{icon}{title}</span>
          <span className="tavlo-codex-stat-title-value">{titleValue}</span>
        </div>
        <div className="tavlo-codex-stat-rule" aria-hidden="true" />
        {children}
      </div>,
      document.body,
    )}
  </span>
}

function tokenCount(value: number): string {
  return `${value.toLocaleString()} tok`
}

export function NativeStats({ useProjection, useSession, directory, t }: NativeStatsProps) {
  const state = useProjection('tavloCodex')
  const selection = useProjection('modelSelection')
  const models = useSyncExternalStore(listener => directory.subscribe(listener), () => directory.getSnapshot())
  const model = selection?.next ?? models.current ?? selection?.lastUsed
  const unavailable = useSession(s => s.subagent !== null || s.removed || s.openState !== 'open')
  if (!state || model?.provider !== 'codex' || unavailable) return null
  const view = statsView(state, model.model)
  if (!view.observed && !state.threadId && !state.usage.last) return null
  const total = state.usage.consumed
  const context = view.context
  const usageLabel = `${view.total === undefined ? '—' : compactTokens(view.total)} tok${view.cache === undefined ? '' : ` · ${t('stats.cache', { percent: view.cache })}`}`
  const usageTitle = view.observed ? t('stats.usageDetails', {
    total: total.totalTokens, input: total.inputTokens, cacheRead: total.cacheReadTokens,
    cacheWrite: total.cacheWriteTokens, output: total.outputTokens,
  }) + (state.usage.baseline === 'inferred' ? ` ${t('stats.inferred')}` : '') : t('stats.awaitingUsage')
  const speedLabel = t('stats.speed', { value: view.speed ?? '—' })
  const speedTitle = view.speed === undefined ? t('stats.awaitingSpeed') : t('stats.speedDetails', {
    tokens: state.usage.lastTurn!.outputTokens, seconds: Number((state.usage.lastTurn!.durationMs / 1000).toFixed(2)),
  })
  const contextLabel = t('stats.context', { value: context ? `${context.percent}%` : '—' })
  const contextTitle = context ? t('stats.contextDetails', { used: context.used, capacity: context.capacity })
    : t(state.compaction.status === 'running' || state.compaction.status === 'requested' ? 'stats.compacting' : 'stats.awaitingContext')
  const usageText = `${usageLabel}. ${usageTitle}`, speedText = `${speedLabel}. ${speedTitle}`, contextText = `${contextLabel}. ${contextTitle}`
  return <span className="tavlo-codex-stats" data-composer-stat="tavlo-codex">
    <StatCard
      stat="speed"
      icon={<IconGaugeOutlineRegular />}
      label={speedLabel}
      text={speedText}
      title={t('stats.dialog.speedTitle')}
      titleValue={view.speed === undefined ? '—' : `${view.speed} tok/s`}
    >
      {state.usage.lastTurn ? <dl className="tavlo-codex-stat-details">
        <dt>{t('stats.dialog.turnOutput')}</dt>
        <dd>{tokenCount(state.usage.lastTurn.outputTokens)}</dd>
        <dt>{t('stats.dialog.turnDuration')}</dt>
        <dd>{t('stats.dialog.seconds', { value: Number((state.usage.lastTurn.durationMs / 1000).toFixed(2)) })}</dd>
      </dl> : <p className="tavlo-codex-stat-note">{t('stats.awaitingSpeed')}</p>}
      <p className="tavlo-codex-stat-note">{t('stats.dialog.speedNote')}</p>
    </StatCard>
    <StatCard
      stat="usage"
      icon={<IconDatabaseOutlineRegular />}
      label={usageLabel}
      text={usageText}
      title={t('stats.dialog.usageTitle')}
      titleValue={view.total === undefined ? '—' : tokenCount(view.total)}
    >
      {view.observed ? <dl className="tavlo-codex-stat-details">
        {view.cache !== undefined && <><dt>{t('stats.dialog.cacheHit')}</dt><dd>{view.cache}%</dd></>}
        <dt>{t('stats.dialog.uncachedInput')}</dt>
        <dd>{tokenCount(total.inputTokens)}</dd>
        <dt>{t('stats.dialog.cacheRead')}</dt>
        <dd>{tokenCount(total.cacheReadTokens)}</dd>
        <dt>{t('stats.dialog.cacheWrite')}</dt>
        <dd>{tokenCount(total.cacheWriteTokens)}</dd>
        <dt>{t('stats.dialog.output')}</dt>
        <dd>{tokenCount(total.outputTokens)}</dd>
      </dl> : <p className="tavlo-codex-stat-note">{t('stats.awaitingUsage')}</p>}
      <p className="tavlo-codex-stat-note">
        {t('stats.dialog.usageNote')}{state.usage.baseline === 'inferred' ? ` ${t('stats.inferred')}` : ''}
      </p>
    </StatCard>
    <StatCard
      stat="context"
      icon={<svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true">
        <circle cx="8" cy="8" r="6" stroke="currentColor" opacity=".25" strokeWidth="1.5" />
        <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" pathLength="1" strokeDasharray={`${context?.fraction ?? 0} 1`} transform="rotate(-90 8 8)" />
      </svg>}
      label={contextLabel}
      text={contextText}
      title={t('stats.dialog.contextTitle')}
      titleValue={context ? `${context.percent}%` : '—'}
    >
      {context ? <dl className="tavlo-codex-stat-details">
        <dt>{t('stats.dialog.contextUsed')}</dt>
        <dd>{tokenCount(context.used)}</dd>
        <dt>{t('stats.dialog.contextCapacity')}</dt>
        <dd>{tokenCount(context.capacity)}</dd>
      </dl> : <p className="tavlo-codex-stat-note">
        {t(state.compaction.status === 'running' || state.compaction.status === 'requested' ? 'stats.compacting' : 'stats.awaitingContext')}
      </p>}
      <p className="tavlo-codex-stat-note">{t('stats.dialog.contextNote')}</p>
    </StatCard>
  </span>
}
