import type {
  SessionsLivePtyQualifier,
  SessionsTerminalHandle,
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
  acquire(
    request: SessionsTerminalSurfaceRequest,
  ): SessionsTerminalSurfaceLease | undefined
}
