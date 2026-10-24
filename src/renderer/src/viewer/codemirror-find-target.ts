import type { Text } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { setFindDecorations } from './find-decorations'
import { FindMatchIndex } from './find-match-index'
import { createFindWorker } from './find-worker'
import type { FindWorkerResponse } from './find-worker-protocol'
import {
  normalizeFindIndex,
  canFindImmediately,
  createSearchQuery,
  type ViewerFindQuery,
  type ViewerFindResult,
  type ViewerFindSide,
  type ViewerFindTarget,
} from './viewer-find'

export { viewerFindDecorations } from './find-decorations'

interface FindDocument {
  readonly view: EditorView
  readonly side?: ViewerFindSide
}

export class CodeMirrorFindTarget implements ViewerFindTarget {
  readonly #listeners = new Set<() => void>()
  readonly #documents: readonly FindDocument[]
  readonly #revealMatches?: () => void
  #revealedMatches = false
  #query?: ViewerFindQuery
  #snapshots: readonly Text[] = []
  #matches: FindMatchIndex[] = []
  #pending = false
  #error = false
  #cancel?: () => void

  constructor(
    documents: readonly FindDocument[],
    options: { readonly revealMatches?: () => void } = {},
  ) {
    this.#documents = documents
    this.#revealMatches = options.revealMatches
  }

  update(query: ViewerFindQuery, requestedIndex: number): ViewerFindResult {
    if (!query.text) {
      this.clear()
      return { current: 0, total: 0 }
    }
    if (!this.#revealedMatches && this.#revealMatches) {
      this.#revealedMatches = true
      this.#revealMatches()
    }
    if (
      query.text !== this.#query?.text ||
      query.caseSensitive !== this.#query.caseSensitive ||
      this.#documents.some(({ view }, i) => view.state.doc !== this.#snapshots[i])
    ) {
      this.#start(query)
    }
    if (this.#error) return { current: 0, total: 0, error: true }
    if (this.#pending) return { current: 0, total: 0, pending: true }
    const total = this.#matches.reduce((sum, matches) => sum + matches.length, 0)
    const index = normalizeFindIndex(requestedIndex, total)
    let offset = index
    let side: ViewerFindSide | undefined
    for (const [i, document] of this.#documents.entries()) {
      const matches = this.#matches[i]!
      const active =
        offset >= 0 && offset < matches.length ? matches.at(offset) : undefined
      if (active) side = document.side
      document.view.dispatch({
        effects: setFindDecorations.of({ matches, active }),
        ...(active
          ? { selection: { anchor: active.from, head: active.to }, scrollIntoView: true }
          : {}),
      })
      offset -= matches.length
    }
    return { current: total ? index + 1 : 0, total, ...(side ? { side } : {}) }
  }

  #start(query: ViewerFindQuery): void {
    this.clear()
    this.#query = { ...query }
    this.#snapshots = this.#documents.map(({ view }) => view.state.doc)
    this.#matches = this.#documents.map(() => new FindMatchIndex())
    if (canFindImmediately(this.#snapshots, query)) {
      const search = createSearchQuery(query)
      for (const [i, doc] of this.#snapshots.entries()) {
        const ranges: number[] = []
        const cursor = search.getCursor(doc)
        for (let next = cursor.next(); !next.done; next = cursor.next()) {
          ranges.push(next.value.from, next.value.to)
        }
        if (ranges.length) this.#matches[i]!.append(Uint32Array.from(ranges))
      }
      return
    }
    this.#pending = true
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    let worker: Worker | undefined
    const cancel = (): void => {
      active = false
      clearTimeout(timer)
      worker?.terminate()
      this.#cancel = undefined
    }
    this.#cancel = cancel
    const fail = (): void => {
      if (!active) return
      cancel()
      this.#pending = false
      this.#error = true
      this.#matches = []
      this.#notify()
    }
    try {
      worker = createFindWorker()
      let completed = 0
      worker.onmessage = ({ data }: MessageEvent<FindWorkerResponse>): void => {
        if (!active) return
        if (
          this.#documents.some(({ view }, i) => view.state.doc !== this.#snapshots[i])
        ) {
          this.contentChanged()
          return
        }
        if (data.type === 'matches') this.#matches[data.document]!.append(data.ranges)
        else if (++completed === this.#documents.length) {
          cancel()
          this.#pending = false
          this.#notify()
        }
      }
      worker.onerror = fail
      let document = 0
      let from = 0
      const send = (): void => {
        if (!active) return
        try {
          const doc = this.#snapshots[document]!
          const to = Math.min(from + 32768, doc.length)
          worker!.postMessage({ type: 'chunk', content: doc.sliceString(from, to) })
          from = to
          if (from === doc.length) {
            worker!.postMessage({ type: 'search', document, query })
            document++
            from = 0
          }
          if (document < this.#snapshots.length) timer = setTimeout(send, 0)
        } catch {
          fail()
        }
      }
      timer = setTimeout(send, 0)
    } catch {
      fail()
    }
  }

  clear(): void {
    this.#cancel?.()
    this.#query = undefined
    this.#snapshots = []
    this.#matches = []
    this.#pending = false
    this.#error = false
    for (const { view } of this.#documents) {
      view.dispatch({ effects: setFindDecorations.of({}) })
    }
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  contentChanged(): void {
    // An editor update listener cannot dispatch a nested transaction.
    this.#cancel?.()
    this.#query = undefined
    this.#matches = []
    this.#snapshots = []
    this.#pending = false
    this.#notify()
  }

  #notify(): void {
    for (const listener of this.#listeners) listener()
  }
}
