import { describe, expect, it } from 'vitest'

import {
  MAX_SESSIONS_PROJECTION_ROWS,
  asHarnessProviderId,
  asSessionsProjectHandle,
  asSessionsTerminalHandle,
  asSessionsWorkspaceHandle,
  sessionsWorkspaceQualifier,
  type HarnessUsageValue,
  type SessionsProjectionRow,
  type SessionsUsageFact,
} from '../src/shared'
import {
  SESSIONS_USAGE_MAX_SAMPLES_PER_SESSION,
  SESSIONS_USAGE_MAX_TOTAL_SAMPLES,
  appendSessionsUsageSample,
  appendSessionsUsageStateBoundary,
  rankSessionsUsage,
  recentSessionsUsage,
  type SessionsUsageHistory,
} from '../src/renderer/src/sessions/sessions-usage-model'

describe('Sessions usage sampling and ranking policy', () => {
  it('treats the first exact observation as a baseline and reports a complete truthful window', () => {
    let history: SessionsUsageHistory | undefined
    for (let second = 0; second <= 60; second += 10) {
      history = appendSessionsUsageSample(history, {
        sampledAt: second * 1_000,
        usage: exact(second * 2, {
          freshInputTokens: second,
          outputTokens: second,
        }),
      })
    }

    const recent = recentSessionsUsage(history, 60_000, 60_000)
    expect(recent).toMatchObject({
      coverage: 'complete',
      coveragePercent: 100,
      lastActivityAt: 60_000,
      value: {
        freshInputTokens: 60,
        outputTokens: 60,
        normalizedTokenTotal: 120,
      },
    })
  })

  it('does not bridge gaps, stale values, partial intervals, or resets as exact coverage', () => {
    let history = appendSessionsUsageSample(undefined, {
      sampledAt: 0,
      usage: exact(10),
    })
    history = appendSessionsUsageSample(history, {
      sampledAt: 10_000,
      usage: partial({ freshInputTokens: 4 }),
    })
    history = appendSessionsUsageSample(history, {
      sampledAt: 20_000,
      usage: {
        status: 'stale',
        value: usage(14),
        observedAt: 10_000,
        reason: 'source-unavailable',
      },
    })
    history = appendSessionsUsageSample(history, {
      sampledAt: 30_000,
      usage: { status: 'reset', reason: 'source-unavailable' },
    })
    history = appendSessionsUsageSample(history, {
      sampledAt: 40_000,
      usage: exact(3),
    })
    history = appendSessionsUsageSample(history, {
      sampledAt: 50_000,
      usage: exact(5),
    })
    const recent = recentSessionsUsage(history, 60_000, 60_000)

    expect(recent.coverage).toBe('reset')
    expect(recent.coveragePercent).toBeLessThan(100)
    expect(recent.value.normalizedTokenTotal).toBeUndefined()
    expect(recent.value.freshInputTokens).toBe(2)
  })

  it('retains one event boundary without turning exact refreshes into samples', () => {
    const baseline = appendSessionsUsageSample(undefined, {
      sampledAt: 0,
      usage: exact(100),
    })
    expect(
      appendSessionsUsageStateBoundary(baseline, {
        sampledAt: 5_000,
        usage: exact(200),
      }),
    ).toBe(baseline)

    const reset = appendSessionsUsageStateBoundary(baseline, {
      sampledAt: 5_000,
      usage: { status: 'reset', reason: 'source-unavailable' },
    })
    expect(reset?.samples).toHaveLength(2)
    expect(
      appendSessionsUsageStateBoundary(reset, {
        sampledAt: 6_000,
        usage: { status: 'reset', reason: 'source-unavailable' },
      }),
    ).toBe(reset)
  })

  it('ages positive work out to truthful zero without dropping quiet rows', () => {
    let active: SessionsUsageHistory | undefined
    let quiet: SessionsUsageHistory | undefined
    for (let second = 0; second <= 120; second += 10) {
      active = appendSessionsUsageSample(active, {
        sampledAt: second * 1_000,
        usage: exact(second <= 10 ? second : 10),
      })
      quiet = appendSessionsUsageSample(quiet, {
        sampledAt: second * 1_000,
        usage: exact(50),
      })
    }
    const first = row('first')
    const second = row('second')
    const ranking = rankSessionsUsage(
      [first, second],
      new Map([
        [first.handle, exact(10)],
        [second.handle, exact(50)],
      ]),
      new Map([
        [first.handle, active!],
        [second.handle, quiet!],
      ]),
      'recent',
      60_000,
      120_000,
    )

    expect(ranking).toHaveLength(2)
    expect(ranking.map((entry) => entry.rankValue)).toEqual([0, 0])
    expect(ranking[0]?.row.handle).toBe(second.handle)
    expect(ranking[0]?.recent.coverage).toBe('complete')
  })

  it('keeps non-numeric states deterministic and ranks any provider-neutral exact capability', () => {
    const future = row('future-provider')
    const partialRow = row('partial')
    const unsupportedRow = row('unsupported')
    const ranking = rankSessionsUsage(
      [unsupportedRow, future, partialRow],
      new Map([
        [future.handle, exact(100)],
        [partialRow.handle, partial({ outputTokens: 80 })],
        [unsupportedRow.handle, { status: 'unsupported' }],
      ]),
      new Map(),
      'session-total',
      60_000,
      0,
    )

    expect(ranking.map((entry) => [entry.row.handle, entry.rank])).toEqual([
      [future.handle, 1],
      [partialRow.handle, undefined],
      [unsupportedRow.handle, undefined],
    ])
  })

  it('bounds retained samples per session', () => {
    expect(SESSIONS_USAGE_MAX_TOTAL_SAMPLES).toBe(
      MAX_SESSIONS_PROJECTION_ROWS * SESSIONS_USAGE_MAX_SAMPLES_PER_SESSION,
    )
    let history: SessionsUsageHistory | undefined
    for (let index = 0; index < SESSIONS_USAGE_MAX_SAMPLES_PER_SESSION + 30; index += 1) {
      history = appendSessionsUsageSample(history, {
        sampledAt: index + 1,
        usage: exact(index),
      })
    }
    expect(history?.samples).toHaveLength(SESSIONS_USAGE_MAX_SAMPLES_PER_SESSION)
    expect(history?.samples[0]?.sampledAt).toBe(31)
  })
})

function exact(
  total: number,
  counters: Partial<HarnessUsageValue> = {},
): SessionsUsageFact & {
  readonly status: 'exact'
  readonly observedAt: number
  readonly value: HarnessUsageValue
} {
  const freshInputTokens = counters.freshInputTokens ?? total
  const cacheReadInputTokens = counters.cacheReadInputTokens ?? 0
  const cacheWriteInputTokens = counters.cacheWriteInputTokens ?? 0
  const outputTokens = counters.outputTokens ?? 0
  return {
    status: 'exact',
    observedAt: 1,
    value: {
      freshInputTokens,
      cacheReadInputTokens,
      cacheWriteInputTokens,
      outputTokens,
      normalizedTokenTotal:
        freshInputTokens + cacheReadInputTokens + cacheWriteInputTokens + outputTokens,
      ...(counters.reasoningTokens === undefined
        ? {}
        : { reasoningTokens: counters.reasoningTokens }),
    },
  }
}

function partial(value: HarnessUsageValue): SessionsUsageFact {
  return { status: 'partial', observedAt: 1, value }
}

function usage(total: number): HarnessUsageValue {
  return exact(total).value
}

function row(id: string): SessionsProjectionRow {
  const unsupported = { status: 'unsupported' as const }
  return {
    handle: asSessionsTerminalHandle(id),
    project: { id: asSessionsProjectHandle('project'), name: 'Project' },
    workspace: {
      id: asSessionsWorkspaceHandle('workspace'),
      name: 'main',
      main: true,
      qualifier: sessionsWorkspaceQualifier(1, 0, 0),
    },
    host: {
      id: 'local',
      label: 'Local',
      kind: 'local',
      connectionState: 'connected',
    },
    provider: {
      id: asHarnessProviderId('future-trusted-provider'),
      name: 'Future provider',
      kind: 'agent',
    },
    profile: unsupported,
    title: id,
    lifecycle: 'live',
    connectionState: 'connected',
    attention: unsupported,
    working: unsupported,
    model: unsupported,
    context: unsupported,
    turn: unsupported,
    telemetryFreshness: unsupported,
    usage: { status: 'pending', reason: 'identity-pending' },
  }
}
