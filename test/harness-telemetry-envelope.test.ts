import { describe, expect, it } from 'vitest'

import {
  asHarnessProviderId,
  boundedHarnessProviderData,
  contextHarnessSnapshot,
} from '../src/shared'

describe('HarnessSnapshot envelope', () => {
  it('carries provenance, freshness, and explicit unsupported facets', () => {
    const snapshot = contextHarnessSnapshot({
      providerId: asHarnessProviderId('fixture'),
      provenance: 'bounded session artifact',
      context: { usedTokens: 12, windowTokens: 100, usedPercent: 12 },
      sessionId: 'session-1',
      modelId: 'model-1',
      observedAt: 42,
    })

    expect(snapshot).toMatchObject({
      version: 1,
      observedAt: 42,
      source: {
        providerId: 'fixture',
        kind: 'session-artifact',
        provenance: 'bounded session artifact',
      },
      freshness: { state: 'live', staleAfterMs: 30_000 },
      facets: {
        session: { status: 'available' },
        model: { status: 'available' },
        context: { status: 'available' },
        usage: { status: 'unsupported' },
        turn: { status: 'unsupported' },
        integrations: { status: 'unsupported' },
      },
    })
  })

  it('accepts only bounded serializable namespaced provider data', () => {
    expect(
      boundedHarnessProviderData({
        'fixture.example': { state: 'ready', counters: [1, 2, 3] },
      }),
    ).toEqual({
      'fixture.example': { state: 'ready', counters: [1, 2, 3] },
    })
    expect(boundedHarnessProviderData({ value: Number.NaN })).toBeUndefined()
    expect(boundedHarnessProviderData({ value: 'x'.repeat(4_097) })).toBeUndefined()

    let tooDeep: unknown = 'leaf'
    for (let depth = 0; depth < 10; depth++) tooDeep = { child: tooDeep }
    expect(boundedHarnessProviderData({ tooDeep })).toBeUndefined()
  })
})
