import { asHostId, hostPath, type HostPath } from '../host-path'
import type { ExtensionManifest } from './contract'
import {
  CONNECTOR_LIMITS,
  connectorConfiguration,
  type ExtensionConnectorConfiguration,
} from './connectors'
import { SOURCE_LIMITS } from './source-access'
import { extensionId, extensionObject, extensionText } from './validation'

export const SETUP_LIMITS = { bytes: 384 * 1024, reviewMs: 10 * 60_000 } as const
export interface ExtensionSetupProposal {
  readonly schema: 1
  readonly extension: string
  readonly connectors: readonly {
    readonly connector: string
    readonly executable: HostPath
    readonly configuration: ExtensionConnectorConfiguration
  }[]
  readonly sources: readonly {
    readonly source: string
    readonly location: HostPath
    readonly workspace: boolean
  }[]
  readonly requestAgentAccess?: boolean
}

function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const object = extensionObject(value)
  if (Object.keys(object).some((key) => !keys.includes(key)))
    throw new Error('Setup contains an unknown field')
  if (object['help'] !== undefined) extensionText(object['help'], 'setup hint', 2048)
  return object
}
function rows(value: unknown, maximum: number): readonly unknown[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > maximum)
    throw new Error('Setup contains too many bindings')
  return value
}
function location(value: unknown): HostPath {
  const item = closed(value, ['host', 'path'])
  const host = extensionText(item['host'], 'configured host', 128)
  const path = extensionText(item['path'], 'absolute setup path', 4096)
  const result = hostPath(asHostId(host), path)
  if (
    !path.startsWith('/') ||
    path !== result.path ||
    new TextEncoder().encode(path).length > 4096
  )
    throw new Error('Fill in a normalized absolute path and configured host')
  return result
}
function distinct(keys: readonly string[]): void {
  if (new Set(keys).size !== keys.length)
    throw new Error('Setup contains duplicate bindings')
}

/** Structural validity is not canonical readiness or consent. No saved state is consumed. */
export function parseExtensionSetup(
  text: string,
  manifest: ExtensionManifest,
): ExtensionSetupProposal {
  if (new TextEncoder().encode(text).length > SETUP_LIMITS.bytes)
    throw new Error('Setup file exceeds 384 KiB')
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error('Choose a valid JSON setup file')
  }
  const object = closed(value, [
    'schema',
    'extension',
    'connectors',
    'sources',
    'requestAgentAccess',
  ])
  if (object['schema'] !== 1 || extensionId(object['extension']) !== manifest.id)
    throw new Error('Setup must name this extension and schema 1')
  const connectors = rows(object['connectors'], CONNECTOR_LIMITS.approvals).map(
    (value) => {
      const item = closed(value, [
        'connector',
        'host',
        'executable',
        'configuration',
        'help',
      ])
      const connector = extensionId(item['connector'])
      const declaration = manifest.connectors?.find((entry) => entry.id === connector)
      if (!declaration) throw new Error('Setup names an undeclared program')
      const executable = location({ host: item['host'], path: item['executable'] })
      const configuration =
        item['configuration'] === undefined
          ? { args: [], env: {} }
          : item['configuration']
      closed(configuration, ['args', 'env'])
      return {
        connector,
        executable,
        configuration: connectorConfiguration(configuration, declaration),
      }
    },
  )
  distinct(
    connectors.map((entry) => JSON.stringify([entry.connector, entry.executable.hostId])),
  )
  const sources = rows(object['sources'], SOURCE_LIMITS.grants).map((value) => {
    const item = closed(value, ['source', 'root', 'workspace', 'help'])
    const source = extensionId(item['source'])
    const declaration = manifest.access.find((entry) => entry.id === source)
    if (!declaration) throw new Error('Setup names an undeclared file source')
    const workspace = item['workspace'] !== undefined
    if (workspace === (item['root'] !== undefined))
      throw new Error('Choose exactly one source root or workspace')
    return {
      source,
      location: location(item[workspace ? 'workspace' : 'root']),
      workspace,
    }
  })
  const agent = object['requestAgentAccess']
  if (agent !== undefined && typeof agent !== 'boolean')
    throw new Error('Choose per-extension agent access explicitly')
  return {
    schema: 1,
    extension: manifest.id,
    connectors,
    sources,
    ...(agent !== undefined ? { requestAgentAccess: agent } : {}),
  }
}

/** Declaration-only authoring aid. Unresolved selections intentionally fail validation. */
export function extensionSetupTemplate(manifest: ExtensionManifest): string {
  return (
    JSON.stringify(
      {
        schema: 1,
        extension: manifest.id,
        connectors: (manifest.connectors ?? []).map((entry) => ({
          connector: entry.id,
          help: `${entry.context} program. ${entry.setup ? `Installed basename: ${entry.setup.executable}. ` : ''}Allowed environment keys: ${entry.environment.join(', ') || 'none'}. Remove unused rows; omitted settings stay unchanged.`,
          host: entry.context === 'application' ? 'local' : '<configured host or local>',
          executable: `<absolute path to ${entry.setup?.executable ?? entry.id}>`,
          configuration: { args: [], env: {} },
        })),
        sources: manifest.access.map((entry) => ({
          source: entry.id,
          help: `${entry.description}. ${entry.context} / ${entry.mode}. Remove this row if not requested.`,
          [entry.context === 'workspace' ? 'workspace' : 'root']: {
            host:
              entry.context === 'application'
                ? 'local'
                : entry.mode === 'managed-delivery'
                  ? '<configured SSH host>'
                  : '<configured host or local>',
            path:
              entry.context === 'workspace'
                ? '<exact registered workspace path>'
                : '<absolute folder path>',
          },
        })),
      },
      null,
      2,
    ) + '\n'
  )
}
