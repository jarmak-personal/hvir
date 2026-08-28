import type { ReactElement } from 'react'

import type { HarnessContextPressurePolicy, SessionsContextFact } from '../../../shared'

export type ProviderContextFacet =
  | { readonly status: 'unsupported' }
  | { readonly status: 'pending' | 'unavailable'; readonly reason?: string }
  | {
      readonly status: 'available' | 'stale'
      readonly value: SessionsContextFact
      readonly reason?: string
    }

export function ProviderContextMeter({
  contextFacet,
  countOnly = false,
  pressurePolicy,
}: {
  readonly contextFacet?: ProviderContextFacet
  readonly countOnly?: boolean
  readonly pressurePolicy?: HarnessContextPressurePolicy
}): ReactElement {
  const context =
    contextFacet?.status === 'available' || contextFacet?.status === 'stale'
      ? contextFacet.value
      : undefined
  const contextStatus = contextFacet?.status
  const assumedWindowTokens =
    context?.windowTokens === undefined ? pressurePolicy?.assumedWindowTokens : undefined
  const presentationWindowTokens = context?.windowTokens ?? assumedWindowTokens
  const reportedPercent = countOnly
    ? undefined
    : (context?.usedPercent ??
      (context && presentationWindowTokens
        ? (context.usedTokens / presentationWindowTokens) * 100
        : undefined))
  const percent =
    typeof reportedPercent === 'number' && Number.isFinite(reportedPercent)
      ? Math.min(100, Math.max(0, reportedPercent))
      : undefined
  const displayPercent = percent === undefined ? undefined : Math.floor(percent)
  const hasCountOnly = context !== undefined && displayPercent === undefined
  const pressure = hasCountOnly
    ? 'count-only'
    : contextStatus === 'pending'
      ? 'pending'
      : contextStatus === 'unavailable'
        ? 'unavailable'
        : displayPercent === undefined
          ? 'unknown'
          : displayPercent >= (pressurePolicy?.criticalPercent ?? 70)
            ? 'critical'
            : displayPercent >= (pressurePolicy?.warningPercent ?? 40)
              ? 'warning'
              : 'normal'
  const label =
    contextStatus === 'pending'
      ? (contextFacet?.reason ?? 'Waiting for context telemetry')
      : contextStatus === 'unavailable'
        ? (contextFacet?.reason ?? 'Context telemetry unavailable')
        : context && context.windowTokens !== undefined
          ? `${formatTokenCount(context.usedTokens)} / ${formatTokenCount(context.windowTokens)} context used`
          : context && assumedWindowTokens !== undefined
            ? `${formatTokenCount(context.usedTokens)} / ${formatTokenCount(assumedWindowTokens)} context used (assumed capacity)`
            : context
              ? `${formatTokenCount(context.usedTokens)} current context tokens; limit unavailable`
              : 'Context usage unavailable'

  return (
    <span
      className={`provider-context ${pressure}${countOnly ? ' count-display' : ''}`}
      title={label}
      aria-label={context === undefined ? label : undefined}
    >
      {!countOnly ? (
        displayPercent === undefined ? (
          <span className="provider-context-track" aria-hidden="true" />
        ) : (
          <span
            className="provider-context-track"
            role="progressbar"
            aria-label="Context used"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={displayPercent}
            aria-valuetext={label}
          >
            <span className="provider-context-fill" style={{ width: `${percent}%` }} />
          </span>
        )
      ) : null}
      <span className="provider-context-value">
        {contextStatus === 'pending'
          ? '…'
          : contextStatus === 'unavailable'
            ? '!'
            : hasCountOnly
              ? formatTokenCount(context.usedTokens)
              : displayPercent === undefined
                ? '--'
                : `${displayPercent}%`}
      </span>
    </span>
  )
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${trimFraction(value / 1_000_000)}m`
  if (value >= 1_000) return `${trimFraction(value / 1_000)}k`
  return String(Math.round(value))
}

function trimFraction(value: number): string {
  return value >= 100 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, '')
}
