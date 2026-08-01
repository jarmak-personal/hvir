import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

import {
  CI_WORKFLOW_NAME,
  CI_WORKFLOW_PATH,
  evaluateReleaseCiEvidence,
  REQUIRED_CI_JOBS,
  RELEASE_REPOSITORY,
  type CiWorkflowJob,
  type CiWorkflowRun,
  type ReleaseCiEvidence,
} from '../scripts/require-release-ci-evidence.mts'

const sourceSha = '1234567890abcdef1234567890abcdef12345678'
const ciWorkflow = parse(
  readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'),
) as {
  jobs: Record<
    string,
    {
      name: string
      strategy?: { matrix?: { include?: Array<{ name?: string }> } }
    }
  >
}

function requiredWorkflowJobNames(): string[] {
  return Object.entries(ciWorkflow.jobs).flatMap(([id, job]) => {
    if (id === 'signed-macos-epic-acceptance') return []
    const matrix = job.strategy?.matrix?.include
    if (!matrix) return [job.name]
    return matrix.map((entry) => job.name.replace('${{ matrix.name }}', entry.name ?? ''))
  })
}

function successfulRun(overrides: Partial<CiWorkflowRun> = {}): CiWorkflowRun {
  return {
    id: 42,
    name: CI_WORKFLOW_NAME,
    path: CI_WORKFLOW_PATH,
    repository: RELEASE_REPOSITORY,
    headRepository: RELEASE_REPOSITORY,
    event: 'push',
    headBranch: 'main',
    headSha: sourceSha,
    runAttempt: 1,
    status: 'completed',
    conclusion: 'success',
    ...overrides,
  }
}

function successfulJobs(): CiWorkflowJob[] {
  return REQUIRED_CI_JOBS.map((name) => ({
    name,
    status: 'completed',
    conclusion: 'success',
  }))
}

function evidence(overrides: Partial<ReleaseCiEvidence> = {}): ReleaseCiEvidence {
  return {
    sourceSha,
    defaultBranch: 'main',
    repository: RELEASE_REPOSITORY,
    runs: [successfulRun()],
    jobs: successfulJobs(),
    ...overrides,
  }
}

describe('release CI evidence', () => {
  it('enumerates every required CI job while excluding only the conditional bootstrap', () => {
    expect([...REQUIRED_CI_JOBS]).toEqual(requiredWorkflowJobNames())
  })

  it('accepts only successful first-attempt evidence for the exact source', () => {
    expect(evaluateReleaseCiEvidence(evidence())).toEqual({
      accepted: true,
      runId: 42,
    })
  })

  it('rejects missing and pending evidence', () => {
    expect(evaluateReleaseCiEvidence(evidence({ runs: [] }))).toEqual({
      accepted: false,
      rejection: 'missing-run',
    })
    expect(
      evaluateReleaseCiEvidence(
        evidence({
          runs: [successfulRun({ status: 'in_progress', conclusion: null })],
        }),
      ),
    ).toEqual({ accepted: false, rejection: 'pending-run' })
  })

  it.each(['failure', 'cancelled', 'skipped'])(
    'rejects a %s workflow conclusion',
    (conclusion) => {
      expect(
        evaluateReleaseCiEvidence(evidence({ runs: [successfulRun({ conclusion })] })),
      ).toEqual({ accepted: false, rejection: 'unsuccessful-run' })
    },
  )

  it('rejects evidence available only from a rerun', () => {
    expect(
      evaluateReleaseCiEvidence(evidence({ runs: [successfulRun({ runAttempt: 2 })] })),
    ).toEqual({ accepted: false, rejection: 'rerun-only' })
  })

  it.each([
    ['another SHA', { headSha: 'abcdef1234567890abcdef1234567890abcdef12' }],
    ['another repository', { repository: 'someone/hvir' }],
    ['a fork head', { headRepository: 'someone/hvir' }],
    ['another event', { event: 'pull_request' }],
    ['another branch', { headBranch: 'feature' }],
    ['another workflow name', { name: 'Release' }],
    ['another workflow path', { path: '.github/workflows/other.yml' }],
  ] satisfies Array<[string, Partial<CiWorkflowRun>]>)(
    'rejects a successful run for %s',
    (_description, runOverrides) => {
      expect(
        evaluateReleaseCiEvidence(evidence({ runs: [successfulRun(runOverrides)] })),
      ).toEqual({ accepted: false, rejection: 'missing-run' })
    },
  )

  it.each([
    ['pending', 'in_progress', null],
    ['failed', 'completed', 'failure'],
    ['cancelled', 'completed', 'cancelled'],
    ['skipped', 'completed', 'skipped'],
  ])('rejects a %s required job', (_description, status, conclusion) => {
    const jobs = successfulJobs()
    jobs[0] = { ...jobs[0]!, status, conclusion }
    expect(evaluateReleaseCiEvidence(evidence({ jobs }))).toEqual({
      accepted: false,
      rejection: status === 'completed' ? 'unsuccessful-job' : 'pending-job',
    })
  })

  it('rejects a missing required job while ignoring optional jobs', () => {
    const jobs = successfulJobs().slice(1)
    jobs.push({
      name: 'Signed native package acceptance (optional)',
      status: 'completed',
      conclusion: 'skipped',
    })
    expect(evaluateReleaseCiEvidence(evidence({ jobs }))).toEqual({
      accepted: false,
      rejection: 'missing-job',
    })
  })
})
