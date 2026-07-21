import { GitHubCanonicalProject } from './canonical-project.ts'
import { GitHubClient, type FetchImplementation } from './github-client.ts'
import { GitHubIssueRepository } from './github-issues.ts'
import type {
  IssueSnapshot,
  KindAutomationPort,
  ProjectKindSyncResult,
} from './kind-reconciler.ts'
import { KIND_DEFINITIONS, type KindOption } from './kind-policy.ts'

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
    option: string,
    apply: boolean,
  ): Promise<ProjectKindSyncResult> {
    const kind = requireKindOption(option)
    await this.#project.validateKindSchema()
    const item = await this.#project.getIssueItem(issue.number)
    if (item?.archived === true) {
      throw new Error(
        `Issue #${issue.number} has an archived item in the canonical Project.`,
      )
    }
    if (item?.kind === kind) {
      return { action: 'unchanged', issueAdded: false }
    }
    if (!apply) {
      return {
        action: item === undefined ? 'would-add-item' : 'would-update',
        issueAdded: false,
      }
    }

    const target = item ?? (await this.#project.addIssue(issue))
    const updated = await this.#project.setKind(target, kind)
    return {
      action:
        item === undefined ? 'added-and-updated' : updated ? 'updated' : 'unchanged',
      issueAdded: item === undefined,
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
