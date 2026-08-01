import { pathToFileURL } from 'node:url'

export const RELEASE_REPOSITORY = 'jarmak-personal/hvir'
export const CI_WORKFLOW_NAME = 'CI'
export const CI_WORKFLOW_PATH = '.github/workflows/ci.yml'

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

function requiredString(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('GitHub Actions evidence response was incomplete')
  }
  return value
}

function optionalString(value: unknown): string | null {
  if (value === null) return null
  return requiredString(value)
}

function requiredNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error('GitHub Actions evidence response was incomplete')
  }
  return value
}

async function requestJson<T>(url: URL, token: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  })
  if (!response.ok) {
    throw new Error(`GitHub Actions evidence request failed (${response.status})`)
  }
  try {
    return (await response.json()) as T
  } catch {
    throw new Error('GitHub Actions evidence response was invalid')
  }
}

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
  const response = await requestJson<GitHubRunResponse>(url, token)
  if (!Array.isArray(response.workflow_runs)) {
    throw new Error('GitHub Actions evidence response was incomplete')
  }
  return response.workflow_runs.map((run) => ({
    id: requiredNumber(run.id),
    name: requiredString(run.name),
    path: requiredString(run.path),
    repository: requiredString(run.repository?.full_name),
    headRepository:
      run.head_repository === null
        ? null
        : requiredString(run.head_repository?.full_name),
    event: requiredString(run.event),
    headBranch: optionalString(run.head_branch),
    headSha: requiredString(run.head_sha),
    runAttempt: requiredNumber(run.run_attempt),
    status: requiredString(run.status),
    conclusion: optionalString(run.conclusion),
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
  const response = await requestJson<GitHubJobsResponse>(url, token)
  if (!Array.isArray(response.jobs)) {
    throw new Error('GitHub Actions evidence response was incomplete')
  }
  return response.jobs.map((job) => ({
    name: requiredString(job.name),
    status: requiredString(job.status),
    conclusion: optionalString(job.conclusion),
  }))
}

function requireEnvironment(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

function requireFullSha(value: string): string {
  if (!/^[0-9a-f]{40}$/.test(value)) {
    throw new Error('RELEASE_SOURCE_SHA must be a full lowercase commit SHA')
  }
  return value
}

export async function requireReleaseCiEvidence(): Promise<void> {
  const repository = requireEnvironment('GITHUB_REPOSITORY')
  if (repository !== RELEASE_REPOSITORY) {
    throw new Error('Release CI evidence is restricted to the canonical repository')
  }
  const defaultBranch = requireEnvironment('GITHUB_DEFAULT_BRANCH')
  const sourceSha = requireFullSha(requireEnvironment('RELEASE_SOURCE_SHA'))
  const token = requireEnvironment('GITHUB_TOKEN')

  const runs = await loadMatchingRuns(repository, defaultBranch, sourceSha, token)
  const exactFirstAttempts = runs.filter(
    (run) =>
      isExactRun(run, { sourceSha, defaultBranch, repository, runs, jobs: [] }) &&
      run.runAttempt === 1,
  )
  const jobs =
    exactFirstAttempts.length === 1
      ? await loadFirstAttemptJobs(repository, exactFirstAttempts[0]!.id, token)
      : []
  const decision = evaluateReleaseCiEvidence({
    sourceSha,
    defaultBranch,
    repository,
    runs,
    jobs,
  })
  if (!decision.accepted) {
    throw new Error(`Trusted CI evidence rejected: ${decision.rejection}`)
  }

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
