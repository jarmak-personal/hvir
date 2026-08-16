import { GitHubClient } from './github-client.ts'
import type {
  AgentWorkRollupIssue,
  AgentWorkRollupIssueReference,
} from './agent-work-rollup.ts'
import { nextPageCursor, type PageInfo } from './github-pagination.ts'
import { isKindLabel } from './kind-policy.ts'

export class GitHubAgentWorkSource {
  readonly #owner: string
  readonly #name: string
  readonly #client: GitHubClient

  constructor(options: { owner: string; name: string; client: GitHubClient }) {
    this.#owner = options.owner
    this.#name = options.name
    this.#client = options.client
  }

  async readIssueBody(issueNumber: number): Promise<string> {
    const data: {
      repository: { issue: { body: string } | null } | null
    } = await this.#client.graphql(
      `query IssueAgentWorkForecast($owner: String!, $name: String!, $number: Int!) {
        repository(owner: $owner, name: $name) {
          issue(number: $number) { body }
        }
      }`,
      { owner: this.#owner, name: this.#name, number: issueNumber },
    )
    const issue = data.repository?.issue
    if (issue === null || issue === undefined) {
      throw new Error(
        `Issue #${issueNumber} was not found in the configured repository ${this.#owner}/${this.#name}.`,
      )
    }
    return issue.body
  }

  async readRollupIssue(issueNumber: number): Promise<AgentWorkRollupIssue> {
    const [identity, directChildren] = await Promise.all([
      this.#readRollupIdentity(issueNumber),
      this.#readDirectChildren(issueNumber),
    ])
    return { ...identity, directChildren }
  }

  async #readRollupIdentity(
    issueNumber: number,
  ): Promise<Omit<AgentWorkRollupIssue, 'directChildren'>> {
    let cursor: string | null = null
    let identity: Omit<AgentWorkRollupIssue, 'kind' | 'directChildren'> | undefined
    const labels: string[] = []
    do {
      const data: {
        repository: {
          issue: {
            number: number
            state: 'OPEN' | 'CLOSED'
            repository: { nameWithOwner: string }
            parent: null | {
              number: number
              repository: { nameWithOwner: string }
            }
            labels: { nodes: Array<{ name: string }>; pageInfo: PageInfo }
          } | null
        } | null
      } = await this.#client.graphql(
        `query IssueAgentWorkRollupIdentity($owner: String!, $name: String!, $number: Int!, $after: String) {
          repository(owner: $owner, name: $name) {
            issue(number: $number) {
              number state repository { nameWithOwner }
              parent { number repository { nameWithOwner } }
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
      if (issue === null || issue === undefined) this.#missingIssue(issueNumber)
      identity ??= {
        number: issue.number,
        repository: issue.repository.nameWithOwner,
        state: issue.state,
        parent:
          issue.parent === null
            ? null
            : {
                number: issue.parent.number,
                repository: issue.parent.repository.nameWithOwner,
              },
      }
      labels.push(...issue.labels.nodes.map((label) => label.name))
      cursor = nextPageCursor(issue.labels.pageInfo)
    } while (cursor !== null)

    const kinds = [...new Set(labels.filter((label) => label.startsWith('kind:')))]
    return {
      ...identity,
      kind:
        kinds.length !== 1 || !isKindLabel(kinds[0]!)
          ? 'invalid'
          : kinds[0] === 'kind:epic'
            ? 'epic'
            : 'other',
    }
  }

  async #readDirectChildren(
    issueNumber: number,
  ): Promise<AgentWorkRollupIssueReference[]> {
    let cursor: string | null = null
    const children: AgentWorkRollupIssueReference[] = []
    do {
      const data: {
        repository: {
          issue: {
            subIssues: {
              nodes: Array<{
                number: number
                repository: { nameWithOwner: string }
              }>
              pageInfo: PageInfo
            }
          } | null
        } | null
      } = await this.#client.graphql(
        `query IssueAgentWorkRollupChildren($owner: String!, $name: String!, $number: Int!, $after: String) {
          repository(owner: $owner, name: $name) {
            issue(number: $number) {
              subIssues(first: 100, after: $after) {
                nodes { number repository { nameWithOwner } }
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
      const connection = data.repository?.issue?.subIssues
      if (connection === undefined) this.#missingIssue(issueNumber)
      children.push(
        ...connection.nodes.map((child) => ({
          number: child.number,
          repository: child.repository.nameWithOwner,
        })),
      )
      cursor = nextPageCursor(connection.pageInfo)
    } while (cursor !== null)
    return children
  }

  #missingIssue(issueNumber: number): never {
    throw new Error(
      `Issue #${issueNumber} was not found in the configured repository ${this.#owner}/${this.#name}.`,
    )
  }
}
