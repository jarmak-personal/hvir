import { parseAgentWorkRecord, type AgentWorkRecord } from './agent-work-ledger.ts'
import { parseProjectRepository } from './project-config.ts'

export interface AgentWorkCliOptions {
  help: boolean
  issueNumber?: number
  append: boolean
  apply: boolean
  record?: AgentWorkRecord
}

export const AGENT_WORK_HELP = `Usage: npm run project:measure -- --issue <number> [options]

Read one normalized append-only agent-work ledger. Appends are explicit and dry-run by default.

Options:
  --issue <number>              Issue in the configured repository (required)
  --append                      Plan an append from HVIR_AGENT_WORK_RECORD
  --apply                       Apply the planned append
  --help                        Show this help

Environment:
  HVIR_REPO_TOKEN               Token used for repository comment reads/writes
  HVIR_REPOSITORY               owner/name (default: jarmak-personal/hvir)
  HVIR_AGENT_WORK_RECORD        Exact JSON record used only with --append
`

export function parseAgentWorkCliOptions(
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
): AgentWorkCliOptions {
  let issueNumber: number | undefined
  let append = false
  let apply = false
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--help') return { help: true, append, apply }
    if (argument === '--append') {
      append = true
      continue
    }
    if (argument === '--apply') {
      apply = true
      continue
    }
    if (argument === '--issue') {
      issueNumber = parsePositiveInteger(requireValue(args, ++index, '--issue'))
      continue
    }
    throw new Error(`Unknown argument: ${argument}`)
  }
  if (issueNumber === undefined) throw new Error('--issue is required.')
  if (apply && !append) throw new Error('--apply requires --append.')
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
    apply,
    ...(record === undefined ? {} : { record }),
  }
}

export const parseAgentWorkRepository = parseProjectRepository

export function agentWorkExitCode(report: { append: { outcome: string } }): 0 | 2 {
  return report.append.outcome === 'rejected' || report.append.outcome === 'uncertain'
    ? 2
    : 0
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
