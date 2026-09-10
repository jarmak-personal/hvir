import { allocationIssues, type TokenPhase } from './session-token-allocation.ts'
export interface ContributorStatusOptions {
  help: boolean
  issue?: number
  issues?: number[]
  phase?: TokenPhase
  pr?: number
  capture?: 'codex' | 'claude-code'
  apply: boolean
  json: boolean
}

export const CONTRIBUTOR_STATUS_HELP = `Usage: npm run project:status -- --issue N [--pr N] [--json]
       npm run project:status -- --issue N --capture codex|claude-code --phase planning|implementation|unknown [--issues N,N] [--apply]

Read Tokens, Project and Acceptance. --json requests detailed structured facts.
Capture plans by default; --apply records one session contribution and updates issue/parent tokens.
Planning may share --issues equally. Repeated captures allocate only new usage. Unknown splits retain only totals.
Use only the exact current harness identity; unavailable usage needs no recovery work.
Credentials: HVIR_REPO_TOKEN and HVIR_PROJECT_TOKEN. Private current identity: CODEX_THREAD_ID
or HVIR_USAGE_SESSION_ID; HVIR_USAGE_CWD is the exact launch directory when different from cwd.
`

export function parseContributorStatusOptions(
  args: readonly string[],
): ContributorStatusOptions {
  const options: ContributorStatusOptions = { help: false, apply: false, json: false }
  const seen = new Set<string>()
  for (let index = 0; index < args.length; index++) {
    const name = args[index]!
    if (seen.has(name)) throw new Error('Duplicate contributor-status option.')
    seen.add(name)
    if (name === '--help') options.help = true
    else if (name === '--apply') options.apply = true
    else if (name === '--json') options.json = true
    else if (name === '--issue' || name === '--pr') {
      const value = Number(args[++index])
      if (!Number.isSafeInteger(value) || value <= 0)
        throw new Error('Issue/PR must be positive integers.')
      if (name === '--issue') options.issue = value
      else options.pr = value
    } else if (name === '--phase') {
      const value = args[++index]
      if (value !== 'planning' && value !== 'implementation' && value !== 'unknown')
        throw new Error('Invalid token phase.')
      options.phase = value
    } else if (name === '--issues') {
      options.issues = allocationIssues((args[++index] ?? '').split(',').map(Number))
    } else if (name === '--capture') {
      const value = args[++index]
      if (value !== 'codex' && value !== 'claude-code')
        throw new Error('Unsupported usage provider.')
      options.capture = value
    } else throw new Error('Unknown contributor-status option.')
  }
  if (!options.help && !options.issue) throw new Error('--issue is required.')
  if (options.apply && !options.capture) throw new Error('--apply requires --capture.')
  if (options.capture && !options.phase)
    throw new Error('--capture requires --phase planning|implementation|unknown.')
  if ((options.phase || options.issues) && !options.capture)
    throw new Error('Allocation options require --capture.')
  if (
    options.issues &&
    (options.phase !== 'planning' || !options.issues.includes(options.issue!))
  )
    throw new Error('--issues requires planning and must include --issue.')
  return options
}
