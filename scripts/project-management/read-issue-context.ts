import { GitHubCanonicalProject } from './canonical-project.ts'
import { GitHubClient } from './github-client.ts'
import { GitHubIssueRepository } from './github-issues.ts'
import { GitHubPullRequestRepository } from './github-pull-requests.ts'
import {
  formatIssueContext,
  ISSUE_CONTEXT_HELP,
  issueContextExitCode,
  parseIssueContextCliOptions,
  parseIssueContextRepository,
  resolvePrimaryRepositoryRoot,
} from './issue-context-cli.ts'
import { readIssueDeliveryContext } from './issue-context.ts'
import { reconcilePlanningRecord } from './planning-record.ts'
import { parseProjectNumber } from './project-config.ts'

async function main(): Promise<void> {
  const options = parseIssueContextCliOptions(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(ISSUE_CONTEXT_HELP)
    return
  }
  const issueNumber = requireIssueNumber(options.issueNumber)
  const [repositoryOwner, repositoryName] = parseIssueContextRepository(
    process.env.HVIR_REPOSITORY ?? 'jarmak-personal/hvir',
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
    number: parseProjectNumber(process.env.HVIR_PROJECT_NUMBER ?? '1'),
    repositoryOwner,
    repositoryName,
    client: new GitHubClient({
      token: process.env.HVIR_PROJECT_TOKEN ?? '',
      purpose: 'Project',
    }),
  })
  const context = await readIssueDeliveryContext(
    {
      inspectIssue: (number) =>
        reconcilePlanningRecord(issues, project, {
          issueNumber: number,
          ensureProject: false,
          apply: false,
        }),
      listEpicBranches: (number) => pullRequests.listEpicBranches(number),
      listOpenPullRequestBodies: () => pullRequests.listOpenPullRequestBodies(),
    },
    {
      issueNumber,
      primaryRoot: resolvePrimaryRepositoryRoot(
        process.cwd(),
        repositoryName,
        process.env,
      ),
    },
  )
  process.stdout.write(
    options.json ? `${JSON.stringify(context, null, 2)}\n` : formatIssueContext(context),
  )
  process.exitCode = issueContextExitCode(context)
}

function requireIssueNumber(issueNumber: number | undefined): number {
  if (issueNumber === undefined) throw new Error('Issue number was not parsed.')
  return issueNumber
}

main().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.message : 'Unknown issue context failure.'
  process.stderr.write(`issue context failed: ${message}\n`)
  process.exitCode = 1
})
