import { GitHubClient } from './github-client.ts'
import type {
  OrdinaryMergeAttempt,
  OrdinaryMergePullRequest,
  OrdinaryMergePullRequestPort,
  OrdinaryMergeRequiredCheck,
} from './ordinary-pr-merge.ts'

interface ClosingIssueNode {
  number: number
  repository: { nameWithOwner: string }
}

type RequiredCheckNode =
  | {
      __typename: 'CheckRun'
      name: string
      status: string
      conclusion: string | null
      isRequired: boolean
    }
  | {
      __typename: 'StatusContext'
      context: string
      state: string
      isRequired: boolean
    }

export class GitHubOrdinaryPullRequestMerge implements OrdinaryMergePullRequestPort {
  readonly #owner: string
  readonly #name: string
  readonly #client: GitHubClient

  constructor(options: { owner: string; name: string; client: GitHubClient }) {
    this.#owner = options.owner
    this.#name = options.name
    this.#client = options.client
  }

  async readPullRequest(pullRequestNumber: number): Promise<OrdinaryMergePullRequest> {
    const data: {
      repository: {
        nameWithOwner: string
        pullRequest: {
          number: number
          state: 'OPEN' | 'CLOSED' | 'MERGED'
          isDraft: boolean
          baseRefName: string
          headRefName: string
          headRefOid: string
          headRepository: { nameWithOwner: string } | null
          mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'
          mergeStateStatus: string
          reviewDecision: string | null
          mergeCommit: { oid: string } | null
          closingIssuesReferences: {
            nodes: ClosingIssueNode[]
            pageInfo: { hasNextPage: boolean }
          }
          commits: {
            nodes: Array<{
              commit: {
                oid: string
                statusCheckRollup: {
                  contexts: {
                    nodes: RequiredCheckNode[]
                    pageInfo: { hasNextPage: boolean }
                  }
                } | null
              }
            }>
          }
        } | null
      } | null
    } = await this.#client.graphql(
      `query OrdinaryPullRequestMerge($owner: String!, $name: String!, $number: Int!) {
        repository(owner: $owner, name: $name) {
          nameWithOwner
          pullRequest(number: $number) {
            number state isDraft baseRefName headRefName headRefOid
            headRepository { nameWithOwner }
            mergeable mergeStateStatus reviewDecision
            mergeCommit { oid }
            closingIssuesReferences(first: 100) {
              nodes { number repository { nameWithOwner } }
              pageInfo { hasNextPage }
            }
            commits(last: 1) {
              nodes {
                commit {
                  oid
                  statusCheckRollup {
                    contexts(first: 100) {
                      nodes {
                        __typename
                        ... on CheckRun {
                          name status conclusion isRequired(pullRequestNumber: $number)
                        }
                        ... on StatusContext {
                          context state isRequired(pullRequestNumber: $number)
                        }
                      }
                      pageInfo { hasNextPage }
                    }
                  }
                }
              }
            }
          }
        }
      }`,
      { owner: this.#owner, name: this.#name, number: pullRequestNumber },
    )
    const pullRequest = data.repository?.pullRequest
    if (pullRequest === null || pullRequest === undefined || data.repository === null) {
      throw new Error(
        `Pull request #${pullRequestNumber} was not found in the configured repository ${this.repository}.`,
      )
    }
    const commit = pullRequest.commits.nodes[0]?.commit
    const contexts = commit?.statusCheckRollup?.contexts
    const checks = contexts?.nodes.filter((check) => check.isRequired) ?? []
    return {
      repository: data.repository.nameWithOwner,
      number: pullRequest.number,
      state: pullRequest.state,
      isDraft: pullRequest.isDraft,
      baseRefName: pullRequest.baseRefName,
      headRefName: pullRequest.headRefName,
      headRefOid: pullRequest.headRefOid,
      headRepository: pullRequest.headRepository?.nameWithOwner ?? null,
      mergeable: pullRequest.mergeable,
      mergeStateStatus: pullRequest.mergeStateStatus,
      reviewDecision: pullRequest.reviewDecision,
      mergeCommitOid: pullRequest.mergeCommit?.oid ?? null,
      closingIssues: pullRequest.closingIssuesReferences.nodes.map((issue) => ({
        repository: issue.repository.nameWithOwner,
        number: issue.number,
      })),
      relationshipsComplete: !pullRequest.closingIssuesReferences.pageInfo.hasNextPage,
      requiredChecks: checks.map(normalizeRequiredCheck).sort(compareChecks),
      checksComplete:
        commit?.oid === pullRequest.headRefOid &&
        contexts !== undefined &&
        !contexts.pageInfo.hasNextPage,
    }
  }

  async mergePullRequest(
    pullRequestNumber: number,
    expectedHeadOid: string,
  ): Promise<OrdinaryMergeAttempt> {
    let response: Response
    try {
      response = await this.#client.requestRestOnce(
        `/repos/${encodeURIComponent(this.#owner)}/${encodeURIComponent(this.#name)}/pulls/${pullRequestNumber}/merge`,
        {
          method: 'PUT',
          body: JSON.stringify({ sha: expectedHeadOid, merge_method: 'merge' }),
        },
      )
    } catch {
      return { outcome: 'uncertain' }
    }
    if (!response.ok) {
      return response.status >= 500 || response.status === 408 || response.status === 429
        ? { outcome: 'uncertain' }
        : { outcome: 'rejected' }
    }
    try {
      const result = (await response.json()) as {
        merged?: unknown
        sha?: unknown
      }
      if (
        result.merged === true &&
        typeof result.sha === 'string' &&
        /^[a-f0-9]{40}$/.test(result.sha)
      ) {
        return { outcome: 'merged', mergeCommitOid: result.sha }
      }
      return result.merged === false ? { outcome: 'rejected' } : { outcome: 'uncertain' }
    } catch {
      return { outcome: 'uncertain' }
    }
  }

  get repository(): string {
    return `${this.#owner}/${this.#name}`
  }
}

function normalizeRequiredCheck(check: RequiredCheckNode): OrdinaryMergeRequiredCheck {
  if (check.__typename === 'StatusContext') {
    return {
      name: check.context,
      outcome:
        check.state === 'SUCCESS'
          ? 'success'
          : check.state === 'EXPECTED' || check.state === 'PENDING'
            ? 'pending'
            : 'failure',
    }
  }
  return {
    name: check.name,
    outcome:
      check.status !== 'COMPLETED'
        ? 'pending'
        : check.conclusion === 'SUCCESS'
          ? 'success'
          : 'failure',
  }
}

function compareChecks(
  first: OrdinaryMergeRequiredCheck,
  second: OrdinaryMergeRequiredCheck,
): number {
  return (
    first.name.localeCompare(second.name) || first.outcome.localeCompare(second.outcome)
  )
}
