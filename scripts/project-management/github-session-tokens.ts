import { GitHubClient } from './github-client.ts'
import { nextPageCursor, type PageInfo } from './github-pagination.ts'
import {
  readTokenReceipts,
  serializeTokenReceipt,
  type SessionTokenReceipt,
  type TokenReceiptHistory,
  type TokenReceiptPort,
  type TokenComment,
} from './session-token-receipts.ts'

export class GitHubSessionTokens implements TokenReceiptPort {
  private readonly client: GitHubClient
  private readonly owner: string
  private readonly name: string

  constructor(client: GitHubClient, owner: string, name: string) {
    this.client = client
    this.owner = owner
    this.name = name
  }

  async read(issue: number): Promise<TokenReceiptHistory> {
    const comments: TokenComment[] = []
    let after: string | null = null
    do {
      const data: {
        repository: {
          issue: {
            comments: {
              nodes: {
                body: string
                author: { login: string } | null
                createdAt: string
                updatedAt: string
              }[]
              pageInfo: PageInfo
            }
          } | null
        } | null
      } = await this.client.graphql(
        `query SessionTokenComments($owner:String!,$name:String!,$number:Int!,$after:String) {
          repository(owner:$owner,name:$name) { issue(number:$number) {
            comments(first:100,after:$after) {
              nodes { body author { login } createdAt updatedAt }
              pageInfo { endCursor hasNextPage }
            }
          } }
        }`,
        { owner: this.owner, name: this.name, number: issue, after },
      )
      const connection = data.repository?.issue?.comments
      if (!connection) throw new Error('Token history unavailable.')
      comments.push(
        ...connection.nodes.map((comment) => ({
          ...comment,
          authorLogin: comment.author?.login ?? null,
        })),
      )
      after = nextPageCursor(connection.pageInfo)
    } while (after !== null)
    return readTokenReceipts(issue, this.owner, comments)
  }

  async append(receipt: SessionTokenReceipt): Promise<void> {
    const body = serializeTokenReceipt(receipt)
    try {
      const response = await this.client.requestRestOnce(
        `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.name)}/issues/${receipt.issue}/comments`,
        { method: 'POST', body: JSON.stringify({ body }) },
      )
      if (!response.ok) throw new Error()
      const value = (await response.json()) as {
        body?: unknown
        user?: { login?: unknown }
        created_at?: unknown
        updated_at?: unknown
      }
      if (
        value.body !== body ||
        typeof value.user?.login !== 'string' ||
        value.user.login.toLowerCase() !== this.owner.toLowerCase() ||
        typeof value.created_at !== 'string' ||
        value.created_at !== value.updated_at
      )
        throw new Error()
    } catch {
      throw new Error(
        'Token append uncertain; retry capture with the same local assignment.',
      )
    }
  }
}
