import { pathToFileURL } from 'node:url'

import {
  FULL_COMMIT_SHA_PATTERN,
  ReleaseGitHubEvidenceReader,
  requireFullCommitSha,
  requireReleaseEnvironment,
} from './release-github-evidence.mts'
import { loadReleasePrIntegrityDecision } from './validate-release-pr.mts'
import {
  evaluateCompletedCiAttempt,
  loadCiAttemptJobs,
  RELEASE_VERSION_INTEGRITY_JOB,
  type CiAttemptEvidenceRejection,
  type CiWorkflowJob,
} from './ci-attempt-evidence.mts'

export const RELEASE_REPOSITORY = 'jarmak-personal/hvir'
export const CI_WORKFLOW_NAME = 'CI'
export const CI_WORKFLOW_PATH = '.github/workflows/ci.yml'

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
  runNumber: number
  pullRequests: readonly RunPullRequest[]
  status: string
  conclusion: string | null
}

export interface RunPullRequest {
  number: number
  base: PullRequestRef
  head: PullRequestRef
  baseToHead: CommitComparison | null
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
  | CiAttemptEvidenceRejection
  | 'missing-pull-request'
  | 'ambiguous-pull-request'
  | 'invalid-pull-request'
  | 'missing-run'
  | 'ambiguous-run'
  | 'pending-run'
  | 'unsuccessful-run'
  | 'changed-candidate'
  | 'stale-base'
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
  jobsRunId: number | null
  jobsRunAttempt: number | null
  baseToHead: CommitComparison | null
  prBaseToHead: CommitComparison | null
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

export function evaluateReleaseCiEvidence(evidence: ReleaseCiEvidence): EvidenceDecision {
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

  return evaluateCandidateCiEvidence(evidence, pullRequest)
}

/** GitHub's workflow-specific run_number is creation order, unchanged by reruns. */
function selectCandidateRun(
  runs: readonly CiWorkflowRun[],
  repository: string,
  pullRequest: MergedPullRequest,
): { run: CiWorkflowRun } | { rejection: EvidenceRejection } {
  const candidates = runs.filter((run) =>
    matchesRunCandidate(run, repository, pullRequest),
  )
  if (!candidates.length) return { rejection: 'missing-run' }
  const numbers = new Set<number>(),
    ids = new Set<number>()
  for (const run of candidates) {
    if (
      !Number.isSafeInteger(run.runNumber) ||
      run.runNumber <= 0 ||
      !Number.isSafeInteger(run.id) ||
      run.id <= 0 ||
      numbers.has(run.runNumber) ||
      ids.has(run.id)
    )
      return { rejection: 'ambiguous-run' }
    numbers.add(run.runNumber)
    ids.add(run.id)
  }
  return {
    run: candidates.reduce((latest, run) =>
      run.runNumber > latest.runNumber ? run : latest,
    ),
  }
}

/** Tested candidate facts confer no recorded merge acceptance by themselves. */
export function evaluateCandidateCiEvidence(
  evidence: ReleaseCiEvidence,
  pullRequest: MergedPullRequest,
): EvidenceDecision {
  const selection = selectCandidateRun(evidence.runs, evidence.repository, pullRequest)
  if ('rejection' in selection) return { accepted: false, rejection: selection.rejection }
  const { run } = selection
  if (
    !Number.isSafeInteger(run.runAttempt) ||
    run.runAttempt <= 0 ||
    evidence.jobsRunId !== run.id ||
    evidence.jobsRunAttempt !== run.runAttempt
  )
    return { accepted: false, rejection: 'changed-candidate' }
  // Association snapshots can name a different base for the same tested head.
  // An ancestor base proves the default merge-ref checkout has the exact head tree.
  // Empty redundant association metadata is permitted; the canonical PR base proof
  // and trusted CI verification/checkout contract remain required below.
  for (const association of run.pullRequests) {
    if (
      association.number !== pullRequest.number ||
      association.head.sha !== pullRequest.head.sha ||
      association.head.ref !== pullRequest.head.ref ||
      association.head.repository !== evidence.repository ||
      association.base.ref !== pullRequest.base.ref ||
      association.base.repository !== evidence.repository
    )
      return { accepted: false, rejection: 'changed-candidate' }
    if (
      !association.baseToHead ||
      !['ahead', 'identical'].includes(association.baseToHead.status) ||
      association.baseToHead.mergeBaseSha !== association.base.sha
    )
      return { accepted: false, rejection: 'stale-base' }
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
    !evidence.prBaseToHead ||
    !['ahead', 'identical'].includes(evidence.prBaseToHead.status) ||
    evidence.prBaseToHead.mergeBaseSha !== pullRequest.base.sha
  )
    return { accepted: false, rejection: 'stale-base' }
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

  const attemptDecision = evaluateCompletedCiAttempt(evidence.jobs)
  if (!attemptDecision.accepted) return attemptDecision
  if (attemptDecision.kind === 'version-only') {
    if (evidence.versionOnlyIntegrityAccepted !== true) {
      return { accepted: false, rejection: 'invalid-version-only' }
    }
    return { accepted: true, kind: 'version-only' }
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
    repo?: { full_name?: unknown; url?: unknown } | null
  }
  head?: {
    ref?: unknown
    sha?: unknown
    repo?: { full_name?: unknown; url?: unknown } | null
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
  run_number?: unknown
  pull_requests?: GitHubPullRequestResponse[]
  status?: unknown
  conclusion?: unknown
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
  repo?: { full_name?: unknown; url?: unknown } | null
}): PullRequestRef {
  return {
    ref: githubEvidence.requiredString(value.ref),
    sha: requireFullCommitSha(
      'pull request ref SHA',
      githubEvidence.requiredString(value.sha),
    ),
    repository: githubEvidence.requiredString(
      value.repo?.full_name ??
        (value.repo?.url === `https://api.github.com/repos/${RELEASE_REPOSITORY}`
          ? RELEASE_REPOSITORY
          : undefined),
    ),
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

export async function loadPullRequests(
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
  return decodePullRequests(raw)
}

/** Discovery fallback when GitHub's commit-to-PR associations omit closed history. */
export async function loadClosedPullRequests(
  repository: string,
  base: string,
  headSha: string,
  token: string,
): Promise<MergedPullRequest[]> {
  const raw = await loadBoundedPages(
    (page) => {
      const url = new URL(`https://api.github.com/repos/${repository}/pulls`)
      url.searchParams.set('state', 'closed')
      url.searchParams.set('base', base)
      url.searchParams.set('per_page', String(PAGE_SIZE))
      url.searchParams.set('page', String(page))
      return url
    },
    (response) => (Array.isArray(response) ? response : undefined),
    token,
  )
  // A deleted fork may omit head.repo. Ignore it only when raw identities prove it
  // unrelated; indeterminate or matching records still require complete decoding.
  return decodePullRequests(
    raw.filter((value) => {
      const pr = value as GitHubPullRequestResponse | null
      return !(
        (typeof pr?.head?.sha === 'string' && pr.head.sha !== headSha) ||
        (typeof pr?.base?.ref === 'string' && pr.base.ref !== base)
      )
    }),
  )
}

function decodePullRequests(raw: readonly unknown[]): MergedPullRequest[] {
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
      runNumber: githubEvidence.requiredNumber(run.run_number),
      pullRequests: (Array.isArray(run.pull_requests)
        ? run.pull_requests
        : githubEvidence.incomplete()
      ).map((pr) => ({
        number: githubEvidence.requiredNumber(pr.number),
        base: pullRequestRef(pr.base ?? {}),
        head: pullRequestRef(pr.head ?? {}),
        baseToHead: null,
      })),
      status: githubEvidence.requiredString(run.status),
      conclusion: githubEvidence.nullableString(run.conclusion),
    }
  })
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
      jobsRunId: null,
      jobsRunAttempt: null,
      baseToHead: null,
      prBaseToHead: null,
      sourceToDefault: null,
      sourceCommit: null,
      headCommit: null,
      versionOnlyIntegrityAccepted: null,
    }
  }

  return loadCandidateCiEvidence(
    repository,
    defaultBranch,
    sourceSha,
    pullRequest,
    token,
    pullRequests,
  )
}

export async function loadCandidateCiEvidence(
  repository: string,
  defaultBranch: string,
  sourceSha: string,
  pullRequest: MergedPullRequest,
  token: string,
  pullRequests: readonly MergedPullRequest[] = [pullRequest],
): Promise<ReleaseCiEvidence> {
  let selectedRun: CiWorkflowRun | null = null
  try {
    const runs = await loadWorkflowRuns(repository, pullRequest.head.sha, token)
    const selection = selectCandidateRun(runs, repository, pullRequest)
    const candidateRun = 'run' in selection ? selection.run : null
    selectedRun = candidateRun
    if (candidateRun) {
      for (const association of candidateRun.pullRequests) {
        association.baseToHead = await loadComparison(
          repository,
          association.base.sha,
          pullRequest.head.sha,
          token,
        )
      }
    }
    const jobs = candidateRun
      ? await loadCiAttemptJobs(
          repository,
          candidateRun.id,
          candidateRun.runAttempt,
          token,
        )
      : []
    const [sourceToDefault, sourceCommit, headCommit] = await Promise.all([
      loadComparison(repository, sourceSha, defaultBranch, token),
      loadCommit(repository, sourceSha, token),
      loadCommit(repository, pullRequest.head.sha, token),
    ])
    const mergedBaseSha = sourceCommit.parents[0]
    const baseToHead = mergedBaseSha
      ? await loadComparison(repository, mergedBaseSha, pullRequest.head.sha, token)
      : null

    const prBaseToHead =
      mergedBaseSha === pullRequest.base.sha
        ? baseToHead
        : await loadComparison(
            repository,
            pullRequest.base.sha,
            pullRequest.head.sha,
            token,
          )
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
      jobsRunId: candidateRun?.id ?? null,
      jobsRunAttempt: candidateRun?.runAttempt ?? null,
      baseToHead,
      prBaseToHead,
      sourceToDefault,
      sourceCommit,
      headCommit,
      versionOnlyIntegrityAccepted,
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'GitHub evidence read failed'
    throw new Error(
      `Candidate PR #${pullRequest.number} base=${pullRequest.base.ref}@${pullRequest.base.sha} head=${pullRequest.head.ref}@${pullRequest.head.sha} merge=${sourceSha}${selectedRun ? ` run=${selectedRun.id} attempt=${selectedRun.runAttempt}` : ''}: ${detail}`,
      { cause: error },
    )
  }
}

export function formatCiEvidenceFailure(
  evidence: ReleaseCiEvidence,
  requirement: string,
): string {
  const prs = evidence.pullRequests
    .slice(0, 5)
    .map(
      (pr) =>
        `PR #${pr.number} base=${pr.base.ref}@${pr.base.sha} head=${pr.head.ref}@${pr.head.sha} recorded-merge=${pr.mergeCommitSha ?? 'absent'}`,
    )
  const runs = evidence.runs
    .filter((run) =>
      evidence.pullRequests.some((pr) =>
        matchesRunCandidate(run, evidence.repository, pr),
      ),
    )
    .sort((a, b) => b.runNumber - a.runNumber)
    .slice(0, 5)
    .map((run) => `run=${run.id} order=${run.runNumber} attempt=${run.runAttempt}`)
  const action =
    requirement.includes('run') || requirement.includes('job')
      ? 'Inspect the latest equivalent CI run; wait for pending work or request a full workflow rerun, then reverify.'
      : 'Inspect canonical PR and Git identities; restore the required evidence and reverify. Release requires a recorded accepted merge.'
  const jobFacts = requirement.includes('job')
    ? evidence.jobs
        .slice(0, 10)
        .map((job) => `${job.name}=${job.status}/${job.conclusion ?? 'absent'}`)
        .join(', ')
    : ''
  return `Trusted CI evidence rejected: ${requirement}; source=${evidence.sourceSha} target=${evidence.defaultBranch}; ${prs.join('; ') || 'PR absent'}; ${runs.join('; ') || 'run absent'}${jobFacts ? '; jobs: ' + jobFacts : ''}. ${action}`
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

  const evidence = await loadReleaseCiEvidence(
    repository,
    defaultBranch,
    sourceSha,
    token,
  )
  const decision = evaluateReleaseCiEvidence(evidence)
  if (!decision.accepted) {
    throw new Error(formatCiEvidenceFailure(evidence, decision.rejection))
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
