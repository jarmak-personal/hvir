import type { KindEvent } from './kind-policy.ts'
import type { ReconciliationReport } from './kind-reconciler.ts'

export interface ProjectKindCliOptions {
  help: boolean
  issueNumber?: number
  apply: boolean
  event?: KindEvent
  eventUpdatedAt?: string
}

export const PROJECT_KIND_HELP = `Usage: npm run project:kind -- [options]

Reconcile repository kind labels into the canonical Project Kind field.
Dry-run is the default.

Options:
  --issue <number>              Reconcile one issue; omit to inspect every open issue
  --apply                       Apply deterministic label and Project mutations
  --event <action>              labeled, unlabeled, opened, or reopened
  --event-label <label>         Label from a labeled or unlabeled event
  --event-updated-at <date>     Issue updated_at captured by the event
  --help                        Show this help

Environment:
  HVIR_REPO_TOKEN               Token used for repository issue reads/writes
  HVIR_PROJECT_TOKEN            Token used for the user-owned Project
  HVIR_REPOSITORY               owner/name (default: jarmak-personal/hvir)
  HVIR_PROJECT_OWNER            Project owner (default: jarmak-personal)
  HVIR_PROJECT_NUMBER           Project number (default: 1)

Workflow environment equivalents:
  HVIR_ISSUE_NUMBER, HVIR_APPLY, HVIR_EVENT_ACTION,
  HVIR_EVENT_LABEL, HVIR_EVENT_UPDATED_AT
`

export function parseProjectKindCliOptions(
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
): ProjectKindCliOptions {
  let issueNumber = optionalPositiveInteger(
    environment.HVIR_ISSUE_NUMBER,
    'HVIR_ISSUE_NUMBER',
  )
  let apply = parseBoolean(environment.HVIR_APPLY, false)
  let eventAction = environment.HVIR_EVENT_ACTION
  let eventLabel = environment.HVIR_EVENT_LABEL
  let eventUpdatedAt = environment.HVIR_EVENT_UPDATED_AT

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--help') return { help: true, apply }
    if (argument === '--apply') {
      apply = true
      continue
    }
    if (argument === '--issue') {
      issueNumber = parsePositiveInteger(
        requireValue(args, ++index, '--issue'),
        '--issue',
      )
      continue
    }
    if (argument === '--event') {
      eventAction = requireValue(args, ++index, '--event')
      continue
    }
    if (argument === '--event-label') {
      eventLabel = requireValue(args, ++index, '--event-label')
      continue
    }
    if (argument === '--event-updated-at') {
      eventUpdatedAt = requireValue(args, ++index, '--event-updated-at')
      continue
    }
    throw new Error(`Unknown argument: ${argument}`)
  }

  const event = parseEvent(eventAction, eventLabel)
  if (event !== undefined && issueNumber === undefined) {
    throw new Error('An event reconciliation requires --issue or HVIR_ISSUE_NUMBER.')
  }
  if (eventUpdatedAt !== undefined && Number.isNaN(Date.parse(eventUpdatedAt))) {
    throw new Error('The event updated_at value must be an ISO-8601 date.')
  }
  return {
    help: false,
    apply,
    ...(issueNumber === undefined ? {} : { issueNumber }),
    ...(event === undefined ? {} : { event }),
    ...(eventUpdatedAt === undefined ? {} : { eventUpdatedAt }),
  }
}

export function parseProjectKindRepository(value: string): [string, string] {
  const parts = value.split('/').map((part) => part.trim())
  if (parts.length !== 2 || parts.some((part) => part === '')) {
    throw new Error('HVIR_REPOSITORY must use owner/name syntax.')
  }
  return [parts[0]!, parts[1]!]
}

export function parseProjectKindProjectNumber(value: string): number {
  return parsePositiveInteger(value, 'HVIR_PROJECT_NUMBER')
}

export function projectKindExitCode(report: {
  summary: Pick<ReconciliationReport['summary'], 'missing' | 'ambiguous'>
}): 0 | 2 {
  return report.summary.missing > 0 || report.summary.ambiguous > 0 ? 2 : 0
}

function parseEvent(
  action: string | undefined,
  label: string | undefined,
): KindEvent | undefined {
  if (action === undefined || action === '') return undefined
  if (action === 'opened' || action === 'reopened') return { action }
  if (action === 'labeled' || action === 'unlabeled') {
    if (label === undefined || label === '') {
      throw new Error(`The ${action} event requires an event label.`)
    }
    return { action, label }
  }
  throw new Error(`Unsupported issue event action: ${action}`)
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
