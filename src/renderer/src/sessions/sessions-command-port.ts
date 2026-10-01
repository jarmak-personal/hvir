import type {
  HarnessProfile,
  HarnessProfileProbe,
  HarnessProviderDescriptor,
  SessionsProjectionRow,
  SessionsProjectionSnapshot,
  SessionsProjectHandle,
  SessionsTerminalHandle,
  TerminalMovePlan,
} from '../../../shared'

export interface SessionsLaunchChoices {
  readonly profiles: readonly HarnessProfile[]
  readonly providers: readonly HarnessProviderDescriptor[]
  readonly probes: readonly HarnessProfileProbe[]
  refresh(signal: AbortSignal): Promise<SessionsLaunchChoices>
  start(profile: HarnessProfile, signal: AbortSignal): Promise<SessionsTerminalHandle>
}

export interface SessionsMoveChoice {
  readonly id: string
  readonly name: string
}

/** Explicit commands are separate from the immutable observation projection. */
export interface SessionsCommandPort {
  launchChoices(
    project: SessionsProjectHandle,
    snapshot: SessionsProjectionSnapshot,
    signal: AbortSignal,
  ): Promise<SessionsLaunchChoices>
  moveChoices(
    row: SessionsProjectionRow,
    snapshot: SessionsProjectionSnapshot,
  ): readonly SessionsMoveChoice[]
  planMove(
    row: SessionsProjectionRow,
    snapshot: SessionsProjectionSnapshot,
    targetId: string,
    signal: AbortSignal,
  ): Promise<TerminalMovePlan>
  move(
    row: SessionsProjectionRow,
    plan: TerminalMovePlan,
    signal: AbortSignal,
  ): Promise<void>
}
