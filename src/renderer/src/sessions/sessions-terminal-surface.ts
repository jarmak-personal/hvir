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
  'runtime-not-ready' | 'instance-mismatch' | 'lease-conflict'

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
  acquire(request: SessionsTerminalSurfaceRequest):
    | { readonly outcome: 'acquired'; readonly lease: SessionsTerminalSurfaceLease }
    | {
        readonly outcome: 'unavailable'
        readonly reason: SessionsTerminalSurfaceUnavailableReason
      }
}

export function sessionsTerminalSurfaceEligible(row: SessionsProjectionRow): boolean {
  return (
    row.lifecycle === 'live' &&
    row.connectionState === 'connected' &&
    row.livePty !== undefined
  )
}

export function sessionsTerminalSurfaceUnavailableMessage(
  reason: SessionsTerminalSurfaceUnavailableReason,
): string {
  switch (reason) {
    case 'runtime-not-ready':
      return 'This terminal surface is not ready for interaction.'
    case 'instance-mismatch':
      return 'The live terminal changed before interaction began.'
    case 'lease-conflict':
      return 'This terminal surface is already being shown elsewhere.'
  }
}

export function sessionsTerminalSurfaceRevocationMessage(
  reason: SessionsTerminalSurfaceRevocationReason,
): string {
  switch (reason) {
    case 'terminal-unavailable':
      return 'The live terminal ended or was replaced.'
    case 'connection-unavailable':
      return 'The terminal host disconnected.'
    case 'workspace-unavailable':
      return 'The terminal moved or its workspace became unavailable.'
    case 'owner-disposed':
      return 'The terminal owner was replaced.'
  }
}
