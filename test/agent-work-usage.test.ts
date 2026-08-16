import { describe, expect, it } from 'vitest'

import {
  calculateHarnessUsageDelta,
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

  it('omits an unsafe normalized total while retaining exact category deltas', () => {
    const result = calculateHarnessUsageDelta(
      snapshot(10, {
        freshInputTokens: 0,
        cacheReadInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
      }),
      snapshot(20, {
        freshInputTokens: Number.MAX_SAFE_INTEGER,
        cacheReadInputTokens: 1,
        cacheWriteInputTokens: 1,
        outputTokens: 1,
        reasoningTokens: 0,
      }),
    )

    expect(result).toMatchObject({
      status: 'partial',
      counters: {
        freshInputTokens: Number.MAX_SAFE_INTEGER,
        cacheReadInputTokens: 1,
        cacheWriteInputTokens: 1,
        outputTokens: 1,
        reasoningTokens: 0,
      },
      missingCounters: [],
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

  it('calculates an available model or API timing delta', () => {
    expect(
      calculateHarnessUsageDelta(
        snapshot(10, { outputTokens: 1 }, 100),
        snapshot(20, { outputTokens: 2 }, 275),
      ),
    ).toMatchObject({
      status: 'partial',
      timing: { modelOrApiMilliseconds: 175 },
    })
  })

  it('fails the whole delta closed when the timing counter resets', () => {
    expect(
      calculateHarnessUsageDelta(
        snapshot(10, { outputTokens: 1 }, 275),
        snapshot(20, { outputTokens: 2 }, 100),
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
})

function snapshot(
  observedAt: number,
  counters: Extract<HarnessUsageSnapshot, { status: 'available' }>['counters'],
  modelOrApiMilliseconds?: number,
): HarnessUsageSnapshot {
  return {
    version: 1,
    status: 'available',
    providerId: asHarnessProviderId('codex'),
    observedAt,
    route: { modelId: 'gpt-test', reasoningEffort: 'high' },
    counters,
    timing:
      modelOrApiMilliseconds === undefined ? {} : { modelOrApiMilliseconds },
  }
}
