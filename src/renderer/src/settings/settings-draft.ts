import type { AppTheme } from '../theme-model'
import { keybindingOverridesJson, parseKeybindingOverrides } from './keybindings'
import type { AppSettings } from './settings-model'
import type { SettingsSection } from './settings-navigation'

export interface SettingsDraft {
  readonly theme: AppTheme
  readonly terminalTheme: AppSettings['terminalTheme']
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
    composerSubmitMode: settings.composerSubmitMode,
    idleSeconds: String(settings.idleThresholdMs / 1000),
    recoveryMode: settings.terminalRecoveryMode,
    gitAutoFetchIntervalMs: String(settings.gitAutoFetchIntervalMs),
    keybindingsJson: keybindingOverridesJson(settings.keybindings),
  }
}

export function validateSettingsDraft(draft: SettingsDraft): SettingsDraftValidation {
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
      composerSubmitMode: draft.composerSubmitMode,
      keybindings,
    },
  }
}
