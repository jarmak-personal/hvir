import {
  validNativeTerminalQueryResponse,
  validNativeTerminalQueryUpdate,
  type NativeTerminalQueryRequest,
  type NativeTerminalQueryResponse,
  type NativeTerminalQuerySnapshot,
  type NativeTerminalQueryUpdate,
} from '../../../shared/native-terminal-query'
import type { TerminalEventProvenance } from './terminal-pane'
import type {
  TerminalRetainedOccurrence,
  TerminalRetainedQuery,
  TerminalRetainedQueryCapability,
  TerminalRetainedQuerySnapshot,
} from './terminal-retained-query'

type Intent = NativeTerminalQueryRequest extends infer Request
  ? Request extends NativeTerminalQueryRequest
    ? Omit<Request, 'viewId' | 'requestId'>
    : never
  : never
export interface NativeTerminalRetainedPort {
  view(): string | undefined
  invoke(request: NativeTerminalQueryRequest): Promise<NativeTerminalQueryResponse>
  cancel(viewId: string, requestId: string): void
  updates(listener: (update: NativeTerminalQueryUpdate) => void): () => void
}

/** Revocable query intentions only; native owns result metadata and every text cursor. */
export class NativeTerminalRetained implements TerminalRetainedQueryCapability {
  private generation = 0
  private query?: NativeQuery
  private early?: NativeTerminalQueryUpdate & { initialComplete: boolean }
  private readonly pending = new Set<AbortController>()
  private readonly queryRequests = new Set<AbortController>()
  private readonly extractions = new Set<AbortController>()
  private readonly stop: () => void
  constructor(private readonly port: NativeTerminalRetainedPort) {
    this.stop = port.updates((update) => {
      if (!validNativeTerminalQueryUpdate(update) || update.viewId !== port.view()) return
      if (this.query?.id === update.queryId) this.query.update(update.snapshot)
      else
        this.early = {
          ...update,
          initialComplete:
            (!update.snapshot.pending &&
              !update.snapshot.invalidated &&
              !update.snapshot.unavailable) ||
            Boolean(this.early?.queryId === update.queryId && this.early.initialComplete),
        }
    })
  }
  async search(
    text: string,
    options: { caseSensitive: boolean; signal?: AbortSignal },
  ): Promise<TerminalRetainedQuery> {
    this.cancelSearch()
    const generation = this.generation
    const viewId = this.view()
    const response = await this.call(
      { kind: 'begin', text, caseSensitive: options.caseSensitive },
      options.signal,
      false,
      (value) => {
        if (
          value.kind === 'query' &&
          (generation !== this.generation ||
            viewId !== this.port.view() ||
            options.signal?.aborted)
        )
          this.cleanup(viewId, { kind: 'close', queryId: value.queryId })
      },
    )
    if (generation !== this.generation)
      throw new DOMException('Terminal query cancelled', 'AbortError')
    if (response.kind !== 'query')
      throw new Error('Invalid terminal query begin response')
    const query: NativeQuery = new NativeQuery(
      response.queryId,
      response.snapshot,
      (intent, signal) => this.call(intent, signal),
      (intent) => this.cleanup(viewId, intent),
      () =>
        this.query === query &&
        generation === this.generation &&
        this.port.view() === viewId,
    )
    this.query = query
    const early = this.early
    if (early?.queryId === query.id) query.update(early.snapshot, early.initialComplete)
    this.early = undefined
    return query
  }
  cancelSearch(): void {
    this.generation++
    for (const controller of this.queryRequests) controller.abort()
    this.query?.dispose()
    this.query = undefined
    this.early = undefined
  }
  async activeScreen(signal?: AbortSignal) {
    const response = await this.call({ kind: 'active-screen' }, signal)
    if (response.kind !== 'screen') throw new Error('Invalid terminal screen response')
    return response.screen
  }
  async resolveBoundary(boundary: TerminalEventProvenance, signal?: AbortSignal) {
    if (!boundary.boundaryId) return undefined
    const response = await this.call(
      { kind: 'boundary-resolve', boundaryId: boundary.boundaryId },
      signal,
    )
    if (response.kind !== 'boundary')
      throw new Error('Invalid terminal boundary response')
    return response.location
  }
  async revealBoundary(
    boundary: TerminalEventProvenance,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (!boundary.boundaryId) return false
    const response = await this.call(
      { kind: 'boundary-reveal', boundaryId: boundary.boundaryId },
      signal,
    )
    if (response.kind !== 'revealed') throw new Error('Invalid terminal boundary reveal')
    return response.revealed
  }
  async readRange(
    start: TerminalEventProvenance,
    end?: TerminalEventProvenance,
    signal?: AbortSignal,
  ): Promise<string> {
    if (!start.boundaryId || (end && !end.boundaryId))
      throw new Error('Terminal boundaries are unavailable')
    const response = await this.call(
      {
        kind: 'range-read',
        startId: start.boundaryId,
        ...(end ? { endId: end.boundaryId } : {}),
      },
      signal,
      true,
    )
    if (response.kind !== 'text' || response.text === undefined)
      throw new Error('Terminal range is no longer retained')
    return response.text
  }
  cancelExtraction(): void {
    for (const controller of this.extractions) controller.abort()
  }
  revoke(): void {
    this.cancelSearch()
    for (const controller of this.pending) controller.abort()
  }
  dispose(): void {
    this.revoke()
    this.stop()
  }
  private view(): string {
    const view = this.port.view()
    if (!view) throw new Error('Terminal query view is unavailable')
    return view
  }
  private cleanup(viewId: string, intent: Intent): void {
    void this.port
      .invoke({ ...intent, viewId, requestId: crypto.randomUUID() })
      .catch(() => undefined)
  }
  private async call(
    intent: Intent,
    signal?: AbortSignal,
    extraction = false,
    settled?: (response: NativeTerminalQueryResponse) => void,
  ): Promise<NativeTerminalQueryResponse> {
    const viewId = this.view()
    const requestId = crypto.randomUUID()
    const controller = new AbortController()
    const abort = () => controller.abort()
    if (signal?.aborted) throw new DOMException('Terminal query cancelled', 'AbortError')
    signal?.addEventListener('abort', abort, { once: true })
    const cancel = () => this.port.cancel(viewId, requestId)
    controller.signal.addEventListener('abort', cancel, { once: true })
    this.pending.add(controller)
    if ('queryId' in intent || intent.kind === 'begin') this.queryRequests.add(controller)
    if (extraction) this.extractions.add(controller)
    try {
      const response = await this.port.invoke({ ...intent, viewId, requestId })
      if (!validNativeTerminalQueryResponse(response))
        throw new Error('Invalid terminal query response')
      settled?.(response)
      if (controller.signal.aborted || viewId !== this.port.view())
        throw new DOMException('Terminal query cancelled', 'AbortError')
      return response
    } finally {
      signal?.removeEventListener('abort', abort)
      controller.signal.removeEventListener('abort', cancel)
      this.pending.delete(controller)
      this.queryRequests.delete(controller)
      this.extractions.delete(controller)
    }
  }
}

class NativeQuery implements TerminalRetainedQuery {
  private disposed = false
  private readonly occurrences = new WeakSet<TerminalRetainedOccurrence>()
  private readonly listeners = new Set<() => void>()
  constructor(
    readonly id: string,
    private state: TerminalRetainedQuerySnapshot,
    private readonly call: (
      intent: Intent,
      signal?: AbortSignal,
    ) => Promise<NativeTerminalQueryResponse>,
    private readonly cleanup: (intent: Intent) => void,
    private readonly current: () => boolean,
  ) {
    this.state = {
      ...state,
      initialComplete: !state.pending && !state.invalidated && !state.unavailable,
    }
  }
  snapshot() {
    return this.disposed
      ? { ...this.state, matchCount: 0, pending: false, invalidated: true }
      : this.state
  }
  update(snapshot: NativeTerminalQuerySnapshot, initialComplete = false): void {
    if (this.disposed) return
    const complete = Boolean(
      this.state.initialComplete ||
      initialComplete ||
      (!snapshot.pending && !snapshot.invalidated && !snapshot.unavailable),
    )
    this.state =
      snapshot.revision < this.state.revision
        ? { ...this.state, initialComplete: complete }
        : { ...snapshot, initialComplete: complete }
    for (const listener of this.listeners) listener()
  }
  onUpdate(listener: () => void) {
    if (!this.disposed) this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  async at(
    index: number,
    signal?: AbortSignal,
  ): Promise<TerminalRetainedOccurrence | undefined> {
    this.assertCurrent()
    const response = await this.call({ kind: 'at', queryId: this.id, index }, signal)
    this.assertCurrent()
    if (response.kind !== 'occurrence')
      throw new Error('Invalid terminal occurrence response')
    if (response.occurrenceId === undefined) return undefined
    const occurrence = Object.freeze({ id: response.occurrenceId })
    this.occurrences.add(occurrence)
    return occurrence
  }
  async resolve(occurrence: TerminalRetainedOccurrence, signal?: AbortSignal) {
    if (!this.accepts(occurrence)) return undefined
    const response = await this.call(
      { kind: 'resolve', queryId: this.id, occurrenceId: occurrence.id },
      signal,
    )
    this.assertCurrent()
    if (response.kind !== 'resolved')
      throw new Error('Invalid terminal occurrence resolution')
    return response.index === undefined ? undefined : { index: response.index }
  }
  async reveal(
    occurrence: TerminalRetainedOccurrence,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (!this.accepts(occurrence)) return false
    const response = await this.call(
      { kind: 'reveal', queryId: this.id, occurrenceId: occurrence.id },
      signal,
    )
    this.assertCurrent()
    if (response.kind !== 'revealed') throw new Error('Invalid terminal query reveal')
    return response.revealed
  }
  async read(
    occurrence: TerminalRetainedOccurrence,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    if (!this.accepts(occurrence)) return undefined
    const response = await this.call(
      { kind: 'read', queryId: this.id, occurrenceId: occurrence.id },
      signal,
    )
    this.assertCurrent()
    if (response.kind !== 'text') throw new Error('Invalid terminal query text')
    return response.text
  }
  clearReveal(): void {
    if (!this.disposed) this.cleanup({ kind: 'clear-reveal', queryId: this.id })
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.listeners.clear()
    this.cleanup({ kind: 'close', queryId: this.id })
  }
  private accepts(occurrence: TerminalRetainedOccurrence): boolean {
    return !this.disposed && this.current() && this.occurrences.has(occurrence)
  }
  private assertCurrent(): void {
    if (this.disposed || !this.current())
      throw new Error('Terminal query is no longer current')
  }
}
