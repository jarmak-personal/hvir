import { createHash } from 'node:crypto'
import {
  asHostId,
  asHarnessProfileId,
  hostPath,
  isHarnessProviderId,
  isTerminalTitleText,
  type HarnessProviderId,
  type HarnessProfileId,
  type HostPath,
  type TerminalAttentionState,
  type TerminalName,
} from '../../shared'
import { harnessProvider } from '../harness/harness-provider'

export const TERMINAL_ID = /^[a-zA-Z0-9-]{1,80}$/
export const MAX_SESSIONS = 500
const MAX_TITLE_LENGTH = 512

export interface StoredTerminalSession extends TerminalName {
  readonly id: string
  readonly providerId: HarnessProviderId
  readonly profileId: HarnessProfileId
  readonly launchRevision: number
  readonly recoverySkipCount: 0 | 1
  readonly artifactIdentity?: string
  readonly harnessSessionId?: string
  readonly hostId: string
  readonly workspaceRoot: HostPath
  readonly cwd: HostPath
  readonly title: string
  readonly position: number
  readonly active: boolean
  readonly attention?: TerminalAttentionState
  readonly updatedAt: number
}

export function parseStoredSession(value: unknown): StoredTerminalSession | undefined {
  if (!isRecord(value)) return undefined
  const id = value['id']
  const providerId = value['providerId']
  const profileId = value['profileId']
  const launchRevision = value['launchRevision']
  const recoverySkipCount = value['recoverySkipCount']
  const artifactIdentity = value['artifactIdentity']
  const harnessSessionId = value['harnessSessionId']
  const hostId = value['hostId']
  const workspaceRoot =
    parsePath(value['workspaceRoot']) ?? parsePath(value['projectRoot'])
  const cwd = parsePath(value['cwd'])
  const customName = value['customName']
  const nameRevision = value['nameRevision']
  const title = value['title']
  const position = value['position']
  const active = value['active']
  const attention = value['attention']
  const updatedAt = value['updatedAt']
  if (
    typeof id !== 'string' ||
    !TERMINAL_ID.test(id) ||
    !isHarnessProviderId(providerId) ||
    typeof profileId !== 'string' ||
    !/^[a-z0-9](?:[a-z0-9._-]{0,78}[a-z0-9])?$/.test(profileId) ||
    typeof launchRevision !== 'number' ||
    !Number.isSafeInteger(launchRevision) ||
    launchRevision <= 0 ||
    (recoverySkipCount !== 0 && recoverySkipCount !== 1) ||
    (artifactIdentity !== undefined &&
      (typeof artifactIdentity !== 'string' ||
        !/^[a-f0-9]{24}$/.test(artifactIdentity))) ||
    (harnessSessionId !== undefined &&
      (typeof harnessSessionId !== 'string' || !isHarnessSessionId(harnessSessionId))) ||
    typeof hostId !== 'string' ||
    !workspaceRoot ||
    !cwd ||
    workspaceRoot.hostId !== hostId ||
    cwd.hostId !== hostId ||
    (customName !== undefined && !isTerminalTitleText(customName)) ||
    (nameRevision !== undefined &&
      (typeof nameRevision !== 'number' ||
        !Number.isSafeInteger(nameRevision) ||
        nameRevision < 0)) ||
    typeof title !== 'string' ||
    title.length > MAX_TITLE_LENGTH ||
    typeof position !== 'number' ||
    !Number.isSafeInteger(position) ||
    position < 0 ||
    position >= MAX_SESSIONS ||
    typeof active !== 'boolean' ||
    (attention !== undefined && !isTerminalAttention(attention)) ||
    typeof updatedAt !== 'number' ||
    !Number.isFinite(updatedAt) ||
    updatedAt < 0
  ) {
    return undefined
  }
  return {
    id,
    providerId,
    profileId: asHarnessProfileId(profileId),
    launchRevision,
    recoverySkipCount,
    artifactIdentity,
    harnessSessionId,
    hostId,
    workspaceRoot,
    cwd,
    customName:
      typeof customName === 'string' ? customName.trim() || undefined : undefined,
    nameRevision: typeof nameRevision === 'number' ? nameRevision : undefined,
    title,
    position,
    active,
    attention,
    updatedAt,
  }
}

export function parsePreSkipStoredSession(
  value: unknown,
): StoredTerminalSession | undefined {
  if (!isRecord(value)) return undefined
  return parseStoredSession({ ...value, recoverySkipCount: 0 })
}

export function parseAttentionOrSkipStoredSession(
  value: unknown,
): StoredTerminalSession | undefined {
  if (!isRecord(value)) return undefined
  const normalized =
    value['attention'] === 'output' ? { ...value, attention: 'working' } : value
  return normalized['recoverySkipCount'] === undefined
    ? parsePreSkipStoredSession(normalized)
    : parseStoredSession(normalized)
}

function parsePath(value: unknown): HostPath | undefined {
  if (!isRecord(value)) return undefined
  const hostId = value['hostId']
  const path = value['path']
  if (
    typeof hostId !== 'string' ||
    hostId.length === 0 ||
    hostId.length > 255 ||
    /\s/.test(hostId) ||
    hasControlCharacter(hostId) ||
    typeof path !== 'string' ||
    !path.startsWith('/')
  ) {
    return undefined
  }
  return hostPath(asHostId(hostId), path)
}

export function parseLegacyStoredSession(
  value: unknown,
  usesAdapterId: boolean,
): StoredTerminalSession | undefined {
  if (!isRecord(value)) return undefined
  const providerId = value[usesAdapterId ? 'adapterId' : 'providerId']
  if (!isHarnessProviderId(providerId)) return undefined
  return parseStoredSession({
    ...value,
    providerId,
    profileId: legacyProfileId(providerId),
    launchRevision: 1,
    recoverySkipCount: 0,
  })
}

function legacyProfileId(providerId: HarnessProviderId): HarnessProfileId {
  try {
    const id = harnessProvider(providerId).profile.defaultProfile?.id
    if (id) return id
  } catch {
    // Missing providers remain as unavailable records with a stable synthetic profile id.
  }
  const candidate = `legacy-${providerId}`
  if (candidate.length <= 80) return asHarnessProfileId(candidate)

  const digest = createHash('sha256').update(providerId).digest('hex').slice(0, 16)
  const providerPrefixLength = 80 - 'legacy-'.length - 1 - digest.length
  return asHarnessProfileId(
    `legacy-${providerId.slice(0, providerPrefixLength)}-${digest}`,
  )
}

export function cleanTitle(value: string): string {
  const title = [...value]
    .map((character) => (hasControlCharacter(character) ? ' ' : character))
    .join('')
    .trim()
  return title.slice(0, MAX_TITLE_LENGTH) || 'Terminal'
}

export function isHarnessSessionId(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 240 &&
    !/\s/.test(value) &&
    !hasControlCharacter(value)
  )
}

function isTerminalAttention(value: unknown): value is TerminalAttentionState {
  return value === 'working' || value === 'bell' || value === 'idle'
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0)
    return code <= 31 || code === 127
  })
}

export function cleanPosition(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(MAX_SESSIONS - 1, Math.floor(value)))
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
