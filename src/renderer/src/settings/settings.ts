import { useSyncExternalStore } from 'react'

import {
  DEFAULT_KEYBINDINGS,
  parseKeybindingOverrides,
  type KeybindingMap,
} from './keybindings'

export type TerminalThemeOverride = 'app' | 'dark' | 'light'
export type TerminalRecoveryMode = 'prompt' | 'auto'

export interface AppSettings {
  readonly idleThresholdMs: number
  readonly gitAutoFetchIntervalMs: number
  readonly terminalRecoveryMode: TerminalRecoveryMode
  readonly terminalTheme: TerminalThemeOverride
  readonly keybindings: KeybindingMap
}

const STORAGE_KEY = 'hvir:settings:v1'
const listeners = new Set<() => void>()
let settings = readSettings()

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

export function setAppSettings(next: AppSettings): void {
  settings = normalizeSettings(next)
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
      return normalizeSettings(raw)
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

function normalizeSettings(value: Partial<AppSettings>): AppSettings {
  const idle = value.idleThresholdMs
  const autoFetch = value.gitAutoFetchIntervalMs
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
    terminalRecoveryMode: value.terminalRecoveryMode === 'auto' ? 'auto' : 'prompt',
    terminalTheme:
      value.terminalTheme === 'dark' || value.terminalTheme === 'light'
        ? value.terminalTheme
        : 'app',
    keybindings: parseKeybindingOverrides(value.keybindings ?? DEFAULT_KEYBINDINGS),
  }
}

function defaults(): AppSettings {
  return {
    idleThresholdMs: 4_000,
    gitAutoFetchIntervalMs: 5 * 60_000,
    terminalRecoveryMode: 'prompt',
    terminalTheme: 'app',
    keybindings: DEFAULT_KEYBINDINGS,
  }
}
