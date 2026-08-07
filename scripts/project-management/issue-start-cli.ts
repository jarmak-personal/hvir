import type { IssueStartOperation, IssueStartReport } from './issue-start.ts'

export interface IssueStartCliOptions {
  help: boolean
  issueNumber?: number
  apply: boolean
  json: boolean
}

export const ISSUE_START_HELP = `Usage: npm run issue:start -- --issue <number> [options]

Plan or apply deterministic issue worktree startup.

Options:
  --issue <number>              Issue in the configured repository
  --apply                       Apply the recomputed setup plan
  --json                        Emit a bounded structured result
  --help                        Show this help

Planning always runs git fetch --prune origin. It does not otherwise mutate a local branch,
worktree, dependency tree, or Project value. Apply prepares dependencies with npm ci and a
15-minute timeout.

Environment:
  HVIR_REPO_TOKEN               Token used for repository issue, PR, and branch reads
  HVIR_PROJECT_TOKEN            Token used for the user-owned Project
  HVIR_REPOSITORY               owner/name (default: jarmak-personal/hvir)
  HVIR_PROJECT_OWNER            Project owner (default: jarmak-personal)
  HVIR_PROJECT_NUMBER           Project number (default: 1)
  HVIR_PRIMARY_ROOT             Primary checkout root when it cannot be inferred
`

export function parseIssueStartCliOptions(args: readonly string[]): IssueStartCliOptions {
  let issueNumber: number | undefined
  let apply = false
  let json = false
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--help') return { help: true, apply, json }
    if (argument === '--apply') {
      apply = true
      continue
    }
    if (argument === '--json') {
      json = true
      continue
    }
    if (argument === '--issue') {
      issueNumber = positiveInteger(requireValue(args, ++index, '--issue'), '--issue')
      continue
    }
    throw new Error(`Unknown argument: ${argument}`)
  }
  if (issueNumber === undefined) throw new Error('--issue is required.')
  return { help: false, issueNumber, apply, json }
}

export function formatIssueStartReport(report: IssueStartReport): string {
  const lines = [
    `Issue #${report.issue.number} — ${report.outcome} ${report.apply ? 'apply' : 'startup plan'}`,
    `Delivery: ${report.delivery.path} · base ${report.delivery.pullRequestBase ?? 'unresolved'} · start ${report.delivery.startRef ?? 'unresolved'}`,
    `Branch: ${report.delivery.branch}`,
    `Worktree: ${report.delivery.worktree}`,
    `Selected HEAD: ${report.selectedHead ?? 'none'}`,
    `Dependencies: ${report.dependency.status}${report.dependency.failure === undefined ? '' : ` (${report.dependency.failure})`}`,
  ]
  if (report.operations.length > 0) {
    lines.push('Operations:')
    lines.push(...report.operations.map((operation) => `- ${formatOperation(operation)}`))
  }
  if (report.retained.length > 0) {
    lines.push('Retained state:')
    lines.push(
      ...report.retained.map(
        (retained) =>
          `- issue #${retained.issueNumber} ${retained.branch} at ${retained.worktree}: ${retained.reasons.join(', ')}`,
      ),
    )
  }
  if (report.blockers.length > 0) {
    lines.push('Delivery conflicts:')
    lines.push(...report.blockers.map((blocker) => `- ${blocker.message}`))
  }
  if (report.failures.length > 0) {
    lines.push('Operational failures:')
    lines.push(...report.failures.map((failure) => `- ${failure.message}`))
  }
  return `${lines.join('\n')}\n`
}

export function formatIssueStartOperationalFailure(json: boolean): string {
  if (json) {
    return `${JSON.stringify(
      {
        outcome: 'failed',
        failures: [
          {
            operation: 'startup',
            code: 'startup-failed',
            message: 'Issue startup could not read or refresh its required state.',
          },
        ],
      },
      null,
      2,
    )}\n`
  }
  return 'issue start failed: required remote, Git, issue, PR, or Project state could not be read.\n'
}

function formatOperation(operation: IssueStartOperation): string {
  switch (operation.operation) {
    case 'fetch-prune':
      return 'fetch/prune completed'
    case 'remove-worktree':
      return `${operation.outcome} issue #${operation.issueNumber} worktree ${operation.worktree}`
    case 'delete-branch':
      return `${operation.outcome} issue #${operation.issueNumber} branch ${operation.branch} at ${operation.expectedHead}`
    case 'select-worktree':
      return `${operation.outcome} ${operation.branch} at ${operation.worktree}`
    case 'prepare-dependencies':
      return `${operation.outcome} npm ci in ${operation.worktree}`
  }
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`)
  }
  return parsed
}

function requireValue(args: readonly string[], index: number, name: string): string {
  const value = args[index]
  if (value === undefined) throw new Error(`${name} requires a value.`)
  return value
}
