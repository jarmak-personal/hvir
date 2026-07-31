export function isTerminalId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(value)
}

export function recoveryDecisionIds(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 500) {
    throw new Error('Invalid terminal recovery decision')
  }
  const ids = value.filter(isTerminalId)
  if (ids.length !== value.length || new Set(ids).size !== ids.length) {
    throw new Error('Invalid terminal recovery decision')
  }
  return ids
}

export function isTerminalTitle(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    !hasControlCharacter(value)
  )
}

export function isTerminalAttention(
  value: unknown,
): value is 'working' | 'bell' | 'idle' {
  return value === 'working' || value === 'bell' || value === 'idle'
}

export function isHarnessSessionId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 240 &&
    !/\s/.test(value) &&
    !hasControlCharacter(value)
  )
}

export function isClassifiedHarnessLaunchFailure(reason: unknown): boolean {
  const message = reason instanceof Error ? reason.message : String(reason)
  return /\bENOENT\b|command not found|unknown option|unrecognized option|unsupported option/i.test(
    message,
  )
}

export function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function terminalDimension(value: number): number {
  if (!Number.isFinite(value)) return 80
  return Math.max(2, Math.min(1000, Math.floor(value)))
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0)
    return code <= 31 || code === 127
  })
}
