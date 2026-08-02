import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { parse } from 'yaml'

import {
  CI_WORKFLOW_NAME,
  CI_WORKFLOW_PATH,
  evaluateReleaseCiEvidence,
  requireReleaseCiEvidence,
  REQUIRED_CI_JOBS,
  RELEASE_REPOSITORY,
  waitForReleaseCiEvidence,
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
    if (id === 'release-version-integrity' || id === 'signed-macos-epic-acceptance') {
      return []
    }
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

function githubJson(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function releaseCiFetch(): ReturnType<typeof vi.fn> {
  return vi.fn((input: string | URL | Request) => {
    const url = input instanceof Request ? new URL(input.url) : new URL(input)
    if (url.pathname.endsWith('/actions/workflows/ci.yml/runs')) {
      return Promise.resolve(
        githubJson({
          workflow_runs: [
            {
              id: 42,
              name: CI_WORKFLOW_NAME,
              path: CI_WORKFLOW_PATH,
              repository: { full_name: RELEASE_REPOSITORY },
              head_repository: { full_name: RELEASE_REPOSITORY },
              event: 'push',
              head_branch: 'main',
              head_sha: sourceSha,
              run_attempt: 1,
              status: 'completed',
              conclusion: 'success',
            },
          ],
        }),
      )
    }
    if (url.pathname.endsWith('/actions/runs/42/attempts/1/jobs')) {
      return Promise.resolve(githubJson({ jobs: successfulJobs() }))
    }
    return Promise.resolve(new Response(null, { status: 404 }))
  })
}

function stubReleaseEnvironment(outputPath = ''): void {
  for (const [name, value] of Object.entries({
    GITHUB_REPOSITORY: RELEASE_REPOSITORY,
    GITHUB_DEFAULT_BRANCH: 'main',
    GITHUB_TOKEN: 'test-token',
    GITHUB_OUTPUT: outputPath,
    RELEASE_SOURCE_SHA: sourceSha,
  })) {
    vi.stubEnv(name, value)
  }
}

describe('release CI evidence', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('enumerates every required main-push job while excluding conditional PR-only jobs', () => {
    expect([...REQUIRED_CI_JOBS]).toEqual(requiredWorkflowJobNames())
  })

  it('accepts only successful first-attempt evidence for the exact source', () => {
    expect(evaluateReleaseCiEvidence(evidence())).toEqual({
      accepted: true,
      runId: 42,
    })
  })

  it('exposes the accepted exact-source run for immutable artifact download', async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'hvir-release-ci-'))
    onTestFinished(() => rm(temporaryDirectory, { recursive: true, force: true }))
    const outputPath = join(temporaryDirectory, 'output')
    stubReleaseEnvironment(outputPath)
    const fetchMock = releaseCiFetch()
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    await expect(requireReleaseCiEvidence()).resolves.toBe(42)

    await expect(readFile(outputPath, 'utf8')).resolves.toBe('run_id=42\n')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('requires the workflow output channel before loading CI evidence', async () => {
    stubReleaseEnvironment()
    const fetchMock = releaseCiFetch()
    vi.stubGlobal('fetch', fetchMock)

    await expect(requireReleaseCiEvidence()).rejects.toThrow(
      'GITHUB_OUTPUT is required',
    )
    expect(fetchMock).not.toHaveBeenCalled()
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

  it('waits through absent and pending evidence until exact CI succeeds', async () => {
    const observations = [
      evidence({ runs: [] }),
      evidence({
        runs: [successfulRun({ status: 'in_progress', conclusion: null })],
      }),
      evidence(),
    ]
    const sleeps: number[] = []
    let now = 0
    let loadCount = 0

    await expect(
      waitForReleaseCiEvidence({
        loadEvidence: () => Promise.resolve(observations[loadCount++]!),
        now: () => now,
        sleep: (milliseconds) => {
          sleeps.push(milliseconds)
          now += milliseconds
          return Promise.resolve()
        },
        pollIntervalMs: 10,
        maxWaitMs: 20,
      }),
    ).resolves.toBe(42)
    expect(loadCount).toBe(3)
    expect(sleeps).toEqual([10, 10])
  })

  it.each([
    [
      'an unsuccessful first attempt',
      evidence({ runs: [successfulRun({ conclusion: 'failure' })] }),
      'unsuccessful-run',
    ],
    [
      'rerun-only evidence',
      evidence({ runs: [successfulRun({ runAttempt: 2 })] }),
      'rerun-only',
    ],
  ] satisfies Array<[string, ReleaseCiEvidence, string]>)(
    'fails immediately for %s',
    async (_description, observation, rejection) => {
      let sleepCount = 0
      let loadCount = 0

      await expect(
        waitForReleaseCiEvidence({
          loadEvidence: () => {
            loadCount += 1
            return Promise.resolve(observation)
          },
          sleep: () => {
            sleepCount += 1
            return Promise.resolve()
          },
        }),
      ).rejects.toThrow(`Trusted CI evidence rejected: ${rejection}`)
      expect(loadCount).toBe(1)
      expect(sleepCount).toBe(0)
    },
  )

  it.each([
    ['absent', evidence({ runs: [] }), 'missing-run'],
    [
      'pending',
      evidence({
        runs: [successfulRun({ status: 'in_progress', conclusion: null })],
      }),
      'pending-run',
    ],
  ] satisfies Array<[string, ReleaseCiEvidence, string]>)(
    'fails closed when %s evidence outlives the bounded wait',
    async (_description, observation, rejection) => {
      const sleeps: number[] = []
      let now = 0
      let loadCount = 0

      await expect(
        waitForReleaseCiEvidence({
          loadEvidence: () => {
            loadCount += 1
            return Promise.resolve(observation)
          },
          now: () => now,
          sleep: (milliseconds) => {
            sleeps.push(milliseconds)
            now += milliseconds
            return Promise.resolve()
          },
          pollIntervalMs: 10,
          maxWaitMs: 20,
        }),
      ).rejects.toThrow(`Trusted CI evidence rejected after bounded wait: ${rejection}`)
      expect(loadCount).toBe(3)
      expect(sleeps).toEqual([10, 10])
    },
  )
})
