import { GitHubClient } from './github-client.ts'

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
}
