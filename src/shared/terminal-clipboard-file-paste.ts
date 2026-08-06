const WINDOWS_DRIVE_ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/

function hasTerminalControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) {
      return true
    }
  }
  return false
}

/** Validate inert local path text without granting filesystem authority. */
export function terminalClipboardFilePastePath(value: string): string | undefined {
  const absolute = value.startsWith('/') || WINDOWS_DRIVE_ABSOLUTE_PATH.test(value)
  if (!absolute || hasTerminalControlCharacter(value)) return undefined
  return value
}
