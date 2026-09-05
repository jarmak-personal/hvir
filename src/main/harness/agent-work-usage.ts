/** Content-free usage snapshots shared by bundled harness providers and phase policy. */

import {
  HARNESS_USAGE_ADDITIVE_TOKEN_COUNTER_NAMES,
  HARNESS_USAGE_TOKEN_COUNTER_NAMES,
  type HarnessProviderId,
  type HarnessUsageDeltaUnavailableReason,
  type HarnessUsageCounterName,
  type HarnessUsageCounters,
} from '../../shared'
import {
  nonNegativeUsageCounter,
  normalizedHarnessUsageTotal,
} from './harness-usage'
import type {
  HarnessUsageRoute,
  HarnessUsageSnapshot,
  HarnessUsageTiming,
} from './harness-provider-contract'

export {
  nonNegativeUsageCounter,
  sumNonNegativeUsageCounters,
  unavailableHarnessUsageSnapshot,
  type HarnessUsageUnavailableReason,
} from './harness-usage'
export type {
  HarnessUsageRoute,
  HarnessUsageSnapshot,
  HarnessUsageSnapshotContext,
  HarnessUsageSnapshotProvider,
  HarnessUsageTiming,
} from './harness-provider-contract'

export type { HarnessUsageCounters } from '../../shared'
export type { HarnessUsageCounterName } from '../../shared'

export type HarnessUsageDelta =
  | {
      readonly status: 'complete' | 'partial'
      readonly providerId: HarnessProviderId
      readonly route: {
        readonly start: HarnessUsageRoute
        readonly end: HarnessUsageRoute
      }
      readonly counters: HarnessUsageCounters
      readonly timing?: HarnessUsageTiming
      readonly normalizedTokenTotal?: number
      readonly missingCounters: readonly HarnessUsageCounterName[]
    }
  | {
      readonly status: 'unavailable'
      readonly reason: HarnessUsageDeltaUnavailableReason
    }

/** Compare two snapshots from one provider-qualified run without parsing provider records. */
export function calculateHarnessUsageDelta(
  start: HarnessUsageSnapshot,
  end: HarnessUsageSnapshot,
): HarnessUsageDelta {
  if (start.status !== 'available' || end.status !== 'available') {
    return { status: 'unavailable', reason: 'snapshot-unavailable' }
  }
  if (start.providerId !== end.providerId) {
    return { status: 'unavailable', reason: 'provider-mismatch' }
  }
  if (end.observedAt < start.observedAt) {
    return { status: 'unavailable', reason: 'observation-order-invalid' }
  }

  const counters: Record<string, number> = {}
  const missingCounters: HarnessUsageCounterName[] = []
  for (const name of HARNESS_USAGE_TOKEN_COUNTER_NAMES) {
    const startValue = start.counters[name]
    const endValue = end.counters[name]
    if (startValue === undefined || endValue === undefined) {
      missingCounters.push(name)
      continue
    }
    if (endValue < startValue) {
      return { status: 'unavailable', reason: 'counter-reset' }
    }
    const delta = nonNegativeUsageCounter(endValue - startValue)
    if (delta === undefined) {
      missingCounters.push(name)
      continue
    }
    counters[name] = delta
  }

  if (Object.keys(counters).length === 0) {
    return { status: 'unavailable', reason: 'counters-unavailable' }
  }

  const hasEveryAdditiveCounter = HARNESS_USAGE_ADDITIVE_TOKEN_COUNTER_NAMES.every(
    (name) => counters[name] !== undefined,
  )
  const normalizedTokenTotal = hasEveryAdditiveCounter
    ? normalizedHarnessUsageTotal(counters)
    : undefined
  const startModelTime = start.timing.modelOrApiMilliseconds
  const endModelTime = end.timing.modelOrApiMilliseconds
  if (
    startModelTime !== undefined &&
    endModelTime !== undefined &&
    endModelTime < startModelTime
  ) {
    return { status: 'unavailable', reason: 'counter-reset' }
  }
  const timing =
    startModelTime === undefined || endModelTime === undefined
      ? undefined
      : nonNegativeUsageCounter(endModelTime - startModelTime) === undefined
        ? undefined
        : { modelOrApiMilliseconds: endModelTime - startModelTime }

  return {
    status:
      hasEveryAdditiveCounter && normalizedTokenTotal !== undefined
        ? 'complete'
        : 'partial',
    providerId: start.providerId,
    route: { start: start.route, end: end.route },
    counters,
    ...(timing ? { timing } : {}),
    ...(normalizedTokenTotal === undefined ? {} : { normalizedTokenTotal }),
    missingCounters,
  }
}
