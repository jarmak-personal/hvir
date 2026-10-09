import { readFileSync } from 'node:fs'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'

import {
  CI_WORKFLOW_NAME,
  CI_WORKFLOW_PATH,
  evaluateReleaseCiEvidence,
  loadReleaseCiEvidence,
  RELEASE_REPOSITORY,
  requireReleaseCiEvidence,
  formatCiEvidenceFailure,
  type CiWorkflowRun,
  type MergedPullRequest,
  type ReleaseCiEvidence,
} from '../scripts/require-release-ci-evidence.mts'
import {
  MERGE_ACCEPTANCE_JOB,
  RELEASE_VERSION_INTEGRITY_JOB,
  REQUIRED_CI_JOBS,
  type CiWorkflowJob,
} from '../scripts/ci-attempt-evidence.mts'

const baseSha = '1111111111111111111111111111111111111111'
const headSha = '2222222222222222222222222222222222222222'
const sourceSha = '3333333333333333333333333333333333333333'
const treeSha = '4444444444444444444444444444444444444444'
const otherSha = '5555555555555555555555555555555555555555'

const ciWorkflow = parse(
  readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'),
) as { jobs: Record<string, { name: string }> }

function pullRequest(overrides: Partial<MergedPullRequest> = {}): MergedPullRequest {
  return {
    number: 625,
    state: 'closed',
    mergedAt: '2026-08-20T12:00:00Z',
    mergeCommitSha: sourceSha,
    base: { ref: 'main', sha: baseSha, repository: RELEASE_REPOSITORY },
    head: {
      ref: 'agent/issue-625',
      sha: headSha,
      repository: RELEASE_REPOSITORY,
    },
    ...overrides,
  }
}

function workflowRun(overrides: Partial<CiWorkflowRun> = {}): CiWorkflowRun {
  const pr = pullRequest()
  return {
    id: 42,
    name: CI_WORKFLOW_NAME,
    path: CI_WORKFLOW_PATH,
    repository: RELEASE_REPOSITORY,
    headRepository: RELEASE_REPOSITORY,
    event: 'pull_request',
    headBranch: pr.head.ref,
    headSha: pr.head.sha,
    runAttempt: 1,
    runNumber: 1,
    pullRequests: [],
    status: 'completed',
    conclusion: 'success',
    ...overrides,
  }
}

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
    { name: MERGE_ACCEPTANCE_JOB, status: 'completed', conclusion: 'success' },
  ]
}

function evidence(overrides: Partial<ReleaseCiEvidence> = {}): ReleaseCiEvidence {
  return {
    sourceSha,
    defaultBranch: 'main',
    repository: RELEASE_REPOSITORY,
    pullRequests: [pullRequest()],
    runs: [workflowRun()],
    jobs: successfulJobs(),
    jobsRunId: 42,
    jobsRunAttempt: 1,
    baseToHead: { status: 'ahead', mergeBaseSha: baseSha },
    prBaseToHead: { status: 'ahead', mergeBaseSha: baseSha },
    sourceToDefault: { status: 'identical', mergeBaseSha: sourceSha },
    sourceCommit: { sha: sourceSha, treeSha, parents: [baseSha] },
    headCommit: { sha: headSha, treeSha, parents: [baseSha] },
    versionOnlyIntegrityAccepted: null,
    ...overrides,
  }
}

function githubJson(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function requestUrl(value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof URL) return value.href
  if (value instanceof Request) return value.url
  throw new Error('Unexpected request input')
}

function apiPullRequest(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    number: 625,
    state: 'closed',
    merged_at: '2026-08-20T12:00:00Z',
    merge_commit_sha: sourceSha,
    base: {
      ref: 'main',
      sha: baseSha,
      repo: { full_name: RELEASE_REPOSITORY },
    },
    head: {
      ref: 'agent/issue-625',
      sha: headSha,
      repo: { full_name: RELEASE_REPOSITORY },
    },
    ...overrides,
  }
}

function apiWorkflowRun(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 42,
    name: CI_WORKFLOW_NAME,
    path: CI_WORKFLOW_PATH,
    repository: { full_name: RELEASE_REPOSITORY },
    head_repository: { full_name: RELEASE_REPOSITORY },
    event: 'pull_request',
    head_branch: 'agent/issue-625',
    head_sha: headSha,
    run_attempt: 1,
    run_number: 1,
    status: 'completed',
    conclusion: 'success',
    pull_requests: [],
    ...overrides,
  }
}

function releaseCiFetch(): ReturnType<typeof vi.fn> {
  return vi.fn((input: string | URL | Request) => {
    const url = input instanceof Request ? new URL(input.url) : new URL(input)
    if (url.pathname.endsWith(`/commits/${sourceSha}/pulls`)) {
      return Promise.resolve(githubJson([apiPullRequest()]))
    }
    if (url.pathname.endsWith('/actions/workflows/ci.yml/runs')) {
      return Promise.resolve(githubJson({ workflow_runs: [apiWorkflowRun()] }))
    }
    if (url.pathname.endsWith('/actions/runs/42/attempts/1/jobs')) {
      return Promise.resolve(githubJson({ jobs: successfulJobs() }))
    }
    if (url.pathname.endsWith(`/compare/${baseSha}...${headSha}`)) {
      return Promise.resolve(
        githubJson({ status: 'ahead', merge_base_commit: { sha: baseSha } }),
      )
    }
    if (url.pathname.endsWith(`/compare/${sourceSha}...main`)) {
      return Promise.resolve(
        githubJson({ status: 'identical', merge_base_commit: { sha: sourceSha } }),
      )
    }
    if (url.pathname.endsWith(`/git/commits/${sourceSha}`)) {
      return Promise.resolve(
        githubJson({
          sha: sourceSha,
          tree: { sha: treeSha },
          parents: [{ sha: baseSha }],
        }),
      )
    }
    if (url.pathname.endsWith(`/git/commits/${headSha}`)) {
      return Promise.resolve(
        githubJson({
          sha: headSha,
          tree: { sha: treeSha },
          parents: [{ sha: baseSha }],
        }),
      )
    }
    return Promise.resolve(githubJson({ error: 'unexpected test URL' }, 404))
  })
}

function stubReleaseEnvironment(): void {
  for (const [name, value] of Object.entries({
    GITHUB_REPOSITORY: RELEASE_REPOSITORY,
    GITHUB_DEFAULT_BRANCH: 'main',
    GITHUB_TOKEN: 'test-token',
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

  it('keeps the required evidence list aligned with the CI workflow', () => {
    expect([...REQUIRED_CI_JOBS]).toEqual([
      ciWorkflow.jobs.verify?.name,
      ciWorkflow.jobs['electron-smoke']?.name,
      ciWorkflow.jobs['macos-electron-smoke']?.name,
      ciWorkflow.jobs.codeql?.name,
    ])
    expect(ciWorkflow.jobs['merge-acceptance']?.name).toBe(MERGE_ACCEPTANCE_JOB)
  })

  it('accepts an exact ordinary merged candidate', () => {
    expect(evaluateReleaseCiEvidence(evidence())).toEqual({
      accepted: true,
      kind: 'ordinary',
    })
  })

  it('accepts the permitted merge-commit parent shape for the same tree', () => {
    expect(
      evaluateReleaseCiEvidence(
        evidence({
          sourceCommit: {
            sha: sourceSha,
            treeSha,
            parents: [baseSha, headSha],
          },
        }),
      ),
    ).toEqual({ accepted: true, kind: 'ordinary' })
  })

  it('accepts the exact validator-backed version-only exception', () => {
    expect(
      evaluateReleaseCiEvidence(
        evidence({
          jobs: successfulJobs('version-only'),
          versionOnlyIntegrityAccepted: true,
        }),
      ),
    ).toEqual({ accepted: true, kind: 'version-only' })
  })

  it('rejects version-only skip evidence without exact validator acceptance', () => {
    expect(
      evaluateReleaseCiEvidence(evidence({ jobs: successfulJobs('version-only') })),
    ).toEqual({ accepted: false, rejection: 'invalid-version-only' })
  })

  it('rejects direct, ambiguous, unmerged, and non-canonical pull request evidence', () => {
    expect(evaluateReleaseCiEvidence(evidence({ pullRequests: [] }))).toEqual({
      accepted: false,
      rejection: 'missing-pull-request',
    })
    expect(
      evaluateReleaseCiEvidence(
        evidence({ pullRequests: [pullRequest(), pullRequest({ number: 626 })] }),
      ),
    ).toEqual({ accepted: false, rejection: 'ambiguous-pull-request' })
    for (const changed of [
      pullRequest({ mergedAt: null }),
      pullRequest({ state: 'open' }),
      pullRequest({ base: { ...pullRequest().base, ref: 'epic/511' } }),
      pullRequest({ head: { ...pullRequest().head, repository: 'someone/hvir' } }),
    ]) {
      expect(evaluateReleaseCiEvidence(evidence({ pullRequests: [changed] }))).toEqual({
        accepted: false,
        rejection: 'invalid-pull-request',
      })
    }
  })

  it('rejects wrong, duplicate, pending, and failed workflow evidence', () => {
    for (const changed of [
      workflowRun({ repository: 'someone/hvir' }),
      workflowRun({ headRepository: 'someone/hvir' }),
      workflowRun({ event: 'push' }),
      workflowRun({ name: 'Another workflow' }),
      workflowRun({ path: '.github/workflows/other.yml' }),
      workflowRun({ headSha: otherSha }),
      workflowRun({ headBranch: 'agent/another-issue' }),
    ]) {
      expect(evaluateReleaseCiEvidence(evidence({ runs: [changed] }))).toEqual({
        accepted: false,
        rejection: 'missing-run',
      })
    }
    expect(
      evaluateReleaseCiEvidence(
        evidence({ runs: [workflowRun(), workflowRun({ id: 43 })] }),
      ),
    ).toEqual({ accepted: false, rejection: 'ambiguous-run' })
    expect(
      evaluateReleaseCiEvidence(
        evidence({
          runs: [workflowRun({ status: 'in_progress', conclusion: null })],
        }),
      ),
    ).toEqual({ accepted: false, rejection: 'pending-run' })
    expect(
      evaluateReleaseCiEvidence(
        evidence({ runs: [workflowRun({ conclusion: 'failure' })] }),
      ),
    ).toEqual({ accepted: false, rejection: 'unsuccessful-run' })
  })

  it('accepts one complete rerun attempt and rejects partial-attempt job evidence', () => {
    const rerun = evidence({ runs: [workflowRun({ runAttempt: 2 })], jobsRunAttempt: 2 })
    expect(evaluateReleaseCiEvidence(rerun)).toEqual({
      accepted: true,
      kind: 'ordinary',
    })
    expect(
      evaluateReleaseCiEvidence({
        ...rerun,
        jobs: successfulJobs().filter((job) => job.name !== REQUIRED_CI_JOBS[0]),
      }),
    ).toEqual({ accepted: false, rejection: 'missing-job' })
  })

  it.each(['success', 'failure', 'cancelled'])(
    'selects the latest equivalent run after %s regardless of API order',
    (earlierConclusion) => {
      const earlier = workflowRun({ conclusion: earlierConclusion, runAttempt: 9 })
      const latest = workflowRun({ id: 43, runNumber: 2 })
      for (const runs of [
        [earlier, latest],
        [latest, earlier],
      ])
        expect(evaluateReleaseCiEvidence(evidence({ runs, jobsRunId: 43 }))).toEqual({
          accepted: true,
          kind: 'ordinary',
        })
    },
  )

  it.each(['pending', 'failure', 'partial'])(
    'does not fall back to an older success after newer %s evidence',
    (defect) => {
      const latest = workflowRun({
        id: 43,
        runNumber: 2,
        ...(defect === 'pending' ? { status: 'queued', conclusion: null } : {}),
        ...(defect === 'failure' ? { conclusion: 'failure' } : {}),
      })
      const current = evidence({
        runs: [latest, workflowRun()],
        jobsRunId: 43,
        ...(defect === 'partial' ? { jobs: successfulJobs().slice(1) } : {}),
      })
      expect(evaluateReleaseCiEvidence(current)).toEqual({
        accepted: false,
        rejection:
          defect === 'pending'
            ? 'pending-run'
            : defect === 'failure'
              ? 'unsuccessful-run'
              : 'missing-job',
      })
    },
  )

  it('requires proven equivalent bases and rejects contradictory run associations', () => {
    const pr = pullRequest()
    const association = {
      number: pr.number,
      head: pr.head,
      base: { ...pr.base, sha: otherSha },
      baseToHead: { status: 'ahead', mergeBaseSha: otherSha },
    }
    const current = evidence({ runs: [workflowRun({ pullRequests: [association] })] })
    expect(evaluateReleaseCiEvidence(current)).toEqual({
      accepted: true,
      kind: 'ordinary',
    })
    for (const changed of [
      { ...association, baseToHead: null },
      { ...association, baseToHead: { status: 'diverged', mergeBaseSha: baseSha } },
    ])
      expect(
        evaluateReleaseCiEvidence({
          ...current,
          runs: [workflowRun({ pullRequests: [changed] })],
        }),
      ).toEqual({ accepted: false, rejection: 'stale-base' })
    for (const changed of [
      { ...association, number: 999 },
      { ...association, head: { ...pr.head, sha: otherSha } },
      { ...association, base: { ...pr.base, ref: 'epic/other' } },
      { ...association, head: { ...pr.head, repository: 'other/repo' } },
    ])
      expect(
        evaluateReleaseCiEvidence({
          ...current,
          runs: [workflowRun({ pullRequests: [changed] })],
        }),
      ).toEqual({ accepted: false, rejection: 'changed-candidate' })
  })

  it('ignores unrelated runs and rejects unresolved creation order and cross-run/attempt jobs', () => {
    expect(
      evaluateReleaseCiEvidence(
        evidence({
          runs: [
            workflowRun(),
            workflowRun({ id: 90, runNumber: 90, headSha: otherSha }),
          ],
        }),
      ),
    ).toEqual({ accepted: true, kind: 'ordinary' })
    for (const runNumber of [0, NaN, 1.5])
      expect(
        evaluateReleaseCiEvidence(evidence({ runs: [workflowRun({ runNumber })] })),
      ).toEqual({ accepted: false, rejection: 'ambiguous-run' })
    for (const changes of [{ jobsRunId: 43 }, { jobsRunAttempt: 2 }])
      expect(evaluateReleaseCiEvidence(evidence(changes))).toEqual({
        accepted: false,
        rejection: 'changed-candidate',
      })
    expect(
      evaluateReleaseCiEvidence(
        evidence({ jobs: [...successfulJobs(), successfulJobs()[1]!] }),
      ),
    ).toEqual({ accepted: false, rejection: 'ambiguous-job' })
    const message = formatCiEvidenceFailure(evidence(), 'missing-job')
    for (const identity of [
      'PR #625',
      baseSha,
      headSha,
      sourceSha,
      'run=42',
      'attempt=1',
      'full workflow rerun',
    ])
      expect(message).toContain(identity)
  })

  it('loads only the latest run current attempt, including when it is incomplete', async () => {
    const fallback = releaseCiFetch()
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(input)
      if (url.pathname.endsWith('/actions/workflows/ci.yml/runs'))
        return Promise.resolve(
          githubJson({
            workflow_runs: [
              apiWorkflowRun({ id: 43, run_number: 2, run_attempt: 3 }),
              apiWorkflowRun(),
            ],
          }),
        )
      if (url.pathname.endsWith('/actions/runs/43/attempts/3/jobs'))
        return Promise.resolve(githubJson({ jobs: successfulJobs().slice(1) }))
      return (fallback as (value: string | URL | Request) => Promise<Response>)(input)
    })
    vi.stubGlobal('fetch', fetchMock)
    const current = await loadReleaseCiEvidence(
      RELEASE_REPOSITORY,
      'main',
      sourceSha,
      'test-token',
    )
    expect(evaluateReleaseCiEvidence(current)).toEqual({
      accepted: false,
      rejection: 'missing-job',
    })
    expect(
      fetchMock.mock.calls
        .map(([input]) => requestUrl(input))
        .some((url) => url.includes('/runs/42/')),
    ).toBe(false)
  })

  it('rejects a source without the exact merge or squash parent shape', () => {
    for (const sourceCommit of [
      { sha: otherSha, treeSha, parents: [baseSha] },
      { sha: sourceSha, treeSha, parents: [] },
      { sha: sourceSha, treeSha, parents: [baseSha, otherSha] },
      { sha: sourceSha, treeSha, parents: [baseSha, headSha, otherSha] },
    ]) {
      expect(evaluateReleaseCiEvidence(evidence({ sourceCommit }))).toEqual({
        accepted: false,
        rejection: 'changed-candidate',
      })
    }
  })

  it('rejects stale bases, unreachable sources, and changed merge trees', () => {
    expect(
      evaluateReleaseCiEvidence(
        evidence({ baseToHead: { status: 'diverged', mergeBaseSha: otherSha } }),
      ),
    ).toEqual({ accepted: false, rejection: 'stale-base' })
    expect(
      evaluateReleaseCiEvidence(
        evidence({
          sourceToDefault: { status: 'diverged', mergeBaseSha: otherSha },
        }),
      ),
    ).toEqual({ accepted: false, rejection: 'unreachable-source' })
    expect(
      evaluateReleaseCiEvidence(
        evidence({
          headCommit: { sha: headSha, treeSha: otherSha, parents: [baseSha] },
        }),
      ),
    ).toEqual({ accepted: false, rejection: 'changed-tree' })
  })

  it('rejects missing, duplicate, pending, failed, cancelled, and skipped-required jobs', () => {
    const names = [
      RELEASE_VERSION_INTEGRITY_JOB,
      ...REQUIRED_CI_JOBS,
      MERGE_ACCEPTANCE_JOB,
    ]
    for (const name of names) {
      expect(
        evaluateReleaseCiEvidence(
          evidence({ jobs: successfulJobs().filter((job) => job.name !== name) }),
        ),
      ).toEqual({ accepted: false, rejection: 'missing-job' })
      const duplicate = successfulJobs()
      duplicate.push({ ...duplicate.find((job) => job.name === name)! })
      expect(evaluateReleaseCiEvidence(evidence({ jobs: duplicate }))).toEqual({
        accepted: false,
        rejection: 'ambiguous-job',
      })
    }

    for (const [status, conclusion, rejection] of [
      ['in_progress', null, 'pending-job'],
      ['completed', 'failure', 'unsuccessful-job'],
      ['completed', 'cancelled', 'unsuccessful-job'],
      ['completed', 'skipped', 'unsuccessful-job'],
    ] as const) {
      const jobs = successfulJobs()
      const index = jobs.findIndex((job) => job.name === REQUIRED_CI_JOBS[0])
      jobs[index] = { ...jobs[index]!, status, conclusion }
      expect(evaluateReleaseCiEvidence(evidence({ jobs }))).toEqual({
        accepted: false,
        rejection,
      })
    }
  })

  it('loads bounded exact-source metadata and accepts the decision', async () => {
    stubReleaseEnvironment()
    const fetchMock = releaseCiFetch()
    vi.stubGlobal('fetch', fetchMock)
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    await expect(requireReleaseCiEvidence()).resolves.toBeUndefined()
    expect(stdout).toHaveBeenCalledWith('Trusted ordinary merge evidence accepted.\n')
    expect(fetchMock).toHaveBeenCalledTimes(7)
    for (const call of fetchMock.mock.calls) {
      expect((call[1] as RequestInit | undefined)?.method).toBeUndefined()
      expect((call[1] as RequestInit | undefined)?.headers).toMatchObject({
        Authorization: 'Bearer test-token',
      })
    }
  })

  it('loads jobs only from the workflow run current attempt', async () => {
    const baseFetch = releaseCiFetch()
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(input)
      if (url.pathname.endsWith('/actions/workflows/ci.yml/runs')) {
        return Promise.resolve(
          githubJson({ workflow_runs: [apiWorkflowRun({ run_attempt: 2 })] }),
        )
      }
      if (url.pathname.endsWith('/actions/runs/42/attempts/2/jobs')) {
        return Promise.resolve(githubJson({ jobs: successfulJobs() }))
      }
      return (baseFetch as (value: string | URL | Request) => Promise<Response>)(input)
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      loadReleaseCiEvidence(RELEASE_REPOSITORY, 'main', sourceSha, 'test-token'),
    ).resolves.toMatchObject({
      runs: [expect.objectContaining({ runAttempt: 2 })],
      jobs: successfulJobs(),
    })
    expect(
      fetchMock.mock.calls.some((call) =>
        new URL(requestUrl(call[0])).pathname.endsWith(
          '/actions/runs/42/attempts/1/jobs',
        ),
      ),
    ).toBe(false)
  })

  it('paginates complete metadata instead of choosing from a truncated first page', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) =>
      apiPullRequest({ number: index + 1, merge_commit_sha: otherSha }),
    )
    const baseFetch = releaseCiFetch()
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(input)
      if (url.pathname.endsWith(`/commits/${sourceSha}/pulls`)) {
        return Promise.resolve(
          githubJson(
            url.searchParams.get('page') === '1' ? firstPage : [apiPullRequest()],
          ),
        )
      }
      return (baseFetch as (value: string | URL | Request) => Promise<Response>)(input)
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      loadReleaseCiEvidence(RELEASE_REPOSITORY, 'main', sourceSha, 'test-token'),
    ).resolves.toMatchObject({ pullRequests: { length: 101 } })
    expect(
      fetchMock.mock.calls.filter((call) =>
        new URL(requestUrl(call[0])).pathname.endsWith(`/commits/${sourceSha}/pulls`),
      ),
    ).toHaveLength(2)
  })

  it('fails closed when bounded metadata pagination does not terminate', async () => {
    const fullPage = Array.from({ length: 100 }, (_, index) =>
      apiPullRequest({ number: index + 1, merge_commit_sha: otherSha }),
    )
    const fetchMock = vi.fn(() => Promise.resolve(githubJson(fullPage)))
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      loadReleaseCiEvidence(RELEASE_REPOSITORY, 'main', sourceSha, 'test-token'),
    ).rejects.toThrow('GitHub merge evidence response was incomplete')
    expect(fetchMock).toHaveBeenCalledTimes(10)
  })

  it('loads a different proven CI base and rejects unproven association trees', async () => {
    const fallback = releaseCiFetch()
    const association = {
      number: 625,
      base: {
        ref: 'main',
        sha: otherSha,
        repo: { url: `https://api.github.com/repos/${RELEASE_REPOSITORY}` },
      },
      head: {
        ref: 'agent/issue-625',
        sha: headSha,
        repo: { url: `https://api.github.com/repos/${RELEASE_REPOSITORY}` },
      },
    }
    for (const status of ['ahead', 'diverged']) {
      vi.stubGlobal(
        'fetch',
        vi.fn((input: string | URL | Request) => {
          const url = new URL(requestUrl(input))
          if (url.pathname.endsWith('/actions/workflows/ci.yml/runs'))
            return Promise.resolve(
              githubJson({
                workflow_runs: [apiWorkflowRun({ pull_requests: [association] })],
              }),
            )
          if (url.pathname.endsWith(`/compare/${otherSha}...${headSha}`))
            return Promise.resolve(
              githubJson({
                status,
                merge_base_commit: { sha: status === 'ahead' ? otherSha : baseSha },
              }),
            )
          return (fallback as (value: string | URL | Request) => Promise<Response>)(input)
        }),
      )
      const current = await loadReleaseCiEvidence(
        RELEASE_REPOSITORY,
        'main',
        sourceSha,
        'test-token',
      )
      expect(evaluateReleaseCiEvidence(current)).toEqual(
        status === 'ahead'
          ? { accepted: true, kind: 'ordinary' }
          : { accepted: false, rejection: 'stale-base' },
      )
    }
  })

  it('distinguishes unavailable API reads from absent evidence without leaking errors', async () => {
    stubReleaseEnvironment()
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('secret-token response data'))),
    )
    const failure = requireReleaseCiEvidence()
    await expect(failure).rejects.toThrow(/API unavailable.*restore connectivity/)
    await expect(failure).rejects.not.toThrow('secret-token')
  })

  it('requires all local inputs before making an evidence request', async () => {
    stubReleaseEnvironment()
    vi.stubEnv('GITHUB_TOKEN', '')
    const fetchMock = releaseCiFetch()
    vi.stubGlobal('fetch', fetchMock)
    await expect(requireReleaseCiEvidence()).rejects.toThrow('GITHUB_TOKEN is required')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports only the status of a failed GitHub evidence request', async () => {
    stubReleaseEnvironment()
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(new Response('sensitive response body', { status: 500 })),
      ),
    )
    const failure = requireReleaseCiEvidence()
    await expect(failure).rejects.toThrow('GitHub merge evidence request failed (500)')
    await expect(failure).rejects.not.toThrow('sensitive response body')
  })
})
