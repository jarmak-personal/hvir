import { isProjectFileEntryName } from '../../../shared'

export function projectFileEntryNameError(name: string): string | undefined {
  if (isProjectFileEntryName(name)) return undefined
  if (name.length === 0) return 'Enter one file or folder name.'
  return 'Use one name without “.”, “..”, NUL, “/”, or “\\”.'
}
