import { useLayoutEffect, useRef, useState, type ReactElement } from 'react'

import type { HarnessCompactionFacet, SessionsCompactionFact } from '../../../shared'
import {
  compactionMarkerPresentation,
  DEFAULT_COMPACTION_MARKER_PITCH,
} from './compaction-marker-presentation'

export type CompactionMarkerFact =
  | { readonly status: 'unsupported' }
  | { readonly status: 'pending' | 'unavailable'; readonly reason?: string }
  | {
      readonly status: 'available' | 'stale'
      readonly value: HarnessCompactionFacet | SessionsCompactionFact
    }

export function CompactionMarkers({
  fact,
  className = '',
}: {
  readonly fact?: CompactionMarkerFact
  readonly className?: string
}): ReactElement | null {
  const root = useRef<HTMLSpanElement>(null)
  const [metrics, setMetrics] = useState({
    width: 0,
    markerPitch: DEFAULT_COMPACTION_MARKER_PITCH,
  })
  useLayoutEffect(() => {
    const element = root.current
    if (!element) return
    const measure = (): void => {
      const next = {
        width: element.getBoundingClientRect().width,
        markerPitch:
          Number.parseFloat(getComputedStyle(element).fontSize) ||
          DEFAULT_COMPACTION_MARKER_PITCH,
      }
      setMetrics((current) =>
        current.width === next.width && current.markerPitch === next.markerPitch
          ? current
          : next,
      )
    }
    measure()
    const observer =
      typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)
    observer?.observe(element)
    return () => observer?.disconnect()
  }, [])

  if (!fact) return null
  const value =
    fact.status === 'available' || fact.status === 'stale' ? fact.value : undefined
  const presentation = compactionMarkerPresentation(
    value?.observedCount ?? 0,
    metrics.width,
    metrics.markerPitch,
  )
  const label = value
    ? `${value.observedCount} observed ${value.observedCount === 1 ? 'compaction' : 'compactions'} during this app observation period${value.coverage === 'gapped' ? '; observation has gaps' : ''}`
    : fact.status === 'pending'
      ? 'Compaction observation pending'
      : fact.status === 'unsupported'
        ? 'Compaction observation unsupported by this provider version'
        : 'Compaction observation unavailable'
  return (
    <span
      ref={root}
      className={`compaction-markers ${className}`.trim()}
      role="img"
      aria-label={label}
      data-state={value ? presentation.kind : fact.status}
      title={label}
    >
      {!value ? (
        <span className="compaction-marker-unknown" aria-hidden="true">
          {fact.status === 'pending' ? '…' : '–'}
        </span>
      ) : presentation.kind === 'circles' ? (
        Array.from({ length: presentation.count }, (_, index) => (
          <span className="compaction-marker" aria-hidden="true" key={index} />
        ))
      ) : presentation.kind === 'summary' ? (
        <span className="compaction-marker-summary" aria-hidden="true">
          <span className="compaction-marker" /> ×{presentation.count}
        </span>
      ) : null}
    </span>
  )
}
