import { createHash } from 'node:crypto'

import {
  asHostId,
  asHarnessProfileId,
  hostPath,
  isHarnessProviderId,
  type HarnessProviderId,
  type HarnessProfileId,
  type HostPath,
  type TerminalAttentionState,
  type TerminalLayoutEntry,
  type TerminalRecoverySession,
} from '../../shared'
import type { ProjectHost } from '../project-host'
import { harnessProvider } from '../harness/harness-provider'
import type { HarnessRecoveryProfileReference } from '../harness/harness-profile-store'

const FILE_VERSION = 6
const LEGACY_ATTENTION_OR_SKIP_FILE_VERSION = 5
const LEGACY_PROFILE_FILE_VERSION = 4
const LEGACY_WORKSPACE_FILE_VERSION = 3
const LEGACY_PROVIDER_FILE_VERSION = 2
const LEGACY_ADAPTER_FILE_VERSION = 1
const TERMINAL_ID = /^[a-zA-Z0-9-]{1,80}$/
const MAX_SESSIONS = 500
const MAX_TITLE_LENGTH = 512

interface StoredTerminalSession {
  readonly id: string
  readonly providerId: HarnessProviderId
  readonly profileId: HarnessProfileId
  readonly launchRevision: number
  readonly recoverySkipCount: 0 | 1
  readonly riskAcknowledgedRevision?: number
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

interface StoredFile {
  readonly version: typeof FILE_VERSION
  readonly sessions: readonly StoredTerminalSession[]
}

export interface RecordTerminalSpawn {
  readonly id: string
  readonly providerId: HarnessProviderId
  readonly profileId: HarnessProfileId
  readonly launchRevision: number
  readonly riskAcknowledgedRevision?: number
  readonly artifactIdentity?: string
  readonly harnessSessionId?: string
  readonly workspaceRoot: HostPath
  readonly cwd: HostPath
  readonly title: string
  readonly position: number
  readonly active: boolean
}

export interface AuthorizeTerminalResume {
  readonly id: string
  readonly providerId: HarnessProviderId
  readonly profileId: HarnessProfileId
  readonly launchRevision: number
  readonly harnessSessionId: string
  readonly workspaceRoot: HostPath
  readonly cwd: HostPath
}

export interface AuthorizeTerminalReattach {
  readonly id: string
  readonly providerId: HarnessProviderId
  readonly profileId: HarnessProfileId
  readonly launchRevision: number
  readonly harnessSessionId?: string
  readonly workspaceRoot: HostPath
  readonly cwd: HostPath
}

export interface AuthorizeTerminalReplacement {
  readonly replacedId: string
  readonly replacementId: string
  readonly providerId: HarnessProviderId
  readonly profileId: HarnessProfileId
  readonly launchRevision: number
  readonly workspaceRoot: HostPath
  readonly cwd: HostPath
}

export interface RecordTerminalReplacement {
  readonly replacedId: string
  readonly spawn: RecordTerminalSpawn
}

export interface RebindTerminalProfile {
  readonly id: string
  readonly providerId: HarnessProviderId
  readonly profileId: HarnessProfileId
  readonly launchRevision: number
  readonly riskAcknowledgedRevision?: number
  readonly workspaceRoot: HostPath
}

export interface MoveTerminalSession {
  readonly id: string
  readonly sourceRoot: HostPath
  readonly targetRoot: HostPath
}

export interface OwnedTerminalSession extends TerminalRecoverySession {
  readonly workspaceRoot: HostPath
}

export interface TerminalSessionStore {
  list(workspaceRoot: HostPath): readonly TerminalRecoverySession[]
  recordRecoveryDecision(
    workspaceRoot: HostPath,
    decision: {
      readonly restoredIds: readonly string[]
      readonly skippedIds: readonly string[]
    },
  ): Promise<void>
  recordSpawn(spawn: RecordTerminalSpawn): Promise<void>
  recordReplacement(replacement: RecordTerminalReplacement): Promise<void>
  recordIdentity(id: string, harnessSessionId: string): Promise<void>
  updateLayout(
    workspaceRoot: HostPath,
    layout: readonly TerminalLayoutEntry[],
  ): Promise<void>
  forget(workspaceRoot: HostPath, id: string): Promise<void>
  rebindProfile(request: RebindTerminalProfile): Promise<TerminalRecoverySession>
  authorizeReattach(request: AuthorizeTerminalReattach): boolean
  authorizeResume(request: AuthorizeTerminalResume): boolean
  authorizeReplacement(request: AuthorizeTerminalReplacement): boolean
  flush(): Promise<void>
}

export interface TerminalMoveSessionStore {
  get(id: string): OwnedTerminalSession | undefined
  move(request: MoveTerminalSession): Promise<TerminalRecoverySession>
}

export type TerminalSessionRegistryDiagnostic =
  | {
      readonly kind: 'load-failed'
      readonly reason: 'read-failed' | 'invalid-json' | 'invalid-schema'
    }
  | { readonly kind: 'persist-failed' }

export class TerminalSessionRegistry implements TerminalSessionStore {
  private readonly sessions = new Map<string, StoredTerminalSession>()
  private readonly forgotten = new Set<string>()
  private readonly pendingIdentities = new Map<string, string>()
  private pendingWrite: Promise<void> = Promise.resolve()

  private constructor(
    private readonly host: ProjectHost,
    private readonly file: HostPath,
    sessions: readonly StoredTerminalSession[],
    private readonly onDiagnostic?: (event: TerminalSessionRegistryDiagnostic) => void,
  ) {
    for (const session of sessions.slice(-MAX_SESSIONS)) {
      this.sessions.set(session.id, session)
    }
  }

  static async load(
    host: ProjectHost,
    file: HostPath,
    onDiagnostic?: (event: TerminalSessionRegistryDiagnostic) => void,
  ): Promise<TerminalSessionRegistry> {
    let sessions: StoredTerminalSession[] = []
    let migrated = false
    let content: string | undefined
    try {
      content = await host.readTextFile(file)
    } catch (error) {
      if (!isMissingFile(error)) {
        reportDiagnostic(onDiagnostic, { kind: 'load-failed', reason: 'read-failed' })
      }
    }
    if (content !== undefined) {
      let value: unknown
      try {
        value = JSON.parse(content)
      } catch {
        reportDiagnostic(onDiagnostic, { kind: 'load-failed', reason: 'invalid-json' })
      }
      if (value !== undefined) {
        if (
          isRecord(value) &&
          (value['version'] === FILE_VERSION ||
            value['version'] === LEGACY_ATTENTION_OR_SKIP_FILE_VERSION ||
            value['version'] === LEGACY_PROFILE_FILE_VERSION ||
            value['version'] === LEGACY_WORKSPACE_FILE_VERSION ||
            value['version'] === LEGACY_PROVIDER_FILE_VERSION ||
            value['version'] === LEGACY_ADAPTER_FILE_VERSION)
        ) {
          const rawSessions = value['sessions']
          if (Array.isArray(rawSessions)) {
            const parsed = rawSessions
              .map((session) =>
                value['version'] === FILE_VERSION
                  ? parseStoredSession(session)
                  : value['version'] === LEGACY_ATTENTION_OR_SKIP_FILE_VERSION
                    ? parseAttentionOrSkipStoredSession(session)
                    : value['version'] === LEGACY_PROFILE_FILE_VERSION ||
                      value['version'] === LEGACY_WORKSPACE_FILE_VERSION
                    ? parsePreSkipStoredSession(session)
                    : parseLegacyStoredSession(
                        session,
                        value['version'] === LEGACY_ADAPTER_FILE_VERSION,
                      ),
              )
              .filter((session): session is StoredTerminalSession => Boolean(session))
            sessions = parsed
            if (parsed.length !== rawSessions.length) {
              reportDiagnostic(onDiagnostic, {
                kind: 'load-failed',
                reason: 'invalid-schema',
              })
            }
            migrated = value['version'] !== FILE_VERSION
          } else {
            reportDiagnostic(onDiagnostic, {
              kind: 'load-failed',
              reason: 'invalid-schema',
            })
          }
        } else {
          reportDiagnostic(onDiagnostic, {
            kind: 'load-failed',
            reason: 'invalid-schema',
          })
        }
      }
    }
    const registry = new TerminalSessionRegistry(host, file, sessions, onDiagnostic)
    if (migrated) {
      await registry
        .persist()
        .catch((error) =>
          console.warn('[terminal] session registry migration write failed', error),
        )
    }
    return registry
  }

  list(workspaceRoot: HostPath): readonly TerminalRecoverySession[] {
    return [...this.sessions.values()]
      .filter((session) => hostPathEquals(session.workspaceRoot, workspaceRoot))
      .sort(
        (left, right) =>
          left.position - right.position || left.updatedAt - right.updatedAt,
      )
      .map(({ workspaceRoot: _workspaceRoot, ...session }) => session)
  }

  get(id: string): OwnedTerminalSession | undefined {
    const session = this.sessions.get(id)
    return session ? { ...session } : undefined
  }

  profileReferences(): readonly HarnessRecoveryProfileReference[] {
    return [...this.sessions.values()].map((session) => ({
      providerId: session.providerId,
      profileId: session.profileId,
      launchRevision: session.launchRevision,
    }))
  }

  async recordRecoveryDecision(
    workspaceRoot: HostPath,
    decision: {
      readonly restoredIds: readonly string[]
      readonly skippedIds: readonly string[]
    },
  ): Promise<void> {
    const previous = new Map<string, StoredTerminalSession>()
    const applied = new Map<string, StoredTerminalSession | undefined>()
    const newlyForgotten = new Set<string>()
    const restore = new Set(decision.restoredIds)
    const skip = new Set(decision.skippedIds)

    for (const id of restore) {
      const current = this.sessions.get(id)
      if (
        !current ||
        !hostPathEquals(current.workspaceRoot, workspaceRoot) ||
        current.recoverySkipCount === 0
      ) {
        continue
      }
      const updated: StoredTerminalSession = {
        ...current,
        recoverySkipCount: 0,
      }
      previous.set(id, current)
      applied.set(id, updated)
      this.sessions.set(id, updated)
    }

    for (const id of skip) {
      if (restore.has(id)) continue
      const current = this.sessions.get(id)
      if (!current || !hostPathEquals(current.workspaceRoot, workspaceRoot)) continue
      previous.set(id, current)
      if (current.recoverySkipCount === 1) {
        applied.set(id, undefined)
        this.sessions.delete(id)
        if (!this.forgotten.has(id)) {
          this.forgotten.add(id)
          newlyForgotten.add(id)
        }
      } else {
        const updated: StoredTerminalSession = {
          ...current,
          recoverySkipCount: 1,
        }
        applied.set(id, updated)
        this.sessions.set(id, updated)
      }
    }

    if (previous.size === 0) return
    try {
      await this.persist()
    } catch (error) {
      for (const [id, prior] of previous) {
        const attempted = applied.get(id)
        if (
          (attempted === undefined && !this.sessions.has(id)) ||
          this.sessions.get(id) === attempted
        ) {
          this.sessions.set(id, prior)
        }
        if (newlyForgotten.has(id)) this.forgotten.delete(id)
      }
      await this.persist().catch(() => undefined)
      throw error
    }
  }

  recordSpawn(spawn: RecordTerminalSpawn): Promise<void> {
    if (this.forgotten.has(spawn.id)) {
      this.pendingIdentities.delete(spawn.id)
      return Promise.resolve()
    }
    const harnessSessionId =
      spawn.harnessSessionId ?? this.pendingIdentities.get(spawn.id)
    const retainedAttention = this.sessions.get(spawn.id)?.attention
    this.pendingIdentities.delete(spawn.id)
    const now = Date.now()
    this.sessions.set(spawn.id, {
      id: spawn.id,
      providerId: spawn.providerId,
      profileId: spawn.profileId,
      launchRevision: spawn.launchRevision,
      recoverySkipCount: 0,
      riskAcknowledgedRevision: spawn.riskAcknowledgedRevision,
      artifactIdentity: spawn.artifactIdentity,
      harnessSessionId,
      hostId: spawn.cwd.hostId,
      workspaceRoot: spawn.workspaceRoot,
      cwd: spawn.cwd,
      title: cleanTitle(spawn.title),
      position: cleanPosition(spawn.position),
      active: spawn.active,
      attention: retainedAttention,
      updatedAt: now,
    })
    return this.persist()
  }

  async recordReplacement({
    replacedId,
    spawn,
  }: RecordTerminalReplacement): Promise<void> {
    if (
      !this.authorizeReplacement({
        replacedId,
        replacementId: spawn.id,
        providerId: spawn.providerId,
        profileId: spawn.profileId,
        launchRevision: spawn.launchRevision,
        workspaceRoot: spawn.workspaceRoot,
        cwd: spawn.cwd,
      })
    ) {
      throw new Error('Terminal replacement is no longer authorized')
    }
    const replaced = this.sessions.get(replacedId)!
    const pendingIdentity = this.pendingIdentities.get(spawn.id)
    const harnessSessionId = spawn.harnessSessionId ?? pendingIdentity
    const replacement: StoredTerminalSession = {
      id: spawn.id,
      providerId: spawn.providerId,
      profileId: spawn.profileId,
      launchRevision: spawn.launchRevision,
      recoverySkipCount: 0,
      riskAcknowledgedRevision: spawn.riskAcknowledgedRevision,
      artifactIdentity: spawn.artifactIdentity,
      harnessSessionId,
      hostId: spawn.cwd.hostId,
      workspaceRoot: spawn.workspaceRoot,
      cwd: spawn.cwd,
      title: cleanTitle(spawn.title),
      position: cleanPosition(spawn.position),
      active: spawn.active,
      updatedAt: Date.now(),
    }
    this.pendingIdentities.delete(spawn.id)
    this.sessions.delete(replacedId)
    this.sessions.set(spawn.id, replacement)
    this.forgotten.add(replacedId)
    try {
      await this.persist()
      if (this.forgotten.has(spawn.id)) {
        throw new Error('Terminal replacement was cancelled')
      }
    } catch (error) {
      if (this.forgotten.has(spawn.id)) throw error
      this.sessions.delete(spawn.id)
      this.sessions.set(replacedId, replaced)
      this.forgotten.delete(replacedId)
      this.forgotten.add(spawn.id)
      // A discovery callback may have queued a replacement snapshot after the
      // failed write. Persist the rollback last so reload observes the source.
      await this.persist().catch(() => undefined)
      throw error
    }
  }

  recordIdentity(id: string, harnessSessionId: string): Promise<void> {
    if (
      this.forgotten.has(id) ||
      !TERMINAL_ID.test(id) ||
      !isHarnessSessionId(harnessSessionId)
    ) {
      return Promise.resolve()
    }
    const current = this.sessions.get(id)
    if (!current) {
      if (this.pendingIdentities.size >= MAX_SESSIONS) {
        const oldest = this.pendingIdentities.keys().next().value
        if (oldest !== undefined) this.pendingIdentities.delete(oldest)
      }
      this.pendingIdentities.set(id, harnessSessionId)
      return Promise.resolve()
    }
    this.sessions.set(id, {
      ...current,
      harnessSessionId,
      updatedAt: Date.now(),
    })
    return this.persist()
  }

  updateLayout(
    workspaceRoot: HostPath,
    layout: readonly TerminalLayoutEntry[],
  ): Promise<void> {
    let changed = false
    for (const item of layout.slice(0, MAX_SESSIONS)) {
      const current = this.sessions.get(item.id)
      if (!current || !hostPathEquals(current.workspaceRoot, workspaceRoot)) continue
      const next = {
        ...current,
        title: cleanTitle(item.title),
        position: cleanPosition(item.position),
        active: item.active,
        attention: item.attention,
        updatedAt: Date.now(),
      }
      this.sessions.set(item.id, next)
      changed = true
    }
    return changed ? this.persist() : Promise.resolve()
  }

  forget(workspaceRoot: HostPath, id: string): Promise<void> {
    const current = this.sessions.get(id)
    if (current && !hostPathEquals(current.workspaceRoot, workspaceRoot)) {
      return Promise.resolve()
    }
    this.forgotten.add(id)
    this.pendingIdentities.delete(id)
    if (!current) return Promise.resolve()
    this.sessions.delete(id)
    return this.persist()
  }

  async move(request: MoveTerminalSession): Promise<TerminalRecoverySession> {
    const current = this.sessions.get(request.id)
    if (!current || !hostPathEquals(current.workspaceRoot, request.sourceRoot)) {
      throw new Error('Terminal no longer belongs to the source workspace')
    }
    if (request.sourceRoot.hostId !== request.targetRoot.hostId) {
      throw new Error('Terminal cannot move to another host')
    }
    const updated: StoredTerminalSession = {
      ...current,
      workspaceRoot: request.targetRoot,
      updatedAt: Date.now(),
    }
    this.sessions.set(request.id, updated)
    try {
      await this.persist()
    } catch (error) {
      if (this.sessions.get(request.id) === updated)
        this.sessions.set(request.id, current)
      throw error
    }
    const { workspaceRoot: _workspaceRoot, ...result } = updated
    return result
  }

  async rebindProfile(request: RebindTerminalProfile): Promise<TerminalRecoverySession> {
    const current = this.sessions.get(request.id)
    if (!current || !hostPathEquals(current.workspaceRoot, request.workspaceRoot)) {
      throw new Error('Unknown terminal recovery record')
    }
    if (current.providerId !== request.providerId) {
      throw new Error('Terminal profiles can only be rebound within the same provider')
    }
    const updated: StoredTerminalSession = {
      ...current,
      profileId: request.profileId,
      launchRevision: request.launchRevision,
      riskAcknowledgedRevision: request.riskAcknowledgedRevision,
      artifactIdentity: undefined,
      updatedAt: Date.now(),
    }
    this.sessions.set(request.id, updated)
    await this.persist()
    const { workspaceRoot: _workspaceRoot, ...result } = updated
    return result
  }

  authorizeResume(request: AuthorizeTerminalResume): boolean {
    const stored = this.sessions.get(request.id)
    return Boolean(
      stored &&
      stored.providerId === request.providerId &&
      stored.profileId === request.profileId &&
      stored.launchRevision === request.launchRevision &&
      stored.harnessSessionId === request.harnessSessionId &&
      hostPathEquals(stored.workspaceRoot, request.workspaceRoot) &&
      hostPathEquals(stored.cwd, request.cwd),
    )
  }

  authorizeReattach(request: AuthorizeTerminalReattach): boolean {
    const stored = this.sessions.get(request.id)
    return Boolean(
      stored &&
      stored.providerId === request.providerId &&
      stored.profileId === request.profileId &&
      stored.launchRevision === request.launchRevision &&
      stored.harnessSessionId === request.harnessSessionId &&
      hostPathEquals(stored.workspaceRoot, request.workspaceRoot) &&
      hostPathEquals(stored.cwd, request.cwd),
    )
  }

  authorizeReplacement(request: AuthorizeTerminalReplacement): boolean {
    const stored = this.sessions.get(request.replacedId)
    return Boolean(
      request.replacedId !== request.replacementId &&
      !this.sessions.has(request.replacementId) &&
      !this.forgotten.has(request.replacementId) &&
      stored?.harnessSessionId &&
      stored.providerId === request.providerId &&
      stored.profileId === request.profileId &&
      stored.launchRevision === request.launchRevision &&
      hostPathEquals(stored.workspaceRoot, request.workspaceRoot) &&
      hostPathEquals(stored.cwd, request.cwd),
    )
  }

  flush(): Promise<void> {
    return this.pendingWrite
  }

  private persist(): Promise<void> {
    const snapshot: StoredFile = {
      version: FILE_VERSION,
      sessions: [...this.sessions.values()].slice(-MAX_SESSIONS),
    }
    const write = this.pendingWrite
      .catch(() => undefined)
      .then(() => this.host.writeFile(this.file, JSON.stringify(snapshot, null, 2)))
      .catch((error: unknown) => {
        reportDiagnostic(this.onDiagnostic, { kind: 'persist-failed' })
        throw error
      })
    this.pendingWrite = write
    return write
  }
}

function reportDiagnostic(
  observer: ((event: TerminalSessionRegistryDiagnostic) => void) | undefined,
  event: TerminalSessionRegistryDiagnostic,
): void {
  try {
    observer?.(event)
  } catch {
    // Diagnostics is best-effort and never owns session recovery or persistence.
  }
}

function isMissingFile(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    value.code === 'ENOENT'
  )
}

function parseStoredSession(value: unknown): StoredTerminalSession | undefined {
  if (!isRecord(value)) return undefined
  const id = value['id']
  const providerId = value['providerId']
  const profileId = value['profileId']
  const launchRevision = value['launchRevision']
  const recoverySkipCount = value['recoverySkipCount']
  const riskAcknowledgedRevision = value['riskAcknowledgedRevision']
  const artifactIdentity = value['artifactIdentity']
  const harnessSessionId = value['harnessSessionId']
  const hostId = value['hostId']
  const workspaceRoot =
    parsePath(value['workspaceRoot']) ?? parsePath(value['projectRoot'])
  const cwd = parsePath(value['cwd'])
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
    (riskAcknowledgedRevision !== undefined &&
      (typeof riskAcknowledgedRevision !== 'number' ||
        !Number.isSafeInteger(riskAcknowledgedRevision) ||
        riskAcknowledgedRevision <= 0)) ||
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
    riskAcknowledgedRevision,
    artifactIdentity,
    harnessSessionId,
    hostId,
    workspaceRoot,
    cwd,
    title,
    position,
    active,
    attention,
    updatedAt,
  }
}

function parsePreSkipStoredSession(value: unknown): StoredTerminalSession | undefined {
  if (!isRecord(value)) return undefined
  return parseStoredSession({ ...value, recoverySkipCount: 0 })
}

function parseAttentionOrSkipStoredSession(
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

function parseLegacyStoredSession(
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

function cleanTitle(value: string): string {
  const title = [...value]
    .map((character) => (hasControlCharacter(character) ? ' ' : character))
    .join('')
    .trim()
  return title.slice(0, MAX_TITLE_LENGTH) || 'Terminal'
}

function isHarnessSessionId(value: string): boolean {
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

function cleanPosition(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(MAX_SESSIONS - 1, Math.floor(value)))
}

function hostPathEquals(left: HostPath, right: HostPath): boolean {
  return left.hostId === right.hostId && left.path === right.path
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
