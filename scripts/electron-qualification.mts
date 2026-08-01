import {
  REQUIRED_ELECTRON_PLATFORMS,
  REQUIRED_ELECTRON_SUITE_DEFINITIONS,
  requiredElectronSelectionEvidence,
  type RequiredElectronExclusion,
  type RequiredElectronPlatform,
} from './required-electron-suites.mts'
import type { RequiredElectronSuiteResult } from './run-required-electron-suite.mts'

export const QUALIFICATION_CONFIDENCE = 0.95
export const QUALIFICATION_FAILURE_TARGET = 0.005
export const QUALIFICATION_INVOCATIONS_PER_PLATFORM = 598
export const SAMPLE_INVOCATIONS_PER_PLATFORM = 20
export const QUALIFICATION_PARTITION_SIZE = 1
export const QUALIFICATION_MATRIX_BATCH_SIZE = 240
export const QUALIFICATION_MATRIX_BATCH_COUNT = 5

export type ElectronQualificationMode = 'qualification' | 'sample'

export interface ElectronQualificationPlanEntry {
  readonly platform: RequiredElectronPlatform
  readonly runner: 'ubuntu-24.04' | 'macos-15'
  readonly partition: number
  readonly attemptStart: number
  readonly attemptCount: number
}

export interface ElectronQualificationPlan {
  readonly schema: 1
  readonly mode: ElectronQualificationMode
  readonly sourceSha: string
  readonly runAttempt: number
  readonly confidence: number
  readonly failureTarget: number
  readonly invocationsPerPlatform: number
  readonly partitionSize: number
  readonly samplingUnit: 'one-full-suite-invocation-per-runner-allocation'
  readonly matrix: { readonly include: readonly ElectronQualificationPlanEntry[] }
}

export interface ElectronQualificationAttempt {
  readonly number: number
  readonly status: 'passed' | 'failed'
  readonly durationMs: number
  readonly failure: 'suite-failure' | 'runner-error' | null
  readonly suites: readonly RequiredElectronSuiteResult[]
  readonly failureArtifacts: readonly string[]
}

export interface ElectronQualificationPartitionResult {
  readonly schema: 1
  readonly mode: ElectronQualificationMode
  readonly sourceSha: string
  readonly platform: RequiredElectronPlatform
  readonly runner: 'ubuntu-24.04' | 'macos-15'
  readonly partition: number
  readonly attemptStart: number
  readonly expectedAttempts: number
  readonly suiteCount: number
  readonly scenarioCount: number
  readonly exclusions: readonly RequiredElectronExclusion[]
  readonly attempts: readonly ElectronQualificationAttempt[]
}

export interface ElectronQualificationInvocationSummary {
  readonly platform: RequiredElectronPlatform
  readonly number: number
  readonly partition: number
  readonly status: 'passed' | 'failed'
  readonly failure:
    | 'suite-failure'
    | 'runner-error'
    | 'missing-partition'
    | 'missing-invocation'
    | 'invalid-evidence'
    | null
  readonly failedSuites: readonly string[]
  readonly failureArtifacts: readonly string[]
}

export interface ElectronQualificationPlatformSummary {
  readonly platform: RequiredElectronPlatform
  readonly name: string
  readonly runner: 'ubuntu-24.04' | 'macos-15'
  readonly suiteCount: number
  readonly scenarioCount: number
  readonly exclusions: readonly RequiredElectronExclusion[]
  readonly fullSuiteInvocations: number
  readonly runnerAllocations: number
  readonly passes: number
  readonly failures: number
  readonly failureArtifactCount: number
  readonly oneSided95UpperFailureProbability: number
  readonly target: number
  readonly passed: boolean
}

export interface ElectronQualificationSummary {
  readonly schema: 1
  readonly mode: ElectronQualificationMode
  readonly confidenceClaim:
    'one-sided-95-percent-upper-bound' | 'manual-sample-only'
  readonly sourceSha: string
  readonly passed: boolean
  readonly platforms: readonly ElectronQualificationPlatformSummary[]
  readonly invocations: readonly ElectronQualificationInvocationSummary[]
  readonly evidenceProblems: readonly string[]
}

export function createElectronQualificationPlan(options: {
  readonly mode: ElectronQualificationMode
  readonly sourceSha: string
  readonly reviewedSourceSha: string
  readonly runAttempt: number
}): ElectronQualificationPlan {
  requireSourceSha(options.sourceSha)
  requireSourceSha(options.reviewedSourceSha)
  if (options.sourceSha !== options.reviewedSourceSha) {
    throw new Error('Reviewed qualification SHA does not match the workflow source SHA')
  }
  if (!Number.isSafeInteger(options.runAttempt) || options.runAttempt < 1) {
    throw new Error('Workflow run attempt must be a positive integer')
  }
  if (options.mode === 'qualification' && options.runAttempt !== 1) {
    throw new Error('Qualification evidence cannot be replaced by a workflow rerun')
  }
  const invocationsPerPlatform =
    options.mode === 'qualification'
      ? QUALIFICATION_INVOCATIONS_PER_PLATFORM
      : SAMPLE_INVOCATIONS_PER_PLATFORM
  const platformEntries = REQUIRED_ELECTRON_PLATFORMS.map((platform) =>
    partitionPlatform(platform, invocationsPerPlatform),
  )
  const include = Array.from({ length: invocationsPerPlatform }, (_, index) =>
    platformEntries.map((entries) => entries[index]!),
  ).flat()
  return {
    schema: 1,
    mode: options.mode,
    sourceSha: options.sourceSha,
    runAttempt: options.runAttempt,
    confidence: QUALIFICATION_CONFIDENCE,
    failureTarget: QUALIFICATION_FAILURE_TARGET,
    invocationsPerPlatform,
    partitionSize: QUALIFICATION_PARTITION_SIZE,
    samplingUnit: 'one-full-suite-invocation-per-runner-allocation',
    matrix: { include },
  }
}

function partitionPlatform(
  platform: RequiredElectronPlatform,
  total: number,
): readonly ElectronQualificationPlanEntry[] {
  const definition = REQUIRED_ELECTRON_SUITE_DEFINITIONS[platform]
  const entries: ElectronQualificationPlanEntry[] = []
  for (let attemptStart = 1, partition = 1; attemptStart <= total; partition += 1) {
    const attemptCount = Math.min(QUALIFICATION_PARTITION_SIZE, total - attemptStart + 1)
    entries.push({
      platform,
      runner: definition.runner,
      partition,
      attemptStart,
      attemptCount,
    })
    attemptStart += attemptCount
  }
  return entries
}

/** Keep every counted observation on its own runner while respecting GitHub's matrix limit. */
export function electronQualificationMatrixBatches(
  plan: ElectronQualificationPlan,
): readonly { readonly include: readonly ElectronQualificationPlanEntry[] }[] {
  const batches = Array.from({ length: QUALIFICATION_MATRIX_BATCH_COUNT }, () => ({
    include: [] as ElectronQualificationPlanEntry[],
  }))
  for (const [index, entry] of plan.matrix.include.entries()) {
    const batch = batches[Math.floor(index / QUALIFICATION_MATRIX_BATCH_SIZE)]
    if (!batch) throw new Error('Qualification plan exceeded its reviewed matrix batches')
    batch.include.push(entry)
  }
  return batches
}

export function createElectronQualificationPartitionResult(
  plan: Pick<ElectronQualificationPlan, 'mode' | 'sourceSha'>,
  entry: ElectronQualificationPlanEntry,
  attempts: readonly ElectronQualificationAttempt[] = [],
): ElectronQualificationPartitionResult {
  const evidence = requiredElectronSelectionEvidence(entry.platform)
  return {
    schema: 1,
    mode: plan.mode,
    sourceSha: plan.sourceSha,
    platform: entry.platform,
    runner: entry.runner,
    partition: entry.partition,
    attemptStart: entry.attemptStart,
    expectedAttempts: entry.attemptCount,
    suiteCount: evidence.suiteCount,
    scenarioCount: evidence.scenarioCount,
    exclusions: evidence.exclusions,
    attempts,
  }
}

export function combineElectronQualificationResults(
  plan: ElectronQualificationPlan,
  artifacts: readonly unknown[],
): ElectronQualificationSummary {
  const parsed = artifacts.flatMap((artifact) => {
    const result = parsePartitionResult(artifact)
    return result ? [result] : []
  })
  const evidenceProblems: string[] = []
  if (parsed.length !== artifacts.length) {
    evidenceProblems.push(
      `${artifacts.length - parsed.length} invalid partition artifact(s)`,
    )
  }
  for (const result of parsed) {
    if (
      !plan.matrix.include.some(
        (entry) =>
          entry.platform === result.platform && entry.partition === result.partition,
      )
    ) {
      evidenceProblems.push(
        `${result.platform} partition ${result.partition}: unexpected evidence`,
      )
    }
  }
  const invocations: ElectronQualificationInvocationSummary[] = []
  for (const entry of plan.matrix.include) {
    const matches = parsed.filter(
      (result) =>
        result.platform === entry.platform && result.partition === entry.partition,
    )
    const evidence = requiredElectronSelectionEvidence(entry.platform)
    const valid = matches.filter(
      (result) =>
        result.mode === plan.mode &&
        result.sourceSha === plan.sourceSha &&
        result.runner === entry.runner &&
        result.attemptStart === entry.attemptStart &&
        result.expectedAttempts === entry.attemptCount &&
        result.suiteCount === evidence.suiteCount &&
        result.scenarioCount === evidence.scenarioCount &&
        result.attempts.length <= entry.attemptCount &&
        result.attempts.every(
          (attempt) =>
            attempt.number >= entry.attemptStart &&
            attempt.number < entry.attemptStart + entry.attemptCount,
        ) &&
        JSON.stringify(result.exclusions) === JSON.stringify(evidence.exclusions),
    )
    if (matches.length !== 1 || valid.length !== 1) {
      const reason = matches.length === 0 ? 'missing' : 'invalid-or-duplicate'
      evidenceProblems.push(
        `${entry.platform} partition ${entry.partition}: ${reason} evidence`,
      )
      for (let offset = 0; offset < entry.attemptCount; offset += 1) {
        invocations.push({
          platform: entry.platform,
          number: entry.attemptStart + offset,
          partition: entry.partition,
          status: 'failed',
          failure: matches.length === 0 ? 'missing-partition' : 'invalid-evidence',
          failedSuites: evidence.suiteIds,
          failureArtifacts: [],
        })
      }
      continue
    }
    appendPartitionInvocations(invocations, evidenceProblems, entry, valid[0]!)
  }
  const platforms = REQUIRED_ELECTRON_PLATFORMS.map((platform) => {
    const definition = REQUIRED_ELECTRON_SUITE_DEFINITIONS[platform]
    const evidence = requiredElectronSelectionEvidence(platform)
    const platformInvocations = invocations.filter(
      (invocation) => invocation.platform === platform,
    )
    const failures = platformInvocations.filter(
      (invocation) => invocation.status === 'failed',
    ).length
    const passes = platformInvocations.length - failures
    const upper = oneSidedBinomialUpperBound(
      failures,
      platformInvocations.length,
      plan.confidence,
    )
    return {
      platform,
      name: definition.name,
      runner: definition.runner,
      suiteCount: evidence.suiteCount,
      scenarioCount: evidence.scenarioCount,
      exclusions: evidence.exclusions,
      fullSuiteInvocations: platformInvocations.length,
      runnerAllocations: plan.matrix.include.filter(
        (entry) => entry.platform === platform,
      ).length,
      passes,
      failures,
      failureArtifactCount: platformInvocations.reduce(
        (count, invocation) => count + invocation.failureArtifacts.length,
        0,
      ),
      oneSided95UpperFailureProbability: upper,
      target: plan.failureTarget,
      passed:
        platformInvocations.length === plan.invocationsPerPlatform &&
        (plan.mode === 'qualification' ? upper <= plan.failureTarget : failures === 0),
    } satisfies ElectronQualificationPlatformSummary
  })
  return {
    schema: 1,
    mode: plan.mode,
    confidenceClaim:
      plan.mode === 'qualification'
        ? 'one-sided-95-percent-upper-bound'
        : 'manual-sample-only',
    sourceSha: plan.sourceSha,
    passed:
      evidenceProblems.length === 0 && platforms.every((platform) => platform.passed),
    platforms,
    invocations,
    evidenceProblems,
  }
}

function appendPartitionInvocations(
  output: ElectronQualificationInvocationSummary[],
  evidenceProblems: string[],
  entry: ElectronQualificationPlanEntry,
  result: ElectronQualificationPartitionResult,
): void {
  const evidence = requiredElectronSelectionEvidence(entry.platform)
  for (let offset = 0; offset < entry.attemptCount; offset += 1) {
    const number = entry.attemptStart + offset
    const matches = result.attempts.filter((attempt) => attempt.number === number)
    if (matches.length !== 1) {
      evidenceProblems.push(
        `${entry.platform} invocation ${number}: ${matches.length === 0 ? 'missing' : 'duplicate'} evidence`,
      )
      output.push({
        platform: entry.platform,
        number,
        partition: entry.partition,
        status: 'failed',
        failure: matches.length === 0 ? 'missing-invocation' : 'invalid-evidence',
        failedSuites: evidence.suiteIds,
        failureArtifacts: [],
      })
      continue
    }
    const attempt = matches[0]!
    const expectedSuites = new Map(
      REQUIRED_ELECTRON_SUITE_DEFINITIONS[entry.platform].suites.map((suite) => [
        suite.id,
        suite,
      ]),
    )
    const complete =
      attempt.suites.length === expectedSuites.size &&
      [...expectedSuites].every(
        ([id, definition]) =>
          attempt.suites.filter((suite) => suite.id === id).length === 1 &&
          JSON.stringify(attempt.suites.find((suite) => suite.id === id)?.scenarios) ===
            JSON.stringify(definition.scenarios),
      )
    const suitePassed = complete && attempt.suites.every(requiredSuitePassed)
    const passed = attempt.status === 'passed' && suitePassed
    if (attempt.status === 'passed' && !passed) {
      evidenceProblems.push(
        `${entry.platform} invocation ${number}: invalid passing evidence`,
      )
    }
    output.push({
      platform: entry.platform,
      number,
      partition: entry.partition,
      status: passed ? 'passed' : 'failed',
      failure: passed
        ? null
        : attempt.status === 'failed'
          ? (attempt.failure ?? 'suite-failure')
          : 'invalid-evidence',
      failedSuites: passed
        ? []
        : complete
          ? attempt.suites
              .filter((suite) => suite.status === 'failed')
              .map((suite) => suite.id)
          : evidence.suiteIds,
      failureArtifacts: attempt.failureArtifacts,
    })
  }
}

function requiredSuitePassed(suite: RequiredElectronSuiteResult): boolean {
  return (
    suite.status === 'passed' &&
    suite.exitCode === 0 &&
    suite.signal === null &&
    suite.failure === null
  )
}

function parsePartitionResult(
  value: unknown,
): ElectronQualificationPartitionResult | undefined {
  if (!isRecord(value) || value.schema !== 1) return undefined
  if (value.mode !== 'qualification' && value.mode !== 'sample') return undefined
  if (!isSourceSha(value.sourceSha)) return undefined
  if (!REQUIRED_ELECTRON_PLATFORMS.includes(value.platform as RequiredElectronPlatform)) {
    return undefined
  }
  if (value.runner !== 'ubuntu-24.04' && value.runner !== 'macos-15') return undefined
  if (
    !positiveInteger(value.partition) ||
    !positiveInteger(value.attemptStart) ||
    !positiveInteger(value.expectedAttempts) ||
    !positiveInteger(value.suiteCount) ||
    !positiveInteger(value.scenarioCount) ||
    !Array.isArray(value.exclusions) ||
    !Array.isArray(value.attempts)
  ) {
    return undefined
  }
  if (!value.attempts.every(isQualificationAttempt)) return undefined
  return value as unknown as ElectronQualificationPartitionResult
}

function isQualificationAttempt(value: unknown): value is ElectronQualificationAttempt {
  return (
    isRecord(value) &&
    positiveInteger(value.number) &&
    (value.status === 'passed' || value.status === 'failed') &&
    typeof value.durationMs === 'number' &&
    Number.isFinite(value.durationMs) &&
    value.durationMs >= 0 &&
    (value.failure === null ||
      value.failure === 'suite-failure' ||
      value.failure === 'runner-error') &&
    Array.isArray(value.suites) &&
    value.suites.every(isRequiredElectronSuiteResult) &&
    Array.isArray(value.failureArtifacts) &&
    value.failureArtifacts.every((artifact) => typeof artifact === 'string')
  )
}

function isRequiredElectronSuiteResult(
  value: unknown,
): value is RequiredElectronSuiteResult {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    Array.isArray(value.scenarios) &&
    value.scenarios.every((scenario) => typeof scenario === 'string') &&
    (value.status === 'passed' || value.status === 'failed') &&
    typeof value.durationMs === 'number' &&
    Number.isFinite(value.durationMs) &&
    value.durationMs >= 0 &&
    (value.exitCode === null || Number.isSafeInteger(value.exitCode)) &&
    (value.signal === null || typeof value.signal === 'string') &&
    (value.failure === null ||
      value.failure === 'timed-out' ||
      value.failure === 'spawn-failed' ||
      value.failure === 'nonzero-exit')
  )
}

export function oneSidedBinomialUpperBound(
  failures: number,
  attempts: number,
  confidence = QUALIFICATION_CONFIDENCE,
): number {
  if (
    !Number.isSafeInteger(failures) ||
    !Number.isSafeInteger(attempts) ||
    failures < 0 ||
    attempts < 1 ||
    failures > attempts ||
    confidence <= 0 ||
    confidence >= 1
  ) {
    throw new Error('Binomial upper-bound inputs were invalid')
  }
  if (failures === attempts) return 1
  const alpha = 1 - confidence
  let lower = failures / attempts
  let upper = 1
  for (let iteration = 0; iteration < 100; iteration += 1) {
    const candidate = (lower + upper) / 2
    if (binomialCdf(failures, attempts, candidate) > alpha) lower = candidate
    else upper = candidate
  }
  return upper
}

function binomialCdf(failures: number, attempts: number, probability: number): number {
  if (probability <= 0) return 1
  if (probability >= 1) return failures === attempts ? 1 : 0
  const logs: number[] = []
  let logCombination = 0
  const logFailure = Math.log(probability)
  const logPass = Math.log1p(-probability)
  for (let count = 0; count <= failures; count += 1) {
    if (count > 0) {
      logCombination += Math.log(attempts - count + 1) - Math.log(count)
    }
    logs.push(logCombination + count * logFailure + (attempts - count) * logPass)
  }
  const maximum = Math.max(...logs)
  return (
    Math.exp(maximum) * logs.reduce((sum, value) => sum + Math.exp(value - maximum), 0)
  )
}

export function formatElectronQualificationSummary(
  summary: ElectronQualificationSummary,
): string {
  const lines = [
    `# Electron ${summary.mode === 'qualification' ? 'qualification' : 'manual sample'}`,
    '',
    `Source: \`${summary.sourceSha}\``,
    '',
    'Sampling unit: one full-suite invocation per fresh GitHub-hosted runner allocation.',
    '',
    '| Platform | Runner allocations | Suites/invocation | Scenarios/invocation | Passes | Failures | One-sided 95% upper bound | Result |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
    ...summary.platforms.map(
      (platform) =>
        `| ${platform.name} | ${platform.runnerAllocations} | ${platform.suiteCount} | ${platform.scenarioCount} | ${platform.passes} | ${platform.failures} | ${(platform.oneSided95UpperFailureProbability * 100).toFixed(4)}% | ${platform.passed ? 'pass' : 'fail'} |`,
    ),
    '',
  ]
  if (summary.mode === 'sample') {
    lines.push(
      'This manually dispatched 20-invocation-per-platform sample is screening evidence only; it does not establish the 0.5% qualification target.',
      '',
    )
  }
  for (const platform of summary.platforms.filter((item) => item.exclusions.length > 0)) {
    lines.push(
      `Temporary ${platform.name} exclusions: ${platform.exclusions
        .map((item) => `${item.scenario} (${item.acceptanceBoundary})`)
        .join(', ')}.`,
      '',
    )
  }
  if (summary.evidenceProblems.length > 0) {
    lines.push('Evidence problems:', '')
    for (const problem of summary.evidenceProblems.slice(0, 100))
      lines.push(`- ${problem}`)
    lines.push('')
  }
  const failures = summary.invocations.filter((item) => item.status === 'failed')
  if (failures.length > 0) {
    lines.push('Failed invocations:', '')
    for (const failure of failures.slice(0, 100)) {
      lines.push(
        `- ${failure.platform} #${failure.number}: ${failure.failure ?? 'suite-failure'} (${failure.failedSuites.join(', ') || 'unknown suite'})`,
      )
    }
    if (failures.length > 100)
      lines.push(`- ${failures.length - 100} more in summary.json`)
    lines.push('')
  }
  lines.push(`Overall: ${summary.passed ? 'pass' : 'fail'}`)
  return lines.join('\n')
}

function requireSourceSha(value: string): void {
  if (!isSourceSha(value))
    throw new Error('Qualification source SHA must be 40 lowercase hex')
}

function isSourceSha(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value)
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
