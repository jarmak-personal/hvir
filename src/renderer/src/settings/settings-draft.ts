import type { AppTheme } from '../theme-model'
import { keybindingOverridesJson, parseKeybindingOverrides } from './keybindings'
import type { AppSettings } from './settings-model'
import type { SettingsSection } from './settings-navigation'
import {
  MAX_INTERFACE_SCALE,
  MAX_TERMINAL_TEXT_SIZE,
  MIN_INTERFACE_SCALE,
  MIN_TERMINAL_TEXT_SIZE,
  normalizeFontPreference,
} from './typography-settings'

export interface SettingsDraft {
  readonly theme: AppTheme
  readonly terminalTheme: AppSettings['terminalTheme']
  readonly terminalLightThemeId: string
  readonly terminalDarkThemeId: string
  readonly terminalCursorShape: AppSettings['terminalCursorShape']
  readonly terminalCursorBlink: AppSettings['terminalCursorBlink']
  readonly terminalLigatures: boolean
  readonly interfaceFontMode: AppSettings['interfaceFont']['mode']
  readonly interfaceFontFamily: string
  readonly monospaceFontMode: AppSettings['monospaceFont']['mode']
  readonly monospaceFontFamily: string
  readonly interfaceScale: string
  readonly terminalTextSize: string
  readonly composerSubmitMode: AppSettings['composerSubmitMode']
  readonly idleSeconds: string
  readonly recoveryMode: AppSettings['terminalRecoveryMode']
  readonly gitAutoFetchIntervalMs: string
  readonly keybindingsJson: string
}

export type SettingsDraftValidation =
  | {
      readonly valid: true
      readonly theme: AppTheme
      readonly settings: AppSettings
    }
  | {
      readonly valid: false
      readonly section: SettingsSection
      readonly fieldId: string
      readonly message: string
    }

export function createSettingsDraft(
  theme: AppTheme,
  settings: AppSettings,
): SettingsDraft {
  return {
    theme,
    terminalTheme: settings.terminalTheme,
    terminalLightThemeId: settings.terminalLightThemeId,
    terminalDarkThemeId: settings.terminalDarkThemeId,
    terminalCursorShape: settings.terminalCursorShape,
    terminalCursorBlink: settings.terminalCursorBlink,
    terminalLigatures: settings.terminalLigatures,
    interfaceFontMode: settings.interfaceFont.mode,
    interfaceFontFamily: settings.interfaceFont.family,
    monospaceFontMode: settings.monospaceFont.mode,
    monospaceFontFamily: settings.monospaceFont.family,
    interfaceScale: String(settings.interfaceScale),
    terminalTextSize: String(settings.terminalTextSize),
    composerSubmitMode: settings.composerSubmitMode,
    idleSeconds: String(settings.idleThresholdMs / 1000),
    recoveryMode: settings.terminalRecoveryMode,
    gitAutoFetchIntervalMs: String(settings.gitAutoFetchIntervalMs),
    keybindingsJson: keybindingOverridesJson(settings.keybindings),
  }
}

export function validateSettingsDraft(draft: SettingsDraft): SettingsDraftValidation {
  const interfaceScale = Number(draft.interfaceScale)
  if (
    draft.interfaceScale.trim().length === 0 ||
    !Number.isFinite(interfaceScale) ||
    interfaceScale < MIN_INTERFACE_SCALE ||
    interfaceScale > MAX_INTERFACE_SCALE
  ) {
    return {
      valid: false,
      section: 'appearance',
      fieldId: 'settings-interface-scale',
      message: `Interface scale must be between ${MIN_INTERFACE_SCALE * 100}% and ${MAX_INTERFACE_SCALE * 100}%`,
    }
  }

  const terminalTextSize = Number(draft.terminalTextSize)
  if (
    draft.terminalTextSize.trim().length === 0 ||
    !Number.isFinite(terminalTextSize) ||
    terminalTextSize < MIN_TERMINAL_TEXT_SIZE ||
    terminalTextSize > MAX_TERMINAL_TEXT_SIZE
  ) {
    return {
      valid: false,
      section: 'appearance',
      fieldId: 'settings-terminal-text-size',
      message: `Terminal text size must be between ${MIN_TERMINAL_TEXT_SIZE} and ${MAX_TERMINAL_TEXT_SIZE} pixels`,
    }
  }

  const idleSeconds = Number(draft.idleSeconds)
  if (
    draft.idleSeconds.trim().length === 0 ||
    !Number.isFinite(idleSeconds) ||
    idleSeconds < 0.5 ||
    idleSeconds > 60
  ) {
    return {
      valid: false,
      section: 'terminal',
      fieldId: 'settings-idle-threshold',
      message: 'Idle threshold must be between 0.5 and 60 seconds',
    }
  }

  let keybindings: AppSettings['keybindings']
  try {
    const parsed: unknown = JSON.parse(draft.keybindingsJson)
    keybindings = parseKeybindingOverrides(parsed)
  } catch (reason) {
    return {
      valid: false,
      section: 'keybindings',
      fieldId: 'settings-keybindings-json',
      message: reason instanceof Error ? reason.message : String(reason),
    }
  }

  return {
    valid: true,
    theme: draft.theme,
    settings: {
      idleThresholdMs: idleSeconds * 1000,
      gitAutoFetchIntervalMs: Number(draft.gitAutoFetchIntervalMs),
      terminalRecoveryMode: draft.recoveryMode,
      terminalTheme: draft.terminalTheme,
      terminalLightThemeId: draft.terminalLightThemeId,
      terminalDarkThemeId: draft.terminalDarkThemeId,
      terminalCursorShape: draft.terminalCursorShape,
      terminalCursorBlink: draft.terminalCursorBlink,
      terminalLigatures: draft.terminalLigatures,
      interfaceFont: normalizeFontPreference({
        mode: draft.interfaceFontMode,
        family: draft.interfaceFontFamily,
      }),
      monospaceFont: normalizeFontPreference({
        mode: draft.monospaceFontMode,
        family: draft.monospaceFontFamily,
      }),
      interfaceScale,
      terminalTextSize: Math.round(terminalTextSize),
      composerSubmitMode: draft.composerSubmitMode,
      keybindings,
    },
  }
}
