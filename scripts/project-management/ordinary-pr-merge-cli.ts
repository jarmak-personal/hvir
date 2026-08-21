import type { OrdinaryPullRequestMergeReport } from './ordinary-pr-merge.ts'

export interface OrdinaryPullRequestMergeCliOptions {
  help: boolean
  pullRequestNumber?: number
  apply: boolean
  json: boolean
}

export const ORDINARY_PULL_REQUEST_MERGE_HELP = `Usage: npm run issue:merge -- --pull-request <number> [options]

Resolve and merge one explicitly authorized ordinary pull request, then reconcile its
native issue, Project, and measurement state. The operation is dry-run by default.

Options:
  --pull-request <number>       Explicitly authorized pull request (required)
  --apply                       Merge or resume reconciliation from current GitHub state
  --json                        Print the complete structured report
  --help                        Show this help

Environment:
  HVIR_REPO_TOKEN               Token used for repository reads, merge, and ledger append
  HVIR_PROJECT_TOKEN            Token used for Project convergence and projection
  HVIR_PROJECT_OWNER            Project owner (default: jarmak-personal)
  HVIR_PROJECT_NUMBER           Project number (default: 1)
  HVIR_REPOSITORY               owner/name (default: jarmak-personal/hvir)
`

export function parseOrdinaryPullRequestMergeCliOptions(
  args: readonly string[],
): OrdinaryPullRequestMergeCliOptions {
  let pullRequestNumber: number | undefined
  let apply = false
  let json = false
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--help') {
      return { help: true, apply, json }
    }
    if (argument === '--apply') {
      apply = true
      continue
    }
    if (argument === '--json') {
      json = true
      continue
    }
    if (argument === '--pull-request') {
      pullRequestNumber = positiveInteger(
        requireValue(args, ++index, '--pull-request'),
        '--pull-request',
      )
      continue
    }
    throw new Error(`Unknown argument: ${argument}`)
  }
  if (pullRequestNumber === undefined) throw new Error('--pull-request is required.')
  return {
    help: false,
    pullRequestNumber,
    apply,
    json,
  }
}

export function formatOrdinaryPullRequestMergeReport(
  report: OrdinaryPullRequestMergeReport,
  json: boolean,
): string {
  if (json) return `${JSON.stringify(report, null, 2)}\n`
  const diagnostics =
    report.diagnostics.length === 0 ? 'none' : report.diagnostics.join(', ')
  const issue =
    report.issueNumber === null ? 'unresolved issue' : `issue #${report.issueNumber}`
  const candidate = report.candidateOid ?? 'unresolved candidate'
  const issueState = report.issue.state ?? 'unresolved'
  return (
    [
      `ordinary merge #${report.pullRequestNumber} for ${issue}: ${report.outcome}`,
      `candidate ${candidate}; base ${report.pullRequest.base}; merge ${report.merge.outcome}`,
      `issue ${issueState}; Project ${report.issue.projectStatus ?? 'unset'} (${report.project.outcome})`,
      `measurement ${report.measurement.outcome}; projection ${report.projection.outcome}; diagnostics ${diagnostics}`,
    ].join('\n') + '\n'
  )
}

export function ordinaryPullRequestMergeExitCode(
  report: OrdinaryPullRequestMergeReport,
): 0 | 2 {
  return report.diagnostics.length === 0 ? 0 : 2
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
