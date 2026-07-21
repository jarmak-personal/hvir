import { GitHubCanonicalProject } from './canonical-project.ts'
import { GitHubClient } from './github-client.ts'
import { GitHubIssueRepository } from './github-issues.ts'
import { GitHubPullRequestRepository } from './github-pull-requests.ts'
import { reconcilePlanningRecord } from './planning-record.ts'
import {
  parseProjectPullRequestCliOptions,
  parseProjectPullRequestProjectNumber,
  parseProjectPullRequestRepository,
  PROJECT_PULL_REQUEST_HELP,
  projectPullRequestExitCode,
} from './pull-request-cli.ts'
import {
  reconcilePullRequestPlanning,
  reconcileReopenedIssuePlanning,
} from './pull-request-planning.ts'

async function main(): Promise<void> {
  const options = parseProjectPullRequestCliOptions(process.argv.slice(2), process.env)
  if (options.help) {
    process.stdout.write(PROJECT_PULL_REQUEST_HELP)
    return
  }
  const [repositoryOwner, repositoryName] = parseProjectPullRequestRepository(
    process.env.HVIR_REPOSITORY ?? 'jarmak-personal/hvir',
  )
  const projectNumber = parseProjectPullRequestProjectNumber(
    process.env.HVIR_PROJECT_NUMBER ?? '1',
  )
  const repositoryClient = new GitHubClient({
    token: process.env.HVIR_REPO_TOKEN ?? '',
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
    owner: process.env.HVIR_PROJECT_OWNER ?? 'jarmak-personal',
    number: projectNumber,
    repositoryOwner,
    repositoryName,
    client: new GitHubClient({
      token: process.env.HVIR_PROJECT_TOKEN ?? '',
      purpose: 'Project',
    }),
  })
  const planningRecords = {
    reconcile: (input: Parameters<typeof reconcilePlanningRecord>[2]) =>
      reconcilePlanningRecord(issues, project, input),
  }
  const report =
    options.pullRequestNumber === undefined
      ? await reconcileReopenedIssuePlanning(pullRequests, planningRecords, {
          repository: `${repositoryOwner}/${repositoryName}`,
          issueNumber: requireIssueNumber(options.issueNumber),
          apply: options.apply,
        })
      : await reconcilePullRequestPlanning(pullRequests, planningRecords, {
          pullRequestNumber: options.pullRequestNumber,
          apply: options.apply,
          ...(options.previousBody === undefined
            ? {}
            : { previousBody: options.previousBody }),
        })
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  process.exitCode = projectPullRequestExitCode(report)
}

function requireIssueNumber(issueNumber: number | undefined): number {
  if (issueNumber === undefined) throw new Error('Issue number was not parsed.')
  return issueNumber
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown PR planning failure.'
  process.stderr.write(`pull request planning reconciliation failed: ${message}\n`)
  process.exitCode = 1
})
