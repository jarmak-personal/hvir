import { EditorView } from '@codemirror/view'
import { search, setSearchQuery } from '@codemirror/search'

import {
  createSearchQuery,
  normalizeFindIndex,
  type ViewerFindQuery,
  type ViewerFindResult,
  type ViewerFindSide,
  type ViewerFindTarget,
} from './viewer-find'

export const viewerSearch = search({ top: false })

interface FindDocument {
  readonly view: EditorView
  readonly side?: ViewerFindSide
}

interface CodeMirrorMatch {
  readonly document: FindDocument
  readonly from: number
  readonly to: number
}

export class CodeMirrorFindTarget implements ViewerFindTarget {
  readonly #listeners = new Set<() => void>()
  readonly #documents: readonly FindDocument[]

  constructor(documents: readonly FindDocument[]) {
    this.#documents = documents
  }

  update(query: ViewerFindQuery, requestedIndex: number): ViewerFindResult {
    const searchQuery = createSearchQuery(query)
    const matches: CodeMirrorMatch[] = []
    for (const document of this.#documents) {
      document.view.dispatch({ effects: setSearchQuery.of(searchQuery) })
      if (!searchQuery.valid) continue
      const cursor = searchQuery.getCursor(document.view.state)
      for (let next = cursor.next(); !next.done; next = cursor.next()) {
        matches.push({ document, ...next.value })
      }
    }
    if (matches.length === 0) return { current: 0, total: 0 }

    const index = normalizeFindIndex(requestedIndex, matches.length)
    const active = matches[index]
    if (!active) return { current: 0, total: 0 }
    active.document.view.dispatch({
      selection: { anchor: active.from, head: active.to },
      effects: EditorView.scrollIntoView(active.from, { y: 'center' }),
    })
    return {
      current: index + 1,
      total: matches.length,
      ...(active.document.side ? { side: active.document.side } : {}),
    }
  }

  clear(): void {
    const empty = createSearchQuery({ text: '', caseSensitive: false })
    for (const { view } of this.#documents) {
      view.dispatch({ effects: setSearchQuery.of(empty) })
    }
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  contentChanged(): void {
    for (const listener of this.#listeners) listener()
  }
}
