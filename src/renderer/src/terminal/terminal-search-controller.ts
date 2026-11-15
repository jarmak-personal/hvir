import type { Disposer } from '../../../shared'
import { legacyTerminalRetainedQuery } from './terminal-retained-query'
import { isNativeTerminalPane, type TerminalRuntimePane } from './terminal-pane'
import type {
  TerminalRetainedQueryCapability,
  TerminalRetainedQuery,
  TerminalRetainedOccurrence,
} from './terminal-retained-query'

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

/** Owns one pane's live query and one selected occurrence, never a result list. */
export class TerminalSearchController {
  private pane?: TerminalRuntimePane
  private capability?: TerminalRetainedQueryCapability
  private result?: TerminalRetainedQuery
  private resultUpdates?: Disposer
  private selected?: TerminalRetainedOccurrence
  private searchAbort?: AbortController
  private extractionAbort?: AbortController
  private generation = 0
  private navigation = 0
  private initialSelection = false
  private refreshRunning = false
  private refreshAgain = false
  private available = true
  private currentSnapshot = CLOSED_SEARCH
  private readonly listeners = new Set<() => void>()

  constructor(
    private readonly restoreFocus: () => void,
    private readonly extractRegion: (
      pane: TerminalRuntimePane,
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
  bind(pane: TerminalRuntimePane): void {
    if (this.pane === pane) return
    this.revoke()
    this.pane = pane
    this.capability =
      pane.retained ??
      (!isNativeTerminalPane(pane) ? legacyTerminalRetainedQuery(pane) : undefined)
  }
  setAvailable(available: boolean): void {
    this.available = available
    if (!available) this.close(false)
  }
  open(): boolean {
    if (!this.capability || !this.available) return false
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
    this.capability = undefined
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
  async navigate(direction: 'previous' | 'next'): Promise<void> {
    const result = this.result
    if (!result || !result.snapshot().matchCount) return
    this.initialSelection = false
    const navigation = ++this.navigation
    const generation = this.generation
    const signal = this.searchAbort?.signal
    const selected = this.selected
    try {
      const current = selected ? await result.resolve(selected, signal) : undefined
      if (!this.current(result, generation) || navigation !== this.navigation) return
      const count = result.snapshot().matchCount
      if (!count) return
      const index =
        current === undefined
          ? direction === 'next'
            ? 0
            : count - 1
          : direction === 'previous'
            ? (current.index - 1 + count) % count
            : (current.index + 1) % count
      const match = await result.at(index, signal)
      if (!this.current(result, generation) || navigation !== this.navigation) return
      if (!match || !(await result.reveal(match, signal))) {
        if (
          selected &&
          !(await result.resolve(selected, signal)) &&
          this.current(result, generation)
        )
          this.loseSelection()
        return
      }
      if (!this.current(result, generation) || navigation !== this.navigation) return
      this.selected = match
      const resolved = await result.resolve(match, signal)
      if (!this.current(result, generation) || navigation !== this.navigation) return
      if (!resolved) {
        this.loseSelection()
        return
      }
      this.publish({
        ...this.currentSnapshot,
        matchIndex: resolved.index,
        unavailable: false,
      })
    } catch {
      // Revoked navigation is an operation outcome, not terminal input failure.
    }
  }
  async currentMatchText(): Promise<string> {
    const selected = this.selected
    const result = this.result
    const generation = this.generation
    const text =
      selected && result
        ? await result.read(selected, this.searchAbort?.signal)
        : undefined
    if (!result || !this.current(result, generation) || this.selected !== selected)
      throw new Error('Terminal search is no longer current')
    if (text === undefined) {
      this.loseSelection()
      throw new Error('The current terminal match is no longer retained')
    }
    return text
  }
  /** Captured immediately before extraction; caller checks again before clipboard invocation. */
  copyGuard(): () => boolean {
    const generation = this.generation
    const navigation = this.navigation
    const pane = this.pane
    const selected = this.selected
    return () =>
      this.currentSnapshot.open &&
      this.pane === pane &&
      this.generation === generation &&
      this.navigation === navigation &&
      this.selected === selected
  }
  extractCurrentRegion(): Promise<string> {
    const pane = this.pane
    if (!pane || !this.currentSnapshot.open)
      return Promise.reject(new Error('Terminal search is no longer current'))
    this.extractionAbort?.abort()
    this.capability?.cancelExtraction()
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
    this.refresh()
  }
  private startSearch(selectInitial: boolean): void {
    this.releaseResult()
    this.cancelSearchRequest()
    this.initialSelection = selectInitial
    const capability = this.capability
    const query = this.currentSnapshot.query
    const generation = this.generation
    if (!capability || !this.currentSnapshot.open || !query.length) {
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
    void capability
      .search(query, {
        caseSensitive: this.currentSnapshot.caseSensitive,
        signal: controller.signal,
      })
      .then(
        (result) => {
          if (
            controller.signal.aborted ||
            generation !== this.generation ||
            !this.currentSnapshot.open
          ) {
            result.dispose()
            return
          }
          this.result = result
          this.resultUpdates = result.onUpdate(() => this.refresh())
          this.refresh()
        },
        () => {
          if (
            controller.signal.aborted ||
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
  private current(result: TerminalRetainedQuery, generation: number): boolean {
    return (
      this.result === result &&
      this.generation === generation &&
      this.currentSnapshot.open
    )
  }
  private refresh(): void {
    this.refreshAgain = true
    if (this.refreshRunning) return
    this.refreshRunning = true
    void this.refreshLoop().finally(() => {
      this.refreshRunning = false
      if (this.refreshAgain) this.refresh()
    })
  }
  private async refreshLoop(): Promise<void> {
    while (this.refreshAgain) {
      this.refreshAgain = false
      const result = this.result
      if (!result) return
      const generation = this.generation
      const snapshot = result.snapshot()
      if (snapshot.unavailable) {
        this.loseSelection()
        this.releaseResult()
        this.publish({
          ...this.currentSnapshot,
          pending: false,
          matchCount: 0,
          matchIndex: undefined,
          unavailable: true,
        })
        return
      }
      if (snapshot.invalidated) {
        this.loseSelection()
        this.publish({ ...this.currentSnapshot, pending: true, matchCount: 0 })
        this.startSearch(false)
        return
      }
      this.publish({
        ...this.currentSnapshot,
        pending: snapshot.pending,
        matchCount: snapshot.matchCount,
      })
      const selected = this.selected
      const navigation = this.navigation
      try {
        if (selected) {
          const resolved = await result.resolve(selected, this.searchAbort?.signal)
          if (
            !this.current(result, generation) ||
            this.selected !== selected ||
            navigation !== this.navigation
          )
            continue
          if (!resolved) this.loseSelection()
          else this.publish({ ...this.currentSnapshot, matchIndex: resolved.index })
        } else if (
          this.initialSelection &&
          (snapshot.initialComplete || !snapshot.pending) &&
          snapshot.matchCount > 0
        ) {
          this.initialSelection = false
          const match = await result.at(0, this.searchAbort?.signal)
          if (!this.current(result, generation) || navigation !== this.navigation)
            continue
          if (
            match &&
            (await result.reveal(match, this.searchAbort?.signal)) &&
            this.current(result, generation) &&
            navigation === this.navigation
          ) {
            this.selected = match
            const resolved = await result.resolve(match, this.searchAbort?.signal)
            if (
              this.current(result, generation) &&
              this.selected === match &&
              navigation === this.navigation
            ) {
              if (resolved)
                this.publish({
                  ...this.currentSnapshot,
                  matchIndex: resolved.index,
                  unavailable: false,
                })
              else this.loseSelection()
            }
          }
        }
      } catch {
        // A refusal/transport failure is not proof that the occurrence was overwritten.
        // Only an authoritative undefined resolution retires its identity.
      }
    }
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
    this.capability?.cancelExtraction()
  }
  private cancelSearchRequest(): void {
    this.generation++
    this.navigation++
    this.searchAbort?.abort()
    this.searchAbort = undefined
    this.capability?.cancelSearch()
  }
  private releaseResult(): void {
    void this.resultUpdates?.()
    this.resultUpdates = undefined
    const result = this.result
    this.result = undefined
    this.selected = undefined
    result?.dispose()
  }
  private publish(snapshot: TerminalSearchSnapshot): void {
    const current = this.currentSnapshot
    if (
      Object.keys(snapshot).every(
        (key) =>
          current[key as keyof TerminalSearchSnapshot] ===
          snapshot[key as keyof TerminalSearchSnapshot],
      )
    )
      return
    this.currentSnapshot = snapshot
    for (const listener of this.listeners) listener()
  }
}
