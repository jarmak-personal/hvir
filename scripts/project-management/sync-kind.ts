import { GitHubKindAutomation } from './github-kind-automation.ts'
import {
  parseProjectKindCliOptions,
  parseProjectKindProjectNumber,
  parseProjectKindRepository,
  PROJECT_KIND_HELP,
  projectKindExitCode,
} from './kind-cli.ts'
import { reconcileKinds, type ReconcileKindInput } from './kind-reconciler.ts'

async function main(): Promise<void> {
  const options = parseProjectKindCliOptions(process.argv.slice(2), process.env)
  if (options.help) {
    process.stdout.write(PROJECT_KIND_HELP)
    return
  }
  const [repositoryOwner, repositoryName] = parseProjectKindRepository(
    process.env.HVIR_REPOSITORY ?? 'jarmak-personal/hvir',
  )
  const projectNumber = parseProjectKindProjectNumber(
    process.env.HVIR_PROJECT_NUMBER ?? '1',
  )
  const automation = new GitHubKindAutomation({
    repositoryOwner,
    repositoryName,
    projectOwner: process.env.HVIR_PROJECT_OWNER ?? 'jarmak-personal',
    projectNumber,
    repositoryToken: process.env.HVIR_REPO_TOKEN ?? '',
    projectToken: process.env.HVIR_PROJECT_TOKEN ?? '',
  })
  const input: ReconcileKindInput = {
    apply: options.apply,
    ...(options.issueNumber === undefined ? {} : { issueNumber: options.issueNumber }),
    ...(options.event === undefined ? {} : { event: options.event }),
    ...(options.eventUpdatedAt === undefined
      ? {}
      : { eventUpdatedAt: options.eventUpdatedAt }),
  }
  const report = await reconcileKinds(automation, input)
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  process.exitCode = projectKindExitCode(report)
}

main().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.message : 'Unknown project automation failure.'
  process.stderr.write(`project kind reconciliation failed: ${message}\n`)
  process.exitCode = 1
})
