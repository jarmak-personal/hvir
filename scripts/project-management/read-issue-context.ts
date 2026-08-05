import { createGitHubDeliveryAdapters } from './github-delivery-adapters.ts'
import {
  formatIssueContext,
  ISSUE_CONTEXT_HELP,
  issueContextExitCode,
  parseIssueContextCliOptions,
  resolvePrimaryRepositoryRoot,
} from './issue-context-cli.ts'
import { readIssueDeliveryContext } from './issue-context.ts'

async function main(): Promise<void> {
  const options = parseIssueContextCliOptions(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(ISSUE_CONTEXT_HELP)
    return
  }
  const issueNumber = requireIssueNumber(options.issueNumber)
  const adapters = createGitHubDeliveryAdapters(process.env)
  const context = await readIssueDeliveryContext(adapters.issueContext, {
    issueNumber,
    primaryRoot: resolvePrimaryRepositoryRoot(
      process.cwd(),
      adapters.repositoryName,
      process.env,
    ),
  })
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
