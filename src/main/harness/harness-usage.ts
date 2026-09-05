/** Provider-neutral cumulative usage contracts and safe arithmetic. */

import {
  HARNESS_USAGE_ADDITIVE_TOKEN_COUNTER_NAMES,
  HARNESS_USAGE_TOKEN_COUNTER_NAMES,
  UNSUPPORTED_HARNESS_FACET,
  type HarnessProviderId,
  type HarnessTelemetry,
  type HarnessUsageCounterName,
  type HarnessUsageCounters,
  type HarnessUsageFacet,
  type HarnessUsageUnavailableReason,
  type HarnessUsageValue,
} from '../../shared'
import type { HarnessUsageSnapshot } from './harness-provider-contract'
export type {
  HarnessUsageSnapshotContext,
  HarnessUsageRoute,
  HarnessUsageTiming,
  HarnessUsageSnapshot,
  HarnessUsageSnapshotProvider,
} from './harness-provider-contract'

export type { HarnessUsageUnavailableReason } from '../../shared'

export function unavailableHarnessUsageSnapshot(
  providerId: HarnessProviderId,
  reason: HarnessUsageUnavailableReason,
): HarnessUsageSnapshot {
  return { version: 1, status: 'unavailable', providerId, observedAt: Date.now(), reason }
}

export function nonNegativeUsageCounter(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined
}

export function sumNonNegativeUsageCounters(
  values: readonly number[],
): number | undefined {
  let total = 0
  for (const value of values) {
    const admitted = nonNegativeUsageCounter(value)
    if (admitted === undefined) return undefined
    const next = total + admitted
    if (nonNegativeUsageCounter(next) === undefined) return undefined
    total = next
  }
  return total
}

export function normalizedHarnessUsageTotal(
  counters: HarnessUsageCounters,
): number | undefined {
  if (
    !HARNESS_USAGE_ADDITIVE_TOKEN_COUNTER_NAMES.every(
      (name) => counters[name] !== undefined,
    )
  ) {
    return undefined
  }
  return sumNonNegativeUsageCounters(
    HARNESS_USAGE_ADDITIVE_TOKEN_COUNTER_NAMES.map((name) => counters[name] ?? 0),
  )
}

export function harnessUsageValue(
  counters: HarnessUsageCounters,
):
  | { readonly status: 'exact' | 'partial'; readonly value: HarnessUsageValue }
  | undefined {
  const admitted: Partial<Record<HarnessUsageCounterName, number>> = {}
  for (const name of HARNESS_USAGE_TOKEN_COUNTER_NAMES) {
    const value = nonNegativeUsageCounter(counters[name])
    if (value !== undefined) admitted[name] = value
  }
  if (Object.keys(admitted).length === 0) return undefined
  const normalizedTokenTotal = normalizedHarnessUsageTotal(admitted)
  return {
    status: normalizedTokenTotal === undefined ? 'partial' : 'exact',
    value: {
      ...admitted,
      ...(normalizedTokenTotal === undefined ? {} : { normalizedTokenTotal }),
    },
  }
}

export function usageObservationHarnessTelemetry(input: {
  readonly providerId: HarnessProviderId
  readonly sessionId: string
  readonly provenance: string
  readonly counters: HarnessUsageCounters
  readonly observedAt?: number
  readonly modelId?: string
}): HarnessTelemetry | undefined {
  const usage = harnessUsageValue(input.counters)
  if (!usage) return undefined
  return usageFacetHarnessTelemetry({ ...input, usage })
}

export function harnessUsageSnapshotTelemetry(input: {
  readonly snapshot: HarnessUsageSnapshot
  readonly sessionId: string
  readonly provenance: string
}): HarnessTelemetry {
  if (input.snapshot.status === 'unavailable') {
    return usageStatusHarnessTelemetry({
      providerId: input.snapshot.providerId,
      sessionId: input.sessionId,
      provenance: input.provenance,
      observedAt: input.snapshot.observedAt,
      usage: { status: 'unavailable', reason: input.snapshot.reason },
    })
  }
  return (
    usageObservationHarnessTelemetry({
      providerId: input.snapshot.providerId,
      sessionId: input.sessionId,
      provenance: input.provenance,
      observedAt: input.snapshot.observedAt,
      counters: input.snapshot.counters,
      modelId: input.snapshot.route.modelId,
    }) ??
    usageStatusHarnessTelemetry({
      providerId: input.snapshot.providerId,
      sessionId: input.sessionId,
      provenance: input.provenance,
      observedAt: input.snapshot.observedAt,
      usage: { status: 'unavailable', reason: 'usage-unavailable' },
    })
  )
}

export function usageCountersDecreased(
  previous: HarnessUsageCounters,
  next: HarnessUsageCounters,
): boolean {
  return HARNESS_USAGE_TOKEN_COUNTER_NAMES.some((name) => {
    const before = previous[name]
    const after = next[name]
    return before !== undefined && after !== undefined && after < before
  })
}

export function usageCountersEqual(
  left: HarnessUsageCounters,
  right: HarnessUsageCounters,
): boolean {
  return HARNESS_USAGE_TOKEN_COUNTER_NAMES.every((name) => left[name] === right[name])
}

export function usageStatusHarnessTelemetry(input: {
  readonly providerId: HarnessProviderId
  readonly sessionId: string
  readonly provenance: string
  readonly usage: Exclude<HarnessUsageFacet, { readonly status: 'exact' | 'partial' }>
  readonly observedAt?: number
  readonly modelId?: string
}): HarnessTelemetry {
  return usageFacetHarnessTelemetry(input)
}

function usageFacetHarnessTelemetry(input: {
  readonly providerId: HarnessProviderId
  readonly sessionId: string
  readonly provenance: string
  readonly usage: HarnessUsageFacet
  readonly observedAt?: number
  readonly modelId?: string
}): HarnessTelemetry {
  return {
    version: 1,
    observedAt: input.observedAt ?? Date.now(),
    source: {
      providerId: input.providerId,
      kind: 'session-artifact',
      provenance: input.provenance,
    },
    freshness: {
      state: input.usage.status === 'stale' ? 'stale' : 'live',
      staleAfterMs: 30_000,
    },
    facets: {
      session: UNSUPPORTED_HARNESS_FACET,
      model: input.modelId
        ? { status: 'available', value: { id: input.modelId } }
        : UNSUPPORTED_HARNESS_FACET,
      context: UNSUPPORTED_HARNESS_FACET,
      usage: input.usage,
      turn: UNSUPPORTED_HARNESS_FACET,
      integrations: UNSUPPORTED_HARNESS_FACET,
    },
  }
}
