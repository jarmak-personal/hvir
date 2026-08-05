import { createGitHubDeliveryAdapters } from './github-delivery-adapters.ts'
import {
  formatIssueStartOperationalFailure,
  formatIssueStartReport,
  ISSUE_START_HELP,
  parseIssueStartCliOptions,
} from './issue-start-cli.ts'
import { resolvePrimaryRepositoryRoot } from './issue-context-cli.ts'
import { issueStartExitCode, runIssueStart } from './issue-start.ts'
import { readIssueDeliveryContext } from './issue-context.ts'
import { resolveIssueDelivery } from './issue-delivery.ts'
import { NativeIssueWorktreeRepository } from './native-issue-worktrees.ts'

async function main(): Promise<void> {
  const options = parseIssueStartCliOptions(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(ISSUE_START_HELP)
    return
  }
  const issueNumber = requireIssueNumber(options.issueNumber)
  const adapters = createGitHubDeliveryAdapters(process.env)
  const primaryRoot = resolvePrimaryRepositoryRoot(
    process.cwd(),
    adapters.repositoryName,
    process.env,
  )
  const abortController = new AbortController()
  const abort = (): void => abortController.abort()
  process.once('SIGINT', abort)
  process.once('SIGTERM', abort)
  try {
    const report = await runIssueStart(
      {
        context: {
          readIssueContext: (number, root) =>
            readIssueDeliveryContext(adapters.issueContext, {
              issueNumber: number,
              primaryRoot: root,
            }),
          readExpectedBase: async (number) =>
            (await resolveIssueDelivery(adapters.issueContext, number)).base,
        },
        metadata: {
          listWorkflowPullRequestEvidence: (branch) =>
            adapters.pullRequests.listWorkflowPullRequestEvidence(branch),
        },
        repository: new NativeIssueWorktreeRepository({
          primaryRoot,
          environment: process.env,
        }),
      },
      {
        issueNumber,
        primaryRoot,
        invocationRoot: process.cwd(),
        apply: options.apply,
        signal: abortController.signal,
      },
    )
    process.stdout.write(
      options.json
        ? `${JSON.stringify(report, null, 2)}\n`
        : formatIssueStartReport(report),
    )
    process.exitCode = issueStartExitCode(report)
  } finally {
    process.removeListener('SIGINT', abort)
    process.removeListener('SIGTERM', abort)
  }
}

function requireIssueNumber(issueNumber: number | undefined): number {
  if (issueNumber === undefined) throw new Error('Issue number was not parsed.')
  return issueNumber
}

const jsonOutput = process.argv.includes('--json')
main().catch(() => {
  process.stderr.write(formatIssueStartOperationalFailure(jsonOutput))
  process.exitCode = 1
})
