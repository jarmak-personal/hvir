import type { ComposerSubmitMode, KeybindingMap } from '../../../shared'

export type TerminalThemeOverride = 'app' | 'dark' | 'light'
export type TerminalRecoveryMode = 'prompt' | 'auto'

export interface AppSettings {
  readonly idleThresholdMs: number
  readonly gitAutoFetchIntervalMs: number
  readonly terminalRecoveryMode: TerminalRecoveryMode
  readonly terminalTheme: TerminalThemeOverride
  readonly composerSubmitMode: ComposerSubmitMode
  readonly keybindings: KeybindingMap
}

export interface TerminalPreferences {
  readonly idleThresholdMs: number
  readonly terminalRecoveryMode: TerminalRecoveryMode
  readonly terminalTheme: TerminalThemeOverride
  readonly composerSubmitMode: ComposerSubmitMode
}
