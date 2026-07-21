import { parseIssueWorktreeCliOptions, ISSUE_WORKTREE_HELP } from './cli.ts'
import { GitWorktreeRepository } from './git-worktree-repository.ts'
import { GhPullRequestLookup } from './github-pull-requests.ts'
import { runIssueWorktreeLifecycle } from './lifecycle.ts'
import { NodeSystemRunner } from './system-runner.ts'

async function main(): Promise<void> {
  const options = parseIssueWorktreeCliOptions(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(ISSUE_WORKTREE_HELP)
    return
  }
  if (options.issueNumber === undefined || options.baseRef === undefined) {
    throw new Error('Issue worktree arguments were not parsed.')
  }

  const runner = new NodeSystemRunner()
  const repository = await GitWorktreeRepository.open(runner, process.cwd())
  const report = await runIssueWorktreeLifecycle(
    repository,
    new GhPullRequestLookup(runner, repository.primaryRoot),
    {
      issueNumber: options.issueNumber,
      baseRef: options.baseRef,
      apply: options.apply,
    },
  )
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
}

main().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.message : 'Unknown issue worktree failure.'
  process.stderr.write(`issue worktree failed: ${message}\n`)
  process.exitCode = 1
})
