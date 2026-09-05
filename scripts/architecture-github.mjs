import { readFileSync } from 'node:fs'
import process from 'node:process'
import { URL } from 'node:url'
import { ReleaseGitHubEvidenceReader } from './release-github-evidence.mts'
import {
  evaluateReleaseCiEvidence,
  loadReleaseCiEvidence,
  RELEASE_REPOSITORY,
} from './require-release-ci-evidence.mts'
import { parseCompletingChildTrailer } from './project-management/pull-request-relationships.ts'
import { fullCommit, git, requireAncestor } from './architecture-inventory.mjs'

const reader = new ReleaseGitHubEvidenceReader('Architecture GitHub evidence')
export function githubAdapter(token) {
  if (!token)
    throw new Error(
      'HVIR_REPO_TOKEN is required for enforcing architecture provenance; offline architecture:report remains available',
    )
  const request = (path) =>
    reader.requestJson(
      new URL(`https://api.github.com/repos/${RELEASE_REPOSITORY}/${path}`),
      token,
    )
  async function pages(path) {
    const items = []
    for (let page = 1; page <= 10; page++) {
      const result = await request(
        `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`,
      )
      if (!Array.isArray(result)) throw new Error('Incomplete architecture evidence page')
      items.push(...result)
      if (result.length < 100) return items
    }
    throw new Error('Architecture evidence exceeds bounded pagination')
  }
  async function issue(number) {
    // Native parent is read from the documented issue relationship endpoint, never PR prose.
    const record = await request(`issues/${number}`)
    let parent = null
    const response = await globalThis.fetch(
      `https://api.github.com/repos/${RELEASE_REPOSITORY}/issues/${number}/parent`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
    )
    if (response.status !== 404) {
      if (!response.ok)
        throw new Error(`Native parent evidence failed (${response.status})`)
      parent = await response.json()
      if (parent.repository_url !== `https://api.github.com/repos/${RELEASE_REPOSITORY}`)
        throw new Error('Cross-repository native parent')
    }
    return { ...record, parent }
  }
  return { request, pages, issue, token }
}

async function epicBranch(api, issue) {
  const record = Object.hasOwn(issue, 'parent') ? issue : await api.issue(issue.number)
  if (record.state !== 'open' || record.parent)
    throw new Error('Native epic is closed or nested')
  if (
    !record.labels?.some((label) => label.name === 'kind:epic') ||
    record.labels.filter((label) => label.name.startsWith('kind:')).length !== 1
  )
    throw new Error('Native parent is not one valid epic')
  const branches = await api.request(`git/matching-refs/heads/epic/${issue.number}-`)
  if (!Array.isArray(branches) || branches.length !== 1)
    throw new Error('Missing or ambiguous exact epic branch')
  return branches[0].ref.replace('refs/heads/', '')
}

export async function resolveArchitectureContext(root, api, environment = process.env) {
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
  let target = 'main',
    epic = null,
    kind = 'ordinary'
  let eventBase = null
  if (environment.GITHUB_ACTIONS === 'true') {
    if (
      environment.GITHUB_EVENT_NAME !== 'pull_request' ||
      environment.GITHUB_REPOSITORY !== RELEASE_REPOSITORY
    )
      throw new Error('Architecture CI requires the canonical pull_request event')
    const event = JSON.parse(readFileSync(environment.GITHUB_EVENT_PATH, 'utf8'))
    const pr = await api.request(`pulls/${event.number}`)
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
      const child = await api.issue(match[1])
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
  const ref = await api.request(`git/ref/heads/${target}`)
  const base = reader.requiredString(ref.object?.sha)
  if (eventBase && base !== eventBase)
    throw new Error('Live target changed from the tested PR event; refresh and reverify')
  requireAncestor(root, base, head)
  return { kind, target, epic, base, head, tested }
}

export async function loadArchitectureIntegration(root, api, merge, epic) {
  const evidence = await loadReleaseCiEvidence(RELEASE_REPOSITORY, epic, merge, api.token)
  // This shares the exact-head/tree and coherent-attempt policy, with the epic as the
  // reachability target. The result confers architecture policy authority only.
  const decision = evaluateReleaseCiEvidence(evidence)
  if (!decision.accepted || decision.kind !== 'ordinary')
    throw new Error(
      `Missing accepted epic CI evidence: ${merge} (${decision.rejection ?? decision.kind})`,
    )
  const pr = evidence.pullRequests.find((pr) => pr.mergeCommitSha === merge)
  const detail = await api.request(`pulls/${pr.number}`)
  const trailer = parseCompletingChildTrailer(detail.body ?? '', pr.number)
  if (!trailer.issueNumber || trailer.errors.length)
    throw new Error('Accepted PR lacks exact completing-child relationship')
  const child = await api.issue(trailer.issueNumber)
  if (!child.parent || (await epicBranch(api, child.parent)) !== epic)
    throw new Error('Accepted PR belongs to a different native epic')
  if (pr.base.sha !== evidence.sourceCommit.parents[0])
    throw new Error('Recorded PR base differs from accepted merge base')
  requireAncestor(root, pr.base.sha, pr.head.sha)
  return { epic, pullRequest: pr.number, base: pr.base.sha, head: pr.head.sha, merge }
}

export async function requireCurrentRemovalIssues(api, policy) {
  const numbers = [
    ...new Set(
      policy.budgets
        .filter((e) => e.kind === 'transitional')
        .map((e) => e.removalIssue.slice(1)),
    ),
  ]
  for (const number of numbers) {
    const issue = await api.request(`issues/${number}`)
    if (issue.state !== 'open' || issue.pull_request)
      throw new Error(
        `Transitional removal issue #${number} is completed or invalid; remove its exception or accept a current disposition`,
      )
  }
}
