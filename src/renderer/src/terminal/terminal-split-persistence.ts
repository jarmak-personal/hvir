import type { HostPath } from '../../../shared'

export interface StoredTerminalSplitLayout {
  readonly secondaryIds: readonly string[]
  readonly primaryWidth?: number
  readonly activeByPane?: Readonly<{
    readonly primary?: string
    readonly secondary?: string
  }>
}

export function decodeTerminalSplitLayout(raw: string | null): StoredTerminalSplitLayout {
  try {
    const value: unknown = JSON.parse(raw ?? 'null')
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { secondaryIds: [] }
    }
    const record = value as Record<string, unknown>
    const ids = record['secondaryIds']
    const primaryWidth = record['primaryWidth']
    const activeByPane = decodeActiveByPane(record['activeByPane'])
    return {
      secondaryIds: Array.isArray(ids)
        ? ids
            .filter((id): id is string => typeof id === 'string' && id.length <= 80)
            .slice(0, 500)
        : [],
      primaryWidth:
        typeof primaryWidth === 'number' && Number.isFinite(primaryWidth)
          ? primaryWidth
          : undefined,
      ...(activeByPane ? { activeByPane } : {}),
    }
  } catch {
    return { secondaryIds: [] }
  }
}

function decodeActiveByPane(
  value: unknown,
): StoredTerminalSplitLayout['activeByPane'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const primary = terminalId(record['primary'])
  const secondary = terminalId(record['secondary'])
  return primary || secondary ? { primary, secondary } : undefined
}

function terminalId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(value)
    ? value
    : undefined
}

export function readTerminalSplitLayout(root: HostPath): StoredTerminalSplitLayout {
  try {
    return decodeTerminalSplitLayout(localStorage.getItem(terminalSplitStorageKey(root)))
  } catch {
    return { secondaryIds: [] }
  }
}

export function writeTerminalSplitLayout(
  root: HostPath,
  layout: StoredTerminalSplitLayout,
): void {
  try {
    localStorage.setItem(terminalSplitStorageKey(root), JSON.stringify(layout))
  } catch {
    // Split recovery is best effort and never changes the live PTY layout.
  }
}

function terminalSplitStorageKey(root: HostPath): string {
  return `hvir:terminal-split:${root.hostId}:${root.path}`
}
