import { UI_RESPONSIVENESS_BUDGET } from '../../shared/ui-responsiveness-budget'
import {
  CAPACITY_PERFORMANCE_GATE_ENV,
  parseCapacityPerformanceMode,
  type CapacityPerformanceMode,
} from './capacity-performance'

export type NativeWorkbenchPerformanceMode = CapacityPerformanceMode
export type NativeWorkbenchPerformancePhase =
  | 'query'
  | 'readonly-query'
  | 'selection'
  | 'readonly-selection'
  | 'effects'
  | 'paste-unicode'
  | 'paste-lnm'
export interface NativeWorkbenchPerformanceLoop {
  readonly loop: 'main' | 'renderer'
  readonly samples: number
  readonly minimumSamples: 1 | 2
  readonly maximumMs: number
}
export interface NativeWorkbenchPerformanceEvidence {
  readonly mode: NativeWorkbenchPerformanceMode
  readonly phase: NativeWorkbenchPerformancePhase
  readonly maximumInclusiveMs: typeof UI_RESPONSIVENESS_BUDGET.responsivenessMaxMs
  readonly loops: readonly NativeWorkbenchPerformanceLoop[]
  readonly violations: readonly {
    readonly loop: NativeWorkbenchPerformanceLoop['loop']
    readonly actualMs: number
    readonly maximumInclusiveMs: typeof UI_RESPONSIVENESS_BUDGET.responsivenessMaxMs
  }[]
}
const PHASE_LOOPS = {
  query: [{ loop: 'renderer', minimumSamples: 2 }],
  'readonly-query': [{ loop: 'renderer', minimumSamples: 2 }],
  selection: [
    { loop: 'main', minimumSamples: 1 },
    { loop: 'renderer', minimumSamples: 1 },
  ],
  'readonly-selection': [{ loop: 'renderer', minimumSamples: 2 }],
  effects: [
    { loop: 'main', minimumSamples: 2 },
    { loop: 'renderer', minimumSamples: 2 },
  ],
  'paste-unicode': [{ loop: 'renderer', minimumSamples: 1 }],
  'paste-lnm': [{ loop: 'renderer', minimumSamples: 1 }],
} as const

export function nativeWorkbenchPerformanceMode(): NativeWorkbenchPerformanceMode {
  return parseCapacityPerformanceMode(process.env[CAPACITY_PERFORMANCE_GATE_ENV])
}

/** Preserve actual qualification observations; malformed evidence fails in every mode. */
export function nativeWorkbenchPerformanceEvidence(
  mode: NativeWorkbenchPerformanceMode,
  phase: NativeWorkbenchPerformancePhase,
  loops: readonly NativeWorkbenchPerformanceLoop[],
): NativeWorkbenchPerformanceEvidence {
  if (mode !== 'evidence' && mode !== 'controlled')
    throw new Error('native-performance-mode-invalid')
  if (typeof phase !== 'string' || !Object.hasOwn(PHASE_LOOPS, phase))
    throw new Error('native-performance-phase-invalid')
  const rawLoops: unknown = loops
  if (!Array.isArray(rawLoops) || rawLoops.length !== PHASE_LOOPS[phase].length)
    throw new Error('native-performance-loops-invalid')
  const seen = new Set<NativeWorkbenchPerformanceLoop['loop']>()
  const maximumInclusiveMs = UI_RESPONSIVENESS_BUDGET.responsivenessMaxMs
  const violations: NativeWorkbenchPerformanceEvidence['violations'][number][] = []
  const snapshot: NativeWorkbenchPerformanceLoop[] = []
  for (const observation of loops) {
    const required =
      observation && PHASE_LOOPS[phase].find((item) => item.loop === observation.loop)
    if (
      !observation ||
      !required ||
      seen.has(observation.loop) ||
      observation.minimumSamples !== required.minimumSamples ||
      !Number.isSafeInteger(observation.samples) ||
      observation.samples < observation.minimumSamples ||
      !Number.isFinite(observation.maximumMs) ||
      observation.maximumMs < 0
    )
      throw new Error('native-performance-observation-invalid')
    seen.add(observation.loop)
    snapshot.push(
      Object.freeze({
        loop: observation.loop,
        samples: observation.samples,
        minimumSamples: observation.minimumSamples,
        maximumMs: observation.maximumMs,
      }),
    )
    if (observation.maximumMs > maximumInclusiveMs)
      violations.push({
        loop: observation.loop,
        actualMs: observation.maximumMs,
        maximumInclusiveMs,
      })
  }
  return { mode, phase, maximumInclusiveMs, loops: Object.freeze(snapshot), violations }
}

export function enforceNativeWorkbenchPerformance(
  evidence: NativeWorkbenchPerformanceEvidence,
  failure?: Error,
): void {
  const validated = nativeWorkbenchPerformanceEvidence(
    evidence.mode,
    evidence.phase,
    evidence.loops,
  )
  const rawViolations: unknown = evidence.violations
  if (
    evidence.maximumInclusiveMs !== validated.maximumInclusiveMs ||
    !Array.isArray(rawViolations) ||
    rawViolations.length !== validated.violations.length ||
    validated.violations.some((expected, index) => {
      const actual = evidence.violations[index]
      return (
        !actual ||
        typeof actual !== 'object' ||
        Object.keys(actual).length !== 3 ||
        actual.loop !== expected.loop ||
        actual.actualMs !== expected.actualMs ||
        actual.maximumInclusiveMs !== expected.maximumInclusiveMs
      )
    })
  )
    throw new Error('native-performance-evidence-invalid')
  if (validated.mode === 'controlled' && validated.violations.length)
    throw (
      failure ??
      new Error(
        `native-${validated.phase}-performance-budget ${validated.violations.map(({ loop, actualMs, maximumInclusiveMs }) => `${loop} ${actualMs} > ${maximumInclusiveMs}`).join(', ')}`,
      )
    )
}
