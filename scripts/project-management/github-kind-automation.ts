import { GitHubCanonicalProject } from './canonical-project.ts'
import { GitHubClient, type FetchImplementation } from './github-client.ts'
import { GitHubIssueRepository } from './github-issues.ts'
import type {
  IssueSnapshot,
  KindAutomationPort,
  ProjectKindSyncResult,
} from './kind-reconciler.ts'
import { KIND_DEFINITIONS, type KindOption } from './kind-policy.ts'
import { convergeProjectPlanning } from './planning-record.ts'

export interface GitHubKindAutomationOptions {
  repositoryOwner: string
  repositoryName: string
  projectOwner: string
  projectNumber: number
  repositoryToken: string
  projectToken: string
  fetchImplementation?: FetchImplementation
  wait?: (milliseconds: number) => Promise<void>
}

export class GitHubKindAutomation implements KindAutomationPort {
  readonly #issues: GitHubIssueRepository
  readonly #project: GitHubCanonicalProject

  constructor(options: GitHubKindAutomationOptions) {
    const repositoryClient = new GitHubClient({
      token: options.repositoryToken,
      purpose: 'repository',
      ...(options.fetchImplementation === undefined
        ? {}
        : { fetchImplementation: options.fetchImplementation }),
      ...(options.wait === undefined ? {} : { wait: options.wait }),
    })
    const projectClient = new GitHubClient({
      token: options.projectToken,
      purpose: 'Project',
      ...(options.fetchImplementation === undefined
        ? {}
        : { fetchImplementation: options.fetchImplementation }),
      ...(options.wait === undefined ? {} : { wait: options.wait }),
    })
    this.#issues = new GitHubIssueRepository({
      owner: options.repositoryOwner,
      name: options.repositoryName,
      client: repositoryClient,
    })
    this.#project = new GitHubCanonicalProject({
      owner: options.projectOwner,
      number: options.projectNumber,
      repositoryOwner: options.repositoryOwner,
      repositoryName: options.repositoryName,
      client: projectClient,
    })
  }

  getIssue(issueNumber: number): Promise<IssueSnapshot> {
    return this.#issues.getIssue(issueNumber)
  }

  listOpenIssues(): Promise<IssueSnapshot[]> {
    return this.#issues.listOpenIssues()
  }

  addLabels(issueNumber: number, labels: string[]): Promise<void> {
    return this.#issues.addLabels(issueNumber, labels)
  }

  removeLabel(issueNumber: number, label: string): Promise<void> {
    return this.#issues.removeLabel(issueNumber, label)
  }

  async syncProjectKind(
    issue: IssueSnapshot,
    option: string | undefined,
    apply: boolean,
  ): Promise<ProjectKindSyncResult> {
    const kind = option === undefined ? undefined : requireKindOption(option)
    const report = await convergeProjectPlanning(issue, this.#project, {
      active: false,
      apply,
      ...(kind === undefined ? {} : { derivedKind: kind }),
    })
    const membership = report.operations.find(
      (operation) => operation.operation === 'ensure-project',
    )
    const fieldMutations = report.operations.filter(
      (operation) =>
        (operation.operation === 'set-kind' || operation.operation === 'set-status') &&
        operation.outcome !== 'unchanged',
    )
    const issueAdded = membership?.outcome === 'added'
    return {
      action: issueAdded
        ? 'added-and-updated'
        : membership?.outcome === 'would-add'
          ? 'would-add-item'
          : fieldMutations.some((operation) => operation.outcome === 'updated') ||
              membership?.outcome === 'restored'
            ? 'updated'
            : fieldMutations.length > 0 || membership?.outcome === 'would-restore'
              ? 'would-update'
              : 'unchanged',
      issueAdded,
    }
  }
}

function requireKindOption(value: string): KindOption {
  const match = KIND_DEFINITIONS.find((definition) => definition.option === value)
  if (match === undefined) {
    throw new Error(`Unexpected Project Kind option: "${value}".`)
  }
  return match.option
}
