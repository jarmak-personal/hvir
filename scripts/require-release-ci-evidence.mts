import { pathToFileURL } from 'node:url'

import {
  ReleaseGitHubEvidenceReader,
  requireFullCommitSha,
  requireReleaseEnvironment,
} from './release-github-evidence.mts'

export const RELEASE_REPOSITORY = 'jarmak-personal/hvir'
export const CI_WORKFLOW_NAME = 'CI'
export const CI_WORKFLOW_PATH = '.github/workflows/ci.yml'
export const RELEASE_CI_POLL_INTERVAL_MS = 10_000
export const RELEASE_CI_MAX_WAIT_MS = 10 * 60_000

export const REQUIRED_CI_JOBS = [
  'Verification (Linux)',
  'Electron smoke (Linux)',
  'Capacity contracts + performance evidence (Linux)',
  'Electron correctness (macOS arm64; temporary reduced gate)',
  'Native package acceptance (Linux x64)',
  'Native package acceptance (Linux arm64)',
  'Native package acceptance (macOS arm64, unsigned structure)',
  'Native release assembly (unsigned structure)',
] as const

export interface CiWorkflowRun {
  id: number
  name: string
  path: string
  repository: string
  headRepository: string | null
  event: string
  headBranch: string | null
  headSha: string
  runAttempt: number
  status: string
  conclusion: string | null
}

export interface CiWorkflowJob {
  name: string
  status: string
  conclusion: string | null
}

export type EvidenceRejection =
  | 'missing-run'
  | 'rerun-only'
  | 'ambiguous-run'
  | 'pending-run'
  | 'unsuccessful-run'
  | 'missing-job'
  | 'ambiguous-job'
  | 'pending-job'
  | 'unsuccessful-job'

export type EvidenceDecision =
  { accepted: true; runId: number } | { accepted: false; rejection: EvidenceRejection }

export interface ReleaseCiEvidence {
  sourceSha: string
  defaultBranch: string
  repository: string
  runs: readonly CiWorkflowRun[]
  jobs: readonly CiWorkflowJob[]
}

export interface ReleaseCiEvidenceWaitOptions {
  loadEvidence: () => Promise<ReleaseCiEvidence>
  sleep?: (milliseconds: number) => Promise<void>
  now?: () => number
  pollIntervalMs?: number
  maxWaitMs?: number
  onTransient?: (rejection: 'missing-run' | 'pending-run') => void
}

function isExactRun(run: CiWorkflowRun, evidence: ReleaseCiEvidence): boolean {
  return (
    run.name === CI_WORKFLOW_NAME &&
    run.path === CI_WORKFLOW_PATH &&
    run.repository === evidence.repository &&
    run.headRepository === evidence.repository &&
    run.event === 'push' &&
    run.headBranch === evidence.defaultBranch &&
    run.headSha === evidence.sourceSha
  )
}

export function evaluateReleaseCiEvidence(evidence: ReleaseCiEvidence): EvidenceDecision {
  const exactRuns = evidence.runs.filter((run) => isExactRun(run, evidence))
  const firstAttempts = exactRuns.filter((run) => run.runAttempt === 1)

  if (firstAttempts.length === 0) {
    return {
      accepted: false,
      rejection: exactRuns.some((run) => run.runAttempt > 1)
        ? 'rerun-only'
        : 'missing-run',
    }
  }
  if (firstAttempts.length !== 1) {
    return { accepted: false, rejection: 'ambiguous-run' }
  }

  const run = firstAttempts[0]!
  if (run.status !== 'completed') {
    return { accepted: false, rejection: 'pending-run' }
  }
  if (run.conclusion !== 'success') {
    return { accepted: false, rejection: 'unsuccessful-run' }
  }

  for (const requiredName of REQUIRED_CI_JOBS) {
    const matches = evidence.jobs.filter((job) => job.name === requiredName)
    if (matches.length === 0) {
      return { accepted: false, rejection: 'missing-job' }
    }
    if (matches.length !== 1) {
      return { accepted: false, rejection: 'ambiguous-job' }
    }
    const job = matches[0]!
    if (job.status !== 'completed') {
      return { accepted: false, rejection: 'pending-job' }
    }
    if (job.conclusion !== 'success') {
      return { accepted: false, rejection: 'unsuccessful-job' }
    }
  }

  return { accepted: true, runId: run.id }
}

interface GitHubRunResponse {
  workflow_runs?: Array<{
    id?: unknown
    name?: unknown
    path?: unknown
    repository?: { full_name?: unknown }
    head_repository?: { full_name?: unknown } | null
    event?: unknown
    head_branch?: unknown
    head_sha?: unknown
    run_attempt?: unknown
    status?: unknown
    conclusion?: unknown
  }>
}

interface GitHubJobsResponse {
  jobs?: Array<{
    name?: unknown
    status?: unknown
    conclusion?: unknown
  }>
}
const githubEvidence = new ReleaseGitHubEvidenceReader('GitHub Actions evidence')

async function loadMatchingRuns(
  repository: string,
  defaultBranch: string,
  sourceSha: string,
  token: string,
): Promise<CiWorkflowRun[]> {
  const url = new URL(
    `https://api.github.com/repos/${repository}/actions/workflows/ci.yml/runs`,
  )
  url.searchParams.set('branch', defaultBranch)
  url.searchParams.set('event', 'push')
  url.searchParams.set('head_sha', sourceSha)
  url.searchParams.set('per_page', '100')
  const response = await githubEvidence.requestJson<GitHubRunResponse>(url, token)
  if (!Array.isArray(response.workflow_runs)) {
    throw new Error('GitHub Actions evidence response was incomplete')
  }
  return response.workflow_runs.map((run) => ({
    id: githubEvidence.requiredNumber(run.id),
    name: githubEvidence.requiredString(run.name),
    path: githubEvidence.requiredString(run.path),
    repository: githubEvidence.requiredString(run.repository?.full_name),
    headRepository:
      run.head_repository === null
        ? null
        : githubEvidence.requiredString(run.head_repository?.full_name),
    event: githubEvidence.requiredString(run.event),
    headBranch: githubEvidence.nullableString(run.head_branch),
    headSha: githubEvidence.requiredString(run.head_sha),
    runAttempt: githubEvidence.requiredNumber(run.run_attempt),
    status: githubEvidence.requiredString(run.status),
    conclusion: githubEvidence.nullableString(run.conclusion),
  }))
}

async function loadFirstAttemptJobs(
  repository: string,
  runId: number,
  token: string,
): Promise<CiWorkflowJob[]> {
  const url = new URL(
    `https://api.github.com/repos/${repository}/actions/runs/${runId}/attempts/1/jobs`,
  )
  url.searchParams.set('per_page', '100')
  const response = await githubEvidence.requestJson<GitHubJobsResponse>(url, token)
  if (!Array.isArray(response.jobs)) {
    throw new Error('GitHub Actions evidence response was incomplete')
  }
  return response.jobs.map((job) => ({
    name: githubEvidence.requiredString(job.name),
    status: githubEvidence.requiredString(job.status),
    conclusion: githubEvidence.nullableString(job.conclusion),
  }))
}

async function loadReleaseCiEvidence(
  repository: string,
  defaultBranch: string,
  sourceSha: string,
  token: string,
): Promise<ReleaseCiEvidence> {
  const runs = await loadMatchingRuns(repository, defaultBranch, sourceSha, token)
  const exactFirstAttempts = runs.filter(
    (run) =>
      isExactRun(run, { sourceSha, defaultBranch, repository, runs, jobs: [] }) &&
      run.runAttempt === 1,
  )
  const exactRun = exactFirstAttempts.length === 1 ? exactFirstAttempts[0]! : null
  const jobs =
    exactRun?.status === 'completed' && exactRun.conclusion === 'success'
      ? await loadFirstAttemptJobs(repository, exactRun.id, token)
      : []

  return { sourceSha, defaultBranch, repository, runs, jobs }
}

function rejectEvidence(rejection: EvidenceRejection): never {
  throw new Error(`Trusted CI evidence rejected: ${rejection}`)
}

export async function waitForReleaseCiEvidence(
  options: ReleaseCiEvidenceWaitOptions,
): Promise<number> {
  const sleep =
    options.sleep ??
    ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
  const now = options.now ?? Date.now
  const pollIntervalMs = options.pollIntervalMs ?? RELEASE_CI_POLL_INTERVAL_MS
  const maxWaitMs = options.maxWaitMs ?? RELEASE_CI_MAX_WAIT_MS
  if (pollIntervalMs <= 0 || maxWaitMs < 0) {
    throw new Error('Release CI evidence wait configuration is invalid')
  }

  const startedAt = now()
  while (true) {
    const decision = evaluateReleaseCiEvidence(await options.loadEvidence())
    if (decision.accepted) return decision.runId

    if (decision.rejection !== 'missing-run' && decision.rejection !== 'pending-run') {
      rejectEvidence(decision.rejection)
    }

    const remainingMs = maxWaitMs - (now() - startedAt)
    if (remainingMs <= 0) {
      throw new Error(
        `Trusted CI evidence rejected after bounded wait: ${decision.rejection}`,
      )
    }

    options.onTransient?.(decision.rejection)
    await sleep(Math.min(pollIntervalMs, remainingMs))
  }
}

export async function requireReleaseCiEvidence(): Promise<void> {
  const repository = requireReleaseEnvironment('GITHUB_REPOSITORY')
  if (repository !== RELEASE_REPOSITORY) {
    throw new Error('Release CI evidence is restricted to the canonical repository')
  }
  const defaultBranch = requireReleaseEnvironment('GITHUB_DEFAULT_BRANCH')
  const sourceSha = requireFullCommitSha(
    'RELEASE_SOURCE_SHA',
    requireReleaseEnvironment('RELEASE_SOURCE_SHA'),
  )
  const token = requireReleaseEnvironment('GITHUB_TOKEN')

  await waitForReleaseCiEvidence({
    loadEvidence: () =>
      loadReleaseCiEvidence(repository, defaultBranch, sourceSha, token),
    onTransient: (rejection) => {
      process.stdout.write(
        `Trusted CI evidence is not ready (${rejection}); checking again.\n`,
      )
    },
  })

  process.stdout.write(`Trusted first-attempt CI evidence accepted for ${sourceSha}.\n`)
}

const invokedPath = process.argv[1]
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  try {
    await requireReleaseCiEvidence()
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown evidence error'
    process.stderr.write(`::error::${message}\n`)
    process.exitCode = 1
  }
}
