import { parseProjectNumber, parseProjectRepository } from './project-config.ts'
import type { PullRequestPlanningReport } from './pull-request-planning.ts'

export interface ProjectPullRequestCliOptions {
  help: boolean
  pullRequestNumber?: number
  issueNumber?: number
  previousBody?: string
  apply: boolean
}

export const PROJECT_PULL_REQUEST_HELP = `Usage: npm run project:pr -- (--pull-request <number> | --issue <number>) [options]

Reconcile explicit pull-request relationships into issue planning Status.
Dry-run is the default.

Options:
  --pull-request <number>       Pull request in the configured repository
  --issue <number>              Reconcile one reopened issue from current relationships
  --apply                       Apply eligible Todo to In Progress transitions
  --help                        Show this help

Environment:
  HVIR_REPO_TOKEN               Token used for repository issue and PR reads
  HVIR_PROJECT_TOKEN            Token used for the user-owned Project
  HVIR_REPOSITORY               owner/name (default: jarmak-personal/hvir)
  HVIR_PROJECT_OWNER            Project owner (default: jarmak-personal)
  HVIR_PROJECT_NUMBER           Project number (default: 1)

Workflow environment equivalents:
  HVIR_PULL_REQUEST_NUMBER, HVIR_ISSUE_NUMBER, HVIR_APPLY,
  HVIR_EVENT_ACTION, HVIR_PREVIOUS_PR_BODY
`

export function parseProjectPullRequestCliOptions(
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
): ProjectPullRequestCliOptions {
  let pullRequestNumber = optionalPositiveInteger(
    environment.HVIR_PULL_REQUEST_NUMBER,
    'HVIR_PULL_REQUEST_NUMBER',
  )
  let issueNumber = optionalPositiveInteger(
    environment.HVIR_ISSUE_NUMBER,
    'HVIR_ISSUE_NUMBER',
  )
  const previousBody =
    environment.HVIR_EVENT_ACTION === 'edited' &&
    environment.HVIR_PREVIOUS_PR_BODY !== undefined &&
    environment.HVIR_PREVIOUS_PR_BODY !== ''
      ? environment.HVIR_PREVIOUS_PR_BODY
      : undefined
  let apply = parseBoolean(environment.HVIR_APPLY, false)

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--help') return { help: true, apply }
    if (argument === '--apply') {
      apply = true
      continue
    }
    if (argument === '--pull-request') {
      pullRequestNumber = parsePositiveInteger(
        requireValue(args, ++index, '--pull-request'),
        '--pull-request',
      )
      continue
    }
    if (argument === '--issue') {
      issueNumber = parsePositiveInteger(
        requireValue(args, ++index, '--issue'),
        '--issue',
      )
      continue
    }
    throw new Error(`Unknown argument: ${argument}`)
  }

  if (pullRequestNumber === undefined && issueNumber === undefined) {
    throw new Error(
      'One of --pull-request, --issue, HVIR_PULL_REQUEST_NUMBER, or HVIR_ISSUE_NUMBER is required.',
    )
  }
  if (pullRequestNumber !== undefined && issueNumber !== undefined) {
    throw new Error(
      'PR planning reconciliation accepts one pull request or issue, not both.',
    )
  }
  return {
    help: false,
    apply,
    ...(pullRequestNumber === undefined ? {} : { pullRequestNumber }),
    ...(issueNumber === undefined ? {} : { issueNumber }),
    ...(previousBody === undefined ? {} : { previousBody }),
  }
}

export const parseProjectPullRequestRepository = parseProjectRepository
export const parseProjectPullRequestProjectNumber = parseProjectNumber

export function projectPullRequestExitCode(
  report: Pick<PullRequestPlanningReport, 'summary'>,
): 0 | 2 {
  return report.summary.errors > 0 || report.summary.failed > 0 ? 2 : 0
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback
  if (value === 'true') return true
  if (value === 'false') return false
  throw new Error('HVIR_APPLY must be true or false.')
}

function optionalPositiveInteger(
  value: string | undefined,
  name: string,
): number | undefined {
  return value === undefined || value === ''
    ? undefined
    : parsePositiveInteger(value, name)
}

function parsePositiveInteger(value: string, name: string): number {
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
