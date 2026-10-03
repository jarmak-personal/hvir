import {
  AGENT_CONTRACT,
  AGENT_LIMITS,
  agentFailure,
  agentOutput,
  type AgentResponse,
} from './contract'

const targetFlags = ['workspace', 'session'] as const
export const AGENT_COMMANDS = [
  {
    name: 'help',
    summary: 'Read short help or one command reference.',
    flags: [],
    access: 'offline',
    input: 'Optional command name',
    output: 'Trusted installed reference',
    example: 'hvir-agent help report',
  },
  {
    name: 'commands',
    summary: 'List the installed command contract.',
    flags: [],
    access: 'offline',
    input: 'None',
    output: 'Command index; no extension schemas',
    example: 'hvir-agent commands',
  },
  {
    name: 'guide',
    summary: 'List installed guides or read one topic.',
    flags: [],
    access: 'offline',
    input: 'Optional topic name',
    output: 'Trusted installed guide',
    example: 'hvir-agent guide targeting',
  },
  {
    name: 'scaffold',
    summary: 'Create an inspectable clock package at a new local directory.',
    flags: ['output'],
    access: 'offline local authoring',
    input: 'Explicit absolute --output directory',
    output: 'New package; never enabled or launched',
    example: 'hvir-agent scaffold --output /absolute/clock',
  },
  {
    name: 'validate',
    summary:
      'Validate a local directory, ZIP or development link without executing code.',
    flags: ['path'],
    access: 'offline local authoring',
    input: 'Explicit absolute --path package',
    output: 'Ordinary package validation result and warnings',
    example: 'hvir-agent validate --path /absolute/clock',
  },
  {
    name: 'skill',
    summary: 'Inspect the optional authoring skill or export it to a new local file.',
    flags: ['output'],
    access: 'offline local authoring',
    input: 'Optional explicit absolute --output file',
    output: 'Exact shipped skill; no harness configuration is changed',
    example: 'hvir-agent skill',
  },
  {
    name: 'instances',
    summary: 'List running local instance endpoints.',
    flags: [],
    access: 'local endpoint discovery',
    input: 'None',
    output: 'Endpoints only; no workbench metadata',
    example: 'hvir-agent instances',
  },
  {
    name: 'workspaces',
    summary: 'Inspect admitted workspace metadata.',
    flags: ['filter', 'cursor', 'limit'],
    access: 'agent access',
    input: 'Optional bounded filter/page',
    output: 'Workspace metadata page',
    example: 'hvir-agent workspaces --limit 10',
  },
  {
    name: 'sessions',
    summary: 'Inspect admitted live session metadata.',
    flags: [...targetFlags, 'filter', 'cursor', 'limit'],
    access: 'agent access',
    input: 'Optional target/filter/page',
    output: 'Session metadata page; no terminal contents',
    example: 'hvir-agent sessions --workspace WORKSPACE',
  },
  {
    name: 'views',
    summary: 'List views from agent-enabled extensions.',
    flags: ['filter', 'cursor', 'limit'],
    access: 'agent and extension access',
    input: 'Optional bounded filter/page',
    output: 'Declared view metadata page',
    example: 'hvir-agent views',
  },
  {
    name: 'actions',
    summary: 'List admitted actions without fetching schemas.',
    flags: ['filter', 'cursor', 'limit'],
    access: 'agent and extension access',
    input: 'Optional bounded filter/page',
    output: 'Declared action metadata page',
    example: 'hvir-agent actions',
  },
  {
    name: 'action',
    summary: 'Read one untrusted action declaration and input schema.',
    flags: ['extension', 'action'],
    access: 'agent and extension access',
    input: 'Exact installation and action IDs',
    output: 'Selected declaration marked untrusted',
    example: 'hvir-agent action --extension INSTALLATION --action hello',
  },
  {
    name: 'open',
    summary: 'Open a document confined to an explicit workspace.',
    flags: [...targetFlags, 'path'],
    access: 'agent access and registered root',
    input: 'Relative or same-host absolute path',
    output: 'Presentation metadata only',
    example: 'hvir-agent open --path README.md',
  },
  {
    name: 'view',
    summary: 'Open one admitted extension view without focusing it.',
    flags: [...targetFlags, 'extension', 'view'],
    access: 'agent and extension access',
    input: 'Exact installation and view IDs',
    output: 'View presentation metadata',
    example: 'hvir-agent view --extension INSTALLATION --view hello',
  },
  {
    name: 'report',
    summary: 'Publish or replace a workspace report from stdin.',
    flags: [...targetFlags, 'title', 'format', 'handle', 'stdin'],
    access: 'agent access',
    input: 'Bounded text or Markdown on stdin; handle for replacement',
    output: 'Opaque report ID and replacement handle',
    example:
      'printf "# Result\\n" | hvir-agent report --title Result --format markdown --stdin',
  },
  {
    name: 'run',
    summary: 'Invoke an admitted declared action without taking focus.',
    flags: [...targetFlags, 'extension', 'action', 'input'],
    access: 'agent and extension access; optional exact destructive confirmation',
    input: 'Exact IDs and optional bounded JSON input',
    output: 'Correlated action result or structured refusal',
    example: 'hvir-agent run --extension INSTALLATION --action hello --input "{}"',
  },
] as const
export type AgentCommandName = (typeof AGENT_COMMANDS)[number]['name']
export interface ParsedAgentCommand {
  readonly name: AgentCommandName
  readonly positionals: readonly string[]
  readonly flags: Readonly<Record<string, string>>
  readonly instance?: string
}
export function parseAgentCommand(argv: readonly string[]): ParsedAgentCommand {
  let name = argv[0] ?? 'help'
  if (name === '--help' || name === '-h') name = 'help'
  const declaration = AGENT_COMMANDS.find((entry) => entry.name === name)
  if (!declaration) throw new Error('Unknown command; use hvir-agent commands')
  const flags: Record<string, string> = {},
    positionals: string[] = []
  for (let index = 1; index < argv.length; index++) {
    const argument = argv[index]!
    if (!argument.startsWith('--')) {
      positionals.push(argument)
      continue
    }
    const [key, inline] = argument.slice(2).split(/=(.*)/su)
    if (
      !key ||
      (key !== 'instance' && !(declaration.flags as readonly string[]).includes(key))
    )
      throw new Error(`Unknown option for ${name}`)
    if (Object.hasOwn(flags, key)) throw new Error('Duplicate command option')
    if (key === 'stdin' && inline !== undefined)
      throw new Error('The stdin option takes no value')
    const value = key === 'stdin' ? 'true' : (inline ?? argv[++index])
    if (!value || value.startsWith('--')) throw new Error(`Missing ${key} value`)
    flags[key] = value
  }
  if (positionals.length > (['help', 'guide'].includes(name) ? 1 : 0))
    throw new Error('Unexpected command arguments')
  if (flags['filter']?.length && flags['filter'].length > 160)
    throw new Error('Filter is too long')
  if (
    flags['workspace'] &&
    flags['workspace'].length > AGENT_LIMITS.workspaceIdentityChars
  )
    throw new Error('Workspace identity is too long')
  for (const key of ['session', 'extension', 'action', 'view', 'handle'])
    if (flags[key] && flags[key].length > 128)
      throw new Error('Target identity is too long')
  return Object.freeze({
    name: declaration.name,
    flags: Object.freeze(flags),
    positionals: Object.freeze(positionals),
    ...(flags['instance'] ? { instance: flags['instance'] } : {}),
  })
}
/** Dispatch derives offline local authority from the maintained command declaration. */
export function isLocalAuthoringCommand(name: string): boolean {
  return AGENT_COMMANDS.some(
    (entry) => entry.name === name && entry.access === 'offline local authoring',
  )
}
export function staticAgentReference(
  command: ParsedAgentCommand,
  guide: (topic?: string) => unknown,
): AgentResponse | undefined {
  if (command.name === 'commands')
    return agentOutput({
      commands: AGENT_COMMANDS,
      exitStatuses: { success: 0, invalid: 64, unavailable: 69, interrupted: 75 },
    })
  if (command.name === 'guide') {
    try {
      return agentOutput({ guide: guide(command.positionals[0]) })
    } catch {
      return agentFailure(
        'unknown-guide',
        'Use hvir-agent guide to list installed topics',
        64,
      )
    }
  }
  if (command.name !== 'help') return undefined
  const name = command.positionals[0]
  if (!name)
    return agentOutput({
      help: `hvir-agent · installed contract ${AGENT_CONTRACT}\nInspect context, present work, run admitted actions, or scaffold local extensions.\nUse commands for the index, help COMMAND for focused reference, guide for topics.\nLive operations require Settings > Extensions > Agent access; --instance selects an endpoint.`,
    })
  const declaration = AGENT_COMMANDS.find((entry) => entry.name === name)
  return declaration
    ? agentOutput({
        reference: {
          ...declaration,
          targeting: isLocalAuthoringCommand(declaration.name)
            ? 'Offline local authoring; --instance is refused. Reads or writes only the explicitly selected local package/output; no application or grants are required.'
            : declaration.access === 'offline'
              ? 'Offline reference; no instance, workspace or session is required.'
              : declaration.name === 'instances'
                ? 'Local endpoint discovery; no selected instance, workspace or session is required.'
                : `One live instance via protected default or --instance.${
                    (declaration.flags as readonly string[]).some((flag) =>
                      ['workspace', 'session'].includes(flag),
                    )
                      ? ' Target flags: ' +
                        declaration.flags
                          .filter((flag) => ['workspace', 'session'].includes(flag))
                          .map((flag) => '--' + flag)
                          .join(', ') +
                        '; explicit target flags replace terminal target defaults.'
                      : ' Workspace/session target flags are not accepted.'
                  } Selection never supplies authority.`,
          exitStatuses: { success: 0, invalid: 64, unavailable: 69, interrupted: 75 },
        },
      })
    : agentFailure('unknown-command', 'Use hvir-agent commands', 64)
}
