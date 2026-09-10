import { GitHubClient } from './github-client.ts'
import {
  readTokenMigrationSnapshot,
  applyTokenMigration,
} from './github-token-migration.ts'
import {
  planTokenMigration,
  type TokenMigrationSnapshot,
} from './token-migration-plan.ts'

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.includes('--help')) {
    process.stdout.write(
      'Usage: npm run project:migrate-tokens -- --snapshot > evidence.json\nReview evidence.json; documented corrections set reconciled issue-owned totals and cite evidence.\nnpm run project:migrate-tokens < evidence.json\nnpm run project:migrate-tokens -- --apply < evidence.json\nAfter reconciliation and review of exact deletion targets, add --delete to --apply.\nKeep the original snapshot for retries. No mutation occurs without --apply.\n',
    )
    return
  }
  if (
    new Set(args).size !== args.length ||
    args.some((arg) => !['--snapshot', '--apply', '--delete'].includes(arg)) ||
    (args.includes('--snapshot') && args.length > 1) ||
    (args.includes('--delete') && !args.includes('--apply'))
  )
    throw new Error('Invalid migration arguments.')
  if (args.includes('--snapshot')) {
    const project = new GitHubClient({
      token: process.env.HVIR_PROJECT_TOKEN ?? '',
      purpose: 'Project',
    })
    const repository = new GitHubClient({
      token: process.env.HVIR_REPO_TOKEN ?? '',
      purpose: 'repository',
    })
    process.stdout.write(
      `${JSON.stringify(await readTokenMigrationSnapshot(project, repository), null, 2)}\n`,
    )
    return
  }
  let input = ''
  for await (const chunk of process.stdin) {
    input += String(chunk)
    if (Buffer.byteLength(input) > 32 * 1024 * 1024)
      throw new Error('Migration evidence exceeds limit.')
  }
  const snapshot = JSON.parse(input) as TokenMigrationSnapshot
  if (!args.includes('--apply')) {
    const plan = planTokenMigration(snapshot)
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`)
    if (plan.diagnostics.length) process.exitCode = 2
    return
  }
  const project = new GitHubClient({
    token: process.env.HVIR_PROJECT_TOKEN ?? '',
    purpose: 'Project',
  })
  const repository = new GitHubClient({
    token: process.env.HVIR_REPO_TOKEN ?? '',
    purpose: 'repository',
  })
  const result = await applyTokenMigration(
    project,
    repository,
    snapshot,
    args.includes('--apply'),
    args.includes('--delete'),
  )
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  if (result.diagnostics.length) process.exitCode = 2
}
main().catch((error: unknown) => {
  // No raw API data, credentials or evidence bodies enter failure diagnostics.
  process.stderr.write(
    `Token migration unavailable; preserve evidence and retry after reconciliation. ${error instanceof SyntaxError ? 'Invalid JSON evidence.' : 'Check arguments, evidence, and repository/Project access.'}\n`,
  )
  process.exitCode = 1
})
