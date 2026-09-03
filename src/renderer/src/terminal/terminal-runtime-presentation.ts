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

export function resumeUnavailableStatus(reason: 'artifact-missing'): string {
  switch (reason) {
    case 'artifact-missing':
      return 'Resume unavailable · session data is missing'
  }
}

export function launchUnavailableStatus(reason: 'identity-baseline-unavailable'): string {
  switch (reason) {
    case 'identity-baseline-unavailable':
      return 'Launch unavailable · session recovery baseline could not be read'
  }
}
