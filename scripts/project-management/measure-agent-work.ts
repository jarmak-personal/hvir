import {
  agentWorkExitCode,
  AGENT_WORK_HELP,
  parseAgentWorkCliOptions,
  parseAgentWorkRepository,
} from './agent-work-cli.ts'
import { reconcileAgentWorkLedger } from './agent-work-ledger.ts'
import { GitHubAgentWorkLedger } from './github-agent-work-ledger.ts'
import { GitHubClient } from './github-client.ts'

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
  const ledger = new GitHubAgentWorkLedger({
    owner,
    name,
    client: new GitHubClient({
      token: process.env.HVIR_REPO_TOKEN ?? '',
      purpose: 'repository',
    }),
  })
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
