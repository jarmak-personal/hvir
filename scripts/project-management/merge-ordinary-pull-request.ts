import { GitHubAgentWorkLedger } from './github-agent-work-ledger.ts'
import { GitHubAgentWorkSource } from './github-agent-work-source.ts'
import { GitHubCanonicalProject } from './canonical-project.ts'
import { GitHubClient } from './github-client.ts'
import { GitHubIssueRepository } from './github-issues.ts'
import { GitHubOrdinaryPullRequestMerge } from './github-ordinary-pr-merge.ts'
import {
  formatOrdinaryPullRequestMergeReport,
  ORDINARY_PULL_REQUEST_MERGE_HELP,
  ordinaryPullRequestMergeExitCode,
  parseOrdinaryPullRequestMergeCliOptions,
} from './ordinary-pr-merge-cli.ts'
import { reconcileOrdinaryPullRequestMerge } from './ordinary-pr-merge.ts'
import { convergePlanningRecord, reconcilePlanningRecord } from './planning-record.ts'
import { parseProjectNumber, parseProjectRepository } from './project-config.ts'

async function main(): Promise<void> {
  const options = parseOrdinaryPullRequestMergeCliOptions(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(ORDINARY_PULL_REQUEST_MERGE_HELP)
    return
  }
  const [owner, name] = parseProjectRepository(
    process.env.HVIR_REPOSITORY ?? 'jarmak-personal/hvir',
  )
  const repositoryClient = new GitHubClient({
    token: process.env.HVIR_REPO_TOKEN ?? '',
    purpose: 'repository',
  })
  const issues = new GitHubIssueRepository({ owner, name, client: repositoryClient })
  const project = new GitHubCanonicalProject({
    owner: process.env.HVIR_PROJECT_OWNER ?? 'jarmak-personal',
    number: parseProjectNumber(process.env.HVIR_PROJECT_NUMBER ?? '1'),
    repositoryOwner: owner,
    repositoryName: name,
    client: new GitHubClient({
      token: process.env.HVIR_PROJECT_TOKEN ?? '',
      purpose: 'Project',
    }),
  })
  const ledger = new GitHubAgentWorkLedger({ owner, name, client: repositoryClient })
  const projectionSource = new GitHubAgentWorkSource({
    owner,
    name,
    client: repositoryClient,
  })
  const report = await reconcileOrdinaryPullRequestMerge(
    {
      pullRequests: new GitHubOrdinaryPullRequestMerge({
        owner,
        name,
        client: repositoryClient,
      }),
      planning: {
        inspect: (issueNumber) =>
          reconcilePlanningRecord(issues, project, {
            issueNumber,
            ensureProject: false,
            apply: false,
          }),
        converge: (input) => convergePlanningRecord(issues, project, input),
      },
      ledger,
      projectionSource,
      project,
    },
    {
      issueNumber: requireOption(options.issueNumber, '--issue'),
      pullRequestNumber: requireOption(options.pullRequestNumber, '--pull-request'),
      candidateOid: requireOption(options.candidateOid, '--candidate'),
      apply: options.apply,
    },
  )
  process.stdout.write(formatOrdinaryPullRequestMergeReport(report, options.json))
  process.exitCode = ordinaryPullRequestMergeExitCode(report)
}

function requireOption<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`${name} was not parsed.`)
  return value
}

main().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.message : 'Unknown ordinary merge failure.'
  process.stderr.write(`ordinary pull request merge failed: ${message}\n`)
  process.exitCode = 1
})
