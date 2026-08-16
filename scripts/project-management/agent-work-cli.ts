import { parseAgentWorkRecord, type AgentWorkRecord } from './agent-work-ledger.ts'
import { parseProjectRepository } from './project-config.ts'

export interface AgentWorkCliOptions {
  help: boolean
  issueNumber?: number
  append: boolean
  project: boolean
  apply: boolean
  record?: AgentWorkRecord
}

export const AGENT_WORK_HELP = `Usage: npm run project:measure -- --issue <number> [options]

Read one normalized append-only agent-work ledger. Appends and Project projections are explicit
and dry-run by default.

Options:
  --issue <number>              Issue in the configured repository (required)
  --append                      Plan an append from HVIR_AGENT_WORK_RECORD
  --project                     Plan named Project fields from issue and active ledger facts
  --apply                       Apply the selected append or Project projection
  --help                        Show this help

Environment:
  HVIR_REPO_TOKEN               Token used for repository comment reads/writes
  HVIR_PROJECT_TOKEN            Token used only for Project projection reads/writes
  HVIR_PROJECT_OWNER            Project owner (default: jarmak-personal)
  HVIR_PROJECT_NUMBER           Project number (default: 1)
  HVIR_REPOSITORY               owner/name (default: jarmak-personal/hvir)
  HVIR_AGENT_WORK_RECORD        Exact JSON record used only with --append
`

export function parseAgentWorkCliOptions(
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
): AgentWorkCliOptions {
  let issueNumber: number | undefined
  let append = false
  let project = false
  let apply = false
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--help') return { help: true, append, project, apply }
    if (argument === '--append') {
      append = true
      continue
    }
    if (argument === '--apply') {
      apply = true
      continue
    }
    if (argument === '--project') {
      project = true
      continue
    }
    if (argument === '--issue') {
      issueNumber = parsePositiveInteger(requireValue(args, ++index, '--issue'))
      continue
    }
    throw new Error(`Unknown argument: ${argument}`)
  }
  if (issueNumber === undefined) throw new Error('--issue is required.')
  if (append && project)
    throw new Error('--append and --project are separate operations.')
  if (apply && !append && !project) {
    throw new Error('--apply requires --append or --project.')
  }
  const serialized = environment.HVIR_AGENT_WORK_RECORD
  if (!append && serialized !== undefined && serialized !== '') {
    throw new Error('HVIR_AGENT_WORK_RECORD requires --append.')
  }
  if (append && (serialized === undefined || serialized === '')) {
    throw new Error('--append requires HVIR_AGENT_WORK_RECORD.')
  }
  let record: AgentWorkRecord | undefined
  if (serialized !== undefined && serialized !== '') {
    let decoded: unknown
    try {
      decoded = JSON.parse(serialized)
    } catch (error) {
      throw new Error('HVIR_AGENT_WORK_RECORD is not valid JSON.', { cause: error })
    }
    try {
      record = parseAgentWorkRecord(decoded)
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'schema mismatch'
      throw new Error(`HVIR_AGENT_WORK_RECORD is invalid: ${detail}`, { cause: error })
    }
  }
  return {
    help: false,
    issueNumber,
    append,
    project,
    apply,
    ...(record === undefined ? {} : { record }),
  }
}

export const parseAgentWorkRepository = parseProjectRepository

export function agentWorkExitCode(report: { diagnostics: readonly string[] }): 0 | 2 {
  return report.diagnostics.length > 0 ? 2 : 0
}

function parsePositiveInteger(value: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error('--issue must be a positive integer.')
  }
  return parsed
}

function requireValue(args: readonly string[], index: number, name: string): string {
  const value = args[index]
  if (value === undefined) throw new Error(`${name} requires a value.`)
  return value
}
