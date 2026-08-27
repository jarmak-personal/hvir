import type { HostConnectionState } from './fs-types'
import type { HarnessProfileId } from './harness-profile'
import type { HarnessProviderId } from './harness-provider'

export const SESSIONS_PROJECTION_VERSION = 1
export const MAX_SESSIONS_PROJECTION_ROWS = 500
export const MAX_SESSIONS_PROJECTION_WORKSPACES = 1_000
export const MAX_SESSIONS_PROJECTION_PROVIDERS = 128

declare const sessionsTerminalHandleBrand: unique symbol
declare const sessionsPtyHandleBrand: unique symbol

/** Opaque hvir identity. Consumers may compare or route it, but never present it. */
export type SessionsTerminalHandle = string & {
  readonly [sessionsTerminalHandleBrand]: 'SessionsTerminalHandle'
}

/** Opaque identity for one exact live PTY instance. */
export type SessionsPtyHandle = string & {
  readonly [sessionsPtyHandleBrand]: 'SessionsPtyHandle'
}

export type SessionsReasonCode =
  | 'not-materialized'
  | 'not-live'
  | 'telemetry-pending'
  | 'source-unavailable'
  | 'source-stale'
  | 'connection-unavailable'
  | 'workspace-unavailable'
  | 'stopped'
  | 'recovery-unavailable'
  | 'transport-unavailable'

export type SessionsFact<T> =
  | { readonly status: 'unsupported' }
  | { readonly status: 'pending'; readonly reason: SessionsReasonCode }
  | { readonly status: 'unavailable'; readonly reason: SessionsReasonCode }
  | {
      readonly status: 'stale'
      readonly value: T
      readonly observedAt: number
      readonly reason: SessionsReasonCode
    }
  | { readonly status: 'available'; readonly value: T; readonly observedAt?: number }

export interface SessionsModelFact {
  readonly id: string
  readonly displayName?: string
}

export interface SessionsContextFact {
  readonly usedTokens: number
  readonly windowTokens?: number
  readonly usedPercent?: number
}

export interface SessionsTurnFact {
  readonly state: 'working' | 'waiting-for-user' | 'waiting-for-approval' | 'idle'
}

export interface SessionsFreshnessFact {
  readonly staleAfterMs: number
}

export interface SessionsTelemetryFacts {
  readonly model: SessionsFact<SessionsModelFact>
  readonly context: SessionsFact<SessionsContextFact>
  readonly turn: SessionsFact<SessionsTurnFact>
  readonly freshness: SessionsFact<SessionsFreshnessFact>
}

export interface SessionsProviderProjection {
  readonly id: HarnessProviderId
  readonly displayName: string
  readonly telemetrySupported: boolean
}

export interface SessionsWorkspaceProjection {
  readonly projectId: string
  readonly projectName: string
  readonly workspaceId: string
  readonly workspaceName: string
  readonly main: boolean
  readonly closed: boolean
  readonly missing: boolean
  readonly host: {
    readonly id: string
    readonly label: string
    readonly kind: 'local' | 'ssh'
    readonly connectionState: HostConnectionState
  }
}

export interface SessionsLivePtyQualifier {
  readonly handle: SessionsPtyHandle
  readonly rendererOwnerId: number
  readonly rendererGeneration: number
}

/** Main-safe facts before renderer runtime/attention state is joined. */
export interface SessionsObservedSession {
  readonly handle: SessionsTerminalHandle
  readonly workspaceId: string
  readonly providerId: HarnessProviderId
  readonly profile: SessionsFact<{ readonly id: HarnessProfileId }>
  readonly title: string
  readonly lifecycle: 'retained' | 'live'
  readonly livePty?: SessionsLivePtyQualifier
  readonly telemetry: SessionsTelemetryFacts
}

export interface SessionsObservationSnapshot {
  readonly version: typeof SESSIONS_PROJECTION_VERSION
  readonly demandGeneration: number
  readonly revision: number
  readonly workspaces: readonly SessionsWorkspaceProjection[]
  readonly providers: readonly SessionsProviderProjection[]
  readonly sessions: readonly SessionsObservedSession[]
}

export interface SessionsProjectionChange {
  readonly demandGeneration: number
  readonly revision: number
}

export interface SessionsDemandRequest {
  readonly demandGeneration: number
}

export type SessionsLifecycle =
  'retained' | 'starting' | 'resuming' | 'live' | 'stopped' | 'unavailable'

export interface SessionsProjectionRow {
  readonly handle: SessionsTerminalHandle
  readonly project: { readonly id: string; readonly name: string }
  readonly workspace: {
    readonly id: string
    readonly name: string
    readonly main: boolean
  }
  readonly host: SessionsWorkspaceProjection['host']
  readonly provider: { readonly id: HarnessProviderId; readonly name: string }
  readonly profile: SessionsFact<{ readonly id: HarnessProfileId }>
  readonly title: string
  readonly lifecycle: SessionsLifecycle
  readonly lifecycleReason?: SessionsReasonCode
  readonly connectionState: HostConnectionState
  readonly attention: SessionsFact<'none' | 'ready' | 'bell'>
  readonly working: SessionsFact<boolean>
  readonly model: SessionsFact<SessionsModelFact>
  readonly context: SessionsFact<SessionsContextFact>
  readonly turn: SessionsFact<SessionsTurnFact>
  readonly telemetryFreshness: SessionsFact<SessionsFreshnessFact>
  /** Reserved for the cumulative token-counter child; this issue never samples usage. */
  readonly usage: { readonly status: 'unsupported' }
  readonly livePty?: SessionsLivePtyQualifier
}

export interface SessionsProjectionSnapshot {
  readonly version: typeof SESSIONS_PROJECTION_VERSION
  readonly demandGeneration: number
  readonly revision: number
  readonly rows: readonly SessionsProjectionRow[]
}

export function asSessionsTerminalHandle(value: string): SessionsTerminalHandle {
  return value as SessionsTerminalHandle
}

export function asSessionsPtyHandle(value: string): SessionsPtyHandle {
  return value as SessionsPtyHandle
}
