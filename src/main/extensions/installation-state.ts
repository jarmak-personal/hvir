import { EXTENSION_LIMITS } from '../../shared/extensions/contract'

export interface AcceptedInstallation {
  readonly installationId: string
  readonly packageId: string
  readonly source: string
  readonly sourceIdentity: string
  readonly kind: 'directory' | 'zip' | 'development'
  readonly revision: string
  readonly enabled: boolean
  readonly agentAccess: boolean
}

/** Current pre-release schema only. There is no compatibility or migration reader. */
function readInstallations(value: unknown): AcceptedInstallation[] {
  if (!Array.isArray(value) || value.length > EXTENSION_LIMITS.installations)
    throw new Error('Invalid extension state')
  const entries = value.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object') throw new Error('Invalid extension state')
    const item = entry as Record<string, unknown>
    if (
      typeof item['installationId'] !== 'string' ||
      !/^[a-f0-9-]{36}$/u.test(item['installationId']) ||
      typeof item['packageId'] !== 'string' ||
      !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u.test(item['packageId']) ||
      typeof item['source'] !== 'string' ||
      !/^[^/\\.][^/\\]{0,254}$/u.test(item['source']) ||
      typeof item['sourceIdentity'] !== 'string' ||
      !/^\d+:\d+(?::\d+:\d+)?$/u.test(item['sourceIdentity']) ||
      typeof item['revision'] !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(item['revision']) ||
      !['directory', 'zip', 'development'].includes(item['kind'] as string) ||
      typeof item['enabled'] !== 'boolean' ||
      (item['agentAccess'] !== undefined && typeof item['agentAccess'] !== 'boolean')
    )
      throw new Error('Invalid extension state')
    return { ...entry, agentAccess: item['agentAccess'] === true } as AcceptedInstallation
  })
  if (
    new Set(entries.map((entry) => entry.packageId)).size !== entries.length ||
    new Set(entries.map((entry) => entry.source)).size !== entries.length ||
    new Set(entries.map((entry) => entry.installationId)).size !== entries.length
  )
    throw new Error('Duplicated extension state identity')
  return entries
}

export interface PackageRemoval {
  readonly source: string
  readonly staging: string
  readonly identity: string
  readonly kind: 'directory' | 'zip' | 'development'
  readonly forget: boolean
}

export function readInstallationState(value: unknown): {
  installations: AcceptedInstallation[]
  removals: PackageRemoval[]
} {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid extension state')
  const state = value as Record<string, unknown>
  const installations = readInstallations(state['installations'])
  if (
    !Array.isArray(state['removals']) ||
    state['removals'].length > EXTENSION_LIMITS.installations
  )
    throw new Error('Invalid package removal state')
  const removals = state['removals'].map((entry: unknown) => {
    if (!entry || typeof entry !== 'object')
      throw new Error('Invalid package removal state')
    const item = entry as Record<string, unknown>
    if (
      typeof item['source'] !== 'string' ||
      !/^[^/\\.][^/\\]{0,254}$/u.test(item['source']) ||
      typeof item['staging'] !== 'string' ||
      !/^remove-[a-f0-9-]{36}(?:\.zip)?$/u.test(item['staging']) ||
      typeof item['identity'] !== 'string' ||
      !/^\d+:\d+$/u.test(item['identity']) ||
      !['directory', 'zip', 'development'].includes(item['kind'] as string) ||
      typeof item['forget'] !== 'boolean'
    )
      throw new Error('Invalid package removal state')
    return entry as PackageRemoval
  })
  if (
    new Set(removals.map((entry) => entry.source)).size !== removals.length ||
    new Set(removals.map((entry) => entry.staging)).size !== removals.length ||
    removals.some((entry) =>
      installations.some(
        (installation) => installation.source === entry.source && installation.enabled,
      ),
    )
  )
    throw new Error('Invalid package removal identity')
  return { installations, removals }
}
