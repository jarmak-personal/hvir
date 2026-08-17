import { GitHubCanonicalProject } from './canonical-project.ts'
import { GitHubClient } from './github-client.ts'
import { parseProjectNumber, parseProjectRepository } from './project-config.ts'

const help = `Usage: npm run project:audit

Audit the stored canonical Project node IDs, field schema, and single-select options against
the live Project. This command is read-only and is the explicit schema-drift validation path.

Environment:
  HVIR_PROJECT_TOKEN            Token used only for the canonical Project audit
  HVIR_REPOSITORY               owner/name (default: jarmak-personal/hvir)
  HVIR_PROJECT_OWNER            Project owner (default: jarmak-personal)
  HVIR_PROJECT_NUMBER           Project number (default: 1)
`

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write(help)
    return
  }
  if (args.length > 0) throw new Error(`Unknown argument: ${args[0]}`)
  const [repositoryOwner, repositoryName] = parseProjectRepository(
    process.env.HVIR_REPOSITORY ?? 'jarmak-personal/hvir',
  )
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
  const report = await project.auditConfiguration()
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  process.exitCode = report.outcome === 'valid' ? 0 : 2
}

main().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.message : 'Unknown canonical Project audit failure.'
  process.stderr.write(`canonical Project audit failed: ${message}\n`)
  process.exitCode = 1
})
