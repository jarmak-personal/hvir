import { useSyncExternalStore } from 'react'

import { DEFAULT_KEYBINDINGS, parseKeybindingOverrides } from './keybindings'
import type { AppSettings, TerminalPreferences } from './settings-model'
import {
  DEFAULT_TERMINAL_THEME_IDS,
  normalizeTerminalThemeId,
} from '../terminal/terminal-theme-catalog'
import {
  applyTypographyPresentation,
  type TypographyPropertyTarget,
} from './typography-presentation'
import {
  DEFAULT_INTERFACE_SCALE,
  DEFAULT_TERMINAL_TEXT_SIZE,
  fontFamilyStack,
  normalizeFontPreference,
  normalizeInterfaceScale,
  normalizeTerminalTextSize,
  systemFontPreference,
} from './typography-settings'

export type {
  AppSettings,
  TerminalPreferences,
  TerminalRecoveryMode,
  TerminalThemeOverride,
  FontPreference,
  FontPreferenceMode,
} from './settings-model'

const STORAGE_KEY = 'hvir:settings:v1'
const listeners = new Set<() => void>()
let settings = readSettings()
let typographyTarget: TypographyPropertyTarget | undefined

export function getAppSettings(): AppSettings {
  return settings
}

export function useAppSettings(): AppSettings {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => settings,
    () => settings,
  )
}

export function initializeAppSettings(target: TypographyPropertyTarget): void {
  typographyTarget = target
  applyTypographyPresentation(settings, target)
}

export function setAppSettings(next: AppSettings): void {
  settings = normalizeAppSettings(next)
  if (typographyTarget) applyTypographyPresentation(settings, typographyTarget)
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch {
    // Storage denial should not prevent live settings changes.
  }
  for (const listener of listeners) listener()
}

function readSettings(): AppSettings {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      return normalizeAppSettings(raw)
    }
    const legacyRecovery = localStorage.getItem('hvir:terminal-recovery-mode')
    return {
      ...defaults(),
      terminalRecoveryMode: legacyRecovery === 'auto' ? 'auto' : 'prompt',
    }
  } catch {
    return defaults()
  }
}

export function normalizeAppSettings(value: unknown): AppSettings {
  const candidate =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Partial<AppSettings>)
      : {}
  const idle = candidate.idleThresholdMs
  const autoFetch = candidate.gitAutoFetchIntervalMs
  return {
    idleThresholdMs:
      typeof idle === 'number' && Number.isFinite(idle)
        ? Math.min(60_000, Math.max(500, Math.round(idle)))
        : 4_000,
    gitAutoFetchIntervalMs:
      typeof autoFetch === 'number' && Number.isFinite(autoFetch)
        ? autoFetch === 0
          ? 0
          : Math.min(60 * 60_000, Math.max(60_000, Math.round(autoFetch)))
        : 5 * 60_000,
    terminalRecoveryMode: candidate.terminalRecoveryMode === 'auto' ? 'auto' : 'prompt',
    terminalTheme:
      candidate.terminalTheme === 'dark' || candidate.terminalTheme === 'light'
        ? candidate.terminalTheme
        : 'app',
    terminalLightThemeId: normalizeTerminalThemeId(
      candidate.terminalLightThemeId,
      'light',
    ),
    terminalDarkThemeId: normalizeTerminalThemeId(candidate.terminalDarkThemeId, 'dark'),
    terminalCursorShape:
      candidate.terminalCursorShape === 'hollow-block' ||
      candidate.terminalCursorShape === 'bar' ||
      candidate.terminalCursorShape === 'underline'
        ? candidate.terminalCursorShape
        : 'block',
    terminalCursorBlink:
      candidate.terminalCursorBlink === 'blinking' ||
      candidate.terminalCursorBlink === 'steady'
        ? candidate.terminalCursorBlink
        : 'terminal',
    terminalLigatures: candidate.terminalLigatures === false ? false : true,
    interfaceFont: normalizeFontPreference(candidate.interfaceFont),
    monospaceFont: normalizeFontPreference(candidate.monospaceFont),
    interfaceScale: normalizeInterfaceScale(candidate.interfaceScale),
    terminalTextSize: normalizeTerminalTextSize(candidate.terminalTextSize),
    composerSubmitMode:
      candidate.composerSubmitMode === 'ctrl-enter' ? 'ctrl-enter' : 'enter',
    keybindings: parseKeybindingOverrides(candidate.keybindings ?? DEFAULT_KEYBINDINGS),
  }
}

function defaults(): AppSettings {
  return {
    idleThresholdMs: 4_000,
    gitAutoFetchIntervalMs: 5 * 60_000,
    terminalRecoveryMode: 'prompt',
    terminalTheme: 'app',
    terminalLightThemeId: DEFAULT_TERMINAL_THEME_IDS.light,
    terminalDarkThemeId: DEFAULT_TERMINAL_THEME_IDS.dark,
    terminalCursorShape: 'block',
    terminalCursorBlink: 'terminal',
    terminalLigatures: true,
    interfaceFont: systemFontPreference(),
    monospaceFont: systemFontPreference(),
    interfaceScale: DEFAULT_INTERFACE_SCALE,
    terminalTextSize: DEFAULT_TERMINAL_TEXT_SIZE,
    composerSubmitMode: 'enter',
    keybindings: DEFAULT_KEYBINDINGS,
  }
}

export function terminalPreferences(settings: AppSettings): TerminalPreferences {
  return {
    idleThresholdMs: settings.idleThresholdMs,
    terminalRecoveryMode: settings.terminalRecoveryMode,
    terminalTheme: settings.terminalTheme,
    terminalLightThemeId: settings.terminalLightThemeId,
    terminalDarkThemeId: settings.terminalDarkThemeId,
    terminalCursorDefaults: {
      shape: settings.terminalCursorShape,
      blink: settings.terminalCursorBlink,
    },
    terminalLigatures: settings.terminalLigatures,
    terminalTypography: {
      fontFamily: fontFamilyStack(settings.monospaceFont, 'monospace'),
      fontSize: settings.terminalTextSize,
    },
    composerSubmitMode: settings.composerSubmitMode,
  }
}
