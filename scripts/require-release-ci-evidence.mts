import { pathToFileURL } from 'node:url'

import {
  FULL_COMMIT_SHA_PATTERN,
  ReleaseGitHubEvidenceReader,
  requireFullCommitSha,
  requireReleaseEnvironment,
} from './release-github-evidence.mts'
import { loadReleasePrIntegrityDecision } from './validate-release-pr.mts'

export const RELEASE_REPOSITORY = 'jarmak-personal/hvir'
export const CI_WORKFLOW_NAME = 'CI'
export const CI_WORKFLOW_PATH = '.github/workflows/ci.yml'
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

export interface PullRequestRef {
  ref: string
  sha: string
  repository: string
}

export interface MergedPullRequest {
  number: number
  state: string
  mergedAt: string | null
  mergeCommitSha: string | null
  base: PullRequestRef
  head: PullRequestRef
}

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

export interface CommitComparison {
  status: string
  mergeBaseSha: string
}

export interface CommitIdentity {
  sha: string
  treeSha: string
  parents: readonly string[]
}

export type EvidenceRejection =
  | 'missing-pull-request'
  | 'ambiguous-pull-request'
  | 'invalid-pull-request'
  | 'missing-run'
  | 'rerun-only'
  | 'ambiguous-run'
  | 'pending-run'
  | 'unsuccessful-run'
  | 'changed-candidate'
  | 'stale-base'
  | 'missing-job'
  | 'ambiguous-job'
  | 'pending-job'
  | 'unsuccessful-job'
  | 'invalid-version-only'
  | 'unreachable-source'
  | 'changed-tree'

export type EvidenceDecision =
  | { accepted: true; kind: 'ordinary' | 'version-only' }
  | { accepted: false; rejection: EvidenceRejection }

export interface ReleaseCiEvidence {
  sourceSha: string
  defaultBranch: string
  repository: string
  pullRequests: readonly MergedPullRequest[]
  runs: readonly CiWorkflowRun[]
  jobs: readonly CiWorkflowJob[]
  baseToHead: CommitComparison | null
  sourceToDefault: CommitComparison | null
  sourceCommit: CommitIdentity | null
  headCommit: CommitIdentity | null
  versionOnlyIntegrityAccepted: boolean | null
}

function matchesRunCandidate(
  run: CiWorkflowRun,
  repository: string,
  pullRequest: MergedPullRequest,
): boolean {
  return (
    run.name === CI_WORKFLOW_NAME &&
    run.path === CI_WORKFLOW_PATH &&
    run.repository === repository &&
    run.headRepository === repository &&
    run.event === 'pull_request' &&
    run.headBranch === pullRequest.head.ref &&
    run.headSha === pullRequest.head.sha
  )
}

function exactJob(
  jobs: readonly CiWorkflowJob[],
  name: string,
): CiWorkflowJob | EvidenceDecision {
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
  result: CiWorkflowJob | EvidenceDecision,
): result is EvidenceDecision {
  return 'accepted' in result
}

function requireJobConclusion(
  jobs: readonly CiWorkflowJob[],
  name: string,
  conclusion: 'success' | 'skipped',
): EvidenceDecision | null {
  const result = exactJob(jobs, name)
  if (isRejectedJob(result)) return result
  if (result.conclusion !== conclusion) {
    return { accepted: false, rejection: 'unsuccessful-job' }
  }
  return null
}

export function evaluateReleaseCiEvidence(
  evidence: ReleaseCiEvidence,
): EvidenceDecision {
  const sourcePullRequests = evidence.pullRequests.filter(
    (pullRequest) => pullRequest.mergeCommitSha === evidence.sourceSha,
  )
  if (sourcePullRequests.length === 0) {
    return { accepted: false, rejection: 'missing-pull-request' }
  }
  if (sourcePullRequests.length !== 1) {
    return { accepted: false, rejection: 'ambiguous-pull-request' }
  }

  const pullRequest = sourcePullRequests[0]!
  if (
    pullRequest.state !== 'closed' ||
    pullRequest.mergedAt === null ||
    pullRequest.base.ref !== evidence.defaultBranch ||
    pullRequest.base.repository !== evidence.repository ||
    pullRequest.head.repository !== evidence.repository ||
    !FULL_COMMIT_SHA_PATTERN.test(pullRequest.base.sha) ||
    !FULL_COMMIT_SHA_PATTERN.test(pullRequest.head.sha)
  ) {
    return { accepted: false, rejection: 'invalid-pull-request' }
  }

  const candidateRuns = evidence.runs.filter((run) =>
    matchesRunCandidate(run, evidence.repository, pullRequest),
  )
  if (candidateRuns.length === 0) {
    return { accepted: false, rejection: 'missing-run' }
  }
  if (candidateRuns.length !== 1) {
    return { accepted: false, rejection: 'ambiguous-run' }
  }

  const run = candidateRuns[0]!
  if (run.runAttempt !== 1) {
    return { accepted: false, rejection: 'rerun-only' }
  }
  if (run.status !== 'completed') {
    return { accepted: false, rejection: 'pending-run' }
  }
  if (run.conclusion !== 'success') {
    return { accepted: false, rejection: 'unsuccessful-run' }
  }
  if (
    evidence.sourceCommit?.sha !== evidence.sourceSha ||
    evidence.headCommit?.sha !== pullRequest.head.sha ||
    (evidence.sourceCommit.parents.length !== 1 &&
      evidence.sourceCommit.parents.length !== 2) ||
    (evidence.sourceCommit.parents.length === 2 &&
      evidence.sourceCommit.parents[1] !== pullRequest.head.sha)
  ) {
    return { accepted: false, rejection: 'changed-candidate' }
  }
  const mergedBaseSha = evidence.sourceCommit.parents[0]!
  if (
    evidence.baseToHead === null ||
    evidence.baseToHead.status !== 'ahead' ||
    evidence.baseToHead.mergeBaseSha !== mergedBaseSha
  ) {
    return { accepted: false, rejection: 'stale-base' }
  }
  if (
    evidence.sourceToDefault === null ||
    !['ahead', 'identical'].includes(evidence.sourceToDefault.status) ||
    evidence.sourceToDefault.mergeBaseSha !== evidence.sourceSha
  ) {
    return { accepted: false, rejection: 'unreachable-source' }
  }
  if (evidence.sourceCommit.treeSha !== evidence.headCommit.treeSha) {
    return { accepted: false, rejection: 'changed-tree' }
  }

  const aggregateFailure = requireJobConclusion(
    evidence.jobs,
    MERGE_ACCEPTANCE_JOB,
    'success',
  )
  if (aggregateFailure) return aggregateFailure

  const releaseClassifier = exactJob(evidence.jobs, RELEASE_VERSION_INTEGRITY_JOB)
  if (isRejectedJob(releaseClassifier)) return releaseClassifier
  if (releaseClassifier.conclusion === 'success') {
    for (const name of REQUIRED_CI_JOBS) {
      const failure = requireJobConclusion(evidence.jobs, name, 'skipped')
      if (failure) return failure
    }
    if (evidence.versionOnlyIntegrityAccepted !== true) {
      return { accepted: false, rejection: 'invalid-version-only' }
    }
    return { accepted: true, kind: 'version-only' }
  }
  if (releaseClassifier.conclusion !== 'skipped') {
    return { accepted: false, rejection: 'unsuccessful-job' }
  }
  for (const name of REQUIRED_CI_JOBS) {
    const failure = requireJobConclusion(evidence.jobs, name, 'success')
    if (failure) return failure
  }
  return { accepted: true, kind: 'ordinary' }
}

interface GitHubPullRequestResponse {
  number?: unknown
  state?: unknown
  merged_at?: unknown
  merge_commit_sha?: unknown
  base?: {
    ref?: unknown
    sha?: unknown
    repo?: { full_name?: unknown } | null
  }
  head?: {
    ref?: unknown
    sha?: unknown
    repo?: { full_name?: unknown } | null
  }
}

interface GitHubWorkflowRunResponse {
  workflow_runs?: GitHubWorkflowRun[]
}

interface GitHubWorkflowRun {
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
}

interface GitHubJobsResponse {
  jobs?: Array<{
    name?: unknown
    status?: unknown
    conclusion?: unknown
  }>
}

interface GitHubComparisonResponse {
  status?: unknown
  merge_base_commit?: { sha?: unknown }
}

interface GitHubCommitResponse {
  sha?: unknown
  tree?: { sha?: unknown }
  parents?: Array<{ sha?: unknown }>
}

const githubEvidence = new ReleaseGitHubEvidenceReader('GitHub merge evidence')

function pullRequestRef(value: {
  ref?: unknown
  sha?: unknown
  repo?: { full_name?: unknown } | null
}): PullRequestRef {
  return {
    ref: githubEvidence.requiredString(value.ref),
    sha: requireFullCommitSha(
      'pull request ref SHA',
      githubEvidence.requiredString(value.sha),
    ),
    repository: githubEvidence.requiredString(value.repo?.full_name),
  }
}

async function loadBoundedPages<T>(
  createUrl: (page: number) => URL,
  selectItems: (response: unknown) => readonly T[] | undefined,
  token: string,
): Promise<T[]> {
  const result: T[] = []
  for (let page = 1; page <= MAX_EVIDENCE_PAGES; page += 1) {
    const response = await githubEvidence.requestJson<unknown>(createUrl(page), token)
    const items = selectItems(response)
    if (items === undefined) return githubEvidence.incomplete()
    result.push(...items)
    if (items.length < PAGE_SIZE) return result
  }
  return githubEvidence.incomplete()
}

async function loadPullRequests(
  repository: string,
  sourceSha: string,
  token: string,
): Promise<MergedPullRequest[]> {
  const raw = await loadBoundedPages(
    (page) => {
      const url = new URL(
        `https://api.github.com/repos/${repository}/commits/${sourceSha}/pulls`,
      )
      url.searchParams.set('per_page', String(PAGE_SIZE))
      url.searchParams.set('page', String(page))
      return url
    },
    (response) => (Array.isArray(response) ? response : undefined),
    token,
  )
  return raw.map((value) => {
    const pullRequest = value as GitHubPullRequestResponse
    return {
      number: githubEvidence.requiredNumber(pullRequest.number),
      state: githubEvidence.requiredString(pullRequest.state),
      mergedAt: githubEvidence.nullableString(pullRequest.merged_at),
      mergeCommitSha: githubEvidence.nullableString(pullRequest.merge_commit_sha),
      base: pullRequestRef(pullRequest.base ?? {}),
      head: pullRequestRef(pullRequest.head ?? {}),
    }
  })
}

async function loadWorkflowRuns(
  repository: string,
  headSha: string,
  token: string,
): Promise<CiWorkflowRun[]> {
  const raw = await loadBoundedPages(
    (page) => {
      const url = new URL(
        `https://api.github.com/repos/${repository}/actions/workflows/ci.yml/runs`,
      )
      url.searchParams.set('event', 'pull_request')
      url.searchParams.set('head_sha', headSha)
      url.searchParams.set('per_page', String(PAGE_SIZE))
      url.searchParams.set('page', String(page))
      return url
    },
    (response) => (response as GitHubWorkflowRunResponse).workflow_runs,
    token,
  )
  return raw.map((value) => {
    const run = value
    return {
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
      headSha: requireFullCommitSha(
        'workflow head SHA',
        githubEvidence.requiredString(run.head_sha),
      ),
      runAttempt: githubEvidence.requiredNumber(run.run_attempt),
      status: githubEvidence.requiredString(run.status),
      conclusion: githubEvidence.nullableString(run.conclusion),
    }
  })
}

async function loadJobs(
  repository: string,
  runId: number,
  token: string,
): Promise<CiWorkflowJob[]> {
  const raw = await loadBoundedPages(
    (page) => {
      const url = new URL(
        `https://api.github.com/repos/${repository}/actions/runs/${runId}/attempts/1/jobs`,
      )
      url.searchParams.set('per_page', String(PAGE_SIZE))
      url.searchParams.set('page', String(page))
      return url
    },
    (response) => (response as GitHubJobsResponse).jobs,
    token,
  )
  return raw.map((job) => ({
    name: githubEvidence.requiredString(job.name),
    status: githubEvidence.requiredString(job.status),
    conclusion: githubEvidence.nullableString(job.conclusion),
  }))
}

async function loadComparison(
  repository: string,
  base: string,
  head: string,
  token: string,
): Promise<CommitComparison> {
  const url = new URL(
    `https://api.github.com/repos/${repository}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
  )
  const response = await githubEvidence.requestJson<GitHubComparisonResponse>(url, token)
  return {
    status: githubEvidence.requiredString(response.status),
    mergeBaseSha: requireFullCommitSha(
      'merge-base SHA',
      githubEvidence.requiredString(response.merge_base_commit?.sha),
    ),
  }
}

async function loadCommit(
  repository: string,
  sha: string,
  token: string,
): Promise<CommitIdentity> {
  const url = new URL(`https://api.github.com/repos/${repository}/git/commits/${sha}`)
  const response = await githubEvidence.requestJson<GitHubCommitResponse>(url, token)
  const parents = Array.isArray(response.parents)
    ? response.parents
    : githubEvidence.incomplete()
  return {
    sha: requireFullCommitSha('commit SHA', githubEvidence.requiredString(response.sha)),
    treeSha: requireFullCommitSha(
      'commit tree SHA',
      githubEvidence.requiredString(response.tree?.sha),
    ),
    parents: parents.map((parent) =>
      requireFullCommitSha(
        'commit parent SHA',
        githubEvidence.requiredString(parent.sha),
      ),
    ),
  }
}

export async function loadReleaseCiEvidence(
  repository: string,
  defaultBranch: string,
  sourceSha: string,
  token: string,
): Promise<ReleaseCiEvidence> {
  const pullRequests = await loadPullRequests(repository, sourceSha, token)
  const sourcePullRequests = pullRequests.filter(
    (pullRequest) => pullRequest.mergeCommitSha === sourceSha,
  )
  const pullRequest = sourcePullRequests.length === 1 ? sourcePullRequests[0]! : null
  if (!pullRequest) {
    return {
      sourceSha,
      defaultBranch,
      repository,
      pullRequests,
      runs: [],
      jobs: [],
      baseToHead: null,
      sourceToDefault: null,
      sourceCommit: null,
      headCommit: null,
      versionOnlyIntegrityAccepted: null,
    }
  }

  const runs = await loadWorkflowRuns(repository, pullRequest.head.sha, token)
  const candidateRuns = runs.filter((run) =>
    matchesRunCandidate(run, repository, pullRequest),
  )
  const candidateRun = candidateRuns.length === 1 ? candidateRuns[0]! : null
  const jobs = candidateRun ? await loadJobs(repository, candidateRun.id, token) : []
  const [sourceToDefault, sourceCommit, headCommit] = await Promise.all([
    loadComparison(repository, sourceSha, defaultBranch, token),
    loadCommit(repository, sourceSha, token),
    loadCommit(repository, pullRequest.head.sha, token),
  ])
  const mergedBaseSha = sourceCommit.parents[0]
  const baseToHead = mergedBaseSha
    ? await loadComparison(repository, mergedBaseSha, pullRequest.head.sha, token)
    : null

  const releaseClassifier = jobs.filter(
    (job) => job.name === RELEASE_VERSION_INTEGRITY_JOB,
  )
  let versionOnlyIntegrityAccepted: boolean | null = null
  if (
    releaseClassifier.length === 1 &&
    releaseClassifier[0]?.status === 'completed' &&
    releaseClassifier[0].conclusion === 'success'
  ) {
    const decision = await loadReleasePrIntegrityDecision({
      repository,
      defaultBranch,
      token,
      mode: 'merged',
      pullRequestNumber: pullRequest.number,
      expectedHeadSha: pullRequest.head.sha,
      sourceSha,
    })
    versionOnlyIntegrityAccepted = decision.accepted
  }

  return {
    sourceSha,
    defaultBranch,
    repository,
    pullRequests,
    runs,
    jobs,
    baseToHead,
    sourceToDefault,
    sourceCommit,
    headCommit,
    versionOnlyIntegrityAccepted,
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

  const decision = evaluateReleaseCiEvidence(
    await loadReleaseCiEvidence(repository, defaultBranch, sourceSha, token),
  )
  if (!decision.accepted) {
    throw new Error(`Trusted CI evidence rejected: ${decision.rejection}`)
  }

  process.stdout.write(`Trusted ${decision.kind} merge evidence accepted.\n`)
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
