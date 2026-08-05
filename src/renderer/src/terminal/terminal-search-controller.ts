import type { TerminalPane, TerminalRetainedBufferSearch } from './terminal-pane'

export interface TerminalSearchSnapshot {
  readonly open: boolean
  readonly query: string
  readonly caseSensitive: boolean
  readonly pending: boolean
  readonly matchCount: number
  readonly matchIndex?: number
}

const CLOSED_SEARCH: TerminalSearchSnapshot = {
  open: false,
  query: '',
  caseSensitive: false,
  pending: false,
  matchCount: 0,
}

/** Owns one exact pane's ephemeral query, native snapshot, and cancellation. */
export class TerminalSearchController {
  private pane?: TerminalPane
  private result?: TerminalRetainedBufferSearch
  private searchAbort?: AbortController
  private extractionAbort?: AbortController
  private generation = 0
  private available = true
  private currentSnapshot = CLOSED_SEARCH
  private readonly listeners = new Set<() => void>()

  constructor(
    private readonly restoreFocus: () => void,
    private readonly extractRegion: (
      pane: TerminalPane,
      signal: AbortSignal,
    ) => Promise<string>,
  ) {}

  snapshot = (): TerminalSearchSnapshot => this.currentSnapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  bind(pane: TerminalPane): void {
    if (this.pane === pane) return
    this.revoke()
    this.pane = pane
  }

  setAvailable(available: boolean): void {
    this.available = available
    if (!available) this.close(false)
  }

  open(): boolean {
    if (!this.pane || !this.available) return false
    if (!this.currentSnapshot.open) this.publish({ ...CLOSED_SEARCH, open: true })
    return true
  }

  close(restoreFocus = false): void {
    this.cancelOwnedWork()
    if (this.currentSnapshot !== CLOSED_SEARCH) this.publish(CLOSED_SEARCH)
    if (restoreFocus && this.pane && this.available) this.restoreFocus()
  }

  revoke(): void {
    this.close(false)
    this.pane = undefined
  }

  setQuery(query: string): void {
    if (!this.currentSnapshot.open || query === this.currentSnapshot.query) return
    this.publish({
      ...this.currentSnapshot,
      query,
      pending: query.length > 0,
      matchCount: 0,
      matchIndex: undefined,
    })
    this.startSearch()
  }

  setCaseSensitive(caseSensitive: boolean): void {
    if (
      !this.currentSnapshot.open ||
      caseSensitive === this.currentSnapshot.caseSensitive
    ) {
      return
    }
    this.publish({
      ...this.currentSnapshot,
      caseSensitive,
      pending: this.currentSnapshot.query.length > 0,
      matchCount: 0,
      matchIndex: undefined,
    })
    this.startSearch()
  }

  navigate(direction: 'previous' | 'next'): void {
    const result = this.result
    const count = result?.matches.length ?? 0
    if (!result || count === 0) return
    const current = this.currentSnapshot.matchIndex ?? 0
    const index =
      direction === 'previous' ? (current - 1 + count) % count : (current + 1) % count
    const match = result.matches[index]
    if (!match || !result.reveal(match)) {
      this.invalidateAndRefresh()
      return
    }
    this.publish({ ...this.currentSnapshot, matchIndex: index })
  }

  currentMatchText(): string {
    const result = this.result
    const index = this.currentSnapshot.matchIndex
    const match = index === undefined ? undefined : result?.matches[index]
    const text = match ? result?.extract(match) : undefined
    if (text === undefined) {
      this.invalidateAndRefresh()
      throw new Error('The current terminal match is no longer retained')
    }
    return text
  }

  extractCurrentRegion(): Promise<string> {
    const pane = this.pane
    if (!pane || !this.currentSnapshot.open) {
      return Promise.reject(new Error('Terminal search is no longer current'))
    }
    this.extractionAbort?.abort()
    pane.cancelRetainedBufferExtraction()
    const controller = new AbortController()
    this.extractionAbort = controller
    let extraction: Promise<string>
    try {
      extraction = this.extractRegion(pane, controller.signal)
    } catch (error) {
      extraction = Promise.reject(
        error instanceof Error ? error : new Error('Terminal region extraction failed'),
      )
    }
    return extraction.finally(() => {
      if (this.extractionAbort === controller) this.extractionAbort = undefined
    })
  }

  retainedBufferChanged(): void {
    if (!this.currentSnapshot.open || this.currentSnapshot.query.length === 0) return
    this.invalidateAndRefresh()
  }

  private startSearch(): void {
    const pane = this.pane
    const query = this.currentSnapshot.query
    this.releaseResult()
    this.searchAbort?.abort()
    pane?.cancelRetainedBufferSearch()
    const generation = ++this.generation
    if (!pane || !this.currentSnapshot.open || query.length === 0) {
      this.searchAbort = undefined
      this.publish({
        ...this.currentSnapshot,
        pending: false,
        matchCount: 0,
        matchIndex: undefined,
      })
      return
    }
    const controller = new AbortController()
    this.searchAbort = controller
    const caseSensitive = this.currentSnapshot.caseSensitive
    void pane
      .searchRetainedBuffer(query, { caseSensitive, signal: controller.signal })
      .then(
        (result) => {
          if (
            controller.signal.aborted ||
            this.pane !== pane ||
            generation !== this.generation ||
            !this.currentSnapshot.open
          ) {
            result.dispose()
            return
          }
          this.searchAbort = undefined
          this.result = result
          const matchIndex = result.matches.length > 0 ? 0 : undefined
          const first = matchIndex === undefined ? undefined : result.matches[matchIndex]
          if (first && !result.reveal(first)) {
            this.invalidateAndRefresh()
            return
          }
          this.publish({
            ...this.currentSnapshot,
            pending: false,
            matchCount: result.matches.length,
            matchIndex,
          })
        },
        () => {
          if (
            controller.signal.aborted ||
            this.pane !== pane ||
            generation !== this.generation ||
            !this.currentSnapshot.open
          ) {
            return
          }
          this.searchAbort = undefined
          this.publish({
            ...this.currentSnapshot,
            pending: false,
            matchCount: 0,
            matchIndex: undefined,
          })
        },
      )
  }

  private invalidateAndRefresh(): void {
    this.publish({
      ...this.currentSnapshot,
      pending: this.currentSnapshot.query.length > 0,
      matchCount: 0,
      matchIndex: undefined,
    })
    this.startSearch()
  }

  private cancelOwnedWork(): void {
    this.generation += 1
    this.searchAbort?.abort()
    this.searchAbort = undefined
    this.extractionAbort?.abort()
    this.extractionAbort = undefined
    this.pane?.cancelRetainedBufferSearch()
    this.pane?.cancelRetainedBufferExtraction()
    this.releaseResult()
  }

  private releaseResult(): void {
    this.result?.dispose()
    this.result = undefined
  }

  private publish(snapshot: TerminalSearchSnapshot): void {
    this.currentSnapshot = snapshot
    for (const listener of this.listeners) listener()
  }
}
