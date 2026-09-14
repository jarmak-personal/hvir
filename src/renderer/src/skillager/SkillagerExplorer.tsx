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
          {checkedAt ? <small>{rows.length}</small> : null}
        </button>
        {actions}
        <button
          type="button"
          className="skillager-section-refresh"
          disabled={loading}
          aria-label={`Refresh ${title.toLowerCase()}`}
          title={
            checkedAt
              ? `Checked ${new Date(checkedAt).toLocaleTimeString()}`
              : 'Not checked'
          }
          onClick={onRefresh}
        >
          ↻
        </button>
      </header>
      {expanded ? (
        <>
          {children}
          {loading ? (
            <p className="skillager-section-notice" role="status">
              Checking metadata…
            </p>
          ) : null}
          {error ? (
            <p className="skillager-section-notice" role="alert">
              {error}
            </p>
          ) : null}
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
              {!loading && !error ? empty : null}
            </div>
          )}
        </>
      ) : null}
    </section>
  )
}
