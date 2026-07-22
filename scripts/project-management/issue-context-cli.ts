import { basename, dirname, join, resolve } from 'node:path'

import type { IssueDeliveryContext } from './issue-context.ts'
import { parseProjectRepository } from './project-config.ts'

export interface IssueContextCliOptions {
  help: boolean
  issueNumber?: number
  json: boolean
}

export const ISSUE_CONTEXT_HELP = `Usage: npm run issue:context -- --issue <number> [options]

Read normalized issue planning and delivery context without mutation.

Options:
  --issue <number>              Issue in the configured repository
  --json                        Emit structured JSON instead of concise text
  --help                        Show this help

Environment:
  HVIR_REPO_TOKEN               Token used for repository issue, PR, and branch reads
  HVIR_PROJECT_TOKEN            Token used for the user-owned Project
  HVIR_REPOSITORY               owner/name (default: jarmak-personal/hvir)
  HVIR_PROJECT_OWNER            Project owner (default: jarmak-personal)
  HVIR_PROJECT_NUMBER           Project number (default: 1)
  HVIR_PRIMARY_ROOT             Primary checkout root when it cannot be inferred
`

export function parseIssueContextCliOptions(
  args: readonly string[],
): IssueContextCliOptions {
  let issueNumber: number | undefined
  let json = false
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--help') return { help: true, json }
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
  return { help: false, issueNumber, json }
}

export const parseIssueContextRepository = parseProjectRepository

export function formatIssueContext(context: IssueDeliveryContext): string {
  const kind = context.issue.kind.label ?? context.issue.kind.state
  const planning = [
    context.planning.membership,
    context.planning.kind ?? 'no Kind',
    context.planning.status ?? 'no Status',
  ].join(' · ')
  const lines = [
    `Issue #${context.issue.number} (${kind}) — ${context.ready ? 'ready' : 'blocked'} for ${context.delivery.path} delivery`,
    `Base: ${context.delivery.base ?? 'unresolved'}`,
    `Branch: ${context.delivery.branch}`,
    `Worktree: ${context.delivery.worktree}`,
    `Planning: ${planning}`,
    `Open related PRs: ${context.openPullRequests.length === 0 ? 'none' : context.openPullRequests.map((pullRequest) => `#${pullRequest.number}`).join(', ')}`,
  ]
  if (context.conflicts.length > 0) {
    lines.push('Conflicts:')
    lines.push(...context.conflicts.map((conflict) => `- ${conflict.message}`))
  }
  return `${lines.join('\n')}\n`
}

export function issueContextExitCode(context: IssueDeliveryContext): 0 | 2 {
  return context.ready ? 0 : 2
}

export function resolvePrimaryRepositoryRoot(
  cwd: string,
  repositoryName: string,
  environment: Readonly<Record<string, string | undefined>>,
): string {
  const configured = environment.HVIR_PRIMARY_ROOT?.trim()
  if (configured !== undefined && configured !== '') return resolve(cwd, configured)

  const packageRoot =
    environment.npm_package_json === undefined
      ? resolve(environment.INIT_CWD ?? cwd)
      : dirname(resolve(cwd, environment.npm_package_json))
  if (basename(packageRoot) === repositoryName) return packageRoot
  const worktreesRoot = dirname(packageRoot)
  if (
    basename(worktreesRoot) === `${repositoryName}-worktrees` &&
    /^issue-[1-9]\d*$/.test(basename(packageRoot))
  ) {
    return join(dirname(worktreesRoot), repositoryName)
  }
  throw new Error(
    'The primary checkout root could not be inferred. Run from the primary checkout or deterministic issue worktree, or set HVIR_PRIMARY_ROOT.',
  )
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
