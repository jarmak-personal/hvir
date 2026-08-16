import { describe, expect, it } from 'vitest'

import { isProofHarnessUsageSnapshot } from '../scripts/prove-harness-usage-runner.mts'
import {
  AGENT_WORK_TOKEN_COUNTER_NAMES,
  HARNESS_USAGE_UNAVAILABLE_REASONS,
} from '../src/shared'

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

  it('admits every shared counter and unavailable reason without a proof-local vocabulary', () => {
    expect(
      isProofHarnessUsageSnapshot({
        ...snapshot,
        counters: Object.fromEntries(
          AGENT_WORK_TOKEN_COUNTER_NAMES.map((name) => [name, 1]),
        ),
      }),
    ).toBe(true)

    for (const reason of HARNESS_USAGE_UNAVAILABLE_REASONS) {
      expect(
        isProofHarnessUsageSnapshot({
          version: 1,
          status: 'unavailable',
          providerId: 'codex',
          observedAt: 10,
          reason,
        }),
      ).toBe(true)
    }
  })
})
