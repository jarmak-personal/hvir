import { describe, expect, it } from 'vitest'
import {
  CAPACITY_TERMINAL_COMPARISON_COUNTS,
  CAPACITY_TERMINAL_COMPARISON_ORDER,
  evaluateCapacityTerminalComparison,
  type CapacityTerminalComparisonClass,
  type CapacityTerminalPassedProcess,
  type CapacityTerminalProcessResult,
} from '../src/main/smoke/capacity-terminal-comparison'

const kinds = Object.keys(
  CAPACITY_TERMINAL_COMPARISON_COUNTS,
) as CapacityTerminalComparisonClass[]
function fixture(): CapacityTerminalPassedProcess[] {
  return CAPACITY_TERMINAL_COMPARISON_ORDER.map((engine, index) => ({
    index,
    pair: Math.floor(index / 2),
    engine,
    status: 'passed',
    observedPresentation: engine === 'web' ? 'web' : 'native-gpu',
    runId: 'controlled-mac-attempt-1',
    processId: `fresh-process-${index}`,
    identity: {
      sourceSha: 'a'.repeat(40),
      configurationSha: 'b'.repeat(64),
      workloadSha: 'c'.repeat(64),
      topologySha: 'd'.repeat(64),
      observationMethod: 'BrowserWindow.capturePage:synthetic-terminal-tag',
      refreshHz: 60,
      rows: 24,
      columns: 80,
      fontSize: 14,
      cssWidth: 816,
      cssHeight: 360,
      backingScale: 2,
    },
    artifact: {
      sha256: (engine === 'web' ? 'e' : 'f').repeat(64),
      coreVersion: engine === 'web' ? '1.3.1' : '1.4.1-dev',
      build: 'ReleaseFast',
    },
    warmups: { scroll: 10, output: 10, echo: 10, resize: 10, workbench: 10 },
    measurements: Object.fromEntries(
      kinds.map((kind) => [
        kind,
        Array.from(
          { length: CAPACITY_TERMINAL_COMPARISON_COUNTS[kind] },
          (_, sequence) => ({
            sequence,
            durationMs: engine === 'web' ? 40 : 20,
            expectedTag: `${kind}:${sequence}`,
            observedTag: `${kind}:${sequence}`,
            expectedGeometry: '80x24:816x360@2',
            observedGeometry: '80x24:816x360@2',
            expectedInputSequence: sequence,
            observedInputSequence: sequence,
          }),
        ),
      ]),
    ) as unknown as CapacityTerminalPassedProcess['measurements'],
    frameGapsMs: [16, 16, 16],
    uiResponsivenessByClass: Object.fromEntries(
      kinds.map((kind) => [
        kind,
        {
          frameGapsMs: [16, 16],
          clickLatenciesMs: [20, 20],
        },
      ]),
    ) as unknown as CapacityTerminalPassedProcess['uiResponsivenessByClass'],
    budgets: {
      idleRendererPlusGpuRatio: 1,
      terminalReadinessP95Ratio: 1,
      terminalReadinessMaxMs: 200,
      responsivenessP99Ms: 20,
      responsivenessMaxMs: 40,
      workingSetGrowthKiB: 1024,
    },
    accounting: {
      idleWholeAppCpu: 1,
      nativeHostCpu: engine === 'native' ? 0.2 : 0,
      nativeHostMemoryKiB: engine === 'native' ? 1024 : 0,
    },
  }))
}
function withClass(
  process: CapacityTerminalPassedProcess,
  kind: CapacityTerminalComparisonClass,
  values: readonly number[],
): CapacityTerminalPassedProcess {
  return {
    ...process,
    measurements: {
      ...process.measurements,
      [kind]: process.measurements[kind].map((sample, index) => ({
        ...sample,
        durationMs: values[index % values.length]!,
      })),
    },
  }
}
function byPair(
  results: readonly CapacityTerminalPassedProcess[],
  kind: CapacityTerminalComparisonClass,
  web: readonly number[],
  native: readonly number[],
) {
  return results.map((process) =>
    withClass(process, kind, [(process.engine === 'web' ? web : native)[process.pair]!]),
  )
}

describe('fixed native terminal paired comparison policy', () => {
  it('allows revisiting content with a distinct observed input/state sequence', () => {
    const samples = fixture().map((process) => ({
      ...process,
      measurements: {
        ...process.measurements,
        scroll: process.measurements.scroll.map((sample) => ({
          ...sample,
          expectedTag: 'cyclic-row',
          observedTag: 'cyclic-row',
        })),
      },
    }))
    expect(evaluateCapacityTerminalComparison(samples).timingPassed).toBe(true)
    const process = samples[0]!
    const scroll = [...process.measurements.scroll]
    scroll[1] = { ...scroll[1]!, expectedInputSequence: 0, observedInputSequence: 0 }
    expect(
      evaluateCapacityTerminalComparison([
        { ...process, measurements: { ...process.measurements, scroll } },
        ...samples.slice(1),
      ]).blockers,
    ).toContain('process-0:scroll:reused-causal-witness')
  })

  it('requires per-class frame evidence while allowing no scheduled clicks in a terminal class', () => {
    const samples = fixture().map((process) => ({
      ...process,
      uiResponsivenessByClass: Object.fromEntries(
        kinds.map((kind) => [
          kind,
          {
            ...process.uiResponsivenessByClass[kind],
            clickLatenciesMs: kind === 'workbench' ? [20] : [],
          },
        ]),
      ) as unknown as CapacityTerminalPassedProcess['uiResponsivenessByClass'],
    }))
    expect(evaluateCapacityTerminalComparison(samples).timingPassed).toBe(true)
    const process = samples[0]!
    expect(
      evaluateCapacityTerminalComparison([
        {
          ...process,
          uiResponsivenessByClass: {
            ...process.uiResponsivenessByClass,
            output: { frameGapsMs: [], clickLatenciesMs: [] },
          },
        },
        ...samples.slice(1),
      ]).timingPassed,
    ).toBe(false)
  })

  it.each([
    [1, 'web', 'observed-presentation-mismatch'],
    [0, 'native-gpu', 'observed-presentation-mismatch'],
    [1, 'native-pixels', 'compatibility-pixels-require-separate-qualification'],
    [1, undefined, 'observed-presentation-mismatch'],
  ] as const)(
    'refuses process %s observed mode %s as a native GPU comparison',
    (index, observedPresentation, reason) => {
      const samples = fixture().map((sample) =>
        sample.index === index ? { ...sample, observedPresentation } : sample,
      )
      const result = evaluateCapacityTerminalComparison(samples)
      expect(result.timingPassed).toBe(false)
      expect(result.blockers).toContain(`process-${index}:${reason}`)
      expect(result.submitted).toBe(samples)
      expect(result.classes).toBeUndefined()
      expect(result.hardwareGpuQualified).toBe(false)
    },
  )

  it('accepts all four counterbalanced pairs while retaining artifact/core confounders and raw results', () => {
    const samples = fixture()
    const result = evaluateCapacityTerminalComparison(samples)
    expect(result.timingPassed).toBe(true)
    expect(result.blockers).toEqual([])
    expect(result.submitted).toBe(samples)
    expect(result.hardwareGpuQualified).toBe(false)
    expect(result.physicalPresentationQualified).toBe(false)
    expect(result.classes?.scroll).toMatchObject({
      webP95sMs: [40, 40, 40, 40],
      nativeP95sMs: [20, 20, 20, 20],
      webMedianP95Ms: 40,
      nativeMedianP95Ms: 20,
      medianPairedImprovementMs: 20,
      webNoiseMs: 0,
      improvedPairs: 4,
    })
  })

  it('uses nearest-rank p95 and the arithmetic middle-pair median', () => {
    let samples = byPair(fixture(), 'scroll', [36, 38, 40, 42], [18, 20, 22, 24])
    samples = samples.map((process) => ({
      ...process,
      measurements: {
        ...process.measurements,
        output: process.measurements.output.map((sample, index) => ({
          ...sample,
          durationMs: index < 190 ? sample.durationMs : 90,
        })),
      },
    }))
    const result = evaluateCapacityTerminalComparison(samples)
    expect(result.classes?.scroll.webMedianP95Ms).toBe(39)
    expect(result.classes?.scroll.nativeMedianP95Ms).toBe(21)
    expect(result.classes?.output.webP95sMs).toEqual([40, 40, 40, 40])
    expect(result.classes?.output.nativeP95sMs).toEqual([20, 20, 20, 20])
  })

  it('keeps the 20% boundary inclusive and the paired 2ms/noise boundary strict', () => {
    let result = evaluateCapacityTerminalComparison(
      byPair(fixture(), 'scroll', [40, 40, 40, 40], [32, 32, 32, 32]),
    )
    expect(result.timingPassed).toBe(true)
    result = evaluateCapacityTerminalComparison(
      byPair(fixture(), 'scroll', [10, 10, 10, 10], [8, 8, 8, 8]),
    )
    expect(result.blockers).toContain('scroll:paired-improvement-within-noise')
    result = evaluateCapacityTerminalComparison(
      byPair(fixture(), 'scroll', [40, 40, 40, 40], [32.001, 32.001, 32.001, 32.001]),
    )
    expect(result.blockers).toContain('scroll:twenty-percent-improvement-missing')
  })

  it('rejects noisy baselines even if medians appear faster', () => {
    const result = evaluateCapacityTerminalComparison(
      byPair(fixture(), 'scroll', [20, 30, 40, 50], [5, 5, 5, 5]),
    )
    expect(result.blockers).toContain('scroll:baseline-not-repeatable')
    expect(result.blockers).toContain('scroll:paired-improvement-within-noise')
  })

  it('requires three improving pairs independently for both primary metrics', () => {
    const result = evaluateCapacityTerminalComparison(
      byPair(fixture(), 'output', [40, 40, 40, 40], [1, 1, 40, 40]),
    )
    expect(result.blockers).toContain('output:fewer-than-three-improving-pairs')
    expect(result.classes?.scroll.improvedPairs).toBe(4)
  })

  it('uses each secondary class own baseline and includes its nonregression boundary', () => {
    let samples = byPair(fixture(), 'echo', [80, 80, 80, 80], [88, 88, 88, 88])
    expect(evaluateCapacityTerminalComparison(samples).timingPassed).toBe(true)
    samples = byPair(samples, 'resize', [20, 20, 20, 20], [25.01, 25.01, 25.01, 25.01])
    expect(evaluateCapacityTerminalComparison(samples).blockers).toContain(
      'resize:secondary-regression',
    )
  })

  it('uses actual display refresh for the one-frame cadence allowance', () => {
    let samples = fixture().map((process) => ({
      ...process,
      identity: { ...process.identity, refreshHz: 120 },
      frameGapsMs: process.engine === 'web' ? [8] : [16.5],
    }))
    expect(evaluateCapacityTerminalComparison(samples).blockers).toContain(
      'frame-gap:more-than-one-recorded-refresh-regression',
    )
    samples = samples.map((process) => ({
      ...process,
      identity: { ...process.identity, refreshHz: 60 },
    }))
    expect(evaluateCapacityTerminalComparison(samples).timingPassed).toBe(true)
  })

  it('preserves a failed or missing process instead of reducing the paired population', () => {
    const samples: CapacityTerminalProcessResult[] = fixture()
    samples[3] = {
      index: 3,
      pair: 1,
      engine: 'web',
      status: 'failed',
      failure: 'process-exit',
    }
    const result = evaluateCapacityTerminalComparison(samples)
    expect(result.blockers).toContain('process-3:process-failed-or-incomplete')
    expect(result.submitted).toBe(samples)
    expect(result.classes).toBeUndefined()
    expect(evaluateCapacityTerminalComparison(samples.slice(0, 7)).timingPassed).toBe(
      false,
    )
  })

  it('rejects bad order, reused processes and inconsistent common/artifact identities', () => {
    const samples = fixture()
    const swapped = [...samples]
    ;[swapped[2], swapped[3]] = [swapped[3]!, swapped[2]!]
    expect(evaluateCapacityTerminalComparison(swapped).blockers).toContain(
      'process-2:scheduled-order-mismatch',
    )
    expect(
      evaluateCapacityTerminalComparison(
        samples.map((process) => ({ ...process, processId: 'reused' })),
      ).timingPassed,
    ).toBe(false)
    const changed = [...samples]
    changed[7] = { ...changed[7]!, identity: { ...changed[7]!.identity, cssWidth: 640 } }
    expect(evaluateCapacityTerminalComparison(changed).blockers).toContain(
      'process-7:candidate-or-configuration-changed',
    )
    changed[7] = {
      ...samples[7]!,
      artifact: { ...samples[7]!.artifact, sha256: '1'.repeat(64) },
    }
    expect(evaluateCapacityTerminalComparison(changed).blockers).toContain(
      'process-7:engine-artifact-changed',
    )
  })

  it.each(['scroll', 'output', 'echo', 'resize', 'workbench'] as const)(
    'rejects lost %s samples, stale pixel/geometry/input witnesses and insufficient warmups',
    (kind) => {
      const samples = fixture()
      const p = samples[0]!
      const change = (measurements: CapacityTerminalPassedProcess['measurements']) =>
        evaluateCapacityTerminalComparison([{ ...p, measurements }, ...samples.slice(1)])
      expect(
        change({ ...p.measurements, [kind]: p.measurements[kind].slice(1) }).timingPassed,
      ).toBe(false)
      for (const bad of [
        { observedTag: 'stale' },
        { observedGeometry: 'old' },
        { observedInputSequence: 999 },
      ]) {
        const updated = [...p.measurements[kind]]
        updated[0] = { ...updated[0]!, ...bad }
        expect(change({ ...p.measurements, [kind]: updated }).timingPassed).toBe(false)
      }
      expect(
        evaluateCapacityTerminalComparison([
          { ...p, warmups: { ...p.warmups, [kind]: 9 } },
          ...samples.slice(1),
        ]).timingPassed,
      ).toBe(false)
    },
  )

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])(
    'rejects nonfinite or negative timing %s',
    (bad) => {
      expect(
        evaluateCapacityTerminalComparison(
          fixture().map((process) => withClass(process, 'scroll', [bad])),
        ).timingPassed,
      ).toBe(false)
    },
  )

  it('rejects ACK-only observation and missing native/whole-app accounting', () => {
    const samples = fixture()
    const process = samples[0]!
    expect(
      evaluateCapacityTerminalComparison([
        { ...process, identity: { ...process.identity, observationMethod: 'ack' } },
        ...samples.slice(1),
      ]).timingPassed,
    ).toBe(false)
    expect(
      evaluateCapacityTerminalComparison([
        { ...process, accounting: undefined },
        ...samples.slice(1),
      ]).timingPassed,
    ).toBe(false)
  })

  it('enforces absolute capacity limits including strict p99 and inclusive max/growth/ratios', () => {
    const samples = fixture().map((process) => ({
      ...process,
      budgets: {
        idleRendererPlusGpuRatio: 1.5,
        terminalReadinessP95Ratio: 2,
        terminalReadinessMaxMs: 1000,
        responsivenessP99Ms: 99.999,
        responsivenessMaxMs: 500,
        workingSetGrowthKiB: 256 * 1024,
      },
    }))
    expect(evaluateCapacityTerminalComparison(samples).timingPassed).toBe(true)
    for (const [key, value] of Object.entries({
      idleRendererPlusGpuRatio: 1.5001,
      terminalReadinessP95Ratio: 2.0001,
      terminalReadinessMaxMs: 1000.001,
      responsivenessP99Ms: 100,
      responsivenessMaxMs: 500.001,
      workingSetGrowthKiB: 256 * 1024 + 1,
    })) {
      const changed = samples.map((process) => ({
        ...process,
        budgets: { ...process.budgets, [key]: value },
      }))
      expect(evaluateCapacityTerminalComparison(changed).blockers).toContain(
        `process-0:capacity:${key}`,
      )
    }
  })

  it('does not apply UI-loop deadlines as new end-to-end operation latency caps', () => {
    let samples = byPair(fixture(), 'resize', [200, 200, 200, 200], [210, 210, 210, 210])
    samples = byPair(samples, 'output', [600, 600, 600, 600], [400, 400, 400, 400])
    expect(evaluateCapacityTerminalComparison(samples).timingPassed).toBe(true)
  })

  it('does not hide raw class UI or cadence stalls behind passing aggregate summaries', () => {
    let samples = fixture()
    samples[1] = {
      ...samples[1]!,
      uiResponsivenessByClass: {
        ...samples[1]!.uiResponsivenessByClass,
        resize: { frameGapsMs: [16, 501], clickLatenciesMs: [20] },
      },
    }
    expect(evaluateCapacityTerminalComparison(samples).blockers).toContain(
      'process-1:resize:responsiveness-maximum',
    )
    samples = fixture()
    samples[1] = { ...samples[1]!, frameGapsMs: [16, 501] }
    expect(evaluateCapacityTerminalComparison(samples).blockers).toContain(
      'process-1:frame-gap:maximum',
    )
  })
})
