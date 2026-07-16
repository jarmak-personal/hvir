import { useSyncExternalStore } from 'react'

export type AppTheme = 'dark' | 'light'

const STORAGE_KEY = 'hvir:theme'
const listeners = new Set<() => void>()
let activeTheme: AppTheme = readTheme()

export function initializeAppTheme(): void {
  applyTheme(activeTheme)
}

export function setAppTheme(theme: AppTheme): void {
  if (theme === activeTheme) return
  activeTheme = theme
  applyTheme(theme)
  try {
    localStorage.setItem(STORAGE_KEY, theme)
  } catch {
    // A blocked storage backend should not make theme switching fail.
  }
  for (const listener of listeners) listener()
}

export function useAppTheme(): AppTheme {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => activeTheme,
    () => activeTheme,
  )
}

export function shikiTheme(theme: AppTheme): 'dark-plus' | 'github-light-default' {
  return theme === 'light' ? 'github-light-default' : 'dark-plus'
}

function readTheme(): AppTheme {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'light' ? 'light' : 'dark'
  } catch {
    return 'dark'
  }
}

function applyTheme(theme: AppTheme): void {
  document.documentElement.dataset['theme'] = theme
  document.documentElement.style.colorScheme = theme
}
