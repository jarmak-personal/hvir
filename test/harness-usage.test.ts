import { describe, expect, it } from 'vitest'

import {
  harnessUsageValue,
  normalizedHarnessUsageTotal,
  usageObservationHarnessTelemetry,
  usageCountersDecreased,
} from '../src/main/harness/harness-usage'
import { asHarnessProviderId } from '../src/shared'

describe('provider-neutral harness usage arithmetic', () => {
  it('publishes an exact safe total from all additive categories only', () => {
    expect(
      harnessUsageValue({
        freshInputTokens: 10,
        cacheReadInputTokens: 20,
        cacheWriteInputTokens: 30,
        outputTokens: 40,
        reasoningTokens: 35,
      }),
    ).toEqual({
      status: 'exact',
      value: {
        freshInputTokens: 10,
        cacheReadInputTokens: 20,
        cacheWriteInputTokens: 30,
        outputTokens: 40,
        reasoningTokens: 35,
        normalizedTokenTotal: 100,
      },
    })
  })

  it('keeps known categories partial without substituting zero', () => {
    expect(harnessUsageValue({ freshInputTokens: 10, outputTokens: 4 })).toEqual({
      status: 'partial',
      value: { freshInputTokens: 10, outputTokens: 4 },
    })
  })

  it('omits an unsafe total while retaining safe category values', () => {
    const counters = {
      freshInputTokens: Number.MAX_SAFE_INTEGER,
      cacheReadInputTokens: 1,
      cacheWriteInputTokens: 0,
      outputTokens: 0,
    }
    expect(normalizedHarnessUsageTotal(counters)).toBeUndefined()
    expect(harnessUsageValue(counters)).toEqual({ status: 'partial', value: counters })
  })

  it('detects only comparable cumulative counter decreases', () => {
    expect(
      usageCountersDecreased(
        { freshInputTokens: 10, reasoningTokens: 4 },
        { freshInputTokens: 9 },
      ),
    ).toBe(true)
    expect(usageCountersDecreased({ freshInputTokens: 10 }, { outputTokens: 1 })).toBe(
      false,
    )
  })

  it('keeps provider session identity out of the content-free usage envelope', () => {
    const sessionId = '019ab123-4567-7890-abcd-ef0123456789'
    const telemetry = usageObservationHarnessTelemetry({
      providerId: asHarnessProviderId('codex'),
      sessionId,
      provenance: 'test',
      counters: {
        freshInputTokens: 1,
        cacheReadInputTokens: 2,
        cacheWriteInputTokens: 3,
        outputTokens: 4,
      },
    })
    expect(telemetry?.facets.session).toEqual({ status: 'unsupported' })
    expect(JSON.stringify(telemetry)).not.toContain(sessionId)
  })
})
