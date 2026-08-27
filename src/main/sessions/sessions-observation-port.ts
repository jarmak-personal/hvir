import {
  LOCAL_HOST_ID,
  MAX_SESSIONS_PROJECTION_PROVIDERS,
  MAX_SESSIONS_PROJECTION_ROWS,
  MAX_SESSIONS_PROJECTION_WORKSPACES,
  SESSIONS_PROJECTION_VERSION,
  asSessionsPtyHandle,
  asSessionsTerminalHandle,
  sessionsProjectionDisplayTitle,
  sessionsProjectionText,
  sessionsWorkspaceQualifier,
  type ProjectHostOption,
  type ProjectState,
  type SessionsObservationSnapshot,
  type SessionsOpenRequest,
  type SessionsObservedSession,
  type SessionsProjectionChange,
  type SessionsProviderProjection,
  type SessionsTerminalHandle,
  type SessionsUsageDemandRequest,
  type SessionsUsageDemandTarget,
  type SessionsWorkspaceProjection,
} from '../../shared'
import type { Disposer } from '../project-host'
import type { PtyObservationSource } from '../pty/pty-supervisor'
import type { RendererOwner } from '../renderer-resource-scopes'
import type { TerminalSessionObservationSource } from '../terminal/session-registry'
import {
  createSessionsProjectionIdentityScope,
  sessionsProjectionRootKey,
  type SessionsProjectionIdentityScope,
} from './sessions-projection-identities'
import {
  resolveSessionsOpen,
  type SessionsResolvedOpen,
} from './sessions-open-resolution'
import { sessionsTelemetryFacts } from './sessions-telemetry-projection'

export interface SessionsObservationProvider {
  readonly id: SessionsProviderProjection['id']
  readonly displayName: string
  readonly telemetrySupported: boolean
  readonly usageSupported?: boolean
  readonly sessionKind: 'agent' | 'shell'
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

export interface SessionsResolvedUsageTarget extends SessionsUsageDemandTarget {
  readonly providerId: SessionsProviderProjection['id']
  readonly usageSupported: boolean
  readonly connectionState: SessionsWorkspaceProjection['host']['connectionState']
}

export type { SessionsResolvedOpen } from './sessions-open-resolution'

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
  private identities?: SessionsProjectionIdentityScope
  private readonly sourceListeners = new Set<() => void>()
  private disposed = false

  constructor(private readonly options: SessionsObservationPortOptions) {}

  acquire(owner: RendererOwner, demandGeneration: number): SessionsObservationSnapshot {
    this.assertDemandGeneration(demandGeneration)
    if (this.disposed) throw new Error('Sessions observation is disposed')
    const key = ownerKey(owner)
    const current = this.leases.get(key)
    if (current?.demandGeneration === demandGeneration) {
      return this.snapshot(owner, demandGeneration)
    }
    if (current) {
      throw new Error('Sessions observation demand is already active')
    }
    if (this.leases.size === 0) {
      try {
        this.startSources()
      } catch (error) {
        this.stopSources()
        throw error
      }
    }
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

  resolveOpen(owner: RendererOwner, request: SessionsOpenRequest): SessionsResolvedOpen {
    const lease = this.leases.get(ownerKey(owner))
    return resolveSessionsOpen({
      owner,
      request,
      activeDemandGeneration: lease?.demandGeneration,
      sourceRevision: this.revision,
      observation: this.current,
      identities: this.identities,
      projectState: this.options.projectState(),
    })
  }

  resolveUsageTargets(
    owner: RendererOwner,
    request: SessionsUsageDemandRequest,
  ): readonly SessionsResolvedUsageTarget[] {
    if (
      request.sourceRevision !== this.revision ||
      request.targets.length > MAX_SESSIONS_PROJECTION_ROWS
    ) {
      throw new Error('Sessions usage projection is no longer current')
    }
    return this.currentUsageTargets(
      owner,
      request.projectionDemandGeneration,
      request.targets,
    )
  }

  currentUsageTargets(
    owner: RendererOwner,
    projectionDemandGeneration: number,
    targets: readonly SessionsUsageDemandTarget[],
  ): readonly SessionsResolvedUsageTarget[] {
    const lease = this.leases.get(ownerKey(owner))
    if (
      !lease ||
      lease.demandGeneration !== projectionDemandGeneration ||
      !this.current ||
      targets.length > MAX_SESSIONS_PROJECTION_ROWS
    ) {
      throw new Error('Sessions usage projection is no longer current')
    }
    const requested = new Set<SessionsTerminalHandle>()
    const sessions = new Map(
      this.current.sessions.map((session) => [session.handle, session]),
    )
    const workspaces = new Map(
      this.current.workspaces.map((workspace) => [workspace.workspaceId, workspace]),
    )
    const providers = new Map(
      this.current.providers.map((provider) => [provider.id, provider]),
    )
    return targets.map((target) => {
      if (requested.has(target.handle)) throw new Error('Duplicate Sessions usage target')
      requested.add(target.handle)
      const session = sessions.get(target.handle)
      if (!session) throw new Error('Sessions usage target is unavailable')
      if (!sameLivePty(target.livePty, session.livePty)) {
        throw new Error('Sessions usage PTY qualifier is no longer current')
      }
      const workspace = workspaces.get(session.workspaceId)
      if (!workspace) throw new Error('Sessions usage workspace is unavailable')
      return {
        ...target,
        providerId: session.providerId,
        usageSupported: providers.get(session.providerId)?.usageSupported === true,
        connectionState: workspace.host.connectionState,
      }
    })
  }

  observeSourceChanges(listener: () => void): Disposer {
    this.sourceListeners.add(listener)
    return () => {
      this.sourceListeners.delete(listener)
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.leases.clear()
    this.stopSources()
    this.sourceListeners.clear()
  }

  private startSources(): void {
    // Subscribe before taking the initial snapshot so no source transition can fall
    // between observation and capture.
    this.identities = createSessionsProjectionIdentityScope()
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
    this.identities?.clear()
    this.identities = undefined
  }

  private readonly sourceChanged = (): void => {
    if (this.leases.size === 0 || this.disposed) return
    const projectionChanged = this.rebuild(false)
    for (const listener of this.sourceListeners) listener()
    if (!projectionChanged) return
    for (const lease of this.leases.values()) {
      this.options.emit(lease.owner, {
        demandGeneration: lease.demandGeneration,
        revision: this.revision,
      })
    }
  }

  private rebuild(initial: boolean): boolean {
    if (!this.identities) throw new Error('Sessions projection identities are inactive')
    const next = assembleSessionsObservation({
      projectState: this.options.projectState(),
      hosts: this.options.hosts(),
      providers: this.options.providers(),
      sessions: this.options.sessions.observationSnapshot(),
      ptys: this.options.ptys.observationSnapshot(),
      identities: this.identities,
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
  identities = createSessionsProjectionIdentityScope(),
}: {
  readonly projectState: ProjectState
  readonly hosts: readonly ProjectHostOption[]
  readonly providers: readonly SessionsObservationProvider[]
  readonly sessions: ReturnType<TerminalSessionObservationSource['observationSnapshot']>
  readonly ptys: ReturnType<PtyObservationSource['observationSnapshot']>
  readonly identities?: SessionsProjectionIdentityScope
}): ObservationBase {
  const hostById = new Map(
    hosts.slice(0, MAX_SESSIONS_PROJECTION_WORKSPACES).map((host) => [host.hostId, host]),
  )
  const projectedProviders = providers
    .slice(0, MAX_SESSIONS_PROJECTION_PROVIDERS)
    .map((provider) => ({
      id: provider.id,
      displayName: sessionsProjectionText(provider.displayName, 120, String(provider.id)),
      telemetrySupported: provider.telemetrySupported,
      usageSupported: provider.usageSupported === true,
      sessionKind: provider.sessionKind,
    }))
    .sort((left, right) => String(left.id).localeCompare(String(right.id)))
  const providerById = new Map(
    projectedProviders.map((provider) => [provider.id, provider]),
  )
  const workspaceByRoot = new Map<string, SessionsWorkspaceProjection>()
  const workspaces: SessionsWorkspaceProjection[] = []
  projects: for (const [projectIndex, project] of projectState.projects.entries()) {
    const host = hostById.get(project.registeredRoot.hostId)
    const projectHandle = identities.project(project.registeredRoot)
    for (const [workspaceIndex, workspace] of project.workspaces.entries()) {
      if (workspaces.length >= MAX_SESSIONS_PROJECTION_WORKSPACES) break projects
      const key = sessionsProjectionRootKey(workspace.root.hostId, workspace.root.path)
      if (workspaceByRoot.has(key)) continue
      const projected: SessionsWorkspaceProjection = {
        projectId: projectHandle,
        projectName: sessionsProjectionText(project.displayName, 240, 'Project'),
        workspaceId: identities.workspace(workspace.root),
        qualifier: sessionsWorkspaceQualifier(
          projectState.revision,
          projectIndex,
          workspaceIndex,
        ),
        workspaceName: sessionsProjectionText(workspace.name, 240, 'Workspace'),
        main: workspace.main,
        closed: workspace.closed,
        missing: workspace.missing,
        host: {
          id: sessionsProjectionText(workspace.root.hostId, 255, 'host'),
          label: sessionsProjectionText(
            host?.label ?? workspace.root.hostId,
            240,
            'Host',
          ),
          kind: host?.kind ?? (workspace.root.hostId === LOCAL_HOST_ID ? 'local' : 'ssh'),
          connectionState: project.connectionState,
        },
      }
      workspaces.push(projected)
      workspaceByRoot.set(key, projected)
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
      sessionsProjectionRootKey(
        retained.workspaceRoot.hostId,
        retained.workspaceRoot.path,
      ),
    )
    if (!workspace) continue
    const pty = ptyById.get(retained.id)
    const provider = providerById.get(retained.providerId)
    const handle = asSessionsTerminalHandle(retained.id)
    observed.set(retained.id, {
      handle,
      workspaceId: workspace.workspaceId,
      providerId: retained.providerId,
      profile: { status: 'available', value: { id: retained.profileId } },
      title: sessionsProjectionDisplayTitle(
        retained.title,
        handle,
        `${provider?.displayName ?? String(retained.providerId)} · ${workspace.workspaceName}`,
        [retained.workspaceRoot.path, retained.cwd.path],
      ),
      lifecycle: pty ? 'live' : 'retained',
      livePty: pty
        ? {
            handle: asSessionsPtyHandle(pty.info.instanceId),
            rendererOwnerId: pty.info.ownerId,
            rendererGeneration: pty.info.ownerGeneration,
          }
        : undefined,
      telemetry: sessionsTelemetryFacts(
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
      sessionsProjectionRootKey(
        pty.info.workspaceRoot.hostId,
        pty.info.workspaceRoot.path,
      ),
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
      title: sessionsProjectionDisplayTitle(
        `${provider?.displayName ?? String(pty.info.providerId)} · ${workspace.workspaceName}`,
        asSessionsTerminalHandle(pty.info.id),
        'Terminal',
        [pty.info.workspaceRoot.path, pty.info.cwd.path],
      ),
      lifecycle: 'live',
      livePty: {
        handle: asSessionsPtyHandle(pty.info.instanceId),
        rendererOwnerId: pty.info.ownerId,
        rendererGeneration: pty.info.ownerGeneration,
      },
      telemetry: sessionsTelemetryFacts(
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
    workspaces,
    providers: projectedProviders,
    sessions: [...observed.values()].sort((left, right) =>
      String(left.handle).localeCompare(String(right.handle)),
    ),
  }
}

function ownerKey(owner: RendererOwner): string {
  return `${owner.id}:${owner.generation}`
}

function sameLivePty(
  left: SessionsUsageDemandTarget['livePty'],
  right: SessionsUsageDemandTarget['livePty'],
): boolean {
  if (!left || !right) return left === right
  return (
    left.handle === right.handle &&
    left.rendererOwnerId === right.rendererOwnerId &&
    left.rendererGeneration === right.rendererGeneration
  )
}
