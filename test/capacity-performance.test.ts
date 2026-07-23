import { describe, expect, it } from 'vitest'

import {
  capacityPerformanceViolations,
  parseCapacityPerformanceMode,
  type CapacityPerformanceMeasurements,
} from '../src/main/smoke/capacity-performance'

describe('capacity performance verdict policy', () => {
  it('keeps hosted runs evidence-only and requires an explicit controlled mode', () => {
    expect(parseCapacityPerformanceMode(undefined)).toBe('evidence')
    expect(parseCapacityPerformanceMode('')).toBe('evidence')
    expect(parseCapacityPerformanceMode('controlled')).toBe('controlled')
    expect(() => parseCapacityPerformanceMode('1')).toThrow(
      "HVIR_CAPACITY_PERFORMANCE_GATE must be unset or exactly 'controlled'",
    )
    expect(() => parseCapacityPerformanceMode('evidence')).toThrow(
      "HVIR_CAPACITY_PERFORMANCE_GATE must be unset or exactly 'controlled'",
    )
  })

  it('preserves the existing inclusive and exclusive budget boundaries', () => {
    expect(capacityPerformanceViolations(measurements())).toEqual([])
    expect(
      capacityPerformanceViolations(
        measurements({
          responsivenessP99Ms: 100,
          diagnosticFrameP99Ms: 100,
          diagnosticClickP95Ms: 100,
        }),
      ).map((violation) => violation.budget),
    ).toEqual(['responsivenessP99Ms', 'diagnosticFrameP99Ms', 'diagnosticClickP95Ms'])
  })

  it.each([
    ['idleRendererPlusGpuRatio', 1.5001],
    ['terminalReadinessP95Ratio', 2.0001],
    ['terminalReadinessMaxMs', 1_001],
    ['responsivenessMaxMs', 501],
    ['workingSetGrowthKiB', 256 * 1024 + 1],
    ['diagnosticRendererPlusGpuCpuDelta', 1.0001],
    ['diagnosticMemoryGrowthDeltaKiB', 16 * 1024 + 1],
    ['diagnosticFrameMaxMs', 501],
    ['diagnosticClickMaxMs', 501],
  ] as const)(
    'reports a controlled %s crossing without changing the sample',
    (budget, value) => {
      const sample = measurements({ [budget]: value })

      expect(capacityPerformanceViolations(sample)).toEqual([
        expect.objectContaining({ budget, actual: value }),
      ])
      expect(sample[budget]).toBe(value)
    },
  )
})

function measurements(
  overrides: Partial<CapacityPerformanceMeasurements> = {},
): CapacityPerformanceMeasurements {
  return {
    idleRendererPlusGpuRatio: 1.5,
    terminalReadinessP95Ratio: 2,
    terminalReadinessMaxMs: 1_000,
    responsivenessP99Ms: 99.9,
    responsivenessMaxMs: 500,
    workingSetGrowthKiB: 256 * 1024,
    diagnosticRendererPlusGpuCpuDelta: 1,
    diagnosticMemoryGrowthDeltaKiB: 16 * 1024,
    diagnosticFrameP99Ms: 99.9,
    diagnosticFrameMaxMs: 500,
    diagnosticClickP95Ms: 99.9,
    diagnosticClickMaxMs: 500,
    ...overrides,
  }
}
