/** Content-free usage snapshots shared by bundled harness providers and phase policy. */

import type { HarnessProviderId, HostPath } from '../../shared'
import type { ProjectHost } from '../project-host'
import type { HarnessArtifactContext } from './harness-provider'

export interface HarnessUsageSnapshotContext {
  readonly sessionId: string
  readonly cwd: HostPath
  readonly sessionData?: unknown
  readonly artifact: HarnessArtifactContext
  readonly signal: AbortSignal
}

export interface HarnessUsageCounters {
  readonly freshInputTokens?: number
  readonly cacheReadInputTokens?: number
  readonly cacheWriteInputTokens?: number
  readonly outputTokens?: number
  /** Provider-reported detail already contained in output tokens. */
  readonly reasoningTokens?: number
}

export interface HarnessUsageRoute {
  readonly modelId?: string
  readonly reasoningEffort?: string
}

export interface HarnessUsageTiming {
  readonly modelOrApiMilliseconds?: number
}

export type HarnessUsageUnavailableReason =
  | 'invalid-session-identity'
  | 'artifact-unavailable'
  | 'artifact-too-large'
  | 'usage-unavailable'

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

export type HarnessUsageCounterName = keyof HarnessUsageCounters

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
      readonly reason:
        | 'snapshot-unavailable'
        | 'provider-mismatch'
        | 'observation-order-invalid'
        | 'counter-reset'
        | 'counters-unavailable'
    }

const COUNTER_NAMES = [
  'freshInputTokens',
  'cacheReadInputTokens',
  'cacheWriteInputTokens',
  'outputTokens',
  'reasoningTokens',
] as const satisfies readonly HarnessUsageCounterName[]

const ADDITIVE_COUNTER_NAMES = COUNTER_NAMES.slice(0, 4)

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
  for (const name of COUNTER_NAMES) {
    const startValue = start.counters[name]
    const endValue = end.counters[name]
    if (startValue === undefined || endValue === undefined) {
      missingCounters.push(name)
      continue
    }
    if (endValue < startValue) {
      return { status: 'unavailable', reason: 'counter-reset' }
    }
    counters[name] = endValue - startValue
  }

  if (Object.keys(counters).length === 0) {
    return { status: 'unavailable', reason: 'counters-unavailable' }
  }

  const hasEveryAdditiveCounter = ADDITIVE_COUNTER_NAMES.every(
    (name) => counters[name] !== undefined,
  )
  const normalizedTokenTotal = hasEveryAdditiveCounter
    ? ADDITIVE_COUNTER_NAMES.reduce((total, name) => total + (counters[name] ?? 0), 0)
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
      : { modelOrApiMilliseconds: endModelTime - startModelTime }

  return {
    status: hasEveryAdditiveCounter ? 'complete' : 'partial',
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

function nonNegativeUsageCounter(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined
}

export function isHarnessUsageSnapshot(value: unknown): value is HarnessUsageSnapshot {
  if (!isRecord(value) || value.version !== 1) return false
  if (
    typeof value.providerId !== 'string' ||
    value.providerId.length < 1 ||
    value.providerId.length > 64 ||
    nonNegativeUsageCounter(value.observedAt) === undefined
  ) {
    return false
  }
  if (value.status === 'unavailable') {
    return (
      exactKeys(value, ['version', 'status', 'providerId', 'observedAt', 'reason']) &&
      [
        'invalid-session-identity',
        'artifact-unavailable',
        'artifact-too-large',
        'usage-unavailable',
      ].includes(String(value.reason))
    )
  }
  if (
    value.status !== 'available' ||
    !isRecord(value.route) ||
    !isRecord(value.counters) ||
    !isRecord(value.timing)
  ) {
    return false
  }
  const route = value.route
  const counters = value.counters
  const timing = value.timing
  if (
    !exactKeys(value, [
      'version',
      'status',
      'providerId',
      'observedAt',
      'route',
      'counters',
      'timing',
    ])
  ) {
    return false
  }
  if (
    !exactKeys(route, ['modelId', 'reasoningEffort'], true) ||
    !optionalBoundedString(route.modelId, 160) ||
    !optionalBoundedString(route.reasoningEffort, 64)
  ) {
    return false
  }
  if (!exactKeys(counters, COUNTER_NAMES, true)) return false
  if (
    !exactKeys(timing, ['modelOrApiMilliseconds'], true) ||
    (timing.modelOrApiMilliseconds !== undefined &&
      nonNegativeUsageCounter(timing.modelOrApiMilliseconds) === undefined)
  ) {
    return false
  }
  return COUNTER_NAMES.every(
    (name) =>
      counters[name] === undefined ||
      nonNegativeUsageCounter(counters[name]) !== undefined,
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  allowMissing = false,
): boolean {
  const keys = Object.keys(value)
  return (
    keys.every((key) => allowed.includes(key)) &&
    (allowMissing || allowed.every((key) => keys.includes(key)))
  )
}

function optionalBoundedString(value: unknown, maxLength: number): boolean {
  return (
    value === undefined ||
    (typeof value === 'string' && value.length > 0 && value.length <= maxLength)
  )
}
