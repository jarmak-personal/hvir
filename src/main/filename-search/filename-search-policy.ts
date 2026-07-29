import { FILENAME_SEARCH_RESULT_LIMIT, type FilenameSearchResult } from '../../shared'

export type IndexedFilename = FilenameSearchResult

export interface RankedFilenameSearch {
  readonly results: readonly FilenameSearchResult[]
  readonly truncated: boolean
}

/** Fixed first-release matching policy: basename-only, literal, case-insensitive. */
export function rankFilenameMatches(
  files: readonly IndexedFilename[],
  query: string,
  limit = FILENAME_SEARCH_RESULT_LIMIT,
): RankedFilenameSearch {
  const needle = query.toLowerCase()
  if (needle.length === 0) return { results: [], truncated: false }
  const ranked = files
    .map((file) => ({ file, rank: matchRank(file.name.toLowerCase(), needle) }))
    .filter(
      (candidate): candidate is { file: IndexedFilename; rank: number } =>
        candidate.rank !== undefined,
    )
    .sort((left, right) => {
      if (left.rank !== right.rank) return left.rank - right.rank
      const nameOrder = left.file.name
        .toLowerCase()
        .localeCompare(right.file.name.toLowerCase())
      if (nameOrder !== 0) return nameOrder
      const parentOrder = compareText(left.file.parentPath, right.file.parentPath)
      if (parentOrder !== 0) return parentOrder
      return compareText(left.file.path.path, right.file.path.path)
    })
  return {
    results: ranked.slice(0, limit).map(({ file }) => file),
    truncated: ranked.length > limit,
  }
}

function matchRank(name: string, query: string): number | undefined {
  if (name === query) return 0
  if (name.startsWith(query)) return 1
  return name.includes(query) ? 2 : undefined
}

function compareText(left: string, right: string): number {
  const folded = left.toLowerCase().localeCompare(right.toLowerCase())
  return folded || left.localeCompare(right)
}
