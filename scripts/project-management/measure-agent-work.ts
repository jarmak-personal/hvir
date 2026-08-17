import {
  agentWorkExitCode,
  AGENT_WORK_HELP,
  parseAgentWorkCliOptions,
  parseAgentWorkRepository,
} from './agent-work-cli.ts'
import { reconcileAgentWorkLedger } from './agent-work-ledger.ts'
import { reconcileAgentWorkProjection } from './agent-work-projector.ts'
import { reconcileAgentWorkRollup } from './agent-work-rollup.ts'
import { GitHubCanonicalProject } from './canonical-project.ts'
import { GitHubAgentWorkLedger } from './github-agent-work-ledger.ts'
import { GitHubAgentWorkSource } from './github-agent-work-source.ts'
import { GitHubClient } from './github-client.ts'
import { parseProjectNumber } from './project-config.ts'

async function main(): Promise<void> {
  const options = parseAgentWorkCliOptions(process.argv.slice(2), process.env)
  if (options.help) {
    process.stdout.write(AGENT_WORK_HELP)
    return
  }
  if (options.issueNumber === undefined) {
    throw new Error('Agent-work issue number was not parsed.')
  }
  const [owner, name] = parseAgentWorkRepository(
    process.env.HVIR_REPOSITORY ?? 'jarmak-personal/hvir',
  )
  const repositoryClient = new GitHubClient({
    token: process.env.HVIR_REPO_TOKEN ?? '',
    purpose: 'repository',
  })
  const ledger = new GitHubAgentWorkLedger({
    owner,
    name,
    client: repositoryClient,
  })
  if (options.project || options.rollup) {
    const issueSource = new GitHubAgentWorkSource({
      owner,
      name,
      client: repositoryClient,
    })
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
    const report = options.rollup
      ? await reconcileAgentWorkRollup(
          {
            readRollupTarget: (issueNumber) => issueSource.readRollupTarget(issueNumber),
            readRollupParticipant: (issueNumber) =>
              issueSource.readRollupParticipant(issueNumber),
            readCommentHistory: (issueNumber) => ledger.readCommentHistory(issueNumber),
          },
          project,
          { issueNumber: options.issueNumber, apply: options.apply },
        )
      : await reconcileAgentWorkProjection(
          {
            readProjectionIssue: (issueNumber) =>
              issueSource.readProjectionIssue(issueNumber),
            readCommentHistory: (issueNumber) => ledger.readCommentHistory(issueNumber),
          },
          project,
          { issueNumber: options.issueNumber, apply: options.apply },
        )
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    process.exitCode = agentWorkExitCode(report)
    return
  }
  const report = await reconcileAgentWorkLedger(ledger, {
    issueNumber: options.issueNumber,
    apply: options.apply,
    ...(options.record === undefined ? {} : { record: options.record }),
  })
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  process.exitCode = agentWorkExitCode(report)
}

main().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.message : 'Unknown agent-work ledger failure.'
  process.stderr.write(`agent-work ledger failed: ${message}\n`)
  process.exitCode = 1
})
