import type { AgentWorkProjectionIssue } from './agent-work-projector.ts'
import type {
  AgentWorkRollupIssue,
  AgentWorkRollupTargetIssue,
} from './agent-work-rollup.ts'
import type { GitHubClient } from './github-client.ts'
import { GitHubIssueRepository } from './github-issues.ts'
import { planKindLabels } from './kind-policy.ts'

export class GitHubAgentWorkSource {
  readonly #issues: GitHubIssueRepository

  constructor(options: { owner: string; name: string; client: GitHubClient }) {
    this.#issues = new GitHubIssueRepository(options)
  }

  async readProjectionIssue(issueNumber: number): Promise<AgentWorkProjectionIssue> {
    const issue = await this.#issues.getAgentWorkProjectionIssue(issueNumber)
    return {
      body: issue.body,
      kind: agentWorkKind(issue.labels),
      parent: issue.parent,
    }
  }

  async readRollupTarget(issueNumber: number): Promise<AgentWorkRollupTargetIssue> {
    const issue = await this.#issues.getAgentWorkRollupTarget(issueNumber)
    return {
      number: issue.number,
      repository: this.#issues.repository,
      state: issue.state,
      kind: agentWorkKind(issue.labels),
      parent: issue.parent,
      hasDirectChildren: issue.directChildren.length > 0,
      directChildren: issue.directChildren,
    }
  }

  async readRollupParticipant(issueNumber: number): Promise<AgentWorkRollupIssue> {
    const issue = await this.#issues.getAgentWorkRollupParticipant(issueNumber)
    return {
      number: issue.number,
      repository: this.#issues.repository,
      state: issue.state,
      kind: agentWorkKind(issue.labels),
      parent: issue.parent,
      hasDirectChildren: issue.hasDirectChildren,
    }
  }
}

function agentWorkKind(labels: readonly string[]): AgentWorkRollupIssue['kind'] {
  const kind = planKindLabels(labels, { action: 'reconcile' })
  return kind.state !== 'valid'
    ? 'invalid'
    : kind.kind?.label === 'kind:epic'
      ? 'epic'
      : 'other'
}
