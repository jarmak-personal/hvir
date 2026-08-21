import type { OrdinaryPullRequestMergeReport } from './ordinary-pr-merge.ts'

export interface OrdinaryPullRequestMergeCliOptions {
  help: boolean
  issueNumber?: number
  pullRequestNumber?: number
  candidateOid?: string
  apply: boolean
  json: boolean
}

export const ORDINARY_PULL_REQUEST_MERGE_HELP = `Usage: npm run issue:merge -- --issue <number> --pull-request <number> --candidate <sha> [options]

Verify and merge one exact ordinary issue pull-request candidate, then reconcile its
post-merge Project and measurement state. The operation is dry-run by default.

Options:
  --issue <number>              Governing ordinary issue (required)
  --pull-request <number>       Explicitly authorized pull request (required)
  --candidate <sha>             Exact full handed-off head commit SHA (required)
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
  let issueNumber: number | undefined
  let pullRequestNumber: number | undefined
  let candidateOid: string | undefined
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
    if (argument === '--issue') {
      issueNumber = positiveInteger(requireValue(args, ++index, '--issue'), '--issue')
      continue
    }
    if (argument === '--pull-request') {
      pullRequestNumber = positiveInteger(
        requireValue(args, ++index, '--pull-request'),
        '--pull-request',
      )
      continue
    }
    if (argument === '--candidate') {
      candidateOid = requireValue(args, ++index, '--candidate')
      if (!/^[a-f0-9]{40}$/.test(candidateOid)) {
        throw new Error('--candidate must be one full lowercase 40-character commit SHA.')
      }
      continue
    }
    throw new Error(`Unknown argument: ${argument}`)
  }
  if (issueNumber === undefined) throw new Error('--issue is required.')
  if (pullRequestNumber === undefined) throw new Error('--pull-request is required.')
  if (candidateOid === undefined) throw new Error('--candidate is required.')
  return {
    help: false,
    issueNumber,
    pullRequestNumber,
    candidateOid,
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
  return (
    [
      `ordinary merge #${report.pullRequestNumber} for issue #${report.issueNumber}: ${report.outcome}`,
      `candidate ${report.candidateOid}; base ${report.pullRequest.base}; merge ${report.merge.outcome}`,
      `issue ${report.issue.state}; Project ${report.issue.projectStatus ?? 'unset'} (${report.project.outcome})`,
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
