export type NativeFilePathReader = (file: File) => string

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

/**
 * Keep Electron's native File-path capability inside preload and return only
 * one absolute local path that is safe to insert without submitting input.
 */
export function terminalClipboardFilePasteText(
  file: File,
  readNativePath: NativeFilePathReader,
): string | undefined {
  const candidate = readNativePath(file)
  const absolute =
    candidate.startsWith('/') || WINDOWS_DRIVE_ABSOLUTE_PATH.test(candidate)
  if (!absolute || hasTerminalControlCharacter(candidate)) return undefined
  return candidate
}
