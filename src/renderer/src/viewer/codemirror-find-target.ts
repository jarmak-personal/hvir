import { StateEffect, StateField } from '@codemirror/state'
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view'

import {
  createSearchQuery,
  normalizeFindIndex,
  type ViewerFindQuery,
  type ViewerFindRange,
  type ViewerFindResult,
  type ViewerFindSide,
  type ViewerFindTarget,
} from './viewer-find'

interface FindDocument {
  readonly view: EditorView
  readonly side?: ViewerFindSide
}

interface CodeMirrorMatch extends ViewerFindRange {
  readonly document: FindDocument
}

interface FindDecorationState {
  readonly matches: readonly ViewerFindRange[]
  readonly active?: ViewerFindRange
}

const setFindDecorations = StateEffect.define<FindDecorationState>()
const matchMark = Decoration.mark({ class: 'cm-hvir-find-match' })
const activeMatchMark = Decoration.mark({
  class: 'cm-hvir-find-match cm-hvir-find-match-active',
})

export const viewerFindDecorations = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    let next = value.map(transaction.changes)
    for (const effect of transaction.effects) {
      if (!effect.is(setFindDecorations)) continue
      const { active, matches } = effect.value
      next = Decoration.set(
        matches.map((match) =>
          (active?.from === match.from && active.to === match.to
            ? activeMatchMark
            : matchMark
          ).range(match.from, match.to),
        ),
        true,
      )
    }
    return next
  },
  provide: (field) => EditorView.decorations.from(field),
})

export class CodeMirrorFindTarget implements ViewerFindTarget {
  readonly #listeners = new Set<() => void>()
  readonly #documents: readonly FindDocument[]
  readonly #revealMatches?: () => void
  #revealedMatches = false

  constructor(
    documents: readonly FindDocument[],
    options: { readonly revealMatches?: () => void } = {},
  ) {
    this.#documents = documents
    this.#revealMatches = options.revealMatches
  }

  update(query: ViewerFindQuery, requestedIndex: number): ViewerFindResult {
    if (!this.#revealedMatches && this.#revealMatches) {
      this.#revealedMatches = true
      this.#revealMatches()
    }
    const searchQuery = createSearchQuery(query)
    const matches: CodeMirrorMatch[] = []
    const byDocument = new Map<FindDocument, ViewerFindRange[]>()
    for (const document of this.#documents) {
      const documentMatches: ViewerFindRange[] = []
      byDocument.set(document, documentMatches)
      if (!searchQuery.valid) continue
      const cursor = searchQuery.getCursor(document.view.state)
      for (let next = cursor.next(); !next.done; next = cursor.next()) {
        const match = { from: next.value.from, to: next.value.to }
        documentMatches.push(match)
        matches.push({ document, ...match })
      }
    }

    const index = normalizeFindIndex(requestedIndex, matches.length)
    const active = matches[index]
    for (const document of this.#documents) {
      const activeRange =
        active?.document === document ? { from: active.from, to: active.to } : undefined
      document.view.dispatch({
        effects: setFindDecorations.of({
          matches: byDocument.get(document) ?? [],
          ...(activeRange ? { active: activeRange } : {}),
        }),
        ...(activeRange
          ? {
              selection: { anchor: activeRange.from, head: activeRange.to },
              scrollIntoView: true,
            }
          : {}),
      })
    }
    if (!active) return { current: 0, total: 0 }
    return {
      current: index + 1,
      total: matches.length,
      ...(active.document.side ? { side: active.document.side } : {}),
    }
  }

  clear(): void {
    for (const { view } of this.#documents) {
      view.dispatch({ effects: setFindDecorations.of({ matches: [] }) })
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
