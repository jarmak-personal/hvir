import { GitHubKindAutomation } from './github-kind-automation.ts'
import { reconcileKinds, type ReconcileKindInput } from './kind-reconciler.ts'
import type { KindEvent } from './kind-policy.ts'

interface CliOptions {
  issueNumber?: number
  apply: boolean
  event?: KindEvent
  eventUpdatedAt?: string
}

const HELP = `Usage: npm run project:kind -- [options]

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

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2), process.env)
  const [repositoryOwner, repositoryName] = parseRepository(
    process.env.HVIR_REPOSITORY ?? 'jarmak-personal/hvir',
  )
  const projectNumber = parsePositiveInteger(
    process.env.HVIR_PROJECT_NUMBER ?? '1',
    'HVIR_PROJECT_NUMBER',
  )
  const automation = new GitHubKindAutomation({
    repositoryOwner,
    repositoryName,
    projectOwner: process.env.HVIR_PROJECT_OWNER ?? 'jarmak-personal',
    projectNumber,
    repositoryToken: process.env.HVIR_REPO_TOKEN ?? '',
    projectToken: process.env.HVIR_PROJECT_TOKEN ?? '',
  })
  const input: ReconcileKindInput = {
    apply: options.apply,
    ...(options.issueNumber === undefined ? {} : { issueNumber: options.issueNumber }),
    ...(options.event === undefined ? {} : { event: options.event }),
    ...(options.eventUpdatedAt === undefined
      ? {}
      : { eventUpdatedAt: options.eventUpdatedAt }),
  }
  const report = await reconcileKinds(automation, input)
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  if (report.summary.missing > 0 || report.summary.ambiguous > 0) {
    process.exitCode = 2
  }
}

function parseOptions(args: string[], environment: NodeJS.ProcessEnv): CliOptions {
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
    if (argument === '--help') {
      process.stdout.write(HELP)
      process.exit(0)
    }
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
    apply,
    ...(issueNumber === undefined ? {} : { issueNumber }),
    ...(event === undefined ? {} : { event }),
    ...(eventUpdatedAt === undefined ? {} : { eventUpdatedAt }),
  }
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

function parseRepository(value: string): [string, string] {
  const parts = value.split('/')
  if (parts.length !== 2 || parts.some((part) => part.trim() === '')) {
    throw new Error('HVIR_REPOSITORY must use owner/name syntax.')
  }
  return [parts[0]!, parts[1]!]
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

function requireValue(args: string[], index: number, name: string): string {
  const value = args[index]
  if (value === undefined) throw new Error(`${name} requires a value.`)
  return value
}

main().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.message : 'Unknown project automation failure.'
  process.stderr.write(`project kind reconciliation failed: ${message}\n`)
  process.exitCode = 1
})
