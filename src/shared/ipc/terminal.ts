import { invoke, payload, type IpcFeatureContract } from '../ipc-contract'
import { type ComposerSubmitMode } from '../composer-submit'
import { type HostPath } from '../host-path'
import { type HarnessTelemetry } from '../harness-telemetry'
import { type HarnessProviderId } from '../harness-provider'
import { type HarnessProfileId } from '../harness-profile'
import { type ProjectState } from '../workspace-types'
import { type OperationResult } from '../operation-result'
import type { TerminalAttentionState } from '../terminal-attention'

export interface StartPtyRequest {
  readonly sessionId: string
  /**
   * Retained recovery record retired only after this fresh session starts and
   * its replacement record is durably committed.
   */
  readonly replacesSessionId?: string
  readonly profileId: HarnessProfileId
  readonly launchRevision: number
  /** Mutable terminal ownership, distinct from its immutable provider launch context. */
  readonly workspaceRoot: HostPath
  readonly cwd: HostPath
  readonly cols: number
  readonly rows: number
  readonly title: string
  readonly position: number
  readonly active: boolean
  readonly composerSubmitMode: ComposerSubmitMode
  /** Explicit bulk recovery is admitted through the bounded per-host start queue. */
  readonly admission?: 'interactive' | 'bulk'
  /** Omitted by legacy fresh/resume callers; new provider-derived starts name the mode. */
  readonly launchMode?: import('../harness-profile').HarnessLaunchMode
  readonly resume?: boolean
  readonly harnessSessionId?: string
  /** Exact registered source terminal and provider-owned parent identity for a fork. */
  readonly forkSourceSessionId?: string
  readonly parentHarnessSessionId?: string
}

export type StartPtyResponse =
  | {
      readonly outcome: 'started'
      readonly id: string
      /** Exact live spawn identity, distinct from the retained terminal id. */
      readonly instanceId: string
      readonly pid: number
      readonly resumed: boolean
      readonly reattached: boolean
      readonly harnessSessionId?: string
      readonly identityStatus: TerminalIdentityStatus
      readonly identityDiverged?: true
      readonly capabilities: import('../harness-provider').HarnessProviderCapabilities
    }
  | {
      readonly outcome: 'resume-unavailable'
      readonly reason: 'artifact-missing'
    }
  | {
      readonly outcome: 'fork-unavailable'
      readonly reason: 'parent-artifact-missing'
    }
  | {
      readonly outcome: 'launch-unavailable'
      readonly reason: 'identity-baseline-unavailable'
      readonly retryable: true
    }

export type TerminalIdentityStatus =
  'none' | 'discovering' | 'identified' | 'ambiguous' | 'unavailable'

export interface TerminalRecoverySession {
  readonly id: string
  readonly providerId: HarnessProviderId
  readonly profileId: HarnessProfileId
  readonly launchRevision: number
  readonly recoverySkipCount: 0 | 1
  readonly artifactIdentity?: string
  readonly harnessSessionId?: string
  readonly hostId: string
  readonly cwd: HostPath
  readonly title: string
  readonly position: number
  readonly active: boolean
  readonly attention?: TerminalAttentionState
  readonly updatedAt: number
}

export interface TerminalLayoutEntry {
  readonly id: string
  readonly title: string
  readonly position: number
  readonly active: boolean
  readonly attention?: TerminalAttentionState
}

export interface TerminalRecoveryRequest {
  readonly root: HostPath
}

export interface RecordTerminalRecoveryDecisionRequest {
  readonly root: HostPath
  readonly restoredIds: readonly string[]
  readonly skippedIds: readonly string[]
}

export interface TerminalLayoutRequest {
  readonly root: HostPath
  readonly sessions: readonly TerminalLayoutEntry[]
}

export interface ForgetTerminalRequest {
  readonly root: HostPath
  readonly id: string
}

export interface PlanTerminalMoveRequest {
  readonly terminalId: string
  readonly sourceWorkspaceId: string
  readonly targetWorkspaceId: string
}

export interface TerminalMovePlan {
  readonly terminalId: string
  readonly terminalTitle: string
  readonly sourceProjectId: string
  readonly sourceWorkspaceId: string
  readonly sourceWorkspaceName: string
  readonly sourceRoot: HostPath
  readonly targetWorkspaceId: string
  readonly targetWorkspaceName: string
  readonly targetRoot: HostPath
  readonly webPaneIds: readonly string[]
}

export interface MoveTerminalRequest extends PlanTerminalMoveRequest {
  /** Exact route set shown in the confirmation dialog. */
  readonly expectedWebPaneIds: readonly string[]
}

export interface MoveTerminalResponse {
  readonly state: ProjectState
  readonly workspaceRoot: HostPath
}

export interface RebindTerminalProfileRequest {
  readonly root: HostPath
  readonly id: string
  readonly profileId: HarnessProfileId
  readonly launchRevision: number
}

/**
 * Upper UTF-8 byte bound on text a terminal may place on the application host's
 * clipboard. ghostty-web bounds the encoded OSC payload it parses; this is the
 * independent bound main applies to decoded text that crosses IPC.
 */
export const MAX_CLIPBOARD_WRITE_BYTES = 64 * 1024

export const terminalIpc = {
  invoke: {
    'terminal:recovery': invoke<
      TerminalRecoveryRequest,
      readonly TerminalRecoverySession[]
    >(),
    'terminal:record-recovery-decision': invoke<
      RecordTerminalRecoveryDecisionRequest,
      void
    >(),
    'terminal:update-layout': invoke<TerminalLayoutRequest, void>(),
    'terminal:forget': invoke<ForgetTerminalRequest, void>(),
    'terminal:plan-move': invoke<
      PlanTerminalMoveRequest,
      OperationResult<TerminalMovePlan>
    >(),
    'terminal:move': invoke<MoveTerminalRequest, OperationResult<MoveTerminalResponse>>(),
    'terminal:rebind-profile': invoke<
      RebindTerminalProfileRequest,
      TerminalRecoverySession
    >(),
    'terminal:resolve-file-clipboard': invoke<
      Record<string, never>,
      string | undefined
    >(),
    'pty:start': invoke<StartPtyRequest, StartPtyResponse>(),
  },
  send: {
    'pty:write': payload<{ readonly id: string; readonly data: string }>(),
    'pty:resize': payload<{
      readonly id: string
      readonly cols: number
      readonly rows: number
    }>(),
    'pty:kill': payload<{ readonly id: string }>(),
    'terminal:paste-image': payload<{
      readonly id: string
      readonly fallbackData: string
    }>(),
    'terminal:clipboard-write': payload<{ readonly text: string }>(),
  },
  event: {
    'pty:data': payload<{ readonly id: string; readonly data: string }>(),
    'pty:exit': payload<{
      readonly id: string
      readonly exitCode: number
      readonly signal?: number
    }>(),
    'pty:telemetry': payload<{
      readonly id: string
      readonly telemetry: HarnessTelemetry | undefined
    }>(),
    'pty:identity': payload<{
      readonly id: string
      readonly harnessSessionId?: string
      readonly identityStatus: TerminalIdentityStatus
      readonly identityDiverged?: true
    }>(),
  },
} satisfies IpcFeatureContract
