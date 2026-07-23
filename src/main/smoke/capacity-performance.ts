export const CAPACITY_PERFORMANCE_GATE_ENV = 'HVIR_CAPACITY_PERFORMANCE_GATE'

export const CAPACITY_PERFORMANCE_BUDGETS = {
  idleRendererPlusGpuRatio: 1.5,
  terminalReadinessP95Ratio: 2,
  terminalReadinessMaxMs: 1_000,
  responsivenessP99Ms: 100,
  responsivenessMaxMs: 500,
  workingSetGrowthKiB: 256 * 1024,
  diagnosticRendererPlusGpuCpuDelta: 1,
  diagnosticMemoryGrowthDeltaKiB: 16 * 1024,
  diagnosticFrameP99Ms: 100,
  diagnosticFrameMaxMs: 500,
  diagnosticClickP95Ms: 100,
  diagnosticClickMaxMs: 500,
} as const

export type CapacityPerformanceMode = 'evidence' | 'controlled'

export interface CapacityPerformanceMeasurements {
  readonly idleRendererPlusGpuRatio: number
  readonly terminalReadinessP95Ratio: number
  readonly terminalReadinessMaxMs: number
  readonly responsivenessP99Ms: number
  readonly responsivenessMaxMs: number
  readonly workingSetGrowthKiB: number
  readonly diagnosticRendererPlusGpuCpuDelta: number
  readonly diagnosticMemoryGrowthDeltaKiB: number
  readonly diagnosticFrameP99Ms: number
  readonly diagnosticFrameMaxMs: number
  readonly diagnosticClickP95Ms: number
  readonly diagnosticClickMaxMs: number
}

export type CapacityPerformanceBudget = keyof typeof CAPACITY_PERFORMANCE_BUDGETS

export interface CapacityPerformanceViolation {
  readonly budget: CapacityPerformanceBudget
  readonly actual: number
  readonly limit: number
  readonly comparison: 'greater-than' | 'greater-than-or-equal'
}

export function parseCapacityPerformanceMode(
  value: string | undefined,
): CapacityPerformanceMode {
  if (value === undefined || value === '') return 'evidence'
  if (value === 'controlled') return 'controlled'
  throw new Error(
    `${CAPACITY_PERFORMANCE_GATE_ENV} must be unset or exactly 'controlled'; received ${JSON.stringify(value)}`,
  )
}

export function capacityPerformanceViolations(
  measurements: CapacityPerformanceMeasurements,
): readonly CapacityPerformanceViolation[] {
  const violations: CapacityPerformanceViolation[] = []
  addGreaterThan(
    violations,
    'idleRendererPlusGpuRatio',
    measurements.idleRendererPlusGpuRatio,
  )
  addGreaterThan(
    violations,
    'terminalReadinessP95Ratio',
    measurements.terminalReadinessP95Ratio,
  )
  addGreaterThan(
    violations,
    'terminalReadinessMaxMs',
    measurements.terminalReadinessMaxMs,
  )
  addGreaterThanOrEqual(
    violations,
    'responsivenessP99Ms',
    measurements.responsivenessP99Ms,
  )
  addGreaterThan(violations, 'responsivenessMaxMs', measurements.responsivenessMaxMs)
  addGreaterThan(violations, 'workingSetGrowthKiB', measurements.workingSetGrowthKiB)
  addGreaterThan(
    violations,
    'diagnosticRendererPlusGpuCpuDelta',
    measurements.diagnosticRendererPlusGpuCpuDelta,
  )
  addGreaterThan(
    violations,
    'diagnosticMemoryGrowthDeltaKiB',
    measurements.diagnosticMemoryGrowthDeltaKiB,
  )
  addGreaterThanOrEqual(
    violations,
    'diagnosticFrameP99Ms',
    measurements.diagnosticFrameP99Ms,
  )
  addGreaterThan(violations, 'diagnosticFrameMaxMs', measurements.diagnosticFrameMaxMs)
  addGreaterThanOrEqual(
    violations,
    'diagnosticClickP95Ms',
    measurements.diagnosticClickP95Ms,
  )
  addGreaterThan(violations, 'diagnosticClickMaxMs', measurements.diagnosticClickMaxMs)
  return violations
}

export function formatCapacityPerformanceViolation(
  violation: CapacityPerformanceViolation,
): string {
  const operator = violation.comparison === 'greater-than-or-equal' ? '>=' : '>'
  return `${violation.budget} ${violation.actual} ${operator} ${violation.limit}`
}

function addGreaterThan(
  violations: CapacityPerformanceViolation[],
  budget: CapacityPerformanceBudget,
  actual: number,
): void {
  const limit = CAPACITY_PERFORMANCE_BUDGETS[budget]
  if (actual > limit) {
    violations.push({ budget, actual, limit, comparison: 'greater-than' })
  }
}

function addGreaterThanOrEqual(
  violations: CapacityPerformanceViolation[],
  budget: CapacityPerformanceBudget,
  actual: number,
): void {
  const limit = CAPACITY_PERFORMANCE_BUDGETS[budget]
  if (actual >= limit) {
    violations.push({
      budget,
      actual,
      limit,
      comparison: 'greater-than-or-equal',
    })
  }
}
