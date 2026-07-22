import { describe, expect, it } from 'vitest'

import {
  isDiagnosticEvidenceDeleteResult,
  isDiagnosticEvidenceState,
  type DiagnosticEvidenceState,
} from '../src/shared'

const durableState: DiagnosticEvidenceState = {
  version: 1,
  availability: 'durable',
  recent: { maxEvents: 256, maxBytes: 248 * 1024 },
  journal: {
    location: '/local/app-data/runtime-diagnostics.jsonl',
    maxSegments: 4,
    maxSegmentBytes: 1024 * 1024,
    retentionHours: 168,
  },
}

describe('diagnostic evidence schema', () => {
  it('accepts only exact bounded evidence state', () => {
    expect(isDiagnosticEvidenceState(durableState)).toBe(true)
    expect(
      isDiagnosticEvidenceState({
        version: 1,
        availability: 'memory-only',
        recent: { maxEvents: 256, maxBytes: 248 * 1024 },
      }),
    ).toBe(true)
    expect(isDiagnosticEvidenceState({ ...durableState, extra: 'leak' })).toBe(false)
    expect(
      isDiagnosticEvidenceState({
        ...durableState,
        journal: { ...durableState.journal, location: '/local/app-data/secret\npath' },
      }),
    ).toBe(false)
    expect(
      isDiagnosticEvidenceState({
        ...durableState,
        recent: { maxEvents: 0, maxBytes: 248 * 1024 },
      }),
    ).toBe(false)
  })

  it('keeps deletion results closed and coupled to a valid state', () => {
    expect(
      isDiagnosticEvidenceDeleteResult({
        ok: true,
        outcome: 'deleted',
        state: durableState,
      }),
    ).toBe(true)
    expect(
      isDiagnosticEvidenceDeleteResult({
        ok: false,
        reason: 'storage-unavailable',
        state: { ...durableState, availability: 'unavailable' },
      }),
    ).toBe(true)
    expect(
      isDiagnosticEvidenceDeleteResult({
        ok: true,
        outcome: 'deleted',
        state: durableState,
        path: durableState.journal?.location,
      }),
    ).toBe(false)
  })
})
