import type {
  HvirApi,
  SessionsLivePtyQualifier,
  SessionsOpenRequest,
  SessionsOpenUnavailableReason,
  SessionsProjectionRow,
  SessionsProjectionSnapshot,
  SessionsTerminalHandle,
  SessionsTerminalResolutionResponse,
  SessionsWorkspaceRuntimeId,
} from '../../../shared'
import {
  sessionsTerminalSurfaceEligible,
  sessionsTerminalSurfaceRevocationMessage,
  sessionsTerminalSurfaceUnavailableMessage,
  type SessionsTerminalSurfaceLease,
  type SessionsTerminalSurfacePort,
  type SessionsTerminalSurfaceRevocationReason,
} from './sessions-terminal-surface'

export interface SessionsTerminalDetailContext {
  readonly title: string
  readonly projectName: string
  readonly workspaceName: string
  readonly hostLabel: string
  readonly providerName: string
}

export type SessionsTerminalDetailState =
  | { readonly status: 'inactive' }
  | {
      readonly status: 'resolving' | 'ready' | 'paused' | 'unavailable'
      readonly context: SessionsTerminalDetailContext
      readonly message?: string
    }

export interface SessionsTerminalResolutionPort {
  resolve(request: SessionsOpenRequest): Promise<SessionsTerminalResolutionResponse>
}

interface DetailAuthority {
  readonly demandGeneration: number
  readonly projectionRevision: number
  readonly sourceRevision: number
  readonly row: SessionsProjectionRow
}

const INACTIVE: SessionsTerminalDetailState = { status: 'inactive' }

/** Owns one exact, revocable Sessions detail surface and its focus lifetime. */
export class SessionsTerminalDetailController {
  private readonly listeners = new Set<() => void>()
  private current: SessionsTerminalDetailState = INACTIVE
  private selected?: SessionsTerminalHandle
  private authority?: DetailAuthority
  private pendingAuthority?: DetailAuthority
  private latest?: SessionsProjectionSnapshot
  private foreground = false
  private lease?: SessionsTerminalSurfaceLease
  private leaseWorkspaceRuntimeId?: SessionsWorkspaceRuntimeId
  private leaseUnsubscribe?: () => void
  private container?: HTMLElement
  private requestGeneration = 0
  private focusFrame?: number
  private disposed = false

  constructor(
    private readonly resolution: SessionsTerminalResolutionPort,
    private readonly surfaces: SessionsTerminalSurfacePort,
    private readonly frames: Pick<
      typeof window,
      'requestAnimationFrame' | 'cancelAnimationFrame'
    >,
  ) {}

  snapshot = (): SessionsTerminalDetailState => this.current

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  selectedHandle(): SessionsTerminalHandle | undefined {
    return this.selected
  }

  open(
    row: SessionsProjectionRow,
    snapshot: SessionsProjectionSnapshot,
    foreground: boolean,
  ): void {
    if (this.disposed) return
    this.cancelPending()
    this.releaseLease()
    this.selected = row.handle
    this.latest = snapshot
    this.foreground = foreground
    this.drive(row)
  }

  synchronize(snapshot: SessionsProjectionSnapshot, foreground: boolean): void {
    if (this.disposed) return
    this.latest = snapshot
    this.foreground = foreground
    if (!this.selected) return
    const row = snapshot.rows.find((candidate) => candidate.handle === this.selected)
    this.drive(row)
  }

  setContainer(container: HTMLElement | undefined): void {
    if (this.container === container) return
    const previous = this.container
    this.container = container
    this.cancelFocus()
    if (previous) this.lease?.detach(previous)
    const lease = this.lease
    const authority = this.authority
    if (container && lease && authority) this.attachLease(container, lease, authority)
  }

  close(): void {
    if (!this.selected && this.current.status === 'inactive') return
    this.cancelPending()
    this.releaseLease()
    this.selected = undefined
    this.authority = undefined
    this.pendingAuthority = undefined
    this.publish(INACTIVE)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.close()
    this.listeners.clear()
    this.container = undefined
  }

  private drive(row: SessionsProjectionRow | undefined): void {
    const snapshot = this.latest
    if (!this.foreground) {
      this.cancelPending()
      this.releaseLease()
      this.authority = undefined
      this.publishContext(
        'paused',
        row,
        'Terminal detail is paused while hvir is not in the foreground.',
      )
      return
    }
    if (!snapshot || snapshot.status !== 'available') {
      this.cancelPending()
      this.releaseLease()
      this.authority = undefined
      this.publishContext(
        'paused',
        row,
        'Terminal detail is waiting for a current Sessions snapshot.',
      )
      return
    }
    if (!row || !sessionsTerminalSurfaceEligible(row)) {
      this.cancelPending()
      this.releaseLease()
      this.authority = undefined
      this.publishContext(
        'unavailable',
        row,
        'This session no longer has an exact live terminal available.',
      )
      return
    }
    const next: DetailAuthority = {
      demandGeneration: snapshot.demandGeneration,
      projectionRevision: snapshot.revision,
      sourceRevision: snapshot.sourceRevision,
      row,
    }
    if (this.lease && this.authority && sameResolvedTarget(this.authority, next)) {
      if (
        !this.leaseWorkspaceRuntimeId ||
        !this.lease.renew(surfaceRequest(next, this.leaseWorkspaceRuntimeId))
      ) {
        this.beginResolution(next)
        return
      }
      this.authority = next
      if (this.current.status === 'ready') {
        this.publish({ status: 'ready', context: detailContext(row) })
      }
      return
    }
    if (this.pendingAuthority && sameAuthority(this.pendingAuthority, next)) return
    this.beginResolution(next)
  }

  private beginResolution(authority: DetailAuthority): void {
    this.cancelPending()
    this.releaseLease()
    this.authority = undefined
    this.pendingAuthority = authority
    const generation = this.requestGeneration
    this.publish({ status: 'resolving', context: detailContext(authority.row) })
    const request = resolutionRequest(authority)
    void this.resolution.resolve(request).then(
      (response) => this.acceptResolution(generation, authority, response),
      () => this.acceptUnavailable(generation, authority, 'session-unavailable'),
    )
  }

  private acceptResolution(
    generation: number,
    authority: DetailAuthority,
    response: SessionsTerminalResolutionResponse,
  ): void {
    if (!this.isPending(generation, authority)) return
    this.pendingAuthority = undefined
    if (response.outcome === 'unavailable') {
      this.acceptUnavailable(generation, authority, response.reason)
      return
    }
    if (
      response.handle !== authority.row.handle ||
      response.workspaceQualifier !== authority.row.workspace.qualifier ||
      !sameLivePty(response.livePty, authority.row.livePty)
    ) {
      this.publish({
        status: 'unavailable',
        context: detailContext(authority.row),
        message: detailUnavailableMessage('stale-projection'),
      })
      return
    }
    const acquisition = this.surfaces.acquire(
      surfaceRequest(authority, response.workspaceRuntimeId),
    )
    if (acquisition.outcome === 'unavailable') {
      this.publish({
        status: 'unavailable',
        context: detailContext(authority.row),
        message: sessionsTerminalSurfaceUnavailableMessage(acquisition.reason),
      })
      return
    }
    const lease = acquisition.lease
    this.lease = lease
    this.leaseWorkspaceRuntimeId = response.workspaceRuntimeId
    this.authority = authority
    this.leaseUnsubscribe = lease.subscribe((reason) =>
      this.surfaceRevoked(lease, reason),
    )
    if (this.container) this.attachLease(this.container, lease, authority)
  }

  private acceptUnavailable(
    generation: number,
    authority: DetailAuthority,
    reason: SessionsOpenUnavailableReason,
  ): void {
    if (!this.isCurrentGeneration(generation)) return
    if (this.pendingAuthority && !sameAuthority(this.pendingAuthority, authority)) return
    this.pendingAuthority = undefined
    this.publish({
      status: 'unavailable',
      context: detailContext(authority.row),
      message: detailUnavailableMessage(reason),
    })
  }

  private surfaceRevoked(
    lease: SessionsTerminalSurfaceLease,
    reason: SessionsTerminalSurfaceRevocationReason,
  ): void {
    if (this.lease !== lease || !this.selected) return
    this.lease = undefined
    this.leaseUnsubscribe?.()
    this.leaseUnsubscribe = undefined
    this.authority = undefined
    this.cancelFocus()
    const row = this.latest?.rows.find((candidate) => candidate.handle === this.selected)
    this.publishContext(
      'unavailable',
      row,
      sessionsTerminalSurfaceRevocationMessage(reason),
    )
  }

  private publishContext(
    status: 'paused' | 'unavailable',
    row: SessionsProjectionRow | undefined,
    message: string,
  ): void {
    const context = row
      ? detailContext(row)
      : this.current.status === 'inactive'
        ? undefined
        : this.current.context
    if (!context) {
      this.publish(INACTIVE)
      return
    }
    this.publish({ status, context, message })
  }

  private scheduleFocus(): void {
    this.cancelFocus()
    const lease = this.lease
    const container = this.container
    if (!lease || !container || !this.foreground) return
    this.focusFrame = this.frames.requestAnimationFrame(() => {
      this.focusFrame = undefined
      if (
        this.lease !== lease ||
        this.container !== container ||
        !this.foreground ||
        !lease.setVisible(container, true) ||
        !lease.focus(container)
      ) {
        this.releaseLease()
        this.publishContext(
          'unavailable',
          this.authority?.row,
          'The exact terminal changed before it could receive focus.',
        )
      }
    })
  }

  private attachLease(
    container: HTMLElement,
    lease: SessionsTerminalSurfaceLease,
    authority: DetailAuthority,
  ): void {
    const attached = lease.attach(container)
    if (
      this.lease !== lease ||
      this.authority !== authority ||
      this.container !== container
    )
      return
    if (!attached) {
      this.releaseLease()
      this.authority = undefined
      this.publish({
        status: 'unavailable',
        context: detailContext(authority.row),
        message: sessionsTerminalSurfaceUnavailableMessage('instance-mismatch'),
      })
      return
    }
    this.publish({ status: 'ready', context: detailContext(authority.row) })
    this.scheduleFocus()
  }

  private cancelPending(): void {
    this.requestGeneration += 1
    this.pendingAuthority = undefined
  }

  private cancelFocus(): void {
    if (this.focusFrame === undefined) return
    this.frames.cancelAnimationFrame(this.focusFrame)
    this.focusFrame = undefined
  }

  private releaseLease(): void {
    this.cancelFocus()
    const lease = this.lease
    const container = this.container
    this.lease = undefined
    this.leaseWorkspaceRuntimeId = undefined
    this.leaseUnsubscribe?.()
    this.leaseUnsubscribe = undefined
    if (container) lease?.setVisible(container, false)
    lease?.release()
  }

  private isPending(generation: number, authority: DetailAuthority): boolean {
    if (!this.isCurrentGeneration(generation) || !this.pendingAuthority) return false
    if (!sameAuthority(this.pendingAuthority, authority)) return false
    const snapshot = this.latest
    const row = snapshot?.rows.find((candidate) => candidate.handle === this.selected)
    return Boolean(
      this.foreground &&
      snapshot?.status === 'available' &&
      row &&
      sameAuthority(authority, {
        demandGeneration: snapshot.demandGeneration,
        projectionRevision: snapshot.revision,
        sourceRevision: snapshot.sourceRevision,
        row,
      }),
    )
  }

  private isCurrentGeneration(generation: number): boolean {
    return !this.disposed && generation === this.requestGeneration
  }

  private publish(next: SessionsTerminalDetailState): void {
    if (JSON.stringify(next) === JSON.stringify(this.current)) {
      return
    }
    this.current = next
    for (const listener of this.listeners) listener()
  }
}

export function createSessionsTerminalResolutionPort(
  api: Pick<HvirApi, 'invoke'>,
): SessionsTerminalResolutionPort {
  return { resolve: (request) => api.invoke('sessions:resolve-terminal', request) }
}

function resolutionRequest(authority: DetailAuthority): SessionsOpenRequest {
  const row = authority.row
  return {
    demandGeneration: authority.demandGeneration,
    sourceRevision: authority.sourceRevision,
    handle: row.handle,
    projectId: row.project.id,
    workspaceId: row.workspace.id,
    workspaceQualifier: row.workspace.qualifier,
    livePty: row.livePty,
  }
}

function surfaceRequest(
  authority: DetailAuthority,
  workspaceRuntimeId: SessionsWorkspaceRuntimeId,
) {
  return {
    handle: authority.row.handle,
    workspaceQualifier: authority.row.workspace.qualifier,
    workspaceRuntimeId,
    livePty: authority.row.livePty!,
    demandGeneration: authority.demandGeneration,
    projectionRevision: authority.projectionRevision,
    sourceRevision: authority.sourceRevision,
  }
}

function sameAuthority(left: DetailAuthority, right: DetailAuthority): boolean {
  return (
    left.sourceRevision === right.sourceRevision &&
    left.projectionRevision === right.projectionRevision &&
    sameResolvedTarget(left, right)
  )
}

function sameResolvedTarget(left: DetailAuthority, right: DetailAuthority): boolean {
  // The workspace qualifier belongs to one action snapshot; the opaque workspace
  // handle is the stable host-qualified owner for this demand lifetime.
  return (
    left.demandGeneration === right.demandGeneration &&
    left.row.handle === right.row.handle &&
    left.row.workspace.id === right.row.workspace.id &&
    sameLivePty(left.row.livePty, right.row.livePty)
  )
}

function sameLivePty(
  left: SessionsLivePtyQualifier | undefined,
  right: SessionsLivePtyQualifier | undefined,
): boolean {
  return Boolean(
    left &&
    right &&
    left.handle === right.handle &&
    left.rendererOwnerId === right.rendererOwnerId &&
    left.rendererGeneration === right.rendererGeneration,
  )
}

function detailContext(row: SessionsProjectionRow): SessionsTerminalDetailContext {
  return {
    title: row.title,
    projectName: row.project.name,
    workspaceName: row.workspace.name,
    hostLabel: row.host.label,
    providerName: row.provider.name,
  }
}

function detailUnavailableMessage(reason: SessionsOpenUnavailableReason): string {
  switch (reason) {
    case 'stale-projection':
      return 'Sessions changed before the exact terminal could be attached.'
    case 'session-unavailable':
      return 'This session is no longer available.'
    case 'workspace-unavailable':
      return 'The owning workspace is no longer available.'
    case 'connection-unavailable':
      return 'The host disconnected. Reconnect from the workspace before trying again.'
    case 'terminal-unavailable':
      return 'This session no longer has the same live terminal.'
  }
}
