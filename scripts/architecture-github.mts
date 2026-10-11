import { readFileSync } from 'node:fs'
import process from 'node:process'
import { URL } from 'node:url'
import { ReleaseGitHubEvidenceReader } from './release-github-evidence.mts'
import {
  evaluateReleaseCiEvidence,
  evaluateCandidateCiEvidence,
  formatCiEvidenceFailure,
  loadCandidateCiEvidence,
  loadPullRequests,
  loadClosedPullRequests,
  type MergedPullRequest,
  loadReleaseCiEvidence,
  RELEASE_REPOSITORY,
} from './require-release-ci-evidence.mts'
import { parseCompletingChildTrailer } from './project-management/pull-request-relationships.ts'
import { fullCommit, git, requireAncestor } from './architecture-inventory.mts'

import type { ArchitecturePolicy } from './architecture-policy.mts'
import type {
  ArchitectureContext,
  ArchitectureIntegration,
} from './architecture-authorization.mts'

interface GitHubIssue {
  number: number
  state: string
  repository_url?: string
  labels?: Array<{ name: string }>
  parent?: GitHubIssue | null
  pull_request?: unknown
}
interface GitHubRef {
  ref: string
  sha: string
  repo?: { full_name: string } | null
}
interface GitHubPullRequest {
  number: number
  body?: string | null
  base: GitHubRef
  head: GitHubRef
}
interface PullRequestEvent {
  number: number
  pull_request: GitHubPullRequest
}

const reader = new ReleaseGitHubEvidenceReader('Architecture GitHub evidence')
export function githubAdapter(token: string | undefined) {
  if (!token)
    throw new Error(
      'HVIR_REPO_TOKEN is required for enforcing architecture provenance; offline architecture:report remains available',
    )
  const credential = token
  const request = <T,>(path: string): Promise<T> =>
    reader.requestJson<T>(
      new URL(`https://api.github.com/repos/${RELEASE_REPOSITORY}/${path}`),
      credential,
    )
  async function issue(number: string | number): Promise<GitHubIssue> {
    // Native parent is read from the documented issue relationship endpoint, never PR prose.
    const record = await request<GitHubIssue>(`issues/${number}`)
    const parent = await reader.requestJson<GitHubIssue>(
      new URL(
        `https://api.github.com/repos/${RELEASE_REPOSITORY}/issues/${number}/parent`,
      ),
      credential,
      true,
    )
    if (
      parent &&
      parent.repository_url !== `https://api.github.com/repos/${RELEASE_REPOSITORY}`
    )
      throw new Error(
        `Issue #${number}: cross-repository native parent; inspect the canonical child relationship and reverify`,
      )
    return { ...record, parent }
  }
  return { request, issue, token: credential }
}

type ArchitectureGitHub = ReturnType<typeof githubAdapter>

async function epicBranch(api: ArchitectureGitHub, issue: GitHubIssue): Promise<string> {
  const record = Object.hasOwn(issue, 'parent') ? issue : await api.issue(issue.number)
  if (record.state !== 'open' || record.parent)
    throw new Error('Native epic is closed or nested')
  if (
    !record.labels?.some((label) => label.name === 'kind:epic') ||
    record.labels.filter((label) => label.name.startsWith('kind:')).length !== 1
  )
    throw new Error('Native parent is not one valid epic')
  const branches = await api.request<Array<{ ref: string }>>(
    `git/matching-refs/heads/epic/${issue.number}-`,
  )
  if (!Array.isArray(branches) || branches.length !== 1)
    throw new Error('Missing or ambiguous exact epic branch')
  return branches[0]!.ref.replace('refs/heads/', '')
}

export async function resolveArchitectureContext(
  root: string,
  api: ArchitectureGitHub,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ArchitectureContext> {
  const tested = fullCommit(root, 'HEAD')
  let head = tested
  const origin = git(root, ['remote', 'get-url', 'origin'])
  if (
    ![
      'https://github.com/jarmak-personal/hvir.git',
      'git@github.com:jarmak-personal/hvir.git',
      'https://github.com/jarmak-personal/hvir',
    ].includes(origin)
  )
    throw new Error('Architecture evidence requires the canonical repository')
  let target = 'main'
  let epic: string | null = null
  let kind: ArchitectureContext['kind'] = 'ordinary'
  let eventBase: string | null = null
  if (environment.GITHUB_ACTIONS === 'true') {
    if (
      environment.GITHUB_EVENT_NAME !== 'pull_request' ||
      environment.GITHUB_REPOSITORY !== RELEASE_REPOSITORY
    )
      throw new Error('Architecture CI requires the canonical pull_request event')
    if (!environment.GITHUB_EVENT_PATH) throw new Error('Missing PR event file')
    const event = JSON.parse(
      readFileSync(environment.GITHUB_EVENT_PATH, 'utf8'),
    ) as PullRequestEvent
    const pr = await api.request<GitHubPullRequest>(`pulls/${event.number}`)
    head = event.pull_request?.head.sha
    if (
      pr.head.repo?.full_name !== RELEASE_REPOSITORY ||
      pr.base.repo?.full_name !== RELEASE_REPOSITORY ||
      pr.head.sha !== head ||
      pr.base.sha !== event.pull_request?.base.sha ||
      pr.base.ref !== event.pull_request?.base.ref
    ) {
      throw new Error(
        'CI candidate/base differs from the current PR event; refresh and reverify',
      )
    }
    const testedParents = git(root, ['show', '-s', '--format=%P', tested]).split(' ')
    if (
      tested !== environment.GITHUB_SHA ||
      testedParents.length !== 2 ||
      testedParents[0] !== pr.base.sha ||
      testedParents[1] !== head ||
      git(root, ['rev-parse', `${tested}^{tree}`]) !==
        git(root, ['rev-parse', `${head}^{tree}`])
    ) {
      throw new Error(
        'CI merge ref does not preserve the exact current base/head candidate tree',
      )
    }
    target = pr.base.ref
    eventBase = pr.base.sha
    if (target.startsWith('epic/')) {
      const trailer = parseCompletingChildTrailer(pr.body ?? '', pr.number)
      if (!trailer.issueNumber || trailer.errors.length)
        throw new Error('Missing exact completing-child relationship')
      const child = await api.issue(trailer.issueNumber)
      if (!child.parent || (await epicBranch(api, child.parent)) !== target)
        throw new Error('Wrong native epic target')
      epic = target
      kind = 'epic-child'
    } else if (target === 'main' && pr.head.ref.startsWith('epic/')) {
      const number = /^epic\/([1-9]\d*)-/.exec(pr.head.ref)?.[1]
      if (!number || (await epicBranch(api, await api.issue(number))) !== pr.head.ref)
        throw new Error('Wrong cumulative epic')
      epic = pr.head.ref
      kind = 'cumulative'
    } else if (target !== 'main') throw new Error('Unsupported architecture target')
  } else {
    const branch = git(root, ['branch', '--show-current'])
    const match = /^agent\/issue-([1-9]\d*)$/.exec(branch)
    if (match) {
      const child = await api.issue(match[1]!)
      if (child.state !== 'open') throw new Error('Local delivery issue is closed')
      if (child.parent) {
        target = await epicBranch(api, child.parent)
        epic = target
        kind = 'epic-child'
      }
    } else if (branch.startsWith('epic/')) {
      const number = /^epic\/([1-9]\d*)-/.exec(branch)?.[1]
      if (!number || (await epicBranch(api, await api.issue(number))) !== branch)
        throw new Error('Wrong local cumulative epic')
      epic = branch
      kind = 'cumulative'
    } else if (branch !== 'main')
      throw new Error(
        'Unresolved local delivery context; use the issue worktree or exact epic branch',
      )
  }
  const ref = await api.request<{ object?: { sha?: string } }>(`git/ref/heads/${target}`)
  const base = reader.requiredString(ref.object?.sha)
  if (eventBase && base !== eventBase)
    throw new Error('Live target changed from the tested PR event; refresh and reverify')
  requireAncestor(root, base, head)
  return { kind, target, epic, base, head, tested }
}

/** Recovery never establishes authority for the code that enforces or defines policy. */
function recoveryProtectedPath(path: string): boolean {
  return (
    path.startsWith('scripts/architecture-') ||
    path.startsWith('test/architecture-') ||
    path.startsWith('test/fixtures/architecture/') ||
    path.startsWith('docs/adr/') ||
    path.startsWith('docs/architecture-') ||
    path === 'docs/design.md' ||
    path === 'AGENTS.md' ||
    path === 'CONTRIBUTING.md' ||
    path === 'package.json' ||
    path === 'package-lock.json' ||
    path === 'eslint.config.mjs' ||
    path.startsWith('.github/') ||
    path.startsWith('.githooks/') ||
    path.startsWith('.claude/') ||
    path.startsWith('.agents/') ||
    /^tsconfig.*\.json$/.test(path) ||
    /^vitest\.config\./.test(path) ||
    /^scripts\/(check-|run-smoke|phase8-gauntlet|smoke-import-boundary)/.test(path) ||
    /^(scripts|test)\/(require-release-ci-evidence|release-ci-evidence|release-github-evidence|ci-attempt-evidence|validate-release-pr|check-seams|check-adrs|install-git-hooks)\./.test(
      path,
    )
  )
}

export async function loadArchitectureIntegration(
  root: string,
  api: ArchitectureGitHub,
  merge: string,
  epic: string,
): Promise<ArchitectureIntegration> {
  let evidence = await loadReleaseCiEvidence(RELEASE_REPOSITORY, epic, merge, api.token)
  let decision = evaluateReleaseCiEvidence(evidence)
  let pr: MergedPullRequest | undefined
  let recovered = false
  if (!decision.accepted && decision.rejection === 'missing-pull-request') {
    const parents = git(root, ['show', '-s', '--format=%P', merge]).split(' ')
    if (parents.length !== 2)
      throw new Error(
        `Epic recovery merge=${merge}: requires two parents; inspect the integrated Git history and reverify`,
      )
    const associated = await loadPullRequests(RELEASE_REPOSITORY, parents[1]!, api.token)
    const candidates = new Map<number, MergedPullRequest>()
    const discovered = [...evidence.pullRequests, ...associated]
    if (!discovered.some((pr) => pr.head.sha === parents[1] && pr.base.ref === epic))
      discovered.push(
        ...(await loadClosedPullRequests(RELEASE_REPOSITORY, epic, api.token)),
      )
    for (const candidate of discovered) {
      if (candidate.head.sha === parents[1] && candidate.base.ref === epic) {
        const prior = candidates.get(candidate.number)
        if (prior && JSON.stringify(prior) !== JSON.stringify(candidate))
          throw new Error(
            `Epic recovery PR #${candidate.number} merge=${merge}: contradictory merge/head PR records; refresh canonical evidence and reverify`,
          )
        candidates.set(candidate.number, candidate)
      }
    }
    if (candidates.size !== 1)
      throw new Error(
        `Epic recovery merge=${merge} base=${parents[0]} head=${parents[1]}: ${candidates.size ? 'ambiguous' : 'absent'} canonical PR; inspect merge/head PR associations and the closed PR list for ${epic}, then restore unambiguous evidence`,
      )
    pr = [...candidates.values()][0]!
    // Refresh the full canonical PR record; association results are discovery only.
    const detail = await api.request<
      GitHubPullRequest & {
        state: string
        merged_at: string | null
        merge_commit_sha: string | null
      }
    >(`pulls/${pr.number}`)
    if (
      detail.number !== pr.number ||
      detail.state !== 'closed' ||
      detail.merged_at !== null ||
      pr.state !== 'closed' ||
      pr.mergedAt !== null ||
      detail.head.sha !== parents[1] ||
      detail.base.sha !== parents[0] ||
      detail.base.ref !== epic ||
      detail.head.ref !== pr.head.ref ||
      detail.base.repo?.full_name !== RELEASE_REPOSITORY ||
      detail.head.repo?.full_name !== RELEASE_REPOSITORY ||
      pr.base.repository !== RELEASE_REPOSITORY ||
      pr.head.repository !== RELEASE_REPOSITORY ||
      detail.merge_commit_sha !== pr.mergeCommitSha ||
      pr.base.sha !== parents[0]
    )
      throw new Error(
        `Epic recovery PR #${pr.number} merge=${merge} base=${parents[0]} head=${parents[1]}: Closed non-accepted canonical PR identities required; inspect contradictory PR metadata and reverify`,
      )
    // Disable rename detection so moving a protected owner cannot hide its old path.
    const sensitive = git(root, [
      'diff',
      '--no-renames',
      '--name-only',
      '-z',
      pr.base.sha,
      pr.head.sha,
      '--',
    ])
      .split('\0')
      .filter(Boolean)
      .filter(recoveryProtectedPath)
    if (sensitive.length)
      throw new Error(
        `Epic recovery PR #${pr.number} merge=${merge}: recorded merged-PR acceptance required for policy/checker/wiring/decision changes (${sensitive.join(', ')}); restore recorded acceptance through the normal protected PR path`,
      )
    requireAncestor(root, pr.base.sha, pr.head.sha)
    evidence = await loadCandidateCiEvidence(
      RELEASE_REPOSITORY,
      epic,
      merge,
      pr,
      api.token,
    )
    decision = evaluateCandidateCiEvidence(evidence, pr)
    recovered = true
  }
  if (!decision.accepted || decision.kind !== 'ordinary')
    throw new Error(
      formatCiEvidenceFailure(
        evidence,
        decision.accepted ? decision.kind : decision.rejection,
      ),
    )
  pr ??= evidence.pullRequests.find((pr) => pr.mergeCommitSha === merge)
  if (!pr || !evidence.sourceCommit)
    throw new Error(
      `Missing accepted PR identities merge=${merge}; inspect canonical PR metadata and reverify`,
    )
  const detail = await api.request<
    GitHubPullRequest & {
      state: string
      merged_at: string | null
      merge_commit_sha: string | null
    }
  >(`pulls/${pr.number}`)
  if (
    detail.number !== pr.number ||
    detail.state !== pr.state ||
    detail.merged_at !== pr.mergedAt ||
    detail.merge_commit_sha !== pr.mergeCommitSha ||
    detail.head.sha !== pr.head.sha ||
    detail.head.ref !== pr.head.ref ||
    detail.base.sha !== pr.base.sha ||
    detail.base.ref !== epic ||
    detail.base.repo?.full_name !== RELEASE_REPOSITORY ||
    detail.head.repo?.full_name !== RELEASE_REPOSITORY
  )
    throw new Error(
      `PR #${pr.number} merge=${merge} base=${pr.base.sha} head=${pr.head.sha}: current canonical PR contradicts selected evidence; refresh PR/Git identities and reverify`,
    )
  const trailer = parseCompletingChildTrailer(detail.body ?? '', pr.number)
  if (!trailer.issueNumber || trailer.errors.length)
    throw new Error(
      `PR #${pr.number} merge=${merge}: exact completing-child relationship required; correct the PR trailer and reverify`,
    )
  const child = await api.issue(trailer.issueNumber)
  if (!child.parent || (await epicBranch(api, child.parent)) !== epic)
    throw new Error(
      `PR #${pr.number} child=#${trailer.issueNumber} merge=${merge} epic=${epic}: matching native parent required; inspect the child parent and epic target, then reverify`,
    )
  if (pr.base.sha !== evidence.sourceCommit.parents[0])
    throw new Error(
      `PR #${pr.number} base=${pr.base.sha} head=${pr.head.sha} merge=${merge}: recorded base must equal first merge parent; inspect Git/PR identities and reverify`,
    )
  requireAncestor(root, pr.base.sha, pr.head.sha)
  if (recovered) {
    const parents = git(root, ['show', '-s', '--format=%P', merge]).split(' ')
    if (
      parents.length !== 2 ||
      parents[1] !== pr.head.sha ||
      git(root, ['rev-parse', `${merge}^{tree}`]) !==
        git(root, ['rev-parse', `${pr.head.sha}^{tree}`])
    )
      throw new Error(
        `PR #${pr.number} merge=${merge}: exact integrated parents/tree required; inspect Git history and reverify`,
      )
    const live = await api.request<{ object?: { sha?: string } }>(`git/ref/heads/${epic}`)
    requireAncestor(root, merge, reader.requiredString(live.object?.sha))
  }
  return { epic, pullRequest: pr.number, base: pr.base.sha, head: pr.head.sha, merge }
}

export async function requireCurrentRemovalIssues(
  api: ArchitectureGitHub,
  policy: ArchitecturePolicy,
): Promise<void> {
  const numbers = [
    ...new Set(
      policy.budgets
        .filter((e) => e.kind === 'transitional')
        .map((e) => e.removalIssue!.slice(1)),
    ),
  ]
  for (const number of numbers) {
    const issue = await api.request<GitHubIssue>(`issues/${number}`)
    if (issue.state !== 'open' || issue.pull_request)
      throw new Error(
        `Transitional removal issue #${number} is completed or invalid; remove its exception or accept a current disposition`,
      )
  }
}
