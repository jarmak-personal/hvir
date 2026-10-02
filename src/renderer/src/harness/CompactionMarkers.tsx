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
        <span className="compaction-marker" /> ×{presentation.count}
      </span>
    </span>
  )
}
