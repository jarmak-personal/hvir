import { describe, expect, it } from 'vitest'

import {
  calculateHarnessUsageDelta,
  isHarnessUsageSnapshot,
  type HarnessUsageSnapshot,
} from '../src/main/harness/agent-work-usage'
import { asHarnessProviderId } from '../src/shared'

describe('agent-work usage delta policy', () => {
  it('keeps categories distinct and excludes reasoning from the normalized total', () => {
    const result = calculateHarnessUsageDelta(
      snapshot(10, {
        freshInputTokens: 100,
        cacheReadInputTokens: 200,
        cacheWriteInputTokens: 30,
        outputTokens: 40,
        reasoningTokens: 10,
      }),
      snapshot(20, {
        freshInputTokens: 110,
        cacheReadInputTokens: 240,
        cacheWriteInputTokens: 35,
        outputTokens: 47,
        reasoningTokens: 13,
      }),
    )

    expect(result).toEqual({
      status: 'complete',
      providerId: 'codex',
      route: {
        start: { modelId: 'gpt-test', reasoningEffort: 'high' },
        end: { modelId: 'gpt-test', reasoningEffort: 'high' },
      },
      counters: {
        freshInputTokens: 10,
        cacheReadInputTokens: 40,
        cacheWriteInputTokens: 5,
        outputTokens: 7,
        reasoningTokens: 3,
      },
      normalizedTokenTotal: 62,
      missingCounters: [],
    })
  })

  it('keeps missing counters absent instead of replacing them with zero', () => {
    const result = calculateHarnessUsageDelta(
      snapshot(10, { freshInputTokens: 4, outputTokens: 1 }),
      snapshot(20, { freshInputTokens: 9, outputTokens: 3 }),
    )

    expect(result).toMatchObject({
      status: 'partial',
      counters: { freshInputTokens: 5, outputTokens: 2 },
      missingCounters: [
        'cacheReadInputTokens',
        'cacheWriteInputTokens',
        'reasoningTokens',
      ],
    })
    expect(result).not.toHaveProperty('normalizedTokenTotal')
  })

  it('fails the whole delta closed when a provider counter resets', () => {
    expect(
      calculateHarnessUsageDelta(
        snapshot(10, { freshInputTokens: 20 }),
        snapshot(20, { freshInputTokens: 2 }),
      ),
    ).toEqual({ status: 'unavailable', reason: 'counter-reset' })
  })

  it('does not combine unavailable or cross-provider snapshots', () => {
    expect(
      calculateHarnessUsageDelta(
        {
          version: 1,
          status: 'unavailable',
          providerId: asHarnessProviderId('codex'),
          observedAt: 10,
          reason: 'artifact-unavailable',
        },
        snapshot(20, { outputTokens: 1 }),
      ),
    ).toEqual({ status: 'unavailable', reason: 'snapshot-unavailable' })
    expect(
      calculateHarnessUsageDelta(snapshot(10, { outputTokens: 1 }), {
        ...snapshot(20, { outputTokens: 2 }),
        providerId: asHarnessProviderId('claude-code'),
      }),
    ).toEqual({ status: 'unavailable', reason: 'provider-mismatch' })
  })

  it('rejects unrecognized snapshot fields before proof output can reuse them', () => {
    expect(isHarnessUsageSnapshot(snapshot(10, { outputTokens: 1 }))).toBe(true)
    expect(
      isHarnessUsageSnapshot({
        ...snapshot(10, { outputTokens: 1 }),
        sessionId: 'private-session',
      }),
    ).toBe(false)
    expect(
      isHarnessUsageSnapshot({
        ...snapshot(10, { outputTokens: 1 }),
        counters: { outputTokens: -1 },
      }),
    ).toBe(false)
  })
})

function snapshot(
  observedAt: number,
  counters: Extract<HarnessUsageSnapshot, { status: 'available' }>['counters'],
): HarnessUsageSnapshot {
  return {
    version: 1,
    status: 'available',
    providerId: asHarnessProviderId('codex'),
    observedAt,
    route: { modelId: 'gpt-test', reasoningEffort: 'high' },
    counters,
    timing: {},
  }
}
