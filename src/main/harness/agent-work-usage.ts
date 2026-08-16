/** Content-free usage snapshots shared by bundled harness providers and phase policy. */

import {
  AGENT_WORK_ADDITIVE_TOKEN_COUNTER_NAMES,
  AGENT_WORK_TOKEN_COUNTER_NAMES,
  type AgentWorkTokenCounterName,
  type HarnessProviderId,
  type HarnessUsageDeltaUnavailableReason,
  type HarnessUsageUnavailableReason,
  type HostPath,
} from '../../shared'
import type { ProjectHost } from '../project-host'
import type { HarnessArtifactContext } from './harness-provider'

export interface HarnessUsageSnapshotContext {
  readonly sessionId: string
  readonly cwd: HostPath
  readonly sessionData?: unknown
  readonly artifact: HarnessArtifactContext
  readonly signal: AbortSignal
}

export type HarnessUsageCounters = Readonly<
  Partial<Record<AgentWorkTokenCounterName, number>>
>

export interface HarnessUsageRoute {
  readonly modelId?: string
  readonly reasoningEffort?: string
}

export interface HarnessUsageTiming {
  readonly modelOrApiMilliseconds?: number
}

export type { HarnessUsageUnavailableReason } from '../../shared'

export type HarnessUsageSnapshot =
  | {
      readonly version: 1
      readonly status: 'available'
      readonly providerId: HarnessProviderId
      readonly observedAt: number
      readonly route: HarnessUsageRoute
      readonly counters: HarnessUsageCounters
      readonly timing: HarnessUsageTiming
    }
  | {
      readonly version: 1
      readonly status: 'unavailable'
      readonly providerId: HarnessProviderId
      readonly observedAt: number
      readonly reason: HarnessUsageUnavailableReason
    }

export interface HarnessUsageSnapshotProvider {
  snapshot(
    host: ProjectHost,
    context: HarnessUsageSnapshotContext,
  ): Promise<HarnessUsageSnapshot>
}

export type HarnessUsageCounterName = AgentWorkTokenCounterName

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
  for (const name of AGENT_WORK_TOKEN_COUNTER_NAMES) {
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

  const hasEveryAdditiveCounter = AGENT_WORK_ADDITIVE_TOKEN_COUNTER_NAMES.every(
    (name) => counters[name] !== undefined,
  )
  const normalizedTokenTotal = hasEveryAdditiveCounter
    ? sumNonNegativeUsageCounters(
        AGENT_WORK_ADDITIVE_TOKEN_COUNTER_NAMES.map((name) => counters[name] ?? 0),
      )
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
