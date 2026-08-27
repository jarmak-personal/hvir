import type { HostConnectionState } from './fs-types'
import type { HarnessProfileId } from './harness-profile'
import type { HarnessProviderId } from './harness-provider'
import type { ProjectState } from './ipc'

export const SESSIONS_PROJECTION_VERSION = 1
export const MAX_SESSIONS_PROJECTION_ROWS = 500
export const MAX_SESSIONS_PROJECTION_WORKSPACES = 1_000
export const MAX_SESSIONS_PROJECTION_PROVIDERS = 128

declare const sessionsTerminalHandleBrand: unique symbol
declare const sessionsPtyHandleBrand: unique symbol
declare const sessionsProjectHandleBrand: unique symbol
declare const sessionsWorkspaceHandleBrand: unique symbol
declare const sessionsWorkspaceQualifierBrand: unique symbol

/** Opaque hvir identity. Consumers may compare or route it, but never present it. */
export type SessionsTerminalHandle = string & {
  readonly [sessionsTerminalHandleBrand]: 'SessionsTerminalHandle'
}

/** Opaque identity for one exact live PTY instance. */
export type SessionsPtyHandle = string & {
  readonly [sessionsPtyHandleBrand]: 'SessionsPtyHandle'
}

/** Projection-owned identity with no host or path content. */
export type SessionsProjectHandle = string & {
  readonly [sessionsProjectHandleBrand]: 'SessionsProjectHandle'
}

/** Projection-owned identity with no host or path content. */
export type SessionsWorkspaceHandle = string & {
  readonly [sessionsWorkspaceHandleBrand]: 'SessionsWorkspaceHandle'
}

/** Path-free qualifier for matching one ProjectState workspace revision in the renderer. */
export type SessionsWorkspaceQualifier = string & {
  readonly [sessionsWorkspaceQualifierBrand]: 'SessionsWorkspaceQualifier'
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
  readonly sessionKind: 'agent' | 'shell'
}

export interface SessionsWorkspaceProjection {
  readonly projectId: SessionsProjectHandle
  readonly projectName: string
  readonly workspaceId: SessionsWorkspaceHandle
  readonly qualifier: SessionsWorkspaceQualifier
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
  readonly workspaceId: SessionsWorkspaceHandle
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

export interface SessionsOpenRequest extends SessionsDemandRequest {
  readonly sourceRevision: number
  readonly handle: SessionsTerminalHandle
  readonly projectId: SessionsProjectHandle
  readonly workspaceId: SessionsWorkspaceHandle
  readonly workspaceQualifier: SessionsWorkspaceQualifier
  readonly livePty?: SessionsLivePtyQualifier
}

export type SessionsOpenUnavailableReason =
  | 'stale-projection'
  | 'session-unavailable'
  | 'workspace-unavailable'
  | 'connection-unavailable'
  | 'terminal-unavailable'

export type SessionsOpenResponse =
  | {
      readonly outcome: 'opened'
      readonly state: ProjectState
      readonly handle: SessionsTerminalHandle
      readonly workspaceQualifier: SessionsWorkspaceQualifier
      readonly livePty: SessionsLivePtyQualifier
    }
  | {
      readonly outcome: 'unavailable'
      readonly reason: SessionsOpenUnavailableReason
    }

export type SessionsLifecycle =
  'retained' | 'starting' | 'resuming' | 'live' | 'stopped' | 'unavailable'

export interface SessionsProjectionRow {
  readonly handle: SessionsTerminalHandle
  readonly project: { readonly id: SessionsProjectHandle; readonly name: string }
  readonly workspace: {
    readonly id: SessionsWorkspaceHandle
    readonly name: string
    readonly main: boolean
    readonly qualifier: SessionsWorkspaceQualifier
  }
  readonly host: SessionsWorkspaceProjection['host']
  readonly provider: {
    readonly id: HarnessProviderId
    readonly name: string
    readonly kind: 'agent' | 'shell'
  }
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
  /** Main-owned observation revision used only for exact actions. */
  readonly sourceRevision: number
  readonly status: 'inactive' | 'pending' | 'available' | 'unavailable'
  readonly unavailableReason?: 'source-unavailable'
  readonly rows: readonly SessionsProjectionRow[]
}

export function asSessionsTerminalHandle(value: string): SessionsTerminalHandle {
  return value as SessionsTerminalHandle
}

export function asSessionsPtyHandle(value: string): SessionsPtyHandle {
  return value as SessionsPtyHandle
}

export function asSessionsProjectHandle(value: string): SessionsProjectHandle {
  return value as SessionsProjectHandle
}

export function asSessionsWorkspaceHandle(value: string): SessionsWorkspaceHandle {
  return value as SessionsWorkspaceHandle
}

export function sessionsWorkspaceQualifier(
  projectStateRevision: number,
  projectIndex: number,
  workspaceIndex: number,
): SessionsWorkspaceQualifier {
  if (
    !Number.isSafeInteger(projectStateRevision) ||
    projectStateRevision < 0 ||
    !Number.isSafeInteger(projectIndex) ||
    projectIndex < 0 ||
    !Number.isSafeInteger(workspaceIndex) ||
    workspaceIndex < 0
  ) {
    throw new Error('Invalid Sessions workspace qualifier')
  }
  return `${projectStateRevision}:${projectIndex}:${workspaceIndex}` as SessionsWorkspaceQualifier
}

export function sessionsProjectionText(
  value: string | undefined,
  max: number,
  fallback: string,
): string {
  return sessionsProjectionOptionalText(value, max) ?? fallback
}

export function sessionsProjectionOptionalText(
  value: string | undefined,
  max: number,
): string | undefined {
  if (typeof value !== 'string' || !Number.isSafeInteger(max) || max <= 0) {
    return undefined
  }
  const clean = [...value]
    .map((character) => {
      const code = character.charCodeAt(0)
      return code <= 31 || code === 127 ? ' ' : character
    })
    .join('')
    .trim()
    .slice(0, max)
  return clean || undefined
}

export function sessionsProjectionTitle(value: string | undefined): string {
  return sessionsProjectionText(value, 512, 'Terminal')
}
