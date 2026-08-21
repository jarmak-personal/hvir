import { pathToFileURL } from 'node:url'

import {
  ReleaseGitHubEvidenceReader,
  requireReleaseEnvironment,
} from './release-github-evidence.mts'

export const RELEASE_VERSION_INTEGRITY_JOB = 'Release version integrity'
export const MERGE_ACCEPTANCE_JOB = 'Merge acceptance'
export const REQUIRED_CI_JOBS = [
  'Verification (Linux)',
  'Electron smoke (Linux)',
  'Electron correctness (macOS arm64; temporary reduced gate)',
  'CodeQL analysis',
] as const

const PAGE_SIZE = 100
const MAX_EVIDENCE_PAGES = 10

export interface CiWorkflowJob {
  name: string
  status: string
  conclusion: string | null
}

export type CiAttemptEvidenceRejection =
  'missing-job' | 'ambiguous-job' | 'pending-job' | 'unsuccessful-job'

export type CiAttemptDecision =
  | { accepted: true; kind: 'ordinary' | 'version-only' }
  | { accepted: false; rejection: CiAttemptEvidenceRejection }

interface GitHubJobsResponse {
  jobs?: Array<{
    name?: unknown
    status?: unknown
    conclusion?: unknown
  }>
}

const githubEvidence = new ReleaseGitHubEvidenceReader('GitHub CI attempt evidence')

function exactJob(
  jobs: readonly CiWorkflowJob[],
  name: string,
): CiWorkflowJob | CiAttemptDecision {
  const matches = jobs.filter((job) => job.name === name)
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
  return job
}

function isRejectedJob(
  result: CiWorkflowJob | CiAttemptDecision,
): result is CiAttemptDecision {
  return 'accepted' in result
}

function requireJobConclusion(
  jobs: readonly CiWorkflowJob[],
  name: string,
  conclusion: 'success' | 'skipped',
): CiAttemptDecision | null {
  const result = exactJob(jobs, name)
  if (isRejectedJob(result)) return result
  if (result.conclusion !== conclusion) {
    return { accepted: false, rejection: 'unsuccessful-job' }
  }
  return null
}

export function evaluateCiAttemptPrerequisites(
  jobs: readonly CiWorkflowJob[],
): CiAttemptDecision {
  const releaseClassifier = exactJob(jobs, RELEASE_VERSION_INTEGRITY_JOB)
  if (isRejectedJob(releaseClassifier)) return releaseClassifier

  if (releaseClassifier.conclusion === 'success') {
    for (const name of REQUIRED_CI_JOBS) {
      const failure = requireJobConclusion(jobs, name, 'skipped')
      if (failure) return failure
    }
    return { accepted: true, kind: 'version-only' }
  }

  if (releaseClassifier.conclusion !== 'skipped') {
    return { accepted: false, rejection: 'unsuccessful-job' }
  }
  for (const name of REQUIRED_CI_JOBS) {
    const failure = requireJobConclusion(jobs, name, 'success')
    if (failure) return failure
  }
  return { accepted: true, kind: 'ordinary' }
}

export function evaluateCompletedCiAttempt(
  jobs: readonly CiWorkflowJob[],
): CiAttemptDecision {
  const prerequisiteDecision = evaluateCiAttemptPrerequisites(jobs)
  if (!prerequisiteDecision.accepted) return prerequisiteDecision
  const aggregateFailure = requireJobConclusion(jobs, MERGE_ACCEPTANCE_JOB, 'success')
  return aggregateFailure ?? prerequisiteDecision
}

export async function loadCiAttemptJobs(
  repository: string,
  runId: number,
  runAttempt: number,
  token: string,
): Promise<CiWorkflowJob[]> {
  const result: CiWorkflowJob[] = []
  for (let page = 1; page <= MAX_EVIDENCE_PAGES; page += 1) {
    const url = new URL(
      `https://api.github.com/repos/${repository}/actions/runs/${runId}/attempts/${runAttempt}/jobs`,
    )
    url.searchParams.set('per_page', String(PAGE_SIZE))
    url.searchParams.set('page', String(page))
    const response = await githubEvidence.requestJson<GitHubJobsResponse>(url, token)
    if (!Array.isArray(response.jobs)) return githubEvidence.incomplete()
    result.push(
      ...response.jobs.map((job) => ({
        name: githubEvidence.requiredString(job.name),
        status: githubEvidence.requiredString(job.status),
        conclusion: githubEvidence.nullableString(job.conclusion),
      })),
    )
    if (response.jobs.length < PAGE_SIZE) return result
  }
  return githubEvidence.incomplete()
}

function requirePositiveInteger(name: string, value: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a positive integer`)
  const result = Number(value)
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return result
}

export async function requireCiAttemptEvidence(): Promise<void> {
  const repository = requireReleaseEnvironment('GITHUB_REPOSITORY')
  const runId = requirePositiveInteger(
    'GITHUB_RUN_ID',
    requireReleaseEnvironment('GITHUB_RUN_ID'),
  )
  const runAttempt = requirePositiveInteger(
    'GITHUB_RUN_ATTEMPT',
    requireReleaseEnvironment('GITHUB_RUN_ATTEMPT'),
  )
  const token = requireReleaseEnvironment('GITHUB_TOKEN')
  const decision = evaluateCiAttemptPrerequisites(
    await loadCiAttemptJobs(repository, runId, runAttempt, token),
  )
  if (!decision.accepted) {
    throw new Error(`Coherent CI attempt rejected: ${decision.rejection}`)
  }
  process.stdout.write(`Coherent ${decision.kind} CI attempt accepted.\n`)
}

const invokedPath = process.argv[1]
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  try {
    await requireCiAttemptEvidence()
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown evidence error'
    process.stderr.write(`::error::${message}\n`)
    process.exitCode = 1
  }
}
