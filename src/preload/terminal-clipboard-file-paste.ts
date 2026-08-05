import { terminalClipboardFilePastePath } from '../shared'

export type NativeFilePathReader = (file: File) => string

/**
 * Keep Electron's native File-path capability inside preload and return only
 * one absolute local path that is safe to insert without submitting input.
 */
export function terminalClipboardFilePasteText(
  file: File,
  readNativePath: NativeFilePathReader,
): string | undefined {
  return terminalClipboardFilePastePath(readNativePath(file))
}
