import { describe, expect, it } from 'vitest'

import { isProofHarnessUsageSnapshot } from '../scripts/prove-harness-usage-runner.mts'

describe('harness usage proof input', () => {
  const snapshot = {
    version: 1,
    status: 'available',
    providerId: 'codex',
    observedAt: 10,
    route: { modelId: 'gpt-test', reasoningEffort: 'high' },
    counters: { outputTokens: 1 },
    timing: {},
  }

  it('accepts only the exact content-free snapshot schema', () => {
    expect(isProofHarnessUsageSnapshot(snapshot)).toBe(true)
    expect(
      isProofHarnessUsageSnapshot({ ...snapshot, sessionId: 'private-session' }),
    ).toBe(false)
    expect(
      isProofHarnessUsageSnapshot({
        ...snapshot,
        counters: { outputTokens: -1 },
      }),
    ).toBe(false)
  })
})
