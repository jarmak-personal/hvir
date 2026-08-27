import {
  LOCAL_HOST_ID,
  MAX_SESSIONS_PROJECTION_PROVIDERS,
  MAX_SESSIONS_PROJECTION_ROWS,
  MAX_SESSIONS_PROJECTION_WORKSPACES,
  SESSIONS_PROJECTION_VERSION,
  asSessionsPtyHandle,
  asSessionsTerminalHandle,
  type HarnessFacet,
  type HarnessModelFacet,
  type HarnessContextFacet,
  type HarnessTelemetry,
  type HarnessTurnFacet,
  type HostConnectionState,
  type ProjectHostOption,
  type ProjectState,
  type SessionsContextFact,
  type SessionsFact,
  type SessionsModelFact,
  type SessionsObservationSnapshot,
  type SessionsObservedSession,
  type SessionsProjectionChange,
  type SessionsProviderProjection,
  type SessionsTelemetryFacts,
  type SessionsTurnFact,
  type SessionsWorkspaceProjection,
} from '../../shared'
import type { Disposer } from '../project-host'
import type { PtyObservationSource } from '../pty/pty-supervisor'
import type { RendererOwner } from '../renderer-resource-scopes'
import type { TerminalSessionObservationSource } from '../terminal/session-registry'

export interface SessionsObservationProvider {
  readonly id: SessionsProviderProjection['id']
  readonly displayName: string
  readonly telemetrySupported: boolean
}

export interface SessionsObservationPortOptions {
  readonly projectState: () => ProjectState
  readonly hosts: () => readonly ProjectHostOption[]
  readonly providers: () => readonly SessionsObservationProvider[]
  readonly sessions: TerminalSessionObservationSource
  readonly ptys: PtyObservationSource
  readonly observeProjects: (listener: () => void) => Disposer
  readonly emit: (owner: RendererOwner, change: SessionsProjectionChange) => void
}

interface DemandLease {
  readonly owner: RendererOwner
  readonly demandGeneration: number
}

type ObservationBase = Omit<SessionsObservationSnapshot, 'demandGeneration' | 'revision'>

/**
 * Demand-scoped main adapter over existing owners. It owns no session policy or state.
 */
export class SessionsObservationPort {
  private readonly leases = new Map<string, DemandLease>()
  private sourceDisposers: Disposer[] = []
  private current?: ObservationBase
  private fingerprint?: string
  private revision = 0
  private disposed = false

  constructor(private readonly options: SessionsObservationPortOptions) {}

  acquire(owner: RendererOwner, demandGeneration: number): SessionsObservationSnapshot {
    this.assertDemandGeneration(demandGeneration)
    if (this.disposed) throw new Error('Sessions observation is disposed')
    const key = ownerKey(owner)
    if (this.leases.has(key)) {
      throw new Error('Sessions observation demand is already active')
    }
    if (this.leases.size === 0) this.startSources()
    this.leases.set(key, { owner, demandGeneration })
    return this.snapshot(owner, demandGeneration)
  }

  snapshot(owner: RendererOwner, demandGeneration: number): SessionsObservationSnapshot {
    this.assertDemandGeneration(demandGeneration)
    const lease = this.leases.get(ownerKey(owner))
    if (!lease || lease.demandGeneration !== demandGeneration || !this.current) {
      throw new Error('Sessions observation demand is no longer current')
    }
    return {
      ...this.current,
      demandGeneration,
      revision: this.revision,
    }
  }

  release(owner: RendererOwner, demandGeneration: number): boolean {
    const key = ownerKey(owner)
    const lease = this.leases.get(key)
    if (!lease || lease.demandGeneration !== demandGeneration) return false
    this.leases.delete(key)
    if (this.leases.size === 0) this.stopSources()
    return true
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.leases.clear()
    this.stopSources()
  }

  private startSources(): void {
    // Subscribe before taking the initial snapshot so no source transition can fall
    // between observation and capture.
    this.sourceDisposers = [
      this.options.sessions.observe(this.sourceChanged),
      this.options.ptys.observe(this.sourceChanged),
      this.options.observeProjects(this.sourceChanged),
    ]
    this.rebuild(true)
  }

  private stopSources(): void {
    for (const dispose of this.sourceDisposers.splice(0).reverse()) void dispose()
    this.current = undefined
    this.fingerprint = undefined
  }

  private readonly sourceChanged = (): void => {
    if (this.leases.size === 0 || this.disposed) return
    if (!this.rebuild(false)) return
    for (const lease of this.leases.values()) {
      this.options.emit(lease.owner, {
        demandGeneration: lease.demandGeneration,
        revision: this.revision,
      })
    }
  }

  private rebuild(initial: boolean): boolean {
    const next = assembleSessionsObservation({
      projectState: this.options.projectState(),
      hosts: this.options.hosts(),
      providers: this.options.providers(),
      sessions: this.options.sessions.observationSnapshot(),
      ptys: this.options.ptys.observationSnapshot(),
    })
    const fingerprint = JSON.stringify(next)
    if (!initial && fingerprint === this.fingerprint) return false
    this.current = next
    this.fingerprint = fingerprint
    this.revision += 1
    return true
  }

  private assertDemandGeneration(value: number): void {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error('Invalid Sessions demand generation')
    }
  }
}

export function assembleSessionsObservation({
  projectState,
  hosts,
  providers,
  sessions,
  ptys,
}: {
  readonly projectState: ProjectState
  readonly hosts: readonly ProjectHostOption[]
  readonly providers: readonly SessionsObservationProvider[]
  readonly sessions: ReturnType<TerminalSessionObservationSource['observationSnapshot']>
  readonly ptys: ReturnType<PtyObservationSource['observationSnapshot']>
}): ObservationBase {
  const hostById = new Map(
    hosts.slice(0, MAX_SESSIONS_PROJECTION_WORKSPACES).map((host) => [host.hostId, host]),
  )
  const projectedProviders = providers
    .slice(0, MAX_SESSIONS_PROJECTION_PROVIDERS)
    .map((provider) => ({
      id: provider.id,
      displayName: boundedText(provider.displayName, 120, String(provider.id)),
      telemetrySupported: provider.telemetrySupported,
    }))
    .sort((left, right) => String(left.id).localeCompare(String(right.id)))
  const providerById = new Map(
    projectedProviders.map((provider) => [provider.id, provider]),
  )
  const workspaceByRoot = new Map<string, SessionsWorkspaceProjection>()
  const workspaceById = new Map<string, SessionsWorkspaceProjection>()
  const workspaces: SessionsWorkspaceProjection[] = []
  projects: for (const project of projectState.projects) {
    const host = hostById.get(project.registeredRoot.hostId)
    for (const workspace of project.workspaces) {
      if (workspaces.length >= MAX_SESSIONS_PROJECTION_WORKSPACES) break projects
      const projected: SessionsWorkspaceProjection = {
        projectId: boundedText(project.id, 120, 'project'),
        projectName: boundedText(project.displayName, 240, 'Project'),
        workspaceId: boundedText(workspace.id, 120, 'workspace'),
        workspaceName: boundedText(workspace.name, 240, 'Workspace'),
        main: workspace.main,
        closed: workspace.closed,
        missing: workspace.missing,
        host: {
          id: boundedText(workspace.root.hostId, 255, 'host'),
          label: boundedText(host?.label ?? workspace.root.hostId, 240, 'Host'),
          kind: host?.kind ?? (workspace.root.hostId === LOCAL_HOST_ID ? 'local' : 'ssh'),
          connectionState: project.connectionState,
        },
      }
      workspaces.push(projected)
      workspaceByRoot.set(rootKey(workspace.root.hostId, workspace.root.path), projected)
      workspaceById.set(projected.workspaceId, projected)
    }
  }
  workspaces.sort(
    (left, right) =>
      left.projectId.localeCompare(right.projectId) ||
      left.workspaceId.localeCompare(right.workspaceId),
  )

  const boundedPtys = ptys.slice(0, MAX_SESSIONS_PROJECTION_ROWS)
  const ptyById = new Map(boundedPtys.map((pty) => [pty.info.id, pty]))
  const observed = new Map<string, SessionsObservedSession>()
  for (const retained of sessions.slice(0, MAX_SESSIONS_PROJECTION_ROWS)) {
    if (observed.size >= MAX_SESSIONS_PROJECTION_ROWS) break
    const workspace = workspaceByRoot.get(
      rootKey(retained.workspaceRoot.hostId, retained.workspaceRoot.path),
    )
    if (!workspace) continue
    const pty = ptyById.get(retained.id)
    const provider = providerById.get(retained.providerId)
    observed.set(retained.id, {
      handle: asSessionsTerminalHandle(retained.id),
      workspaceId: workspace.workspaceId,
      providerId: retained.providerId,
      profile: { status: 'available', value: { id: retained.profileId } },
      title: boundedText(retained.title, 512, 'Terminal'),
      lifecycle: pty ? 'live' : 'retained',
      livePty: pty
        ? {
            handle: asSessionsPtyHandle(pty.info.instanceId),
            rendererOwnerId: pty.info.ownerId,
            rendererGeneration: pty.info.ownerGeneration,
          }
        : undefined,
      telemetry: telemetryFacts(
        provider?.telemetrySupported === true,
        Boolean(pty),
        pty?.telemetry,
        retained.providerId,
        workspace.host.connectionState,
      ),
    })
  }

  for (const pty of boundedPtys) {
    if (observed.size >= MAX_SESSIONS_PROJECTION_ROWS) break
    if (observed.has(pty.info.id)) continue
    const workspace = workspaceByRoot.get(
      rootKey(pty.info.workspaceRoot.hostId, pty.info.workspaceRoot.path),
    )
    if (!workspace) continue
    const provider = providerById.get(pty.info.providerId)
    observed.set(pty.info.id, {
      handle: asSessionsTerminalHandle(pty.info.id),
      workspaceId: workspace.workspaceId,
      providerId: pty.info.providerId,
      profile: pty.info.profileId
        ? { status: 'available', value: { id: pty.info.profileId } }
        : { status: 'unavailable', reason: 'source-unavailable' },
      title:
        `${provider?.displayName ?? String(pty.info.providerId)} · ${workspace.workspaceName}`.slice(
          0,
          512,
        ),
      lifecycle: 'live',
      livePty: {
        handle: asSessionsPtyHandle(pty.info.instanceId),
        rendererOwnerId: pty.info.ownerId,
        rendererGeneration: pty.info.ownerGeneration,
      },
      telemetry: telemetryFacts(
        provider?.telemetrySupported === true,
        true,
        pty.telemetry,
        pty.info.providerId,
        workspace.host.connectionState,
      ),
    })
  }

  return {
    version: SESSIONS_PROJECTION_VERSION,
    workspaces: [...workspaceById.values()].sort(
      (left, right) =>
        left.projectId.localeCompare(right.projectId) ||
        left.workspaceId.localeCompare(right.workspaceId),
    ),
    providers: projectedProviders,
    sessions: [...observed.values()].sort((left, right) =>
      String(left.handle).localeCompare(String(right.handle)),
    ),
  }
}

function telemetryFacts(
  supported: boolean,
  live: boolean,
  telemetry: HarnessTelemetry | undefined,
  providerId: SessionsProviderProjection['id'],
  connectionState: HostConnectionState,
): SessionsTelemetryFacts {
  if (!supported) return unsupportedTelemetry()
  if (!live) return unavailableTelemetry('not-live')
  if (!telemetry) return pendingTelemetry()
  if (
    telemetry.version !== 1 ||
    telemetry.source.providerId !== providerId ||
    !safeTimestamp(telemetry.observedAt)
  ) {
    return unavailableTelemetry('source-unavailable')
  }
  const observedAt = telemetry.observedAt
  const disconnected = connectionState !== 'connected'
  const stale = disconnected || telemetry.freshness.state === 'stale'
  const reason = disconnected ? 'connection-unavailable' : 'source-stale'
  return {
    model: projectFacet(telemetry.facets.model, observedAt, stale, reason, sanitizeModel),
    context: projectFacet(
      telemetry.facets.context,
      observedAt,
      stale,
      reason,
      sanitizeContext,
    ),
    turn: projectFacet(telemetry.facets.turn, observedAt, stale, reason, sanitizeTurn),
    freshness:
      safeNonNegativeInteger(telemetry.freshness.staleAfterMs) !== undefined
        ? stale
          ? {
              status: 'stale',
              value: { staleAfterMs: telemetry.freshness.staleAfterMs },
              observedAt,
              reason,
            }
          : {
              status: 'available',
              value: { staleAfterMs: telemetry.freshness.staleAfterMs },
              observedAt,
            }
        : { status: 'unavailable', reason: 'source-unavailable' },
  }
}

function projectFacet<TSource, TProjected>(
  facet: HarnessFacet<TSource>,
  snapshotObservedAt: number,
  forceStale: boolean,
  staleReason: 'connection-unavailable' | 'source-stale',
  project: (value: TSource) => TProjected | undefined,
): SessionsFact<TProjected> {
  if (facet.status === 'unsupported') return { status: 'unsupported' }
  if (facet.status === 'pending') {
    return { status: 'pending', reason: 'telemetry-pending' }
  }
  if (facet.status === 'unavailable') {
    return { status: 'unavailable', reason: 'source-unavailable' }
  }
  const value = project(facet.value)
  if (!value) return { status: 'unavailable', reason: 'source-unavailable' }
  const observedAt =
    facet.status === 'stale' && safeTimestamp(facet.observedAt)
      ? facet.observedAt
      : snapshotObservedAt
  if (forceStale || facet.status === 'stale') {
    return {
      status: 'stale',
      value,
      observedAt,
      reason: forceStale ? staleReason : 'source-stale',
    }
  }
  return { status: 'available', value, observedAt }
}

function sanitizeModel(value: HarnessModelFacet): SessionsModelFact | undefined {
  const id = boundedOptionalText(value.id, 256)
  if (!id) return undefined
  const displayName = boundedOptionalText(value.displayName, 256)
  return displayName ? { id, displayName } : { id }
}

function sanitizeContext(value: HarnessContextFacet): SessionsContextFact | undefined {
  const usedTokens = safeNonNegativeInteger(value.usedTokens)
  const windowTokens = safeNonNegativeInteger(value.windowTokens)
  const usedPercent = safePercent(value.usedPercent)
  if (usedTokens === undefined) return undefined
  return {
    usedTokens,
    ...(windowTokens === undefined ? {} : { windowTokens }),
    ...(usedPercent === undefined ? {} : { usedPercent }),
  }
}

function sanitizeTurn(value: HarnessTurnFacet): SessionsTurnFact | undefined {
  switch (value.state) {
    case 'working':
    case 'waiting-for-user':
    case 'waiting-for-approval':
    case 'idle':
      return { state: value.state }
  }
}

function unsupportedTelemetry(): SessionsTelemetryFacts {
  return {
    model: { status: 'unsupported' },
    context: { status: 'unsupported' },
    turn: { status: 'unsupported' },
    freshness: { status: 'unsupported' },
  }
}

function pendingTelemetry(): SessionsTelemetryFacts {
  return {
    model: { status: 'pending', reason: 'telemetry-pending' },
    context: { status: 'pending', reason: 'telemetry-pending' },
    turn: { status: 'pending', reason: 'telemetry-pending' },
    freshness: { status: 'pending', reason: 'telemetry-pending' },
  }
}

function unavailableTelemetry(
  reason: 'not-live' | 'source-unavailable',
): SessionsTelemetryFacts {
  return {
    model: { status: 'unavailable', reason },
    context: { status: 'unavailable', reason },
    turn: { status: 'unavailable', reason },
    freshness: { status: 'unavailable', reason },
  }
}

function boundedText(value: string, max: number, fallback: string): string {
  return boundedOptionalText(value, max) ?? fallback
}

function boundedOptionalText(value: string | undefined, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const clean = [...value]
    .map((character) => (controlCharacter(character) ? ' ' : character))
    .join('')
    .trim()
    .slice(0, max)
  return clean || undefined
}

function controlCharacter(character: string): boolean {
  const code = character.charCodeAt(0)
  return code <= 31 || code === 127
}

function safeNonNegativeInteger(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined
}

function safePercent(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : undefined
}

function safeTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

function rootKey(hostId: string, path: string): string {
  return `${hostId}\u0000${path}`
}

function ownerKey(owner: RendererOwner): string {
  return `${owner.id}:${owner.generation}`
}
