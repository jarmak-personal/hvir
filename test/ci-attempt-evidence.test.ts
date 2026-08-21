import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  evaluateCiAttemptPrerequisites,
  loadCiAttemptJobs,
  MERGE_ACCEPTANCE_JOB,
  RELEASE_VERSION_INTEGRITY_JOB,
  REQUIRED_CI_JOBS,
  requireCiAttemptEvidence,
  type CiWorkflowJob,
} from '../scripts/ci-attempt-evidence.mts'

function successfulJobs(kind: 'ordinary' | 'version-only' = 'ordinary'): CiWorkflowJob[] {
  return [
    {
      name: RELEASE_VERSION_INTEGRITY_JOB,
      status: 'completed',
      conclusion: kind === 'version-only' ? 'success' : 'skipped',
    },
    ...REQUIRED_CI_JOBS.map((name) => ({
      name,
      status: 'completed',
      conclusion: kind === 'version-only' ? 'skipped' : 'success',
    })),
  ]
}

function githubJson(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function requestUrl(value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof URL) return value.href
  if (value instanceof Request) return value.url
  throw new Error('Unexpected request input')
}

describe('coherent CI attempt evidence', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('accepts complete ordinary and version-only prerequisite sets', () => {
    expect(evaluateCiAttemptPrerequisites(successfulJobs())).toEqual({
      accepted: true,
      kind: 'ordinary',
    })
    expect(evaluateCiAttemptPrerequisites(successfulJobs('version-only'))).toEqual({
      accepted: true,
      kind: 'version-only',
    })
  })

  it('rejects partial, duplicate, pending, and unsuccessful prerequisite sets', () => {
    const partial = successfulJobs().filter((job) => job.name !== REQUIRED_CI_JOBS[0])
    expect(evaluateCiAttemptPrerequisites(partial)).toEqual({
      accepted: false,
      rejection: 'missing-job',
    })

    const duplicate = successfulJobs()
    duplicate.push({ ...duplicate[0]! })
    expect(evaluateCiAttemptPrerequisites(duplicate)).toEqual({
      accepted: false,
      rejection: 'ambiguous-job',
    })

    for (const [status, conclusion, rejection] of [
      ['in_progress', null, 'pending-job'],
      ['completed', 'failure', 'unsuccessful-job'],
      ['completed', 'cancelled', 'unsuccessful-job'],
    ] as const) {
      const jobs = successfulJobs()
      jobs[1] = { ...jobs[1]!, status, conclusion }
      expect(evaluateCiAttemptPrerequisites(jobs)).toEqual({
        accepted: false,
        rejection,
      })
    }
  })

  it('loads and accepts only the exact current workflow attempt', async () => {
    vi.stubEnv('GITHUB_REPOSITORY', 'jarmak-personal/hvir')
    vi.stubEnv('GITHUB_RUN_ID', '42')
    vi.stubEnv('GITHUB_RUN_ATTEMPT', '2')
    vi.stubEnv('GITHUB_TOKEN', 'test-token')
    const fetchMock = vi.fn((_input: string | URL | Request, _init?: RequestInit) =>
      Promise.resolve(
        githubJson({
          jobs: [
            ...successfulJobs('version-only'),
            {
              name: MERGE_ACCEPTANCE_JOB,
              status: 'in_progress',
              conclusion: null,
            },
          ],
        }),
      ),
    )
    vi.stubGlobal('fetch', fetchMock)
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    await expect(requireCiAttemptEvidence()).resolves.toBeUndefined()
    expect(stdout).toHaveBeenCalledWith('Coherent version-only CI attempt accepted.\n')
    expect(fetchMock).toHaveBeenCalledOnce()
    const request = new URL(requestUrl(fetchMock.mock.calls[0]![0]))
    expect(request.pathname).toBe(
      '/repos/jarmak-personal/hvir/actions/runs/42/attempts/2/jobs',
    )
    expect(fetchMock.mock.calls[0]![1]?.headers).toMatchObject({
      Authorization: 'Bearer test-token',
    })
  })

  it('fails closed when the exact attempt contains only rerun jobs', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          githubJson({
            jobs: successfulJobs().filter(
              (job) => job.name === RELEASE_VERSION_INTEGRITY_JOB,
            ),
          }),
        ),
      ),
    )

    const jobs = await loadCiAttemptJobs('jarmak-personal/hvir', 42, 3, 'test-token')
    expect(evaluateCiAttemptPrerequisites(jobs)).toEqual({
      accepted: false,
      rejection: 'missing-job',
    })
  })
})
