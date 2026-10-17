import { extensionId, extensionObject, extensionText } from './validation'

export const CONNECTOR_LIMITS = {
  declarations: 8,
  timeoutMs: 180_000,
  outputBytes: 4 * 1024 * 1024,
  concurrent: 16,
  perExtension: 4,
  receipts: 16,
  receiptBytes: 32 * 1024 * 1024,
  retentionMs: 30_000,
  refreshIntervalMs: 1000,
  sources: 128,
  arguments: 128,
  argumentBytes: 8 * 1024,
  configBytes: 8 * 1024,
  stateBytes: 256 * 1024,
  pageBytes: 8 * 1024,
} as const

export interface ExtensionConnectorDeclaration {
  readonly id: string
  readonly description: string
  readonly context: 'application' | 'workspace'
  readonly timeoutMs: number
  readonly outputBytes: number
  readonly setup?: { readonly executable: string }
  readonly environment: readonly string[]
}
export interface ExtensionConnectorConfiguration {
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
}
export interface ExtensionConnectorSelection {
  readonly installationId: string
  readonly connector: string
  readonly host: string
  readonly executable: string
  readonly configuration: ExtensionConnectorConfiguration
}
export interface ExtensionConnectorApproval extends ExtensionConnectorSelection {
  readonly canonicalExecutable: string
  readonly declaration: ExtensionConnectorDeclaration
}
export type ConnectorOutcome = 'not-started' | 'completed' | 'interrupted-uncertain'
export interface ExtensionConnectorResult {
  readonly outcome: ConnectorOutcome
  readonly host: string
  readonly code: number | null
  readonly signal: string | null
  readonly truncated: boolean
  readonly reason?:
    | 'unavailable'
    | 'unapproved'
    | 'disconnected'
    | 'capacity'
    | 'frequency'
    | 'context-ended'
    | 'interrupted'
    | 'deadline'
    | 'output-limit'
    | 'transport'
  readonly receipt?: string
  readonly stdoutBytes: number
  readonly stderrBytes: number
}
export interface ExtensionConnectorOutput {
  readonly data: string
  readonly nextOffset: number | null
  readonly result: ExtensionConnectorResult
}
export interface ExtensionConnectorStatus {
  readonly connector: string
  readonly availability: 'supported' | 'unavailable' | 'disconnected'
  readonly host?: string
  readonly executable?: string
  readonly explanation?: string
}

/** One grammar for declaration hints and passive metadata discovery. */
export function connectorExecutableBasename(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(value))
    throw new Error('Invalid declared executable basename')
  return value
}

function integer(value: unknown, maximum: number, label: string): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > maximum
  )
    throw new Error(`Invalid connector ${label}`)
  return value as number
}
export function validateConnectorDeclarations(
  value: unknown,
  warnings: (value: Record<string, unknown>, known: readonly string[]) => void,
): ExtensionConnectorDeclaration[] {
  if (!Array.isArray(value) || value.length > CONNECTOR_LIMITS.declarations)
    throw new Error('Too many connector declarations')
  const declarations = value.map((entry: unknown) => {
    const object = extensionObject(entry)
    warnings(object, [
      'id',
      'description',
      'context',
      'timeoutMs',
      'outputBytes',
      'environment',
      'setup',
    ])
    if (!['application', 'workspace'].includes(object['context'] as string))
      throw new Error('Invalid connector working context')
    const environment = object['environment']
    if (
      !Array.isArray(environment) ||
      environment.length > 16 ||
      environment.some(
        (name: unknown) =>
          typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/u.test(name),
      ) ||
      new Set(environment).size !== environment.length
    )
      throw new Error('Invalid connector environment declarations')
    let setup: ExtensionConnectorDeclaration['setup']
    if (object['setup'] !== undefined) {
      const hint = extensionObject(object['setup'])
      warnings(hint, ['executable'])
      setup = { executable: connectorExecutableBasename(hint['executable']) }
    }
    return {
      ...(setup ? { setup } : {}),
      id: extensionId(object['id']),
      description: extensionText(object['description'], 'connector description', 240),
      context: object['context'] as 'application' | 'workspace',
      timeoutMs: integer(object['timeoutMs'], CONNECTOR_LIMITS.timeoutMs, 'deadline'),
      outputBytes: integer(
        object['outputBytes'],
        CONNECTOR_LIMITS.outputBytes,
        'output limit',
      ),
      environment: environment as string[],
    }
  })
  if (declarations.filter((entry) => entry.setup).length > 4)
    throw new Error('Too many program setup hints')
  if (new Set(declarations.map((entry) => entry.id)).size !== declarations.length)
    throw new Error('Duplicate connector identity')
  return declarations
}
export function connectorArguments(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > CONNECTOR_LIMITS.arguments ||
    value.some((arg: unknown) => typeof arg !== 'string' || arg.includes('\0'))
  )
    throw new Error('Invalid structured connector arguments')
  if (
    new TextEncoder().encode(JSON.stringify(value)).length >
    CONNECTOR_LIMITS.argumentBytes
  )
    throw new Error('Connector arguments exceed their bound')
  return [...(value as string[])]
}
export function connectorConfiguration(
  value: unknown,
  declaration: ExtensionConnectorDeclaration,
): ExtensionConnectorConfiguration {
  const object = extensionObject(value),
    env = extensionObject(object['env'])
  const args = connectorArguments(object['args'])
  for (const [name, entry] of Object.entries(env))
    if (
      !declaration.environment.includes(name) ||
      typeof entry !== 'string' ||
      entry.includes('\0')
    )
      throw new Error(
        'Connector configuration contains an undeclared environment override',
      )
  const configuration = {
    args,
    env: Object.fromEntries(
      Object.entries(env).sort(([a], [b]) => a.localeCompare(b)),
    ) as Record<string, string>,
  }
  if (
    new TextEncoder().encode(JSON.stringify(configuration)).length >
    CONNECTOR_LIMITS.configBytes
  )
    throw new Error('Connector configuration exceeds its bound')
  return configuration
}

/** Outcomes describe individual consent writes, never an atomic group transaction. */
export interface ExtensionConnectionResult {
  readonly connections: readonly {
    readonly connector: string
    readonly outcome: 'connected' | 'declined' | 'unavailable' | 'interrupted-uncertain'
    readonly explanation?: string
  }[]
}

/** Trusted workbench display only; prepared grant tokens never leave main. */
export interface ExtensionConnectionProposal {
  readonly id: string
  readonly installationId: string
  readonly name: string
  readonly programs: readonly {
    readonly connector: string
    readonly description: string
    readonly context: ExtensionConnectorDeclaration['context']
    readonly replacesHost?: string
    readonly host: string
    readonly canonicalExecutable: string
    readonly configuration: ExtensionConnectorConfiguration
  }[]
}
