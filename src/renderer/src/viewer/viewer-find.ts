import { Text } from '@codemirror/state'
import { SearchQuery } from '@codemirror/search'

export interface ViewerFindQuery {
  readonly text: string
  readonly caseSensitive: boolean
}

export interface ViewerFindRange {
  readonly from: number
  readonly to: number
}

export type ViewerFindSide = 'base' | 'current'

export interface ViewerFindResult {
  readonly current: number
  readonly total: number
  readonly side?: ViewerFindSide
}

export interface ViewerFindTarget {
  update(query: ViewerFindQuery, requestedIndex: number): ViewerFindResult
  clear(): void
  subscribe(listener: () => void): () => void
}

export type RegisterViewerFindTarget = (target: ViewerFindTarget) => () => void

export function createSearchQuery(query: ViewerFindQuery): SearchQuery {
  return new SearchQuery({
    search: query.text,
    caseSensitive: query.caseSensitive,
    literal: true,
  })
}

export function findLiteralRanges(
  content: string,
  query: ViewerFindQuery,
): readonly ViewerFindRange[] {
  if (!query.text) return []
  const cursor = createSearchQuery(query).getCursor(Text.of(content.split('\n')))
  const ranges: ViewerFindRange[] = []
  for (let next = cursor.next(); !next.done; next = cursor.next()) {
    ranges.push({ from: next.value.from, to: next.value.to })
  }
  return ranges
}

export function normalizeFindIndex(requestedIndex: number, total: number): number {
  if (total <= 0) return 0
  return ((Math.trunc(requestedIndex) % total) + total) % total
}
