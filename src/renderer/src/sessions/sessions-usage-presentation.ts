import type { HarnessUsageValue, SessionsUsageFact } from '../../../shared'
import {
  knownAdditiveTokenSubtotal,
  type SessionsUsageMode,
  type SessionsUsageRankedRow,
} from './sessions-usage-model'

export interface SessionsUsagePrimaryPresentation {
  readonly compact: string
  readonly accessible: string
  readonly barScale?: 'ranked' | 'observed'
  readonly barValue: number
}

export function usageValue(fact: SessionsUsageFact): HarnessUsageValue {
  return fact.status === 'exact' || fact.status === 'partial' || fact.status === 'stale'
    ? fact.value
    : {}
}

export function recentLabel(entry: SessionsUsageRankedRow, windowMs: number): string {
  const total = entry.recent.value.normalizedTokenTotal
  if (total !== undefined) {
    return total === 0
      ? `No activity in ${durationLabel(windowMs)}`
      : `${total.toLocaleString()} tokens in ${durationLabel(windowMs)}`
  }
  if (
    entry.recent.observedTokenSubtotal !== undefined &&
    entry.recent.coverage !== 'none'
  ) {
    return `${entry.recent.observedTokenSubtotal.toLocaleString()} observed tokens · ${coverageLabel(entry.recent.coverage).toLowerCase()} · exact Recent total unavailable`
  }
  if (entry.recent.coverage === 'none') {
    return 'Baseline only · exact Recent total unavailable'
  }
  return `${coverageLabel(entry.recent.coverage)} observation · exact total unavailable`
}

export function cumulativeLabel(fact: SessionsUsageFact): string {
  if (fact.status === 'exact') {
    return `${fact.value.normalizedTokenTotal?.toLocaleString()} tokens`
  }
  if (fact.status === 'partial') return 'Partial categories · exact total unavailable'
  if (fact.status === 'stale') return 'Stale cumulative observation'
  return `${sentenceCase(fact.status)} · ${'reason' in fact ? sentenceCase(fact.reason) : 'capability state'}`
}

export function freshnessLabel(fact: SessionsUsageFact, sampledAt: number): string {
  if (fact.status === 'exact' || fact.status === 'partial' || fact.status === 'stale') {
    return `${sentenceCase(fact.status)} · observed ${relativeAge(fact.observedAt, sampledAt)}`
  }
  return sentenceCase(fact.status)
}

export function primaryUsage(
  entry: SessionsUsageRankedRow,
  mode: SessionsUsageMode,
  windowMs: number,
): SessionsUsagePrimaryPresentation {
  const rankedValue = entry.rankValue
  if (rankedValue !== undefined) {
    return {
      compact:
        mode === 'recent' && rankedValue === 0
          ? 'No activity'
          : compactNumber(rankedValue),
      accessible: `${entry.rank === undefined ? '' : `Rank ${entry.rank}; `}${rankedValue.toLocaleString()} tokens ${
        mode === 'recent' ? `in the last ${durationLabel(windowMs)}` : 'for this session'
      }`,
      ...(rankedValue > 0 ? { barScale: 'ranked' as const } : {}),
      barValue: rankedValue,
    }
  }
  if (mode === 'recent') {
    const observed = entry.recent.observedTokenSubtotal
    if (observed !== undefined && entry.recent.coverage !== 'none') {
      return {
        compact: observed > 0 ? `${compactNumber(observed)} observed` : 'Partial',
        accessible: `${observed.toLocaleString()} observed tokens in the last ${durationLabel(windowMs)}; ${coverageLabel(entry.recent.coverage).toLowerCase()}; exact Recent total unavailable; unranked`,
        ...(observed > 0 ? { barScale: 'observed' as const } : {}),
        barValue: observed,
      }
    }
    if (entry.recent.coverage === 'none' && comparableUsage(entry.usage)) {
      const cumulative = knownAdditiveTokenSubtotal(entry.usage.value)
      const cumulativeDescription =
        entry.usage.status === 'exact' &&
        entry.usage.value.normalizedTokenTotal !== undefined
          ? `; exact cumulative total is ${entry.usage.value.normalizedTokenTotal.toLocaleString()} tokens and is shown separately`
          : cumulative === undefined
            ? ''
            : `; cumulative observation contains ${cumulative.toLocaleString()} known tokens`
      return {
        compact: 'Baseline',
        accessible: `Recent baseline only; exact Recent total unavailable; unranked${cumulativeDescription}`,
        barValue: 0,
      }
    }
    return {
      compact:
        entry.recent.coverage === 'reset' ? 'Reset' : sentenceCase(entry.usage.status),
      accessible: `${sentenceCase(entry.usage.status)} usage; exact Recent total unavailable; unranked`,
      barValue: 0,
    }
  }
  const cumulative = comparableUsage(entry.usage)
    ? knownAdditiveTokenSubtotal(entry.usage.value)
    : undefined
  return {
    compact:
      cumulative === undefined
        ? sentenceCase(entry.usage.status)
        : `${compactNumber(cumulative)} known`,
    accessible:
      cumulative === undefined
        ? `${sentenceCase(entry.usage.status)} usage; not ranked`
        : `${cumulative.toLocaleString()} known cumulative tokens; ${sentenceCase(entry.usage.status)} total; exact session total unavailable; unranked`,
    barValue: 0,
  }
}

export function usageStatus(
  status: 'inactive' | 'pending' | 'available' | 'unavailable',
  sampledAt: number,
  mode: SessionsUsageMode,
  entries: readonly SessionsUsageRankedRow[],
): string {
  if (status === 'pending') return 'Newly observing; the first exact value is a baseline.'
  if (status === 'unavailable') return 'Usage observation is currently unavailable.'
  if (status === 'inactive') return 'Usage observation is inactive.'
  if (mode === 'session-total') {
    return `Exact cumulative totals are ranked; partial and unavailable totals remain unranked · updated ${relativeAge(sampledAt, Date.now())}`
  }
  const complete = entries.filter((entry) => entry.recent.coverage === 'complete').length
  const observed = entries.some(
    (entry) =>
      entry.recent.coverage !== 'complete' &&
      entry.recent.observedTokenSubtotal !== undefined,
  )
  if (complete > 0) {
    return `Complete Recent windows are ranked; partial observations remain unranked and cumulative totals stay separate · updated ${relativeAge(sampledAt, Date.now())}`
  }
  if (observed) {
    return `Recent observations are partial; observed subtotals are shown without ranks and cumulative totals stay separate · updated ${relativeAge(sampledAt, Date.now())}`
  }
  return `Recent is establishing baselines; cumulative totals may already be exact and are shown separately · updated ${relativeAge(sampledAt, Date.now())}`
}

export function compactState(
  entry: SessionsUsageRankedRow,
  mode: SessionsUsageMode,
  windowMs: number,
  sampledAt: number,
): string {
  const coverage = `${coverageLabel(entry.recent.coverage)} · ${entry.recent.coveragePercent}% of ${durationLabel(windowMs)}`
  const freshness = comparableUsage(entry.usage)
    ? ` · Cumulative freshness: ${freshnessLabel(entry.usage, sampledAt)}`
    : ''
  const activity =
    entry.recent.lastActivityAt === undefined
      ? ''
      : ` · Last activity: ${relativeAge(entry.recent.lastActivityAt, sampledAt)}`
  return mode === 'recent'
    ? `Recent: ${recentLabel(entry, windowMs)} · Coverage: ${coverage} · Session total: ${cumulativeLabel(entry.usage)}${freshness}${activity}`
    : `Session total: ${cumulativeLabel(entry.usage)}${freshness} · Recent coverage: ${coverage}${activity}`
}

export function hasPositiveCategories(value: HarnessUsageValue): boolean {
  return (knownAdditiveTokenSubtotal(value) ?? 0) > 0
}

export function counterLabel(value: number | undefined): string {
  return value === undefined ? 'Unavailable' : `${value.toLocaleString()} tokens`
}

export function coverageLabel(
  value: SessionsUsageRankedRow['recent']['coverage'],
): string {
  switch (value) {
    case 'complete':
      return 'Complete coverage'
    case 'partial':
      return 'Partial coverage'
    case 'none':
      return 'No current coverage'
    case 'reset':
      return 'Reset boundary'
  }
}

export function durationLabel(milliseconds: number): string {
  const minutes = milliseconds / 60_000
  return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`
}

export function relativeAge(then: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - then) / 1_000))
  if (seconds < 2) return 'just now'
  if (seconds < 60) return `${seconds} seconds ago`
  const minutes = Math.floor(seconds / 60)
  return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`
}

function comparableUsage(
  fact: SessionsUsageFact,
): fact is Extract<
  SessionsUsageFact,
  { readonly status: 'exact' | 'partial' | 'stale' }
> {
  return fact.status === 'exact' || fact.status === 'partial' || fact.status === 'stale'
}

function compactNumber(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: 'compact' }).format(value)
}

function sentenceCase(value: string): string {
  const spaced = value.replaceAll('-', ' ')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}
