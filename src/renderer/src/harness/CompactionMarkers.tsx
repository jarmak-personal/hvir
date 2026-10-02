import type { ReactElement } from 'react'

import type { SessionsCompactionFact, SessionsFact } from '../../../shared'
import { compactionMarkerPresentation } from './compaction-marker-presentation'

export type CompactionMarkerFact = SessionsFact<SessionsCompactionFact>

export function CompactionMarkers({
  fact,
  className = '',
}: {
  readonly fact?: CompactionMarkerFact
  readonly className?: string
}): ReactElement | null {
  const value =
    fact?.status === 'available' || fact?.status === 'stale' ? fact.value : undefined
  const presentation = compactionMarkerPresentation(value?.observedCount ?? 0)
  if (presentation.kind === 'empty') return null

  const label = `${presentation.count} observed ${presentation.count === 1 ? 'compaction' : 'compactions'} during this app observation period${value?.coverage === 'gapped' ? '; observation has gaps' : ''}`
  return (
    <span
      className={`compaction-markers ${className}`.trim()}
      role="img"
      aria-label={label}
      title={label}
    >
      <span className="compaction-marker-summary" aria-hidden="true">
        <svg
          className="compaction-marker"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          aria-hidden="true"
          focusable="false"
        >
          <path d="M1.5 3v10m13-10v10M1.5 8h3m-2-2 2 2-2 2m12-2h-3m2-2-2 2 2 2M6.5 4.5h3m-3 3.5h3m-3 3.5h3" />
        </svg>{' '}
        ×{presentation.count}
      </span>
    </span>
  )
}
