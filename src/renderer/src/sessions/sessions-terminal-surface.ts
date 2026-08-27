import type {
  SessionsLivePtyQualifier,
  SessionsTerminalHandle,
  SessionsProjectionRow,
  SessionsWorkspaceQualifier,
  SessionsWorkspaceRuntimeId,
} from '../../../shared'

export interface SessionsTerminalSurfaceRequest {
  readonly handle: SessionsTerminalHandle
  readonly workspaceQualifier: SessionsWorkspaceQualifier
  readonly workspaceRuntimeId: SessionsWorkspaceRuntimeId
  readonly livePty: SessionsLivePtyQualifier
  readonly demandGeneration: number
  readonly projectionRevision: number
  readonly sourceRevision: number
}

export type SessionsTerminalSurfaceUnavailableReason =
  'source-missing' | 'runtime-not-ready' | 'instance-mismatch' | 'lease-conflict'

export type SessionsTerminalSurfaceCapabilityRequest = Pick<
  SessionsTerminalSurfaceRequest,
  'handle' | 'workspaceQualifier' | 'livePty'
>

export type SessionsTerminalSurfaceAvailability =
  | { readonly outcome: 'available' }
  | {
      readonly outcome: 'unavailable'
      readonly reason: SessionsTerminalSurfaceUnavailableReason
    }

export type SessionsTerminalSurfaceRevocationReason =
  | 'terminal-unavailable'
  | 'connection-unavailable'
  | 'workspace-unavailable'
  | 'owner-disposed'

/** One provider-neutral borrow of the actual retained TerminalPane surface. */
export interface SessionsTerminalSurfaceLease {
  renew(request: SessionsTerminalSurfaceRequest): boolean
  attach(container: HTMLElement): boolean
  detach(container: HTMLElement): void
  setVisible(container: HTMLElement, visible: boolean): boolean
  focus(container: HTMLElement): boolean
  subscribe(
    listener: (reason: SessionsTerminalSurfaceRevocationReason) => void,
  ): () => void
  release(): void
}

export interface SessionsTerminalSurfacePort {
  availability(
    request: SessionsTerminalSurfaceCapabilityRequest,
  ): SessionsTerminalSurfaceAvailability
  acquire(request: SessionsTerminalSurfaceRequest):
    | { readonly outcome: 'acquired'; readonly lease: SessionsTerminalSurfaceLease }
    | {
        readonly outcome: 'unavailable'
        readonly reason: SessionsTerminalSurfaceUnavailableReason
      }
}

export function sessionsTerminalSurfaceAvailable(
  row: SessionsProjectionRow,
  surfaces: SessionsTerminalSurfacePort,
): boolean {
  const livePty = row.livePty
  return (
    sessionsTerminalSurfaceEligible(row) &&
    livePty !== undefined &&
    surfaces.availability({
      handle: row.handle,
      workspaceQualifier: row.workspace.qualifier,
      livePty,
    }).outcome === 'available'
  )
}

export function sessionsTerminalSurfaceEligible(row: SessionsProjectionRow): boolean {
  return (
    row.lifecycle === 'live' &&
    row.connectionState === 'connected' &&
    row.livePty !== undefined
  )
}
