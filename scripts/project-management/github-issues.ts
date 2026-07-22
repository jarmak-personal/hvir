import { GitHubClient } from './github-client.ts'
import { nextPageCursor, type PageInfo } from './github-pagination.ts'
import type {
  IssueReference,
  IssueSnapshot,
  PlanningIssueSnapshot,
  PullRequestReference,
} from './issue-planning.ts'

export type {
  IssueReference,
  PlanningIssueSnapshot,
  PullRequestReference,
} from './issue-planning.ts'

export interface GitHubIssueRepositoryOptions {
  owner: string
  name: string
  client: GitHubClient
}

interface IssueConnectionNode {
  number: number
  state: 'OPEN' | 'CLOSED'
  repository: { nameWithOwner: string }
}

interface PullRequestConnectionNode {
  number: number
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  mergedAt: string | null
  repository: { nameWithOwner: string }
}

export class GitHubIssueRepository {
  readonly #owner: string
  readonly #name: string
  readonly #client: GitHubClient

  constructor(options: GitHubIssueRepositoryOptions) {
    this.#owner = options.owner
    this.#name = options.name
    this.#client = options.client
  }

  async getIssue(issueNumber: number): Promise<IssueSnapshot> {
    let cursor: string | null = null
    let snapshot: Omit<IssueSnapshot, 'labels'> | undefined
    const labels: string[] = []

    do {
      const data: {
        repository: {
          issue: {
            id: string
            number: number
            state: 'OPEN' | 'CLOSED'
            updatedAt: string
            labels: { nodes: Array<{ name: string }>; pageInfo: PageInfo }
          } | null
        } | null
      } = await this.#client.graphql(
        `query IssueKind($owner: String!, $name: String!, $number: Int!, $after: String) {
          repository(owner: $owner, name: $name) {
            issue(number: $number) {
              id number state updatedAt
              labels(first: 100, after: $after) {
                nodes { name }
                pageInfo { endCursor hasNextPage }
              }
            }
          }
        }`,
        {
          owner: this.#owner,
          name: this.#name,
          number: issueNumber,
          after: cursor,
        },
      )
      const issue = data.repository?.issue
      if (issue === null || issue === undefined) {
        throw new Error(
          `Issue #${issueNumber} was not found in the configured repository ${this.repository}.`,
        )
      }
      snapshot ??= {
        id: issue.id,
        number: issue.number,
        state: issue.state,
        updatedAt: issue.updatedAt,
      }
      labels.push(...issue.labels.nodes.map((label) => label.name))
      cursor = nextPageCursor(issue.labels.pageInfo)
    } while (cursor !== null)

    if (snapshot === undefined) {
      throw new Error(`Issue #${issueNumber} could not be loaded.`)
    }
    return { ...snapshot, labels }
  }

  async listOpenIssues(): Promise<IssueSnapshot[]> {
    let cursor: string | null = null
    const issues: IssueSnapshot[] = []

    do {
      const data: {
        repository: {
          issues: {
            nodes: Array<{
              id: string
              number: number
              state: 'OPEN'
              updatedAt: string
              labels: { nodes: Array<{ name: string }>; pageInfo: PageInfo }
            }>
            pageInfo: PageInfo
          }
        } | null
      } = await this.#client.graphql(
        `query OpenIssueKinds($owner: String!, $name: String!, $after: String) {
          repository(owner: $owner, name: $name) {
            issues(first: 100, after: $after, states: OPEN, orderBy: {field: CREATED_AT, direction: ASC}) {
              nodes {
                id number state updatedAt
                labels(first: 100) {
                  nodes { name }
                  pageInfo { endCursor hasNextPage }
                }
              }
              pageInfo { endCursor hasNextPage }
            }
          }
        }`,
        { owner: this.#owner, name: this.#name, after: cursor },
      )
      const connection = data.repository?.issues
      if (connection === undefined) {
        throw new Error(
          `The configured repository ${this.repository} was not found or is not readable.`,
        )
      }
      for (const issue of connection.nodes) {
        if (issue.labels.pageInfo.hasNextPage) {
          issues.push(await this.getIssue(issue.number))
        } else {
          issues.push({
            id: issue.id,
            number: issue.number,
            state: issue.state,
            updatedAt: issue.updatedAt,
            labels: issue.labels.nodes.map((label) => label.name),
          })
        }
      }
      cursor = nextPageCursor(connection.pageInfo)
    } while (cursor !== null)

    return issues
  }

  async getPlanningIssue(issueNumber: number): Promise<PlanningIssueSnapshot> {
    const issue = await this.getIssue(issueNumber)
    const [parent, subIssues, linked, manuallyLinked] = await Promise.all([
      this.#getParent(issueNumber),
      this.#getSubIssues(issueNumber),
      this.#getPullRequests(issueNumber, false),
      this.#getPullRequests(issueNumber, true),
    ])
    const manuallyLinkedKeys = new Set(manuallyLinked.map(pullRequestKey))

    return {
      ...issue,
      repository: this.repository,
      parent,
      subIssues: sortIssueReferences(subIssues),
      linkedPullRequests: linked
        .map((pullRequest) => ({
          ...pullRequest,
          relationship: manuallyLinkedKeys.has(pullRequestKey(pullRequest))
            ? ('linked' as const)
            : ('closing' as const),
        }))
        .sort(compareReferences),
    }
  }

  async addLabels(issueNumber: number, labels: string[]): Promise<void> {
    if (labels.length === 0) return
    await this.#client.rest(
      `/repos/${encodeURIComponent(this.#owner)}/${encodeURIComponent(this.#name)}/issues/${issueNumber}/labels`,
      { method: 'POST', body: JSON.stringify({ labels }) },
    )
  }

  async removeLabel(issueNumber: number, label: string): Promise<void> {
    const response = await this.#client.requestRest(
      `/repos/${encodeURIComponent(this.#owner)}/${encodeURIComponent(this.#name)}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`,
      { method: 'DELETE' },
    )
    if (!response.ok && response.status !== 404) {
      throw new Error(`GitHub rejected a label removal with HTTP ${response.status}.`)
    }
  }

  async closeIssue(issueNumber: number): Promise<void> {
    const result = await this.#client.rest(
      `/repos/${encodeURIComponent(this.#owner)}/${encodeURIComponent(this.#name)}/issues/${issueNumber}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ state: 'closed', state_reason: 'completed' }),
      },
    )
    if (
      typeof result !== 'object' ||
      result === null ||
      !('number' in result) ||
      result.number !== issueNumber ||
      !('state' in result) ||
      result.state !== 'closed'
    ) {
      throw new Error(`GitHub did not confirm closure of issue #${issueNumber}.`)
    }
  }

  get repository(): string {
    return `${this.#owner}/${this.#name}`
  }

  async #getParent(issueNumber: number): Promise<IssueReference | null> {
    const data: {
      repository: {
        issue: {
          parent: IssueConnectionNode | null
        } | null
      } | null
    } = await this.#client.graphql(
      `query IssueParent($owner: String!, $name: String!, $number: Int!) {
        repository(owner: $owner, name: $name) {
          issue(number: $number) {
            parent { number state repository { nameWithOwner } }
          }
        }
      }`,
      { owner: this.#owner, name: this.#name, number: issueNumber },
    )
    const issue = data.repository?.issue
    if (issue === null || issue === undefined) {
      throw new Error(
        `Issue #${issueNumber} disappeared from the configured repository while relationships were being read.`,
      )
    }
    return issue.parent === null ? null : issueReference(issue.parent)
  }

  async #getSubIssues(issueNumber: number): Promise<IssueReference[]> {
    let cursor: string | null = null
    const issues: IssueReference[] = []
    do {
      const data: {
        repository: {
          issue: {
            subIssues: { nodes: IssueConnectionNode[]; pageInfo: PageInfo }
          } | null
        } | null
      } = await this.#client.graphql(
        `query IssueSubIssues($owner: String!, $name: String!, $number: Int!, $after: String) {
          repository(owner: $owner, name: $name) {
            issue(number: $number) {
              subIssues(first: 100, after: $after) {
                nodes { number state repository { nameWithOwner } }
                pageInfo { endCursor hasNextPage }
              }
            }
          }
        }`,
        { owner: this.#owner, name: this.#name, number: issueNumber, after: cursor },
      )
      const connection = data.repository?.issue?.subIssues
      if (connection === undefined) {
        throw new Error(`Sub-issues for issue #${issueNumber} could not be read.`)
      }
      issues.push(...connection.nodes.map(issueReference))
      cursor = nextPageCursor(connection.pageInfo)
    } while (cursor !== null)
    return issues
  }

  async #getPullRequests(
    issueNumber: number,
    userLinkedOnly: boolean,
  ): Promise<Array<Omit<PullRequestReference, 'relationship'>>> {
    let cursor: string | null = null
    const pullRequests: Array<Omit<PullRequestReference, 'relationship'>> = []
    do {
      const data: {
        repository: {
          issue: {
            closedByPullRequestsReferences: {
              nodes: PullRequestConnectionNode[]
              pageInfo: PageInfo
            }
          } | null
        } | null
      } = await this.#client.graphql(
        `query IssuePullRequests($owner: String!, $name: String!, $number: Int!, $after: String, $userLinkedOnly: Boolean!) {
          repository(owner: $owner, name: $name) {
            issue(number: $number) {
              closedByPullRequestsReferences(
                first: 100
                after: $after
                includeClosedPrs: true
                userLinkedOnly: $userLinkedOnly
              ) {
                nodes { number state mergedAt repository { nameWithOwner } }
                pageInfo { endCursor hasNextPage }
              }
            }
          }
        }`,
        {
          owner: this.#owner,
          name: this.#name,
          number: issueNumber,
          after: cursor,
          userLinkedOnly,
        },
      )
      const connection = data.repository?.issue?.closedByPullRequestsReferences
      if (connection === undefined) {
        throw new Error(
          `Linked pull requests for issue #${issueNumber} could not be read.`,
        )
      }
      pullRequests.push(
        ...connection.nodes.map((pullRequest) => ({
          repository: pullRequest.repository.nameWithOwner,
          number: pullRequest.number,
          state: pullRequest.state,
          mergedAt: pullRequest.mergedAt,
        })),
      )
      cursor = nextPageCursor(connection.pageInfo)
    } while (cursor !== null)
    return pullRequests
  }
}

function issueReference(issue: IssueConnectionNode): IssueReference {
  return {
    repository: issue.repository.nameWithOwner,
    number: issue.number,
    state: issue.state,
  }
}

function sortIssueReferences(issues: IssueReference[]): IssueReference[] {
  return issues.sort(compareReferences)
}

function compareReferences(
  first: { repository: string; number: number },
  second: { repository: string; number: number },
): number {
  return first.repository.localeCompare(second.repository) || first.number - second.number
}

function pullRequestKey(pullRequest: { repository: string; number: number }): string {
  return `${pullRequest.repository.toLowerCase()}#${pullRequest.number}`
}
