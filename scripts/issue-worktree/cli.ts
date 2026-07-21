import { assertExactBaseRef } from './worktree-policy.ts'

export interface IssueWorktreeCliOptions {
  help: boolean
  issueNumber?: number
  baseRef?: string
  apply: boolean
}

export const ISSUE_WORKTREE_HELP = `Usage: npm run issue:worktree -- --issue <number> --base <full-ref> [--apply]

Fetch/prune origin, reconcile completed workflow-owned worktrees, then select one
deterministic issue branch and worktree. The command is a dry run unless --apply is used.

Options:
  --issue <number>              Governing issue number
  --base <full-ref>             Exact refs/heads/* or refs/remotes/origin/* base
  --apply                       Apply safe cleanup and create the selected worktree
  --help                        Show this help
`

export function parseIssueWorktreeCliOptions(
  args: readonly string[],
): IssueWorktreeCliOptions {
  let issueNumber: number | undefined
  let baseRef: string | undefined
  let apply = false

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--help') return { help: true, apply }
    if (argument === '--apply') {
      apply = true
      continue
    }
    if (argument === '--issue') {
      issueNumber = positiveInteger(requireValue(args, ++index, '--issue'))
      continue
    }
    if (argument === '--base') {
      baseRef = requireValue(args, ++index, '--base')
      assertExactBaseRef(baseRef)
      continue
    }
    throw new Error(`Unknown argument: ${argument}`)
  }

  if (issueNumber === undefined) throw new Error('--issue is required.')
  if (baseRef === undefined) throw new Error('--base is required.')
  return { help: false, issueNumber, baseRef, apply }
}

function positiveInteger(value: string): number {
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
