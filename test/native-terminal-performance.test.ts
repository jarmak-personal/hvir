import { afterEach, describe, expect, it, vi } from 'vitest'

import { CAPACITY_PERFORMANCE_GATE_ENV } from '../src/main/smoke/capacity-performance'
import {
  enforceNativeWorkbenchPerformance,
  nativeWorkbenchPerformanceEvidence,
  nativeWorkbenchPerformanceMode,
  type NativeWorkbenchPerformanceLoop,
  type NativeWorkbenchPerformanceMode,
  type NativeWorkbenchPerformancePhase,
  type NativeWorkbenchPerformanceEvidence,
} from '../src/main/smoke/native-terminal-performance'

const observed = (maximumMs: number): NativeWorkbenchPerformanceLoop => ({
  loop: 'renderer',
  samples: 2,
  minimumSamples: 2,
  maximumMs,
})
afterEach(() => vi.unstubAllEnvs())

describe('native workbench performance qualification policy', () => {
  it('uses the existing capacity selector without accepting an additional mode spelling', () => {
    vi.stubEnv(CAPACITY_PERFORMANCE_GATE_ENV, undefined)
    expect(nativeWorkbenchPerformanceMode()).toBe('evidence')
    vi.stubEnv(CAPACITY_PERFORMANCE_GATE_ENV, '')
    expect(nativeWorkbenchPerformanceMode()).toBe('evidence')
    vi.stubEnv(CAPACITY_PERFORMANCE_GATE_ENV, 'controlled')
    expect(nativeWorkbenchPerformanceMode()).toBe('controlled')
    for (const value of ['evidence', '1', 'CONTROLLED']) {
      vi.stubEnv(CAPACITY_PERFORMANCE_GATE_ENV, value)
      expect(() => nativeWorkbenchPerformanceMode()).toThrow(
        /must be unset or exactly 'controlled'/,
      )
    }
  })

  it.each(['evidence', 'controlled'] as const)(
    'keeps the inclusive 500 ms boundary in %s mode',
    (mode) => {
      const loops = [observed(500)]
      const evidence = nativeWorkbenchPerformanceEvidence(mode, 'query', loops)
      expect(evidence).toEqual({
        mode,
        phase: 'query',
        maximumInclusiveMs: 500,
        loops,
        violations: [],
      })
      expect(evidence.loops).not.toBe(loops)
      expect(() => enforceNativeWorkbenchPerformance(evidence)).not.toThrow()
    },
  )

  it('reports exact crossings in evidence mode and fails those same observations in controlled mode', () => {
    const loops = [
      { loop: 'main' as const, samples: 1, minimumSamples: 1 as const, maximumMs: 500.1 },
      { ...observed(518.5000000000001), minimumSamples: 1 as const },
    ]
    const evidence = nativeWorkbenchPerformanceEvidence('evidence', 'selection', loops)
    expect(evidence.loops).toEqual(loops)
    expect(evidence.loops[0]).not.toBe(loops[0])
    expect(evidence.loops[1]).not.toBe(loops[1])
    expect(evidence.violations).toEqual([
      { loop: 'main', actualMs: 500.1, maximumInclusiveMs: 500 },
      { loop: 'renderer', actualMs: 518.5000000000001, maximumInclusiveMs: 500 },
    ])
    expect(() => enforceNativeWorkbenchPerformance(evidence)).not.toThrow()
    const controlled = nativeWorkbenchPerformanceEvidence(
      'controlled',
      'selection',
      loops,
    )
    expect(controlled.violations).toEqual(evidence.violations)
    expect(() => enforceNativeWorkbenchPerformance(controlled)).toThrow(
      /main 500.1 > 500/,
    )
  })

  it.each([
    ['query', [observed(0)]],
    ['readonly-query', [observed(0)]],
    [
      'selection',
      [
        { ...observed(0), loop: 'main', minimumSamples: 1 },
        { ...observed(0), minimumSamples: 1 },
      ],
    ],
    ['readonly-selection', [observed(0)]],
    ['effects', [{ ...observed(0), loop: 'main' }, observed(0)]],
    ['paste-unicode', [{ ...observed(0), minimumSamples: 1 }]],
    ['paste-lnm', [{ ...observed(0), minimumSamples: 1 }]],
  ] satisfies [NativeWorkbenchPerformancePhase, NativeWorkbenchPerformanceLoop[]][])(
    'retains the exact phase loop policy for %s',
    (phase, loops) => {
      const result = nativeWorkbenchPerformanceEvidence('evidence', phase, loops)
      expect(result.phase).toBe(phase)
      expect(result.loops).toEqual(loops)
      expect(result.violations).toEqual([])
      for (const mode of ['evidence', 'controlled'] as const) {
        const changedMinimum = loops.map((value, index) =>
          index === 0
            ? {
                ...value,
                minimumSamples: value.minimumSamples === 1 ? (2 as const) : (1 as const),
              }
            : value,
        )
        expect(() =>
          nativeWorkbenchPerformanceEvidence(mode, phase, changedMinimum),
        ).toThrow(/observation-invalid/)
      }
    },
  )

  it('preserves the supplied controlled failure identity without throwing it in evidence mode', () => {
    const failure = new Error('existing rich phase failure')
    const loops = [observed(500.1)]
    expect(() =>
      enforceNativeWorkbenchPerformance(
        nativeWorkbenchPerformanceEvidence('evidence', 'query', loops),
        failure,
      ),
    ).not.toThrow()
    let caught: unknown
    try {
      enforceNativeWorkbenchPerformance(
        nativeWorkbenchPerformanceEvidence('controlled', 'query', loops),
        failure,
      )
    } catch (error) {
      caught = error
    }
    expect(caught).toBe(failure)
    expect(() =>
      enforceNativeWorkbenchPerformance(
        nativeWorkbenchPerformanceEvidence('controlled', 'query', [observed(500)]),
        failure,
      ),
    ).not.toThrow()
  })

  it.each(['evidence', 'controlled'] as const)(
    'rejects malformed observations in %s mode',
    (mode) => {
      const invalid = [
        { ...observed(1), samples: -1 },
        { ...observed(1), samples: 0 },
        { ...observed(1), samples: 1 },
        { ...observed(1), samples: 1.5 },
        { ...observed(1), samples: NaN },
        { ...observed(1), samples: Infinity },
        { ...observed(1), samples: 1e20 },
        { ...observed(1), samples: undefined },
        { ...observed(1), minimumSamples: 0 },
        { ...observed(1), minimumSamples: 3 },
        { ...observed(1), minimumSamples: undefined },
        { ...observed(1), maximumMs: NaN },
        { ...observed(1), maximumMs: Infinity },
        { ...observed(1), maximumMs: -0.1 },
        { ...observed(1), maximumMs: undefined },
        { ...observed(1), loop: 'gpu' },
        undefined,
      ]
      for (const value of invalid)
        expect(() =>
          nativeWorkbenchPerformanceEvidence(mode, 'query', [
            value,
          ] as unknown as NativeWorkbenchPerformanceLoop[]),
        ).toThrow(/observation-invalid/)
      expect(() => nativeWorkbenchPerformanceEvidence(mode, 'effects', [])).toThrow(
        /loops-invalid/,
      )
      expect(() =>
        nativeWorkbenchPerformanceEvidence(
          mode,
          'effects',
          undefined as unknown as NativeWorkbenchPerformanceLoop[],
        ),
      ).toThrow(/loops-invalid/)
      expect(() =>
        nativeWorkbenchPerformanceEvidence(mode, 'effects', [observed(1), observed(2)]),
      ).toThrow(/observation-invalid/)
      expect(() =>
        nativeWorkbenchPerformanceEvidence(
          mode,
          'unknown' as NativeWorkbenchPerformancePhase,
          [observed(1)],
        ),
      ).toThrow(/phase-invalid/)
    },
  )

  it('rejects unknown mode values instead of treating them as non-gating evidence', () => {
    for (const mode of ['unknown', undefined, ''])
      expect(() =>
        nativeWorkbenchPerformanceEvidence(
          mode as NativeWorkbenchPerformanceMode,
          'query',
          [observed(1)],
        ),
      ).toThrow(/mode-invalid/)
  })

  it('does not mutate frozen or repeated observations during reporting and enforcement', () => {
    const loops = Object.freeze([Object.freeze(observed(500.1))])
    const before = JSON.stringify(loops)
    const first = nativeWorkbenchPerformanceEvidence('evidence', 'query', loops)
    enforceNativeWorkbenchPerformance(first)
    const second = nativeWorkbenchPerformanceEvidence('evidence', 'query', loops)
    expect(second).toEqual(first)
    expect(second.loops).not.toBe(loops)
    expect(JSON.stringify(loops)).toBe(before)
    expect(second.violations[0]!.actualMs).toBe(500.1)
  })

  it.each(['evidence', 'controlled'] as const)(
    'rejects missing, extra and duplicate phase loops in %s mode',
    (mode) => {
      const main = { ...observed(1), loop: 'main' as const }
      expect(() => nativeWorkbenchPerformanceEvidence(mode, 'effects', [main])).toThrow(
        /loops-invalid/,
      )
      expect(() =>
        nativeWorkbenchPerformanceEvidence(mode, 'query', [main, observed(1)]),
      ).toThrow(/loops-invalid/)
      expect(() =>
        nativeWorkbenchPerformanceEvidence(mode, 'effects', [main, main]),
      ).toThrow(/observation-invalid/)
    },
  )

  it.each(['evidence', 'controlled'] as const)(
    'rejects raised budgets and omitted or forged violations in %s mode',
    (mode) => {
      const crossing = nativeWorkbenchPerformanceEvidence(mode, 'query', [
        observed(500.1),
      ])
      const quiet = nativeWorkbenchPerformanceEvidence(mode, 'query', [observed(1)])
      const invalid = [
        { ...crossing, maximumInclusiveMs: 501 },
        { ...crossing, violations: [] },
        { ...crossing, violations: undefined },
        {
          ...crossing,
          violations: [{ loop: 'renderer', actualMs: 501, maximumInclusiveMs: 500 }],
        },
        {
          ...crossing,
          violations: [{ loop: 'renderer', actualMs: 500.1, maximumInclusiveMs: 501 }],
        },
        { ...quiet, violations: crossing.violations },
      ]
      for (const evidence of invalid)
        expect(() =>
          enforceNativeWorkbenchPerformance(
            evidence as NativeWorkbenchPerformanceEvidence,
          ),
        ).toThrow(/evidence-invalid/)
    },
  )

  it.each(['evidence', 'controlled'] as const)(
    'snapshots closed scalar records before caller mutation in %s mode',
    (mode) => {
      const input = { ...observed(500.1), extra: 'fixture-only' }
      const evidence = nativeWorkbenchPerformanceEvidence(mode, 'query', [input])
      input.maximumMs = 0
      input.samples = 0
      input.minimumSamples = 1
      input.loop = 'main'
      expect(evidence.loops).toEqual([observed(500.1)])
      expect(Object.keys(evidence.loops[0]!)).toEqual([
        'loop',
        'samples',
        'minimumSamples',
        'maximumMs',
      ])
      expect(evidence.violations).toEqual([
        { loop: 'renderer', actualMs: 500.1, maximumInclusiveMs: 500 },
      ])
      if (mode === 'controlled')
        expect(() => enforceNativeWorkbenchPerformance(evidence)).toThrow(/500.1 > 500/)
      else expect(() => enforceNativeWorkbenchPerformance(evidence)).not.toThrow()
    },
  )
})
