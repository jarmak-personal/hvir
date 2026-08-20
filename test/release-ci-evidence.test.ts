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
  loadReleaseCiEvidence,
  MERGE_ACCEPTANCE_JOB,
  RELEASE_REPOSITORY,
  RELEASE_VERSION_INTEGRITY_JOB,
  requireReleaseCiEvidence,
  REQUIRED_CI_JOBS,
  type CiWorkflowJob,
  type CiWorkflowRun,
  type MergedPullRequest,
  type ReleaseCiEvidence,
} from '../scripts/require-release-ci-evidence.mts'

const baseSha = '1111111111111111111111111111111111111111'
const headSha = '2222222222222222222222222222222222222222'
const sourceSha = '3333333333333333333333333333333333333333'
const treeSha = '4444444444444444444444444444444444444444'
const otherSha = '5555555555555555555555555555555555555555'

const ciWorkflow = parse(
  readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'),
) as { jobs: Record<string, { name: string }> }

function pullRequest(
  overrides: Partial<MergedPullRequest> = {},
): MergedPullRequest {
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
    baseToHead: { status: 'ahead', mergeBaseSha: baseSha },
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

function apiPullRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

function apiWorkflowRun(): Record<string, unknown> {
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
    status: 'completed',
    conclusion: 'success',
    pull_requests: [],
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
      runId: 42,
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
    ).toEqual({ accepted: true, runId: 42, kind: 'ordinary' })
  })

  it('accepts the exact validator-backed version-only exception', () => {
    expect(
      evaluateReleaseCiEvidence(
        evidence({
          jobs: successfulJobs('version-only'),
          versionOnlyIntegrityAccepted: true,
        }),
      ),
    ).toEqual({ accepted: true, runId: 42, kind: 'version-only' })
  })

  it('rejects version-only skip evidence without exact validator acceptance', () => {
    expect(
      evaluateReleaseCiEvidence(
        evidence({ jobs: successfulJobs('version-only') }),
      ),
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
      expect(
        evaluateReleaseCiEvidence(evidence({ pullRequests: [changed] })),
      ).toEqual({ accepted: false, rejection: 'invalid-pull-request' })
    }
  })

  it('rejects wrong, duplicate, pending, failed, and rerun-only workflow evidence', () => {
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
      evaluateReleaseCiEvidence(evidence({ runs: [workflowRun({ runAttempt: 2 })] })),
    ).toEqual({ accepted: false, rejection: 'rerun-only' })
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

  it('rejects a source without the exact merge or squash parent shape', () => {
    for (const sourceCommit of [
      { sha: otherSha, treeSha, parents: [baseSha] },
      { sha: sourceSha, treeSha, parents: [] },
      { sha: sourceSha, treeSha, parents: [baseSha, otherSha] },
      { sha: sourceSha, treeSha, parents: [baseSha, headSha, otherSha] },
    ]) {
      expect(
        evaluateReleaseCiEvidence(evidence({ sourceCommit })),
      ).toEqual({ accepted: false, rejection: 'changed-candidate' })
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

  it('loads bounded exact-source metadata and writes the accepted run', async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'hvir-release-ci-'))
    onTestFinished(() => rm(temporaryDirectory, { recursive: true, force: true }))
    const outputPath = join(temporaryDirectory, 'output')
    stubReleaseEnvironment(outputPath)
    const fetchMock = releaseCiFetch()
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    await expect(requireReleaseCiEvidence()).resolves.toBe(42)
    await expect(readFile(outputPath, 'utf8')).resolves.toBe('run_id=42\n')
    expect(fetchMock).toHaveBeenCalledTimes(7)
    for (const call of fetchMock.mock.calls) {
      expect((call[1] as RequestInit | undefined)?.method).toBeUndefined()
      expect((call[1] as RequestInit | undefined)?.headers).toMatchObject({
        Authorization: 'Bearer test-token',
      })
    }
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
          githubJson(url.searchParams.get('page') === '1' ? firstPage : [apiPullRequest()]),
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

  it('requires all local inputs before making an evidence request', async () => {
    stubReleaseEnvironment()
    const fetchMock = releaseCiFetch()
    vi.stubGlobal('fetch', fetchMock)
    await expect(requireReleaseCiEvidence()).rejects.toThrow('GITHUB_OUTPUT is required')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports only the status of a failed GitHub evidence request', async () => {
    stubReleaseEnvironment('/tmp/output')
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
