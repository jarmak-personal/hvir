import { PROJECT_STATUS_OPTIONS, type ProjectStatus } from './planning-fields.ts'
import { parseProjectNumber, parseProjectRepository } from './project-config.ts'

export interface ProjectPlanningCliOptions {
  help: boolean
  issueNumber?: number
  ensureProject: boolean
  status?: ProjectStatus
  apply: boolean
}

export const PROJECT_PLANNING_HELP = `Usage: npm run project:record -- --issue <number> [options]

Read one normalized issue and canonical Project planning record.
Mutations are explicit and dry-run by default.

Options:
  --issue <number>              Issue in the configured repository (required)
  --ensure-project              Add or restore an eligible open issue when needed
  --status <name>               Set Status to Todo, In Progress, or Done
  --apply                       Apply the planned Project mutations
  --help                        Show this help

Environment:
  HVIR_REPO_TOKEN               Token used for repository issue reads
  HVIR_PROJECT_TOKEN            Token used for the user-owned Project
  HVIR_REPOSITORY               owner/name (default: jarmak-personal/hvir)
  HVIR_PROJECT_OWNER            Project owner (default: jarmak-personal)
  HVIR_PROJECT_NUMBER           Project number (default: 1)
`

export function parseProjectPlanningCliOptions(
  args: readonly string[],
): ProjectPlanningCliOptions {
  let issueNumber: number | undefined
  let ensureProject = false
  let status: ProjectStatus | undefined
  let apply = false

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--help') {
      return { help: true, ensureProject, apply }
    }
    if (argument === '--apply') {
      apply = true
      continue
    }
    if (argument === '--ensure-project') {
      ensureProject = true
      continue
    }
    if (argument === '--issue') {
      issueNumber = parsePositiveInteger(requireValue(args, ++index, '--issue'))
      continue
    }
    if (argument === '--status') {
      status = parseStatus(requireValue(args, ++index, '--status'))
      continue
    }
    if (argument === '--kind') {
      throw new Error(
        'Project Kind is label-derived and cannot be written by this command.',
      )
    }
    throw new Error(`Unknown argument: ${argument}`)
  }

  if (issueNumber === undefined) {
    throw new Error('--issue is required when reading or updating a planning record.')
  }
  return {
    help: false,
    issueNumber,
    ensureProject,
    apply,
    ...(status === undefined ? {} : { status }),
  }
}

export const parseProjectPlanningRepository = parseProjectRepository
export const parseProjectPlanningProjectNumber = parseProjectNumber

function parseStatus(value: string): ProjectStatus {
  if (PROJECT_STATUS_OPTIONS.some((option) => option === value)) {
    return value as ProjectStatus
  }
  throw new Error(`--status must be one of: ${PROJECT_STATUS_OPTIONS.join(', ')}.`)
}

function parsePositiveInteger(value: string, name = '--issue'): number {
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
