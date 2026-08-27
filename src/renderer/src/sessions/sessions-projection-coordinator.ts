import {
  MAX_SESSIONS_PROJECTION_ROWS,
  SESSIONS_PROJECTION_VERSION,
  sessionsProjectionTitle,
  type HvirApi,
  type SessionsFact,
  type SessionsObservationSnapshot,
  type SessionsObservedSession,
  type SessionsProjectionChange,
  type SessionsProjectionRow,
  type SessionsProjectionSnapshot,
  type SessionsProviderProjection,
  type SessionsTelemetryFacts,
  type SessionsWorkspaceProjection,
} from '../../../shared'
import type {
  SessionsRendererObservationPort,
  SessionsRendererSession,
} from './sessions-renderer-observation'

export interface SessionsMainObservationPort {
  observe(demandGeneration: number): Promise<SessionsObservationSnapshot>
  snapshot(demandGeneration: number): Promise<SessionsObservationSnapshot>
  release(demandGeneration: number): Promise<void>
  subscribe(listener: (change: SessionsProjectionChange) => void): () => void
}

const INACTIVE_SNAPSHOT: SessionsProjectionSnapshot = {
  version: SESSIONS_PROJECTION_VERSION,
  demandGeneration: 0,
  revision: 0,
  sourceRevision: 0,
  status: 'inactive',
  rows: [],
}

/** Renderer-owned, immutable derived projection with one explicit demand lifetime. */
export class SessionsProjectionCoordinator {
  private readonly listeners = new Set<() => void>()
  private current = INACTIVE_SNAPSHOT
  private mainSnapshot?: SessionsObservationSnapshot
  private mainUnsubscribe?: () => void
  private rendererUnsubscribe?: () => void
  private consumers = 0
  private demandGeneration = 0
  private projectionRevision = 0
  private pendingMainRevision = 0
  private refreshInFlight = false
  private initialObserveInFlight = false
  private rowsFingerprint = '[]'
  private disposed = false

  constructor(
    private readonly main: SessionsMainObservationPort,
    private readonly renderer: SessionsRendererObservationPort,
  ) {}

  snapshot = (): SessionsProjectionSnapshot => this.current

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  acquire(): () => void {
    if (this.disposed) throw new Error('Sessions projection is disposed')
    this.consumers += 1
    if (this.consumers === 1) this.start()
    let released = false
    return () => {
      if (released) return
      released = true
      this.consumers -= 1
      if (this.consumers === 0) this.stop()
    }
  }

  retry(): boolean {
    if (
      this.current.status !== 'unavailable' ||
      !this.isCurrent(this.demandGeneration) ||
      this.initialObserveInFlight
    ) {
      return false
    }
    this.publishPending(this.demandGeneration)
    this.requestInitialObservation(this.demandGeneration)
    return true
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.consumers = 0
    this.stop()
    this.listeners.clear()
  }

  private start(): void {
    const demandGeneration = ++this.demandGeneration
    this.pendingMainRevision = 0
    this.publishPending(demandGeneration)
    this.mainUnsubscribe = this.main.subscribe((change) => {
      if (
        this.disposed ||
        this.consumers === 0 ||
        change.demandGeneration !== demandGeneration ||
        change.revision <= (this.mainSnapshot?.revision ?? 0)
      ) {
        return
      }
      this.pendingMainRevision = Math.max(this.pendingMainRevision, change.revision)
      void this.refreshMain(demandGeneration)
    })
    this.rendererUnsubscribe = this.renderer.subscribe(() => {
      if (this.isCurrent(demandGeneration) && this.mainSnapshot) this.publishJoined()
    })
    this.requestInitialObservation(demandGeneration)
  }

  private requestInitialObservation(demandGeneration: number): void {
    if (this.initialObserveInFlight || !this.isCurrent(demandGeneration)) return
    this.initialObserveInFlight = true
    void this.main.observe(demandGeneration).then(
      (snapshot) => {
        if (this.isCurrent(demandGeneration)) this.initialObserveInFlight = false
        if (!this.acceptMainSnapshot(demandGeneration, snapshot)) {
          if (this.isCurrent(demandGeneration)) this.publishUnavailable(demandGeneration)
          return
        }
        this.publishJoined()
        if (this.pendingMainRevision > snapshot.revision) {
          void this.refreshMain(demandGeneration)
        }
      },
      () => {
        if (this.isCurrent(demandGeneration)) this.initialObserveInFlight = false
        if (this.isCurrent(demandGeneration)) this.publishUnavailable(demandGeneration)
      },
    )
  }

  private stop(): void {
    const releasedGeneration = this.demandGeneration
    this.demandGeneration += 1
    this.mainUnsubscribe?.()
    this.rendererUnsubscribe?.()
    this.mainUnsubscribe = undefined
    this.rendererUnsubscribe = undefined
    this.mainSnapshot = undefined
    this.pendingMainRevision = 0
    this.refreshInFlight = false
    this.initialObserveInFlight = false
    this.rowsFingerprint = '[]'
    this.current = INACTIVE_SNAPSHOT
    if (releasedGeneration > 0)
      void this.main.release(releasedGeneration).catch(() => undefined)
    this.publish()
  }

  private async refreshMain(demandGeneration: number): Promise<void> {
    if (this.refreshInFlight || !this.isCurrent(demandGeneration)) return
    this.refreshInFlight = true
    try {
      const snapshot = await this.main.snapshot(demandGeneration)
      if (!this.acceptMainSnapshot(demandGeneration, snapshot)) return
      this.publishJoined()
    } catch {
      // A revoked demand or renderer rollover fails closed. A later current
      // notification requests another full snapshot.
    } finally {
      if (this.isCurrent(demandGeneration)) {
        this.refreshInFlight = false
        if (this.pendingMainRevision > (this.mainSnapshot?.revision ?? 0)) {
          void this.refreshMain(demandGeneration)
        }
      }
    }
  }

  private acceptMainSnapshot(
    demandGeneration: number,
    snapshot: SessionsObservationSnapshot,
  ): boolean {
    if (
      !this.isCurrent(demandGeneration) ||
      snapshot.version !== SESSIONS_PROJECTION_VERSION ||
      snapshot.demandGeneration !== demandGeneration ||
      snapshot.revision < (this.mainSnapshot?.revision ?? 0)
    ) {
      return false
    }
    this.mainSnapshot = snapshot
    if (this.pendingMainRevision <= snapshot.revision) this.pendingMainRevision = 0
    return true
  }

  private publishJoined(): void {
    if (!this.mainSnapshot) return
    const rows = joinSessionsProjection(this.mainSnapshot, this.renderer.snapshot())
    const fingerprint = JSON.stringify(rows)
    if (fingerprint === this.rowsFingerprint && this.current.status === 'available') {
      return
    }
    this.rowsFingerprint = fingerprint
    this.projectionRevision += 1
    this.current = {
      version: SESSIONS_PROJECTION_VERSION,
      demandGeneration: this.mainSnapshot.demandGeneration,
      revision: this.projectionRevision,
      sourceRevision: this.mainSnapshot.revision,
      status: 'available',
      rows,
    }
    this.publish()
  }

  private publishPending(demandGeneration: number): void {
    if (!this.isCurrent(demandGeneration)) return
    this.projectionRevision += 1
    this.current = {
      version: SESSIONS_PROJECTION_VERSION,
      demandGeneration,
      revision: this.projectionRevision,
      sourceRevision: 0,
      status: 'pending',
      rows: [],
    }
    this.publish()
  }

  private publishUnavailable(demandGeneration: number): void {
    if (!this.isCurrent(demandGeneration)) return
    this.projectionRevision += 1
    this.current = {
      version: SESSIONS_PROJECTION_VERSION,
      demandGeneration,
      revision: this.projectionRevision,
      sourceRevision: 0,
      status: 'unavailable',
      unavailableReason: 'source-unavailable',
      rows: [],
    }
    this.publish()
  }

  private publish(): void {
    for (const listener of this.listeners) listener()
  }

  private isCurrent(demandGeneration: number): boolean {
    return (
      !this.disposed && this.consumers > 0 && demandGeneration === this.demandGeneration
    )
  }
}

export function createSessionsMainObservationPort(
  api: Pick<HvirApi, 'invoke' | 'on'>,
): SessionsMainObservationPort {
  return {
    observe: (demandGeneration) => api.invoke('sessions:observe', { demandGeneration }),
    snapshot: (demandGeneration) => api.invoke('sessions:snapshot', { demandGeneration }),
    release: (demandGeneration) => api.invoke('sessions:release', { demandGeneration }),
    subscribe: (listener) => api.on('sessions:changed', listener),
  }
}

export function joinSessionsProjection(
  main: SessionsObservationSnapshot,
  rendererSessions: readonly SessionsRendererSession[],
): readonly SessionsProjectionRow[] {
  const workspaceById = new Map(
    main.workspaces.map((workspace) => [workspace.workspaceId, workspace]),
  )
  const providerById = new Map(main.providers.map((provider) => [provider.id, provider]))
  const rendererByHandle = new Map<string, SessionsRendererSession[]>()
  for (const session of rendererSessions.slice(0, MAX_SESSIONS_PROJECTION_ROWS)) {
    const rows = rendererByHandle.get(session.handle) ?? []
    rows.push(session)
    rendererByHandle.set(session.handle, rows)
  }
  for (const rows of rendererByHandle.values()) {
    rows.sort((left, right) =>
      left.workspaceQualifier.localeCompare(right.workspaceQualifier),
    )
  }

  const rows = new Map<string, SessionsProjectionRow>()
  for (const session of main.sessions.slice(0, MAX_SESSIONS_PROJECTION_ROWS)) {
    const workspace = workspaceById.get(session.workspaceId)
    if (!workspace) continue
    const renderer = selectRendererFact(rendererByHandle.get(session.handle), workspace)
    rows.set(
      session.handle,
      projectRow(
        workspace,
        providerById.get(renderer?.providerId ?? session.providerId),
        session,
        renderer,
      ),
    )
  }

  for (const [handle, candidates] of rendererByHandle) {
    if (rows.size >= MAX_SESSIONS_PROJECTION_ROWS) break
    if (rows.has(handle)) continue
    const renderer = candidates[0]
    if (!renderer) continue
    const workspace = main.workspaces.find(
      (candidate) => candidate.qualifier === renderer.workspaceQualifier,
    )
    if (!workspace) continue
    rows.set(
      handle,
      projectRow(workspace, providerById.get(renderer.providerId), undefined, renderer),
    )
  }

  return [...rows.values()].sort((left, right) =>
    String(left.handle).localeCompare(String(right.handle)),
  )
}

function selectRendererFact(
  candidates: readonly SessionsRendererSession[] | undefined,
  workspace: SessionsWorkspaceProjection,
): SessionsRendererSession | undefined {
  return candidates?.find(
    (candidate) => candidate.workspaceQualifier === workspace.qualifier,
  )
}

function projectRow(
  workspace: SessionsWorkspaceProjection,
  provider: SessionsProviderProjection | undefined,
  main: SessionsObservedSession | undefined,
  renderer: SessionsRendererSession | undefined,
): SessionsProjectionRow {
  const lifecycle = lifecycleProjection(workspace, main, renderer)
  const attention = attentionProjection(renderer)
  const telemetry =
    main?.telemetry ?? rendererOnlyTelemetry(provider?.telemetrySupported === true)
  return {
    handle: main?.handle ?? renderer!.handle,
    project: { id: workspace.projectId, name: workspace.projectName },
    workspace: {
      id: workspace.workspaceId,
      name: workspace.workspaceName,
      main: workspace.main,
      qualifier: workspace.qualifier,
    },
    host: workspace.host,
    provider: {
      id: renderer?.providerId ?? main!.providerId,
      name: provider?.displayName ?? String(renderer?.providerId ?? main!.providerId),
      kind: provider?.sessionKind ?? 'unknown',
    },
    profile: renderer
      ? { status: 'available', value: { id: renderer.profileId } }
      : main!.profile,
    title: sessionsProjectionTitle(renderer?.title ?? main?.title),
    ...lifecycle,
    connectionState: workspace.host.connectionState,
    attention: attention.attention,
    working: attention.working,
    model: telemetry.model,
    context: telemetry.context,
    turn: telemetry.turn,
    telemetryFreshness: telemetry.freshness,
    usage:
      provider?.usageSupported !== true
        ? { status: 'unsupported' }
        : workspace.host.connectionState !== 'connected'
          ? { status: 'unavailable', reason: 'connection-unavailable' }
          : main?.livePty
            ? { status: 'pending', reason: 'identity-pending' }
            : { status: 'unavailable', reason: 'not-live' },
    livePty: main?.livePty,
  }
}

function lifecycleProjection(
  workspace: SessionsWorkspaceProjection,
  main: SessionsObservedSession | undefined,
  renderer: SessionsRendererSession | undefined,
): Pick<SessionsProjectionRow, 'lifecycle' | 'lifecycleReason'> {
  if (main?.lifecycle === 'live') return { lifecycle: 'live' }
  if (renderer?.exited) {
    return {
      lifecycle: 'stopped',
      lifecycleReason: renderer.recoveryUnavailable ? 'recovery-unavailable' : 'stopped',
    }
  }
  if (workspace.closed || workspace.missing) {
    return { lifecycle: 'unavailable', lifecycleReason: 'workspace-unavailable' }
  }
  if (!renderer || renderer.dormant) return { lifecycle: 'retained' }
  if (workspace.host.connectionState !== 'connected') {
    return { lifecycle: 'stopped', lifecycleReason: 'transport-unavailable' }
  }
  return { lifecycle: renderer.resumeOnStart ? 'resuming' : 'starting' }
}

function attentionProjection(renderer: SessionsRendererSession | undefined): {
  readonly attention: SessionsProjectionRow['attention']
  readonly working: SessionsProjectionRow['working']
} {
  if (!renderer) {
    return {
      attention: { status: 'unavailable', reason: 'not-materialized' },
      working: { status: 'unavailable', reason: 'not-materialized' },
    }
  }
  return {
    attention: {
      status: 'available',
      value:
        renderer.attention === 'idle'
          ? 'ready'
          : renderer.attention === 'bell'
            ? 'bell'
            : 'none',
    },
    working: { status: 'available', value: renderer.attention === 'working' },
  }
}

function rendererOnlyTelemetry(supported: boolean): SessionsTelemetryFacts {
  const fact: SessionsFact<never> = supported
    ? { status: 'pending', reason: 'telemetry-pending' }
    : { status: 'unsupported' }
  return {
    model: fact,
    context: fact,
    turn: fact,
    freshness: fact,
  }
}
