import type {
  HarnessProfileId,
  HarnessProviderId,
  SessionsTerminalHandle,
  SessionsWorkspaceQualifier,
  TerminalAttentionState,
} from '../../../shared'

export interface SessionsRendererSession {
  readonly handle: SessionsTerminalHandle
  readonly workspaceQualifier: SessionsWorkspaceQualifier
  readonly providerId: HarnessProviderId
  readonly profileId: HarnessProfileId
  readonly title: string
  readonly dormant: boolean
  readonly resumeOnStart: boolean
  readonly exited: boolean
  readonly recoveryUnavailable: boolean
  readonly attention?: TerminalAttentionState
}

/** Read-only view of already materialized renderer terminal owners. */
export interface SessionsRendererObservationPort {
  snapshot(): readonly SessionsRendererSession[]
  subscribe(listener: () => void): () => void
}
