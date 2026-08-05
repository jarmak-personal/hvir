import { GitHubCanonicalProject } from './canonical-project.ts'
import { GitHubClient } from './github-client.ts'
import { GitHubIssueRepository } from './github-issues.ts'
import { GitHubPullRequestRepository } from './github-pull-requests.ts'
import type { IssueContextPort } from './issue-context.ts'
import { reconcilePlanningRecord } from './planning-record.ts'
import { parseProjectNumber, parseProjectRepository } from './project-config.ts'

export interface GitHubDeliveryAdapters {
  repositoryName: string
  issueContext: IssueContextPort
  pullRequests: GitHubPullRequestRepository
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
