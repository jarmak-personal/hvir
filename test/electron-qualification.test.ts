import { describe, expect, it } from 'vitest'

import {
  QUALIFICATION_INVOCATIONS_PER_PLATFORM,
  QUALIFICATION_MATRIX_BATCH_COUNT,
  QUALIFICATION_MATRIX_BATCH_SIZE,
  combineElectronQualificationResults,
  createElectronQualificationPartitionResult,
  createElectronQualificationPlan,
  electronQualificationMatrixBatches,
  oneSidedBinomialUpperBound,
  type ElectronQualificationAttempt,
  type ElectronQualificationPartitionResult,
  type ElectronQualificationPlan,
} from '../scripts/electron-qualification.mts'
import {
  REQUIRED_ELECTRON_SUITE_DEFINITIONS,
  type RequiredElectronPlatform,
} from '../scripts/required-electron-suites.mts'

const sourceSha = 'a'.repeat(40)

describe('Electron reliability qualification planning', () => {
  it('plans at least 598 complete invocations per platform in bounded jobs', () => {
    const plan = qualificationPlan()
    expect(plan.invocationsPerPlatform).toBe(QUALIFICATION_INVOCATIONS_PER_PLATFORM)
    expect(plan.matrix.include).toHaveLength(1_196)
    expect(plan.partitionSize).toBe(1)
    expect(plan.samplingUnit).toBe('one-full-suite-invocation-per-runner-allocation')
    for (const platform of ['linux-x64', 'macos-arm64'] as const) {
      const entries = plan.matrix.include.filter((entry) => entry.platform === platform)
      expect(entries).toHaveLength(598)
      expect(entries.reduce((sum, entry) => sum + entry.attemptCount, 0)).toBe(598)
      expect(entries.every((entry) => entry.attemptCount === 1)).toBe(true)
      expect(entries.map((entry) => entry.partition)).toEqual(
        Array.from({ length: 598 }, (_, index) => index + 1),
      )
    }
    const batches = electronQualificationMatrixBatches(plan)
    expect(batches).toHaveLength(QUALIFICATION_MATRIX_BATCH_COUNT)
    expect(batches.map((batch) => batch.include.length)).toEqual([
      QUALIFICATION_MATRIX_BATCH_SIZE,
      QUALIFICATION_MATRIX_BATCH_SIZE,
      QUALIFICATION_MATRIX_BATCH_SIZE,
      QUALIFICATION_MATRIX_BATCH_SIZE,
      236,
    ])
    expect(
      batches.map((batch) => [
        batch.include.filter((entry) => entry.platform === 'linux-x64').length,
        batch.include.filter((entry) => entry.platform === 'macos-arm64').length,
      ]),
    ).toEqual([
      [120, 120],
      [120, 120],
      [120, 120],
      [120, 120],
      [118, 118],
    ])
  })

  it('rejects a different source SHA and qualification reruns', () => {
    expect(() =>
      createElectronQualificationPlan({
        mode: 'qualification',
        sourceSha,
        reviewedSourceSha: 'b'.repeat(40),
        runAttempt: 1,
      }),
    ).toThrow('does not match')
    expect(() =>
      createElectronQualificationPlan({
        mode: 'qualification',
        sourceSha,
        reviewedSourceSha: sourceSha,
        runAttempt: 2,
      }),
    ).toThrow('cannot be replaced')
  })

  it('plans the weekly twenty-run sample as regression evidence only', () => {
    const plan = createElectronQualificationPlan({
      mode: 'weekly',
      sourceSha,
      reviewedSourceSha: sourceSha,
      runAttempt: 2,
    })
    expect(plan.invocationsPerPlatform).toBe(20)
    expect(plan.matrix.include).toHaveLength(40)
    expect(
      electronQualificationMatrixBatches(plan).map((batch) => batch.include.length),
    ).toEqual([40, 0, 0, 0, 0])
    const summary = combineElectronQualificationResults(plan, passingArtifacts(plan))
    expect(summary.passed).toBe(true)
    expect(summary.confidenceClaim).toBe('weekly-regression-signal-only')
    expect(summary.platforms[0]?.oneSided95UpperFailureProbability).toBeGreaterThan(0.1)
  })
})

describe('Electron reliability qualification statistics and accounting', () => {
  it('requires 598 zero-failure invocations for the 0.5% one-sided bound', () => {
    expect(oneSidedBinomialUpperBound(0, 597)).toBeGreaterThan(0.005)
    expect(oneSidedBinomialUpperBound(0, 598)).toBeLessThanOrEqual(0.005)
    expect(oneSidedBinomialUpperBound(1, 598)).toBeGreaterThan(0.005)
  })

  it('passes only when both complete platform samples satisfy the bound', () => {
    const plan = qualificationPlan()
    const summary = combineElectronQualificationResults(plan, passingArtifacts(plan))
    expect(summary.passed).toBe(true)
    expect(summary.invocations).toHaveLength(1_196)
    expect(summary.platforms).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          platform: 'linux-x64',
          suiteCount: 4,
          scenarioCount: 21,
          fullSuiteInvocations: 598,
          runnerAllocations: 598,
          passes: 598,
          failures: 0,
          passed: true,
        }),
        expect.objectContaining({
          platform: 'macos-arm64',
          suiteCount: 1,
          scenarioCount: 9,
          fullSuiteInvocations: 598,
          runnerAllocations: 598,
          passes: 598,
          failures: 0,
          passed: true,
        }),
      ]),
    )
  })

  it('counts a missing infrastructure partition and every missing invocation as failures', () => {
    const plan = createElectronQualificationPlan({
      mode: 'weekly',
      sourceSha,
      reviewedSourceSha: sourceSha,
      runAttempt: 1,
    })
    const artifacts = passingArtifacts(plan).slice(1)
    const summary = combineElectronQualificationResults(plan, artifacts)
    const linux = summary.platforms.find((platform) => platform.platform === 'linux-x64')
    expect(summary.passed).toBe(false)
    expect(summary.invocations).toHaveLength(40)
    expect(linux).toMatchObject({ passes: 19, failures: 1, passed: false })
    expect(summary.invocations[0]).toMatchObject({
      status: 'failed',
      failure: 'missing-partition',
    })
  })

  it('counts an interrupted invocation whose initial record has no outcome', () => {
    const plan = createElectronQualificationPlan({
      mode: 'weekly',
      sourceSha,
      reviewedSourceSha: sourceSha,
      runAttempt: 1,
    })
    const artifacts = passingArtifacts(plan)
    const first = plan.matrix.include[0]!
    artifacts[0] = createElectronQualificationPartitionResult(plan, first)
    const summary = combineElectronQualificationResults(plan, artifacts)
    const linux = summary.platforms.find((platform) => platform.platform === 'linux-x64')
    expect(linux).toMatchObject({ passes: 19, failures: 1, passed: false })
    expect(summary.evidenceProblems).toEqual(['linux-x64 invocation 1: missing evidence'])
  })

  it('fails closed when passing evidence changes the selected scenarios', () => {
    const plan = createElectronQualificationPlan({
      mode: 'weekly',
      sourceSha,
      reviewedSourceSha: sourceSha,
      runAttempt: 1,
    })
    const artifacts = passingArtifacts(plan)
    const first = structuredClone(artifacts[0]) as ElectronQualificationPartitionResult
    const firstAttempt = first.attempts[0]!
    artifacts[0] = {
      ...first,
      attempts: [
        {
          ...firstAttempt,
          suites: [
            { ...firstAttempt.suites[0]!, scenarios: ['unselected-scenario'] },
            ...firstAttempt.suites.slice(1),
          ],
        },
        ...first.attempts.slice(1),
      ],
    }
    const summary = combineElectronQualificationResults(plan, artifacts)
    expect(summary.passed).toBe(false)
    expect(summary.invocations[0]).toMatchObject({
      status: 'failed',
      failure: 'invalid-evidence',
    })
    expect(summary.evidenceProblems).toContain(
      'linux-x64 invocation 1: invalid passing evidence',
    )
  })
})

function qualificationPlan(): ElectronQualificationPlan {
  return createElectronQualificationPlan({
    mode: 'qualification',
    sourceSha,
    reviewedSourceSha: sourceSha,
    runAttempt: 1,
  })
}

function passingArtifacts(plan: ElectronQualificationPlan): unknown[] {
  return plan.matrix.include.map((entry) =>
    createElectronQualificationPartitionResult(
      plan,
      entry,
      Array.from({ length: entry.attemptCount }, (_, offset) =>
        passingAttempt(entry.platform, entry.attemptStart + offset),
      ),
    ),
  )
}

function passingAttempt(
  platform: RequiredElectronPlatform,
  number: number,
): ElectronQualificationAttempt {
  return {
    number,
    status: 'passed',
    durationMs: 1,
    failure: null,
    suites: passingSuites(platform),
    failureArtifacts: [],
  }
}

function passingSuites(platform: RequiredElectronPlatform) {
  return REQUIRED_ELECTRON_SUITE_DEFINITIONS[platform].suites.map((suite) => ({
    id: suite.id,
    scenarios: suite.scenarios,
    status: 'passed' as const,
    durationMs: 1,
    exitCode: 0,
    signal: null,
    failure: null,
  }))
}
