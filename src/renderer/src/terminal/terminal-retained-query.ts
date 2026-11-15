import type { Disposer } from '../../../shared'
import type {
  TerminalEventLocation,
  TerminalEventProvenance,
  TerminalEventScreen,
  TerminalPane,
  TerminalRetainedBufferRange,
  TerminalRetainedBufferSearch,
} from './terminal-pane'

export interface TerminalRetainedOccurrence {
  readonly id: string
}
export interface TerminalRetainedQuerySnapshot {
  readonly revision: number
  readonly matchCount: number
  readonly pending: boolean
  readonly invalidated: boolean
  readonly unavailable?: true
  /** Sticky completion of the finite initial pass, independent of later streaming work. */
  readonly initialComplete?: boolean
}
export interface TerminalRetainedQuery {
  snapshot(): TerminalRetainedQuerySnapshot
  onUpdate(listener: () => void): Disposer
  at(index: number, signal?: AbortSignal): Promise<TerminalRetainedOccurrence | undefined>
  resolve(
    occurrence: TerminalRetainedOccurrence,
    signal?: AbortSignal,
  ): Promise<{ index: number } | undefined>
  reveal(occurrence: TerminalRetainedOccurrence, signal?: AbortSignal): Promise<boolean>
  read(
    occurrence: TerminalRetainedOccurrence,
    signal?: AbortSignal,
  ): Promise<string | undefined>
  clearReveal(): void
  dispose(): void
}
export interface TerminalRetainedQueryCapability {
  search(
    text: string,
    options: { caseSensitive: boolean; signal?: AbortSignal },
  ): Promise<TerminalRetainedQuery>
  cancelSearch(): void
  activeScreen(signal?: AbortSignal): Promise<TerminalEventScreen>
  resolveBoundary(
    boundary: TerminalEventProvenance,
    signal?: AbortSignal,
  ): Promise<TerminalEventLocation | undefined>
  captureEnd(signal?: AbortSignal): Promise<TerminalEventProvenance | undefined>
  revealBoundary(
    boundary: TerminalEventProvenance,
    signal?: AbortSignal,
  ): Promise<boolean>
  readRange(
    start: TerminalEventProvenance,
    end?: TerminalEventProvenance,
    signal?: AbortSignal,
  ): Promise<string>
  cancelExtraction(): void
}

function check(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Terminal query cancelled', 'AbortError')
}

/** Adapts the existing engine API without copying its result list or retained text. */
export function legacyTerminalRetainedQuery(
  pane: TerminalPane,
): TerminalRetainedQueryCapability {
  return {
    async search(text, options) {
      const result = await pane.searchRetainedBuffer(text, options)
      if (options.signal?.aborted) {
        result.dispose()
        check(options.signal)
      }
      return new LegacyQuery(result)
    },
    cancelSearch: () => pane.cancelRetainedBufferSearch(),
    activeScreen(signal) {
      check(signal)
      return Promise.resolve(pane.activeEventScreen())
    },
    resolveBoundary(boundary, signal) {
      check(signal)
      return Promise.resolve(pane.resolveEventProvenance(boundary))
    },
    captureEnd(signal) {
      check(signal)
      return Promise.resolve(pane.captureRetainedBufferBoundary())
    },
    revealBoundary(boundary, signal) {
      check(signal)
      const location = pane.resolveEventProvenance(boundary)
      return Promise.resolve(Boolean(location && pane.revealEventLocation(location)))
    },
    readRange: (start, end, signal) => {
      check(signal)
      const captured = end ?? pane.captureRetainedBufferBoundary()
      if (!captured) return Promise.reject(new Error('Terminal range end is unavailable'))
      return pane.extractRetainedBufferRange(start, captured, { signal })
    },
    cancelExtraction: () => pane.cancelRetainedBufferExtraction(),
  }
}

class LegacyQuery implements TerminalRetainedQuery {
  private revision = 0
  private disposed = false
  private readonly ranges = new WeakMap<
    TerminalRetainedOccurrence,
    { range: TerminalRetainedBufferRange; index: number; revision: number }
  >()
  private indexRevision = 0
  private matchList: readonly TerminalRetainedBufferRange[]
  private readonly listeners = new Set<() => void>()
  private readonly stop: Disposer
  constructor(private readonly result: TerminalRetainedBufferSearch) {
    this.matchList = result.matches
    this.stop = result.onUpdate(() => {
      this.revision++
      if (this.matchList !== result.matches) {
        this.matchList = result.matches
        this.indexRevision++
      }
      for (const listener of this.listeners) listener()
    })
  }
  snapshot(): TerminalRetainedQuerySnapshot {
    return {
      initialComplete: true,
      revision: this.revision,
      matchCount: this.disposed ? 0 : this.result.matches.length,
      pending: !this.disposed && this.result.pending,
      invalidated: this.disposed || this.result.invalidated,
    }
  }
  onUpdate(listener: () => void): Disposer {
    if (!this.disposed) this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  at(
    index: number,
    signal?: AbortSignal,
  ): Promise<TerminalRetainedOccurrence | undefined> {
    check(signal)
    const range = !this.disposed ? this.result.matches[index] : undefined
    if (!range) return Promise.resolve(undefined)
    const occurrence = Object.freeze({ id: String(range.id) })
    this.ranges.set(occurrence, { range, index, revision: this.indexRevision })
    return Promise.resolve(occurrence)
  }
  resolve(
    occurrence: TerminalRetainedOccurrence,
    signal?: AbortSignal,
  ): Promise<{ index: number } | undefined> {
    check(signal)
    const range = this.range(occurrence)
    if (!range || !this.result.resolve(range)) return Promise.resolve(undefined)
    const entry = this.ranges.get(occurrence)!
    if (entry.revision !== this.indexRevision) {
      entry.index = this.result.matches.findIndex(
        (candidate) => candidate.id === range.id,
      )
      entry.revision = this.indexRevision
    }
    return Promise.resolve(entry.index >= 0 ? { index: entry.index } : undefined)
  }
  reveal(occurrence: TerminalRetainedOccurrence, signal?: AbortSignal): Promise<boolean> {
    check(signal)
    const range = this.range(occurrence)
    return Promise.resolve(Boolean(range && this.result.reveal(range)))
  }
  read(
    occurrence: TerminalRetainedOccurrence,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    check(signal)
    const range = this.range(occurrence)
    return Promise.resolve(range ? this.result.extract(range) : undefined)
  }
  clearReveal(): void {
    this.result.clearReveal()
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.matchList = []
    void this.stop()
    this.listeners.clear()
    this.result.dispose()
  }
  private range(
    occurrence: TerminalRetainedOccurrence,
  ): TerminalRetainedBufferRange | undefined {
    return this.disposed ? undefined : this.ranges.get(occurrence)?.range
  }
}
