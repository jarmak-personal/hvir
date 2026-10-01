import type {
  TerminalPane,
  TerminalRetainedBufferRange,
  TerminalRetainedBufferSearch,
} from './terminal-pane'

export interface TerminalSearchSnapshot {
  readonly open: boolean
  readonly query: string
  readonly caseSensitive: boolean
  readonly pending: boolean
  readonly matchCount: number
  readonly matchIndex?: number
  readonly unavailable: boolean
}

const CLOSED_SEARCH: TerminalSearchSnapshot = {
  open: false,
  query: '',
  caseSensitive: false,
  pending: false,
  matchCount: 0,
  unavailable: false,
}

/** Owns one pane's query subscription and selected logical occurrence. */
export class TerminalSearchController {
  private pane?: TerminalPane
  private result?: TerminalRetainedBufferSearch
  private resultUpdates?: () => void
  private selected?: TerminalRetainedBufferRange
  private matches?: readonly TerminalRetainedBufferRange[]
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
    return () => {
      this.listeners.delete(listener)
    }
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
      unavailable: false,
    })
    this.startSearch(true)
  }
  setCaseSensitive(caseSensitive: boolean): void {
    if (
      !this.currentSnapshot.open ||
      caseSensitive === this.currentSnapshot.caseSensitive
    )
      return
    this.publish({
      ...this.currentSnapshot,
      caseSensitive,
      pending: this.currentSnapshot.query.length > 0,
      matchCount: 0,
      matchIndex: undefined,
      unavailable: false,
    })
    this.startSearch(true)
  }

  navigate(direction: 'previous' | 'next'): void {
    const result = this.result
    const count = result?.matches.length ?? 0
    if (!result || count === 0) return
    const current = this.selected
      ? result.matches.findIndex((match) => match.id === this.selected?.id)
      : -1
    const index =
      current < 0
        ? direction === 'next'
          ? 0
          : count - 1
        : direction === 'previous'
          ? (current - 1 + count) % count
          : (current + 1) % count
    const match = result.matches[index]
    if (!match || !result.reveal(match)) {
      this.loseSelection()
      return
    }
    this.selected = match
    this.publish({ ...this.currentSnapshot, matchIndex: index, unavailable: false })
  }

  currentMatchText(): string {
    const text = this.selected ? this.result?.extract(this.selected) : undefined
    if (text === undefined) {
      this.loseSelection()
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
    // Revalidate presentation-only changes. Writes and refresh scheduling are
    // observed through the engine query subscription.
    if (this.result) this.updateResult()
  }

  private startSearch(selectInitial: boolean): void {
    const pane = this.pane
    const query = this.currentSnapshot.query
    this.releaseResult()
    this.cancelSearchRequest()
    const generation = this.generation
    if (!pane || !this.currentSnapshot.open || query.length === 0) {
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
    void pane
      .searchRetainedBuffer(query, {
        caseSensitive: this.currentSnapshot.caseSensitive,
        signal: controller.signal,
      })
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
          this.result = result
          this.resultUpdates = result.onUpdate(() => {
            if (this.result === result && generation === this.generation)
              this.updateResult()
          })
          const first = selectInitial ? result.matches[0] : undefined
          if (first) {
            if (result.reveal(first)) this.selected = first
            else this.loseSelection()
          }
          this.updateResult()
        },
        () => {
          if (
            controller.signal.aborted ||
            this.pane !== pane ||
            generation !== this.generation ||
            !this.currentSnapshot.open
          )
            return
          this.releaseResult()
          this.publish({
            ...this.currentSnapshot,
            pending: false,
            matchCount: 0,
            matchIndex: undefined,
          })
        },
      )
  }

  private updateResult(): void {
    const result = this.result
    if (!result) return
    if (result.invalidated) {
      this.loseSelection()
      this.publish({ ...this.currentSnapshot, pending: true, matchCount: 0 })
      this.startSearch(false)
      return
    }
    if (this.selected && !result.resolve(this.selected)) this.loseSelection()
    const index = this.selected
      ? result.matches === this.matches
        ? (this.currentSnapshot.matchIndex ?? -1)
        : result.matches.findIndex((match) => match.id === this.selected?.id)
      : -1
    this.matches = result.matches
    // Updates adjust counts and coordinates without revealing any occurrence.
    this.publish({
      ...this.currentSnapshot,
      pending: result.pending,
      matchCount: result.matches.length,
      matchIndex: index >= 0 ? index : undefined,
    })
  }

  private loseSelection(): void {
    const lost = this.selected !== undefined
    this.selected = undefined
    this.result?.clearReveal()
    this.publish({
      ...this.currentSnapshot,
      matchIndex: undefined,
      unavailable: this.currentSnapshot.unavailable || lost,
    })
  }

  private cancelOwnedWork(): void {
    this.releaseResult()
    this.cancelSearchRequest()
    this.extractionAbort?.abort()
    this.extractionAbort = undefined
    this.pane?.cancelRetainedBufferSearch()
    this.pane?.cancelRetainedBufferExtraction()
  }
  private cancelSearchRequest(): void {
    this.generation += 1
    this.searchAbort?.abort()
    this.searchAbort = undefined
    this.pane?.cancelRetainedBufferSearch()
  }
  private releaseResult(): void {
    this.resultUpdates?.()
    this.resultUpdates = undefined
    const result = this.result
    this.result = undefined
    this.selected = undefined
    this.matches = undefined
    result?.dispose()
  }
  private publish(snapshot: TerminalSearchSnapshot): void {
    const current = this.currentSnapshot
    if (
      current.open === snapshot.open &&
      current.query === snapshot.query &&
      current.caseSensitive === snapshot.caseSensitive &&
      current.pending === snapshot.pending &&
      current.matchCount === snapshot.matchCount &&
      current.matchIndex === snapshot.matchIndex &&
      current.unavailable === snapshot.unavailable
    )
      return
    this.currentSnapshot = snapshot
    for (const listener of this.listeners) listener()
  }
}
