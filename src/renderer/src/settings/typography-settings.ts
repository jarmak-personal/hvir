import type { FontPreference } from './settings-model'

export const DEFAULT_INTERFACE_SCALE = 1
export const MIN_INTERFACE_SCALE = 0.8
export const MAX_INTERFACE_SCALE = 1.5
export const DEFAULT_TERMINAL_TEXT_SIZE = 13
export const MIN_TERMINAL_TEXT_SIZE = 10
export const MAX_TERMINAL_TEXT_SIZE = 24

export const SYSTEM_INTERFACE_FONT_STACK =
  'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
export const SYSTEM_MONOSPACE_FONT_STACK =
  'ui-monospace, "SFMono-Regular", Menlo, Monaco, Consolas, "Liberation Mono", monospace'

const MAX_FONT_FAMILY_LENGTH = 100

export function systemFontPreference(): FontPreference {
  return { mode: 'system', family: '' }
}

export function normalizeFontPreference(value: unknown): FontPreference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return systemFontPreference()
  }
  const candidate = value as { readonly mode?: unknown; readonly family?: unknown }
  if (candidate.mode !== 'custom') return systemFontPreference()
  const family = normalizeCustomFontFamily(candidate.family)
  return family ? { mode: 'custom', family } : systemFontPreference()
}

export function normalizeCustomFontFamily(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  if (value.includes(',') || value.includes(';') || containsControlCharacter(value)) {
    return undefined
  }
  const family = value.trim().replace(/\s+/gu, ' ')
  if (family.length === 0 || family.length > MAX_FONT_FAMILY_LENGTH) {
    return undefined
  }
  return family
}

export function fontFamilyStack(
  preference: FontPreference,
  kind: 'interface' | 'monospace',
): string {
  const systemStack =
    kind === 'interface' ? SYSTEM_INTERFACE_FONT_STACK : SYSTEM_MONOSPACE_FONT_STACK
  const normalized = normalizeFontPreference(preference)
  return normalized.mode === 'custom'
    ? `${quoteFontFamily(normalized.family)}, ${systemStack}`
    : systemStack
}

export function normalizeInterfaceScale(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_INTERFACE_SCALE
  }
  const bounded = Math.min(MAX_INTERFACE_SCALE, Math.max(MIN_INTERFACE_SCALE, value))
  return Math.round(bounded * 20) / 20
}

export function normalizeTerminalTextSize(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_TERMINAL_TEXT_SIZE
  }
  return Math.round(
    Math.min(MAX_TERMINAL_TEXT_SIZE, Math.max(MIN_TERMINAL_TEXT_SIZE, value)),
  )
}

function quoteFontFamily(family: string): string {
  return `"${family.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (code <= 31 || code === 127) return true
  }
  return false
}
