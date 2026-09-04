import type { StartPtyResponse } from '../../../shared'

export type TerminalRecoveryFailure = {
  readonly kind: 'resume-unavailable'
  readonly reason: 'artifact-missing'
}

export interface TerminalRuntimeSnapshot {
  readonly title: string
  readonly status: string
  readonly exited: boolean
  readonly recoveryFailure?: TerminalRecoveryFailure
}

export function terminalRecoveryFailureEquals(
  left: TerminalRecoveryFailure | undefined,
  right: TerminalRecoveryFailure | undefined,
): boolean {
  return left?.kind === right?.kind && left?.reason === right?.reason
}

export function terminalStartFailureSnapshot(
  current: TerminalRuntimeSnapshot,
  status: string,
  recoveryFailure?: TerminalRecoveryFailure,
): TerminalRuntimeSnapshot {
  return { ...current, status, exited: true, recoveryFailure }
}

export function pendingForkExitStatus(exitCode: number): string {
  return `The sibling terminal exited before its conversation was identified (${exitCode}).`
}

export function terminalUnavailablePresentation(
  result: Exclude<StartPtyResponse, { outcome: 'started' }>,
): Readonly<{ status: string; recoveryFailure?: TerminalRecoveryFailure }> {
  switch (result.outcome) {
    case 'launch-unavailable':
      return { status: 'Launch unavailable · session recovery baseline could not be read' }
    case 'resume-unavailable':
      return {
        status: 'Resume unavailable · session data is missing',
        recoveryFailure: { kind: 'resume-unavailable', reason: result.reason },
      }
    case 'fork-unavailable':
      return { status: 'Fork unavailable · source conversation data is missing' }
  }
}
