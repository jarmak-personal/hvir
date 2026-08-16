import { GitHubClient } from './github-client.ts'
import type { AgentWorkRollupIssue } from './agent-work-rollup.ts'
import { GitHubIssueRepository } from './github-issues.ts'
import { planKindLabels } from './kind-policy.ts'

export class GitHubAgentWorkSource {
  readonly #owner: string
  readonly #name: string
  readonly #client: GitHubClient
  readonly #issues: GitHubIssueRepository

  constructor(options: { owner: string; name: string; client: GitHubClient }) {
    this.#owner = options.owner
    this.#name = options.name
    this.#client = options.client
    this.#issues = new GitHubIssueRepository(options)
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
    const issue = await this.#issues.getIssueHierarchy(issueNumber)
    const kind = planKindLabels(issue.labels, { action: 'reconcile' })
    return {
      number: issue.number,
      repository: issue.repository,
      state: issue.state,
      kind:
        kind.state !== 'valid'
          ? 'invalid'
          : kind.kind?.label === 'kind:epic'
            ? 'epic'
            : 'other',
      parent:
        issue.parent === null
          ? null
          : { number: issue.parent.number, repository: issue.parent.repository },
      directChildren: issue.subIssues.map((child) => ({
        number: child.number,
        repository: child.repository,
      })),
    }
  }
}
