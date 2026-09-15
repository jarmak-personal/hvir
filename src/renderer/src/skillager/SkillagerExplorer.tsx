import type { SkillagerCanonicalObservation } from './skillager-model'
import type { ReactNode } from 'react'
import type { SkillagerMetadata } from '../../../shared/skillager'
import type { SkillagerController } from './use-skillager-workspace'
import { SkillagerTree } from './SkillagerTree'

/** Section headers stay outside their independently bounded metadata scroll areas. */
export function SkillagerExplorer({
  title,
  expanded,
  onExpanded,
  loading,
  freshness,
  error,
  rows,
  known,
  checkedAt,
  controller,
  onRefresh,
  children,
  empty,
  actions,
}: {
  readonly title: 'In this project' | 'Your library'
  readonly expanded: boolean
  readonly onExpanded: (expanded: boolean) => void
  readonly loading: boolean
  readonly freshness: SkillagerCanonicalObservation['freshness']
  readonly error?: string
  readonly rows: readonly SkillagerMetadata[]
  readonly known: SkillagerCanonicalObservation
  readonly checkedAt?: number
  readonly controller: SkillagerController
  readonly onRefresh: () => void
  readonly children?: ReactNode
  readonly actions?: ReactNode
  readonly empty: ReactNode
}) {
  const observed = checkedAt !== undefined
  const checked = observed
    ? `Last checked ${new Date(checkedAt).toLocaleTimeString()}`
    : 'Not checked'
  const notice = loading
    ? observed
      ? 'Refreshing…'
      : 'Checking…'
    : error
      ? 'Refresh failed'
      : freshness !== 'fresh' && observed
        ? 'Stale'
        : ''
  const explanation = error
    ? `${error} ${checked}. Use Refresh to try again.`
    : `${notice ? `${notice} · ` : ''}${checked}`
  return (
    <section
      className={`skillager-explorer-section${expanded ? ' expanded' : ''}`}
      aria-label={title}
    >
      <header className="skillager-section-header">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => onExpanded(!expanded)}
        >
          <span aria-hidden="true">{expanded ? '⌄' : '›'}</span> {title}
          {observed ? <small>{rows.length}</small> : null}
        </button>
        {actions}
        <span
          className="skillager-refresh-status"
          role={notice ? (error && !loading ? 'alert' : 'status') : undefined}
          title={explanation}
          aria-label={notice ? explanation : undefined}
        >
          {notice}
        </span>
        <button
          type="button"
          className="skillager-section-refresh"
          disabled={loading}
          aria-busy={loading}
          aria-label={`Refresh ${title.toLowerCase()}`}
          title={explanation}
          onClick={onRefresh}
        >
          ↻
        </button>
      </header>
      {expanded ? (
        <>
          {children}
          {rows.length ? (
            <SkillagerTree
              rows={rows}
              known={known}
              activeId={controller.activeId}
              onSelect={controller.select}
              actions={controller.exposures.menu}
              label={title}
            />
          ) : (
            <div className="skillager-section-empty">
              {observed || (!loading && !error) ? empty : null}
            </div>
          )}
        </>
      ) : null}
    </section>
  )
}
