import type { DirEntry } from '../../../shared'

const fileNameCollator = new Intl.Collator(undefined, { numeric: true })

export function compareDirectoryEntries(left: DirEntry, right: DirEntry): number {
  const leftDirectoryLike = left.type === 'dir' || left.type === 'symlink'
  const rightDirectoryLike = right.type === 'dir' || right.type === 'symlink'
  const typeOrder = Number(rightDirectoryLike) - Number(leftDirectoryLike)
  if (typeOrder !== 0) return typeOrder

  return (
    fileNameCollator.compare(left.name, right.name) || left.name.localeCompare(right.name)
  )
}
