import type { ComposerSubmitMode, KeybindingMap } from '../../../shared'

export type TerminalThemeOverride = 'app' | 'dark' | 'light'
export type TerminalRecoveryMode = 'prompt' | 'auto'
export type FontPreferenceMode = 'system' | 'custom'

export interface FontPreference {
  readonly mode: FontPreferenceMode
  readonly family: string
}

export interface TextTypography {
  readonly fontFamily: string
  readonly fontSize: number
}

export interface AppSettings {
  readonly idleThresholdMs: number
  readonly gitAutoFetchIntervalMs: number
  readonly terminalRecoveryMode: TerminalRecoveryMode
  readonly terminalTheme: TerminalThemeOverride
  readonly interfaceFont: FontPreference
  readonly monospaceFont: FontPreference
  readonly interfaceScale: number
  readonly terminalTextSize: number
  readonly composerSubmitMode: ComposerSubmitMode
  readonly keybindings: KeybindingMap
}

export interface TerminalPreferences {
  readonly idleThresholdMs: number
  readonly terminalRecoveryMode: TerminalRecoveryMode
  readonly terminalTheme: TerminalThemeOverride
  readonly terminalTypography: TextTypography
  readonly composerSubmitMode: ComposerSubmitMode
}
