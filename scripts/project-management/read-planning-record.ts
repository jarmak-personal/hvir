import { GitHubCanonicalProject } from './canonical-project.ts'
import { GitHubClient } from './github-client.ts'
import { GitHubIssueRepository } from './github-issues.ts'
import {
  parseProjectPlanningCliOptions,
  parseProjectPlanningProjectNumber,
  parseProjectPlanningRepository,
  PROJECT_PLANNING_HELP,
} from './planning-cli.ts'
import { reconcilePlanningRecord } from './planning-record.ts'

async function main(): Promise<void> {
  const options = parseProjectPlanningCliOptions(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(PROJECT_PLANNING_HELP)
    return
  }
  if (options.issueNumber === undefined) {
    throw new Error('Planning record issue number was not parsed.')
  }
  const [repositoryOwner, repositoryName] = parseProjectPlanningRepository(
    process.env.HVIR_REPOSITORY ?? 'jarmak-personal/hvir',
  )
  const projectNumber = parseProjectPlanningProjectNumber(
    process.env.HVIR_PROJECT_NUMBER ?? '1',
  )
  const issues = new GitHubIssueRepository({
    owner: repositoryOwner,
    name: repositoryName,
    client: new GitHubClient({
      token: process.env.HVIR_REPO_TOKEN ?? '',
      purpose: 'repository',
    }),
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
  const input = {
    issueNumber: options.issueNumber,
    ensureProject: options.ensureProject,
    apply: options.apply,
    ...(options.status === undefined ? {} : { status: options.status }),
  }
  const report = await reconcilePlanningRecord(issues, project, input)
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
}

main().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.message : 'Unknown project planning failure.'
  process.stderr.write(`project planning record failed: ${message}\n`)
  process.exitCode = 1
})
