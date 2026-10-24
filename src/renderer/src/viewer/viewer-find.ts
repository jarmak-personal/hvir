import { Text } from '@codemirror/state'
import { SearchQuery } from '@codemirror/search'

import { renderedFileType } from '../../../shared/viewer-types'
import type { ViewerTab } from './tab-state'

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
  readonly pending?: boolean
  readonly error?: boolean
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

export function viewerFindUnavailable(
  tab: Pick<ViewerTab, 'file' | 'loading' | 'mode' | 'path'>,
): string | undefined {
  if (!tab.file || tab.loading) return 'In-file find is unavailable while the file loads'
  if (tab.file.binary) {
    return renderedFileType(tab.path) === 'image'
      ? 'In-file find is unavailable for images'
      : 'In-file find is unavailable for binary files'
  }
  if (tab.mode !== 'rendered') return undefined
  const type = renderedFileType(tab.path)
  if (type === 'html') {
    return 'In-file find is unavailable in live rendered HTML'
  }
  if (type === 'image') return 'In-file find is unavailable for images'
  if (
    type === 'markdown' ||
    type === 'json' ||
    type === 'jsonl' ||
    type === 'yaml' ||
    type === 'csv' ||
    type === 'mermaid'
  ) {
    return undefined
  }
  return 'In-file find is unavailable in this rendered view'
}

export function createSearchQuery(query: ViewerFindQuery): SearchQuery {
  return new SearchQuery({
    search: query.text,
    caseSensitive: query.caseSensitive,
    literal: true,
  })
}

/** Bound both scanning and partial-prefix comparisons before using the render thread.
 * CodeMirror normalizes for matching, so raw byte/line counts alone aren't a work bound.
 */
export function canFindImmediately(
  documents: readonly Text[],
  query: ViewerFindQuery,
): boolean {
  if (
    query.text.length > 64 ||
    documents.reduce((sum, doc) => sum + doc.length, 0) > 2048
  )
    return false
  const normalizedLength = (value: string): number => {
    const normalized = value.normalize('NFKD')
    return (query.caseSensitive ? normalized : normalized.toLowerCase()).length
  }
  const documentLength = documents.reduce(
    (sum, doc) => sum + normalizedLength(doc.toString()),
    0,
  )
  return documentLength * Math.max(1, normalizedLength(query.text)) <= 32768
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
