import {
  HARNESS_USAGE_ADDITIVE_TOKEN_COUNTER_NAMES,
  HARNESS_USAGE_TOKEN_COUNTER_NAMES,
  MAX_SESSIONS_USAGE_ROWS,
  type HarnessUsageCounterName,
  type HarnessUsageValue,
  type SessionsProjectionRow,
  type SessionsTerminalHandle,
  type SessionsUsageFact,
} from '../../../shared'

export const SESSIONS_USAGE_SAMPLE_CADENCE_MS = 10_000
export const SESSIONS_USAGE_MAX_SAMPLE_INTERVAL_MS = 25_000
export const SESSIONS_USAGE_MAX_SAMPLES_PER_SESSION = 100
export const SESSIONS_USAGE_MAX_TOTAL_SAMPLES =
  MAX_SESSIONS_USAGE_ROWS * SESSIONS_USAGE_MAX_SAMPLES_PER_SESSION
export const SESSIONS_USAGE_WINDOWS = [60_000, 5 * 60_000, 15 * 60_000] as const

export type SessionsUsageMode = 'recent' | 'session-total'
export type SessionsUsageWindow = (typeof SESSIONS_USAGE_WINDOWS)[number]
export type SessionsUsageCoverage = 'complete' | 'partial' | 'none' | 'reset'

export interface SessionsUsageSample {
  readonly sampledAt: number
  readonly usage: SessionsUsageFact
}

export interface SessionsUsageHistory {
  readonly samples: readonly SessionsUsageSample[]
  readonly lastActivityAt?: number
}

export interface SessionsRecentUsage {
  readonly value: HarnessUsageValue
  /** Known additive change only; it is presentation evidence, never a rank value. */
  readonly observedTokenSubtotal?: number
  readonly coverage: SessionsUsageCoverage
  readonly coveragePercent: number
  readonly lastActivityAt?: number
}

export interface SessionsUsageRankedRow {
  readonly row: SessionsProjectionRow
  readonly usage: SessionsUsageFact
  readonly recent: SessionsRecentUsage
  readonly rank?: number
  readonly rankValue?: number
}

export function appendSessionsUsageSample(
  history: SessionsUsageHistory | undefined,
  sample: SessionsUsageSample,
): SessionsUsageHistory {
  const previous = history?.samples.at(-1)
  if (previous && sample.sampledAt <= previous.sampledAt)
    return history ?? { samples: [] }
  const samples = [...(history?.samples ?? []), sample].slice(
    -SESSIONS_USAGE_MAX_SAMPLES_PER_SESSION,
  )
  const delta = previous ? comparableUsageDelta(previous, sample) : undefined
  return {
    samples,
    lastActivityAt:
      delta && positiveUsage(delta.value) ? sample.sampledAt : history?.lastActivityAt,
  }
}

/** Retain one non-exact state edge so a later exact sample cannot bridge it. */
export function appendSessionsUsageStateBoundary(
  history: SessionsUsageHistory | undefined,
  sample: SessionsUsageSample,
): SessionsUsageHistory | undefined {
  if (sample.usage.status === 'exact') return history
  if (history?.samples.at(-1)?.usage.status === sample.usage.status) return history
  return appendSessionsUsageSample(history, sample)
}

export function recentSessionsUsage(
  history: SessionsUsageHistory | undefined,
  now: number,
  windowMs: SessionsUsageWindow,
): SessionsRecentUsage {
  const windowStart = now - windowMs
  const counters: Partial<Record<HarnessUsageCounterName, number>> = {}
  let exactCoverageMs = 0
  let partialCoverageMs = 0
  let resetBoundary = false
  let arithmeticInvalid = false
  const samples = history?.samples ?? []
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1]
    const current = samples[index]
    if (!previous || !current || current.sampledAt <= windowStart) continue
    const clippedStart = Math.max(previous.sampledAt, windowStart)
    const clippedEnd = Math.min(current.sampledAt, now)
    if (clippedEnd <= clippedStart) continue
    const delta = comparableUsageDelta(previous, current)
    if (!delta) {
      if (
        current.usage.status === 'reset' ||
        countersDecrease(previous.usage, current.usage)
      ) {
        resetBoundary = true
      }
      continue
    }
    const intervalMs = clippedEnd - clippedStart
    if (delta.exact) exactCoverageMs += intervalMs
    else partialCoverageMs += intervalMs
    for (const name of HARNESS_USAGE_TOKEN_COUNTER_NAMES) {
      const value = delta.value[name]
      if (value !== undefined) {
        const next = safeUsageSum(counters[name] ?? 0, value)
        if (next === undefined) arithmeticInvalid = true
        else counters[name] = next
      }
    }
  }
  const complete = exactCoverageMs >= windowMs && !arithmeticInvalid
  let normalizedTokenTotal: number | undefined = complete ? 0 : undefined
  for (const name of HARNESS_USAGE_ADDITIVE_TOKEN_COUNTER_NAMES) {
    if (normalizedTokenTotal === undefined) break
    normalizedTokenTotal = safeUsageSum(normalizedTokenTotal, counters[name] ?? 0)
  }
  const observedMs = Math.min(windowMs, exactCoverageMs + partialCoverageMs)
  const observedTokenSubtotal = knownAdditiveTokenSubtotal(counters)
  return {
    value: {
      ...counters,
      ...(normalizedTokenTotal === undefined ? {} : { normalizedTokenTotal }),
    },
    ...(observedTokenSubtotal === undefined ? {} : { observedTokenSubtotal }),
    coverage: resetBoundary
      ? 'reset'
      : complete
        ? 'complete'
        : observedMs > 0
          ? 'partial'
          : 'none',
    coveragePercent: Math.min(100, Math.floor((observedMs / windowMs) * 100)),
    lastActivityAt: history?.lastActivityAt,
  }
}

export function knownAdditiveTokenSubtotal(value: HarnessUsageValue): number | undefined {
  let subtotal = 0
  let observed = false
  for (const name of HARNESS_USAGE_ADDITIVE_TOKEN_COUNTER_NAMES) {
    const counter = value[name]
    if (counter === undefined) continue
    observed = true
    const next = safeUsageSum(subtotal, counter)
    if (next === undefined) return undefined
    subtotal = next
  }
  return observed ? subtotal : undefined
}

export function rankSessionsUsage(
  rows: readonly SessionsProjectionRow[],
  facts: ReadonlyMap<SessionsTerminalHandle, SessionsUsageFact>,
  histories: ReadonlyMap<SessionsTerminalHandle, SessionsUsageHistory>,
  mode: SessionsUsageMode,
  windowMs: SessionsUsageWindow,
  now: number,
): readonly SessionsUsageRankedRow[] {
  const stableOrder = new Map(rows.map((row, index) => [row.handle, index]))
  const ranked = rows.map((row) => {
    const usage = facts.get(row.handle) ?? row.usage
    const recent = recentSessionsUsage(histories.get(row.handle), now, windowMs)
    const rankValue =
      mode === 'recent'
        ? recent.coverage === 'complete'
          ? recent.value.normalizedTokenTotal
          : undefined
        : usage.status === 'exact'
          ? usage.value.normalizedTokenTotal
          : undefined
    return { row, usage, recent, rankValue }
  })
  ranked.sort((left, right) => {
    if (left.rankValue !== undefined && right.rankValue !== undefined) {
      if (left.rankValue !== right.rankValue) return right.rankValue - left.rankValue
      if (mode === 'recent') {
        const leftTotal = exactCumulativeTotal(left.usage)
        const rightTotal = exactCumulativeTotal(right.usage)
        if (leftTotal !== rightTotal) return rightTotal - leftTotal
      }
    } else if (left.rankValue !== undefined) return -1
    else if (right.rankValue !== undefined) return 1
    else {
      const status = usageStatusOrder(left.usage) - usageStatusOrder(right.usage)
      if (status !== 0) return status
    }
    return (
      (stableOrder.get(left.row.handle) ?? 0) - (stableOrder.get(right.row.handle) ?? 0)
    )
  })
  let numericRank = 0
  return ranked.map((entry) => ({
    ...entry,
    ...(entry.rankValue === undefined ? {} : { rank: (numericRank += 1) }),
  }))
}

function comparableUsageDelta(
  previous: SessionsUsageSample,
  current: SessionsUsageSample,
): { readonly exact: boolean; readonly value: HarnessUsageValue } | undefined {
  if (
    current.sampledAt - previous.sampledAt > SESSIONS_USAGE_MAX_SAMPLE_INTERVAL_MS ||
    !comparableFact(previous.usage) ||
    !comparableFact(current.usage) ||
    countersDecrease(previous.usage, current.usage)
  ) {
    return undefined
  }
  const value: Partial<Record<HarnessUsageCounterName, number>> = {}
  for (const name of HARNESS_USAGE_TOKEN_COUNTER_NAMES) {
    const before = previous.usage.value[name]
    const after = current.usage.value[name]
    if (before !== undefined && after !== undefined) value[name] = after - before
  }
  const exact = previous.usage.status === 'exact' && current.usage.status === 'exact'
  return {
    exact,
    value: {
      ...value,
      ...(exact &&
      previous.usage.value.normalizedTokenTotal !== undefined &&
      current.usage.value.normalizedTokenTotal !== undefined
        ? {
            normalizedTokenTotal:
              current.usage.value.normalizedTokenTotal -
              previous.usage.value.normalizedTokenTotal,
          }
        : {}),
    },
  }
}

function comparableFact(
  fact: SessionsUsageFact,
): fact is Extract<SessionsUsageFact, { readonly status: 'exact' | 'partial' }> {
  return fact.status === 'exact' || fact.status === 'partial'
}

function countersDecrease(
  previous: SessionsUsageFact,
  current: SessionsUsageFact,
): boolean {
  if (!comparableFact(previous) || !comparableFact(current)) return false
  return HARNESS_USAGE_TOKEN_COUNTER_NAMES.some((name) => {
    const before = previous.value[name]
    const after = current.value[name]
    return before !== undefined && after !== undefined && after < before
  })
}

function positiveUsage(value: HarnessUsageValue): boolean {
  return HARNESS_USAGE_TOKEN_COUNTER_NAMES.some((name) => (value[name] ?? 0) > 0)
}

function safeUsageSum(left: number, right: number): number | undefined {
  const value = left + right
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function exactCumulativeTotal(fact: SessionsUsageFact): number {
  return fact.status === 'exact' ? (fact.value.normalizedTokenTotal ?? 0) : -1
}

function usageStatusOrder(fact: SessionsUsageFact): number {
  switch (fact.status) {
    case 'partial':
      return 0
    case 'stale':
      return 1
    case 'reset':
      return 2
    case 'pending':
      return 3
    case 'unavailable':
      return 4
    case 'unsupported':
      return 5
    case 'exact':
      return -1
  }
}
