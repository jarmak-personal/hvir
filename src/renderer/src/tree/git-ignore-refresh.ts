import type { DirEntry } from '../../../shared'

export function directoryEntriesEqual(
  left: readonly DirEntry[],
  right: readonly DirEntry[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (entry, index) =>
        entry.name === right[index]?.name && entry.type === right[index]?.type,
    )
  )
}

export function isGitIgnoreRulePath(path: string): boolean {
  return /(^|\/)\.gitignore$/.test(path) || /(^|\/)\.git\/info\/exclude$/.test(path)
}
