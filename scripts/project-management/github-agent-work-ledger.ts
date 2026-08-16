import {
  AgentWorkAppendRejectedError,
  AgentWorkAppendUncertainError,
  type AgentWorkLedgerPort,
} from './agent-work-ledger.ts'
import { GitHubClient } from './github-client.ts'
import { nextPageCursor, type PageInfo } from './github-pagination.ts'

export interface GitHubAgentWorkLedgerOptions {
  owner: string
  name: string
  client: GitHubClient
}

export class GitHubAgentWorkLedger implements AgentWorkLedgerPort {
  readonly #owner: string
  readonly #name: string
  readonly #client: GitHubClient

  constructor(options: GitHubAgentWorkLedgerOptions) {
    this.#owner = options.owner
    this.#name = options.name
    this.#client = options.client
  }

  async listCommentBodies(issueNumber: number): Promise<string[]> {
    let cursor: string | null = null
    const bodies: string[] = []
    do {
      const data: {
        repository: {
          issue: {
            comments: {
              nodes: Array<{ body: string }>
              pageInfo: PageInfo
            }
          } | null
        } | null
      } = await this.#client.graphql(
        `query IssueAgentWorkComments($owner: String!, $name: String!, $number: Int!, $after: String) {
          repository(owner: $owner, name: $name) {
            issue(number: $number) {
              comments(first: 100, after: $after) {
                nodes { body }
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
      bodies.push(...issue.comments.nodes.map((comment) => comment.body))
      cursor = nextPageCursor(issue.comments.pageInfo)
    } while (cursor !== null)
    return bodies
  }

  async appendComment(issueNumber: number, body: string): Promise<void> {
    let response: Response
    try {
      response = await this.#client.requestRestOnce(
        `/repos/${encodeURIComponent(this.#owner)}/${encodeURIComponent(this.#name)}/issues/${issueNumber}/comments`,
        { method: 'POST', body: JSON.stringify({ body }) },
      )
    } catch {
      throw new AgentWorkAppendUncertainError()
    }
    if (!response.ok) {
      if (response.status === 408 || response.status === 429 || response.status >= 500) {
        throw new AgentWorkAppendUncertainError()
      }
      throw new AgentWorkAppendRejectedError()
    }
    try {
      const result = (await response.json()) as unknown
      if (
        typeof result !== 'object' ||
        result === null ||
        !('body' in result) ||
        result.body !== body
      ) {
        throw new AgentWorkAppendUncertainError()
      }
    } catch (error) {
      if (error instanceof AgentWorkAppendUncertainError) throw error
      throw new AgentWorkAppendUncertainError()
    }
  }

  get repository(): string {
    return `${this.#owner}/${this.#name}`
  }
}
