import {
  CAPACITY_PERFORMANCE_BUDGETS,
  capacityPerformanceViolations,
  type CapacityPerformanceMeasurements,
} from './capacity-performance.ts'
import { median } from './capacity-statistics.ts'

export const CAPACITY_TERMINAL_COMPARISON_ORDER = [
  'web',
  'native',
  'native',
  'web',
  'native',
  'web',
  'web',
  'native',
] as const
export const CAPACITY_TERMINAL_COMPARISON_COUNTS = {
  scroll: 200,
  output: 200,
  echo: 100,
  resize: 30,
  workbench: 100,
} as const
export type CapacityTerminalComparisonClass =
  keyof typeof CAPACITY_TERMINAL_COMPARISON_COUNTS
export type CapacityTerminalComparisonEngine = 'web' | 'native'
export interface CapacityTerminalComparisonIdentity {
  readonly sourceSha: string
  readonly configurationSha: string
  readonly workloadSha: string
  readonly topologySha: string
  readonly observationMethod: 'BrowserWindow.capturePage:synthetic-terminal-tag-v3'
  readonly refreshHz: number
  readonly rows: number
  readonly columns: number
  readonly fontSize: number
  readonly cssWidth: number
  readonly cssHeight: number
  readonly backingScale: number
}
export interface CapacityTerminalComparisonMeasurement {
  readonly sequence: number
  readonly durationMs: number
  readonly expectedTag: string
  readonly observedTag: string
  readonly expectedGeometry: string
  readonly observedGeometry: string
  readonly expectedInputSequence: number
  readonly observedInputSequence: number
}
interface ScheduledProcess {
  readonly index: number
  readonly pair: number
  readonly engine: CapacityTerminalComparisonEngine
}
export interface CapacityTerminalPassedProcess extends ScheduledProcess {
  readonly status: 'passed'
  readonly observedPresentation: 'web' | 'native-gpu' | 'native-pixels'
  readonly processId: string
  readonly runId: string
  readonly identity: CapacityTerminalComparisonIdentity
  readonly artifact: {
    readonly sha256: string
    readonly coreVersion: string
    readonly build: string
  }
  readonly warmups: Readonly<Record<CapacityTerminalComparisonClass, number>>
  readonly measurements: Readonly<
    Record<
      CapacityTerminalComparisonClass,
      readonly CapacityTerminalComparisonMeasurement[]
    >
  >
  readonly frameGapsMs: readonly number[]
  readonly uiResponsivenessByClass: Readonly<
    Record<
      CapacityTerminalComparisonClass,
      {
        readonly frameGapsMs: readonly number[]
        readonly clickLatenciesMs: readonly number[]
      }
    >
  >
  readonly budgets: CapacityPerformanceMeasurements
  readonly accounting: {
    readonly idleWholeAppCpu: number
    readonly nativeHostCpu: number
    readonly nativeHostMemoryKiB: number
  }
}
export interface CapacityTerminalFailedProcess extends ScheduledProcess {
  readonly status: 'failed'
  readonly failure: string
}
export type CapacityTerminalProcessResult =
  CapacityTerminalPassedProcess | CapacityTerminalFailedProcess
export interface CapacityTerminalClassComparison {
  readonly webP95sMs: readonly number[]
  readonly nativeP95sMs: readonly number[]
  readonly webMedianP95Ms: number
  readonly nativeMedianP95Ms: number
  readonly pairedImprovementsMs: readonly number[]
  readonly medianPairedImprovementMs: number
  readonly webNoiseMs: number
  readonly improvedPairs: number
}
export interface CapacityTerminalComparisonResult {
  readonly timingPassed: boolean
  readonly physicalPresentationQualified: false
  readonly hardwareGpuQualified: false
  readonly blockers: readonly string[]
  /** Preserve every scheduled result, including incomplete/failed processes. */
  readonly submitted: unknown
  readonly classes?: Readonly<
    Record<CapacityTerminalComparisonClass, CapacityTerminalClassComparison>
  >
  readonly frameGaps?: CapacityTerminalClassComparison
}
const classes = Object.keys(
  CAPACITY_TERMINAL_COMPARISON_COUNTS,
) as CapacityTerminalComparisonClass[]
const budgets = Object.keys(
  CAPACITY_PERFORMANCE_BUDGETS,
) as (keyof CapacityPerformanceMeasurements)[]
const identityNumbers = [
  'refreshHz',
  'rows',
  'columns',
  'fontSize',
  'cssWidth',
  'cssHeight',
  'backingScale',
] as const
const identityHashes = [
  'sourceSha',
  'configurationSha',
  'workloadSha',
  'topologySha',
] as const

/** The fixed M1 comparison policy; this evaluates observed timing only. Hardware,
 * packaging, real-host/manual and resource-lifetime acceptance remain independent. */
export function evaluateCapacityTerminalComparison(
  submitted: unknown,
): CapacityTerminalComparisonResult {
  const blockers: string[] = []
  const result = (
    extra: Partial<CapacityTerminalComparisonResult> = {},
  ): CapacityTerminalComparisonResult => ({
    timingPassed: blockers.length === 0,
    physicalPresentationQualified: false,
    hardwareGpuQualified: false,
    blockers,
    submitted,
    ...extra,
  })
  if (!Array.isArray(submitted) || submitted.length !== 8) {
    blockers.push('protocol:exactly-eight-scheduled-processes-required')
    return result()
  }
  for (let index = 0; index < submitted.length; index++) {
    const process = submitted[index] as unknown
    if (!record(process)) {
      blockers.push(`process-${index}:invalid-record`)
      continue
    }
    if (
      process.index !== index ||
      process.pair !== Math.floor(index / 2) ||
      process.engine !== CAPACITY_TERMINAL_COMPARISON_ORDER[index]
    )
      blockers.push(`process-${index}:scheduled-order-mismatch`)
    if (process.status !== 'passed') {
      blockers.push(`process-${index}:process-failed-or-incomplete`)
      continue
    }
    validateProcess(process, index, blockers)
  }
  // An invalid process never disappears into a reduced timing population.
  if (blockers.length) return result()
  const processes = submitted as CapacityTerminalPassedProcess[]
  const first = processes[0]!
  const ids = new Set<string>()
  for (const process of processes) {
    if (ids.has(process.processId))
      blockers.push(`process-${process.index}:reused-process-identity`)
    ids.add(process.processId)
    if (process.runId !== first.runId || !sameIdentity(process.identity, first.identity))
      blockers.push(`process-${process.index}:candidate-or-configuration-changed`)
    const sameEngine = processes.find((other) => other.engine === process.engine)!
    if (
      process.artifact.sha256 !== sameEngine.artifact.sha256 ||
      process.artifact.coreVersion !== sameEngine.artifact.coreVersion ||
      process.artifact.build !== sameEngine.artifact.build
    )
      blockers.push(`process-${process.index}:engine-artifact-changed`)
  }
  if (blockers.length) return result()
  const comparisons = {} as Record<
    CapacityTerminalComparisonClass,
    CapacityTerminalClassComparison
  >
  for (const kind of classes) {
    const comparison = compare(processes, (process) =>
      nearestRank(
        process.measurements[kind].map((sample) => sample.durationMs),
        0.95,
      ),
    )
    comparisons[kind] = comparison
    const {
      webMedianP95Ms: w,
      nativeMedianP95Ms: n,
      medianPairedImprovementMs: delta,
      webNoiseMs: noise,
      improvedPairs,
    } = comparison
    if (kind === 'scroll' || kind === 'output') {
      if (noise > Math.max(4, 0.2 * w)) blockers.push(`${kind}:baseline-not-repeatable`)
      if (n > 0.8 * w) blockers.push(`${kind}:twenty-percent-improvement-missing`)
      if (delta <= Math.max(2, noise))
        blockers.push(`${kind}:paired-improvement-within-noise`)
      if (improvedPairs < 3) blockers.push(`${kind}:fewer-than-three-improving-pairs`)
    } else if (delta < -Math.max(5, 0.1 * w))
      blockers.push(`${kind}:secondary-regression`)
    for (const process of processes) {
      const ui = process.uiResponsivenessByClass[kind]
      const durations = [...ui.frameGapsMs, ...ui.clickLatenciesMs]
      if (
        nearestRank(durations, 0.99) >= CAPACITY_PERFORMANCE_BUDGETS.responsivenessP99Ms
      )
        blockers.push(`process-${process.index}:${kind}:responsiveness-p99`)
      if (maximum(durations) > CAPACITY_PERFORMANCE_BUDGETS.responsivenessMaxMs)
        blockers.push(`process-${process.index}:${kind}:responsiveness-maximum`)
    }
  }
  const frameGaps = compare(processes, (process) =>
    nearestRank(process.frameGapsMs, 0.95),
  )
  if (
    frameGaps.nativeMedianP95Ms >
    frameGaps.webMedianP95Ms + 1000 / first.identity.refreshHz
  )
    blockers.push('frame-gap:more-than-one-recorded-refresh-regression')
  for (const process of processes) {
    if (maximum(process.frameGapsMs) > CAPACITY_PERFORMANCE_BUDGETS.responsivenessMaxMs)
      blockers.push(`process-${process.index}:frame-gap:maximum`)
    for (const violation of capacityPerformanceViolations(process.budgets))
      blockers.push(`process-${process.index}:capacity:${violation.budget}`)
  }
  return result({ classes: comparisons, frameGaps })
}

function validateProcess(
  process: Record<string, unknown>,
  index: number,
  blockers: string[],
): void {
  const fail = (reason: string) => blockers.push(`process-${index}:${reason}`)
  if (process.engine === 'native' && process.observedPresentation === 'native-pixels')
    fail('compatibility-pixels-require-separate-qualification')
  else if (
    process.observedPresentation !== (process.engine === 'web' ? 'web' : 'native-gpu')
  )
    fail('observed-presentation-mismatch')
  if (!text(process.runId, 120) || !text(process.processId, 120))
    fail('missing-run-or-process-identity')
  const identity = process.identity
  if (
    !record(identity) ||
    identity.observationMethod !==
      'BrowserWindow.capturePage:synthetic-terminal-tag-v3' ||
    identityNumbers.some((key) => !positive(identity[key])) ||
    !Number.isSafeInteger(identity.rows) ||
    !Number.isSafeInteger(identity.columns) ||
    identityHashes.some((key) => !hash(identity[key], key === 'sourceSha' ? 40 : 64))
  )
    fail('invalid-common-identity')
  const artifact = process.artifact
  if (
    !record(artifact) ||
    !hash(artifact.sha256, 64) ||
    !text(artifact.coreVersion, 120) ||
    !text(artifact.build, 120)
  )
    fail('invalid-engine-artifact')
  const measurementsBudgets = process.budgets
  if (
    !record(measurementsBudgets) ||
    budgets.some(
      (key) =>
        !finite(measurementsBudgets[key]) ||
        (key !== 'workingSetGrowthKiB' && Number(measurementsBudgets[key]) < 0),
    )
  )
    fail('invalid-capacity-measurements')
  const accounting = process.accounting
  if (
    !record(accounting) ||
    ['idleWholeAppCpu', 'nativeHostCpu', 'nativeHostMemoryKiB'].some(
      (key) => !nonnegative(accounting[key]),
    )
  )
    fail('missing-whole-app-native-accounting')
  if (!numbers(process.frameGapsMs)) fail('invalid-frame-gaps')
  const uiByClass = process.uiResponsivenessByClass
  if (
    !record(uiByClass) ||
    classes.some((kind) => {
      const ui = uiByClass[kind]
      return (
        !record(ui) ||
        !numbers(ui.frameGapsMs) ||
        !numbers(ui.clickLatenciesMs, kind !== 'workbench')
      )
    })
  )
    fail('invalid-per-class-ui-responsiveness')
  const measurements = process.measurements
  const warmups = process.warmups
  if (!record(measurements) || !record(warmups)) {
    fail('missing-measurements-or-warmups')
    return
  }
  for (const kind of classes) {
    if (warmups[kind] !== 10) fail(`${kind}:exactly-ten-warmups-required`)
    const samples = measurements[kind]
    if (
      !Array.isArray(samples) ||
      samples.length !== CAPACITY_TERMINAL_COMPARISON_COUNTS[kind]
    ) {
      fail(`${kind}:scheduled-sample-count-mismatch`)
      continue
    }
    const tags = new Set<string>()
    for (let sequence = 0; sequence < samples.length; sequence++) {
      const sample = samples[sequence] as unknown
      if (
        !record(sample) ||
        sample.sequence !== sequence ||
        !nonnegative(sample.durationMs) ||
        !text(sample.expectedTag, 120) ||
        sample.expectedTag !== sample.observedTag ||
        !text(sample.expectedGeometry, 120) ||
        sample.expectedGeometry !== sample.observedGeometry ||
        !Number.isSafeInteger(sample.expectedInputSequence) ||
        Number(sample.expectedInputSequence) < 0 ||
        sample.expectedInputSequence !== sample.observedInputSequence
      ) {
        fail(`${kind}:invalid-matching-consumer-witness`)
        break
      }
      const witness = JSON.stringify([
        sample.expectedTag,
        sample.expectedGeometry,
        sample.expectedInputSequence,
      ])
      if (tags.has(witness)) {
        fail(`${kind}:reused-causal-witness`)
        break
      }
      tags.add(witness)
    }
  }
}

function compare(
  processes: readonly CapacityTerminalPassedProcess[],
  p95: (process: CapacityTerminalPassedProcess) => number,
): CapacityTerminalClassComparison {
  const webP95sMs: number[] = [],
    nativeP95sMs: number[] = []
  for (let pair = 0; pair < 4; pair++) {
    webP95sMs.push(
      p95(
        processes.find((process) => process.pair === pair && process.engine === 'web')!,
      ),
    )
    nativeP95sMs.push(
      p95(
        processes.find(
          (process) => process.pair === pair && process.engine === 'native',
        )!,
      ),
    )
  }
  const pairedImprovementsMs = webP95sMs.map(
    (value, index) => value - nativeP95sMs[index]!,
  )
  return {
    webP95sMs,
    nativeP95sMs,
    webMedianP95Ms: median(webP95sMs),
    nativeMedianP95Ms: median(nativeP95sMs),
    pairedImprovementsMs,
    medianPairedImprovementMs: median(pairedImprovementsMs),
    webNoiseMs: Math.max(...webP95sMs) - Math.min(...webP95sMs),
    improvedPairs: pairedImprovementsMs.filter((value) => value > 0).length,
  }
}
function sameIdentity(
  a: CapacityTerminalComparisonIdentity,
  b: CapacityTerminalComparisonIdentity,
): boolean {
  return [...identityNumbers, ...identityHashes, 'observationMethod' as const].every(
    (key) => a[key] === b[key],
  )
}
function maximum(values: readonly number[]): number {
  return values.reduce((highest, value) => Math.max(highest, value), 0)
}
function nearestRank(values: readonly number[], fraction: number): number {
  return [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1]!
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}
function positive(value: unknown): value is number {
  return finite(value) && value > 0
}
function nonnegative(value: unknown): value is number {
  return finite(value) && value >= 0
}
function numbers(value: unknown, allowEmpty = false): value is readonly number[] {
  return (
    Array.isArray(value) && (allowEmpty || value.length > 0) && value.every(nonnegative)
  )
}
function text(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
}
function hash(value: unknown, length: number): value is string {
  return typeof value === 'string' && value.length === length && /^[a-f0-9]+$/.test(value)
}
