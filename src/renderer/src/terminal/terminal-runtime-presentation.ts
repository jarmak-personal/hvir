import type { TerminalColorTheme } from './terminal-pane'
import type { RichOutputSnapshot } from './rich-output-coordinator'

export type TerminalRecoveryFailure = {
  readonly kind: 'resume-unavailable'
  readonly reason: 'artifact-missing'
}

export interface TerminalRuntimeSnapshot {
  readonly title: string
  readonly status: string
  readonly exited: boolean
  readonly recoveryFailure?: TerminalRecoveryFailure
  readonly richOutput: RichOutputSnapshot
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

export function terminalStartStatus(
  result: {
    readonly pid: number
    readonly resumed: boolean
    readonly reattached: boolean
  },
  context: {
    readonly replacement: boolean
    readonly resume: boolean
    readonly manualRestart: boolean
    readonly reconnect: boolean
  },
): string {
  if (result.reattached) return `Reattached · pid ${result.pid}`
  if (result.resumed) return `Resumed · pid ${result.pid}`
  if (context.replacement || context.resume) return `New session · pid ${result.pid}`
  if (context.manualRestart) return `Restarted · pid ${result.pid}`
  return context.reconnect ? `New shell · pid ${result.pid}` : `pid ${result.pid}`
}

export function recoveryFailureEquals(
  left: TerminalRecoveryFailure | undefined,
  right: TerminalRecoveryFailure | undefined,
): boolean {
  return left?.kind === right?.kind && left?.reason === right?.reason
}

export function terminalSnapshotsEqual(
  left: TerminalRuntimeSnapshot,
  right: TerminalRuntimeSnapshot,
): boolean {
  return (
    left.title === right.title &&
    left.status === right.status &&
    left.exited === right.exited &&
    left.richOutput === right.richOutput &&
    recoveryFailureEquals(left.recoveryFailure, right.recoveryFailure)
  )
}

export function baseTerminalTheme(): TerminalColorTheme {
  return {
    background: '#111318',
    foreground: '#d8dee9',
    cursor: '#d8dee9',
    selectionBackground: '#39445a',
    black: '#20242c',
    red: '#e06c75',
    green: '#98c379',
    yellow: '#e5c07b',
    blue: '#61afef',
    magenta: '#c678dd',
    cyan: '#56b6c2',
    white: '#d8dee9',
  }
}
