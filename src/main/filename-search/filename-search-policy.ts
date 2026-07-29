import { FILENAME_SEARCH_RESULT_LIMIT, type FilenameSearchResult } from '../../shared'

export type IndexedFilename = FilenameSearchResult

export interface RankedFilenameSearch {
  readonly results: readonly FilenameSearchResult[]
  readonly truncated: boolean
}

/** Fixed basename-only, case-insensitive literal and `*` wildcard policy. */
export function rankFilenameMatches(
  files: readonly IndexedFilename[],
  query: string,
  limit = FILENAME_SEARCH_RESULT_LIMIT,
): RankedFilenameSearch {
  const needle = query.toLowerCase()
  if (needle.length === 0) return { results: [], truncated: false }
  const wildcard = needle.includes('*')
  const ranked = files
    .map((file) => ({
      file,
      rank: wildcard
        ? matchesWildcard(file.name.toLowerCase(), needle)
          ? 3
          : undefined
        : matchRank(file.name.toLowerCase(), needle),
    }))
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

function matchesWildcard(name: string, pattern: string): boolean {
  let nameIndex = 0
  let patternIndex = 0
  let starIndex = -1
  let starMatchIndex = 0

  while (nameIndex < name.length) {
    if (pattern[patternIndex] === name[nameIndex]) {
      nameIndex += 1
      patternIndex += 1
    } else if (pattern[patternIndex] === '*') {
      starIndex = patternIndex
      starMatchIndex = nameIndex
      patternIndex += 1
    } else if (starIndex >= 0) {
      starMatchIndex += 1
      nameIndex = starMatchIndex
      patternIndex = starIndex + 1
    } else {
      return false
    }
  }

  while (pattern[patternIndex] === '*') patternIndex += 1
  return patternIndex === pattern.length
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
