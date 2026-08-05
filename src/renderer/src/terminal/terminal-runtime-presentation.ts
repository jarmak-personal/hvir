import type { TerminalColorTheme } from './terminal-pane'

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
