import { GitHubClient } from './github-client.ts'
import { nextPageCursor, type PageInfo } from './github-pagination.ts'
import type { IssueReference } from './issue-planning.ts'
import type {
  PullRequestBodySnapshot,
  PullRequestSnapshot,
  PullRequestState,
} from './pull-request-relationships.ts'

export interface GitHubPullRequestRepositoryOptions {
  owner: string
  name: string
  client: GitHubClient
}

interface IssueConnectionNode {
  number: number
  state: 'OPEN' | 'CLOSED'
  repository: { nameWithOwner: string }
}

export class GitHubPullRequestRepository {
  readonly #owner: string
  readonly #name: string
  readonly #client: GitHubClient

  constructor(options: GitHubPullRequestRepositoryOptions) {
    this.#owner = options.owner
    this.#name = options.name
    this.#client = options.client
  }

  async getPullRequest(pullRequestNumber: number): Promise<PullRequestSnapshot> {
    const data: {
      repository: {
        pullRequest: {
          number: number
          state: PullRequestState
          isDraft: boolean
          baseRefName: string
          headRefName: string
          body: string
          repository: { nameWithOwner: string }
        } | null
      } | null
    } = await this.#client.graphql(
      `query PullRequestPlanning($owner: String!, $name: String!, $number: Int!) {
        repository(owner: $owner, name: $name) {
          pullRequest(number: $number) {
            number state isDraft baseRefName headRefName body
            repository { nameWithOwner }
          }
        }
      }`,
      { owner: this.#owner, name: this.#name, number: pullRequestNumber },
    )
    const pullRequest = data.repository?.pullRequest
    if (pullRequest === null || pullRequest === undefined) {
      throw new Error(
        `Pull request #${pullRequestNumber} was not found in the configured repository ${this.repository}.`,
      )
    }

    const [relatedIssues, manuallyLinkedIssues] = await Promise.all([
      this.#getClosingIssues(pullRequestNumber, false),
      this.#getClosingIssues(pullRequestNumber, true),
    ])
    const manuallyLinked = new Set(manuallyLinkedIssues.map(issueKey))
    return {
      repository: pullRequest.repository.nameWithOwner,
      number: pullRequest.number,
      state: pullRequest.state,
      isDraft: pullRequest.isDraft,
      baseRefName: pullRequest.baseRefName,
      headRefName: pullRequest.headRefName,
      body: pullRequest.body,
      closingIssues: relatedIssues
        .filter((issue) => !manuallyLinked.has(issueKey(issue)))
        .sort(compareIssues),
    }
  }

  async listOpenPullRequestBodies(): Promise<PullRequestBodySnapshot[]> {
    let cursor: string | null = null
    const pullRequests: PullRequestBodySnapshot[] = []
    do {
      const data: {
        repository: {
          pullRequests: {
            nodes: Array<{
              number: number
              baseRefName: string
              headRefName: string
              body: string
              repository: { nameWithOwner: string }
            }>
            pageInfo: PageInfo
          }
        } | null
      } = await this.#client.graphql(
        `query OpenPullRequestBodies($owner: String!, $name: String!, $after: String) {
          repository(owner: $owner, name: $name) {
            pullRequests(first: 100, after: $after, states: OPEN, orderBy: {field: CREATED_AT, direction: ASC}) {
              nodes { number baseRefName headRefName body repository { nameWithOwner } }
              pageInfo { endCursor hasNextPage }
            }
          }
        }`,
        { owner: this.#owner, name: this.#name, after: cursor },
      )
      const connection = data.repository?.pullRequests
      if (connection === undefined) {
        throw new Error(`Open pull requests in ${this.repository} could not be read.`)
      }
      pullRequests.push(
        ...connection.nodes.map((pullRequest) => ({
          repository: pullRequest.repository.nameWithOwner,
          number: pullRequest.number,
          baseRefName: pullRequest.baseRefName,
          headRefName: pullRequest.headRefName,
          body: pullRequest.body,
        })),
      )
      cursor = nextPageCursor(connection.pageInfo)
    } while (cursor !== null)

    return pullRequests
  }

  async listEpicBranches(parentIssueNumber: number): Promise<string[]> {
    let cursor: string | null = null
    const branches: string[] = []
    const prefix = 'refs/heads/epic/'
    const branchPrefix = `epic/${parentIssueNumber}-`
    do {
      const data: {
        repository: {
          refs: {
            nodes: Array<{ name: string }>
            pageInfo: PageInfo
          }
        } | null
      } = await this.#client.graphql(
        `query EpicBranches($owner: String!, $name: String!, $prefix: String!, $after: String) {
          repository(owner: $owner, name: $name) {
            refs(refPrefix: $prefix, first: 100, after: $after, orderBy: {field: ALPHABETICAL, direction: ASC}) {
              nodes { name }
              pageInfo { endCursor hasNextPage }
            }
          }
        }`,
        { owner: this.#owner, name: this.#name, prefix, after: cursor },
      )
      const connection = data.repository?.refs
      if (connection === undefined) {
        throw new Error(`Epic branches in ${this.repository} could not be read.`)
      }
      branches.push(
        ...connection.nodes
          .map((reference) => reference.name)
          .filter((name) => name.startsWith(branchPrefix)),
      )
      cursor = nextPageCursor(connection.pageInfo)
    } while (cursor !== null)

    return [...new Set(branches)].sort()
  }

  get repository(): string {
    return `${this.#owner}/${this.#name}`
  }

  async #getClosingIssues(
    pullRequestNumber: number,
    userLinkedOnly: boolean,
  ): Promise<IssueReference[]> {
    let cursor: string | null = null
    const issues: IssueReference[] = []
    do {
      const data: {
        repository: {
          pullRequest: {
            closingIssuesReferences: {
              nodes: IssueConnectionNode[]
              pageInfo: PageInfo
            }
          } | null
        } | null
      } = await this.#client.graphql(
        `query PullRequestClosingIssues($owner: String!, $name: String!, $number: Int!, $after: String, $userLinkedOnly: Boolean!) {
          repository(owner: $owner, name: $name) {
            pullRequest(number: $number) {
              closingIssuesReferences(first: 100, after: $after, userLinkedOnly: $userLinkedOnly) {
                nodes { number state repository { nameWithOwner } }
                pageInfo { endCursor hasNextPage }
              }
            }
          }
        }`,
        {
          owner: this.#owner,
          name: this.#name,
          number: pullRequestNumber,
          after: cursor,
          userLinkedOnly,
        },
      )
      const connection = data.repository?.pullRequest?.closingIssuesReferences
      if (connection === undefined) {
        throw new Error(
          `Closing issues for pull request #${pullRequestNumber} could not be read.`,
        )
      }
      issues.push(...connection.nodes.map(issueReference))
      cursor = nextPageCursor(connection.pageInfo)
    } while (cursor !== null)
    return issues
  }
}

function issueReference(issue: IssueConnectionNode): IssueReference {
  return {
    repository: issue.repository.nameWithOwner,
    number: issue.number,
    state: issue.state,
  }
}

function issueKey(issue: IssueReference): string {
  return `${issue.repository.toLowerCase()}#${issue.number}`
}

function compareIssues(first: IssueReference, second: IssueReference): number {
  return first.repository.localeCompare(second.repository) || first.number - second.number
}
