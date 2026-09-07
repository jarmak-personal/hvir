import { GitHubCanonicalProject } from './canonical-project.ts'
import { GitHubClient } from './github-client.ts'
import { GitHubIssueRepository } from './github-issues.ts'
import { GitHubPullRequestRepository } from './github-pull-requests.ts'
import type { IssueContextPort } from './issue-context.ts'
import {
  reconcilePlanningRecord,
  type IssuePlanningPort,
  type ProjectPlanningPort,
} from './planning-record.ts'
import { parseProjectNumber, parseProjectRepository } from './project-config.ts'

export interface GitHubDeliveryAdapters {
  repositoryName: string
  issueContext: IssueContextPort
  pullRequests: GitHubPullRequestRepository
  markInProgress: (issueNumber: number) => Promise<'updated' | 'unchanged'>
}

export function createGitHubDeliveryAdapters(
  environment: Readonly<Record<string, string | undefined>>,
): GitHubDeliveryAdapters {
  const [repositoryOwner, repositoryName] = parseProjectRepository(
    environment.HVIR_REPOSITORY ?? 'jarmak-personal/hvir',
  )
  const repositoryClient = new GitHubClient({
    token: environment.HVIR_REPO_TOKEN ?? '',
    purpose: 'repository',
  })
  const issues = new GitHubIssueRepository({
    owner: repositoryOwner,
    name: repositoryName,
    client: repositoryClient,
  })
  const pullRequests = new GitHubPullRequestRepository({
    owner: repositoryOwner,
    name: repositoryName,
    client: repositoryClient,
  })
  const project = new GitHubCanonicalProject({
    owner: environment.HVIR_PROJECT_OWNER ?? 'jarmak-personal',
    number: parseProjectNumber(environment.HVIR_PROJECT_NUMBER ?? '1'),
    repositoryOwner,
    repositoryName,
    client: new GitHubClient({
      token: environment.HVIR_PROJECT_TOKEN ?? '',
      purpose: 'Project',
    }),
  })

  return {
    markInProgress: (issueNumber) => markIssueInProgress(issues, project, issueNumber),
    repositoryName,
    issueContext: {
      inspectIssue: (number) =>
        reconcilePlanningRecord(issues, project, {
          issueNumber: number,
          ensureProject: false,
          apply: false,
        }),
      listEpicBranches: (number) => pullRequests.listEpicBranches(number),
      listOpenPullRequestBodies: () => pullRequests.listOpenPullRequestBodies(),
    },
    pullRequests,
  }
}

/** A skipped or unconverged write cannot claim successful implementation startup. */
export async function markIssueInProgress(
  issues: IssuePlanningPort,
  project: ProjectPlanningPort,
  issueNumber: number,
): Promise<'updated' | 'unchanged'> {
  const result = await reconcilePlanningRecord(issues, project, {
    issueNumber,
    ensureProject: false,
    status: 'In Progress',
    openOnly: true,
    apply: true,
  })
  const status = result.operations.find(
    (operation) => operation.operation === 'set-status',
  )
  if (
    result.record.issue.state !== 'OPEN' ||
    result.record.project.membership !== 'present' ||
    result.record.project.status !== 'In Progress' ||
    (status?.outcome !== 'updated' && status?.outcome !== 'unchanged')
  )
    throw new Error('Issue startup Status did not converge to OPEN / In Progress.')
  return status.outcome
}
