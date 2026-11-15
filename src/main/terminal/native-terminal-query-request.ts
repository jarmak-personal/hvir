import type { NativeTerminalHost } from './native-terminal-host'
import type { NativeBoundarySource } from './native-terminal-query-boundaries'
import type { PtyTerminalInputPrefix } from '../pty/pty-contract'
import {
  nativeQueryUnsentBusy,
  nativeTerminalQueryAcquiresCursor,
  type NativeTerminalQueryOperation,
} from '../../shared/native-terminal-query-operations'
import type { NativeTerminalSelectionContext } from '../../shared/native-terminal-selection'
import {
  validNativeTerminalSelectionCursor,
  NativeTerminalSelectionRefused,
} from '../../shared/native-terminal-selection'
import { nativeSelectionChunk } from './native-terminal-selection-results'
import {
  NativeTerminalAdmissionError,
  NATIVE_TERMINAL_LIMITS,
} from '../../shared/native-terminal'

export interface NativeTerminalQuerySource extends NativeBoundarySource {
  readonly viewId: string
  prefix(): PtyTerminalInputPrefix
  context(reveal: boolean, signal: AbortSignal): Promise<NativeTerminalSelectionContext>
}
type Host = Pick<NativeTerminalHost, 'query' | 'inspectProducer'>

/** Expected logical revocation, distinct from native execution/cleanup failures. */
export class NativeTerminalQuerySourceStale extends Error {
  constructor() {
    super('native-query-source-stale')
  }
}

/** One revocable request; native resources remain owned until explicitly transferred. */
export class NativeTerminalQueryRequestOwner {
  readonly abort = new AbortController()
  private pending?: Promise<unknown>
  private acquisition?: NativeTerminalQueryOperation
  private closing?: Promise<void>
  constructor(
    private readonly host: Host,
    readonly source: NativeTerminalQuerySource,
  ) {}

  async call(
    operation: NativeTerminalQueryOperation,
    eligible?: (signal: AbortSignal) => Promise<void>,
  ): Promise<unknown> {
    this.current()
    const deadline = Date.now() + NATIVE_TERMINAL_LIMITS.requestMs
    let value: unknown
    for (;;) {
      this.current()
      this.pending = this.host.query(
        this.source.handle,
        this.source.session.instanceId,
        operation,
        this.abort.signal,
        eligible,
      )
      try {
        value = await this.pending
        if (
          nativeTerminalQueryAcquiresCursor(operation) &&
          value &&
          typeof value === 'object'
        ) {
          const result = value as Record<string, unknown>
          if (
            (result.cursor === undefined || result.cursor === '0') &&
            nativeQueryUnsentBusy(result.unavailable, result.stale) &&
            Date.now() < deadline
          ) {
            await new Promise<void>((resolve) => setTimeout(resolve, 1))
            continue
          }
        }
        break
      } catch (error) {
        if (!(error instanceof NativeTerminalAdmissionError) || Date.now() >= deadline)
          throw error
        await new Promise<void>((resolve) => setTimeout(resolve, 1))
      }
    }
    // Capture physical resources before rejecting a revoked logical delivery.
    if (value && typeof value === 'object') {
      const result = value as Record<string, unknown>
      if (
        nativeTerminalQueryAcquiresCursor(operation) &&
        validNativeTerminalSelectionCursor(result.cursor)
      )
        this.acquisition = { kind: 'close', cursor: result.cursor }
      if (
        operation.kind === 'query-begin' &&
        validNativeTerminalSelectionCursor(result.query)
      )
        this.acquisition = { kind: 'query-close', query: result.query }
    }
    if (operation.kind === 'finish') this.acquisition = undefined // Every definitive Finish closes.
    this.current()
    return value
  }

  /** The receiving query owner has accepted this exact physical token. */
  transferAcquisition(kind: 'query-close', token: string): void {
    const operation = this.acquisition
    if (!operation || operation.kind !== kind || operation.query !== token)
      throw new Error('native-query-acquisition-mismatch')
    this.acquisition = undefined
  }

  /** Productive continuation has no total text/time cap and never occupies the DOM FIFO. */
  async collect(): Promise<{ text: string; finished: Record<string, unknown> }> {
    const acquisition = this.acquisition
    if (acquisition?.kind !== 'close') throw new Error('native-query-cursor-missing')
    const cursor = acquisition.cursor
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
    const parts: string[] = []
    for (;;) {
      const chunk = nativeSelectionChunk(
        await this.call({ kind: 'next', cursor }),
        cursor,
      )
      parts.push(decoder.decode(chunk.data, { stream: true }))
      if (chunk.done) break
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    const finished = nativeQueryResult(await this.call({ kind: 'finish', cursor }))
    parts.push(decoder.decode())
    return { text: parts.join(''), finished }
  }

  async applied(mutation: number): Promise<void> {
    if (!mutation) return
    const deadline = Date.now() + NATIVE_TERMINAL_LIMITS.requestMs
    for (;;) {
      this.current()
      const status = await this.host.inspectProducer(
        this.source.handle,
        this.source.session.instanceId,
      )
      this.current()
      if (status.ioAppliedMutation >= mutation) return
      if (Date.now() >= deadline) throw new Error('native-query-apply-timeout')
      await new Promise<void>((resolve) => setTimeout(resolve, 1))
    }
  }

  current(): void {
    this.abort.signal.throwIfAborted()
    this.source.assertCurrent()
  }

  close(): Promise<void> {
    if (this.closing) return this.closing
    this.abort.abort()
    this.closing = (async () => {
      await this.pending?.catch(() => undefined)
      const operation = this.acquisition
      if (!operation) return
      // Cleanup uses immutable physical identity after renderer/query authority is gone.
      const deadline = Date.now() + NATIVE_TERMINAL_LIMITS.requestMs
      for (;;) {
        try {
          const result = await this.host.query(
            this.source.handle,
            this.source.session.instanceId,
            operation,
          )
          if (nativeQueryResult(result).result !== 0)
            throw new Error('native-query-cleanup-failed')
          this.acquisition = undefined
          return
        } catch (error) {
          if (!nativeQueryCleanupUnsent(error) || Date.now() >= deadline) throw error
          await new Promise<void>((resolve) => setTimeout(resolve, 1))
        }
      }
    })()
    return this.closing
  }
}

/** Only explicit admission or native BUSY certifies that cleanup was not applied. */
export function nativeQueryCleanupUnsent(error: unknown): boolean {
  return (
    error instanceof NativeTerminalAdmissionError ||
    (error instanceof NativeTerminalSelectionRefused &&
      nativeQueryUnsentBusy(error.code, error.stale))
  )
}

export function nativeQueryResult(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('native-query-result-invalid')
  const result = value as Record<string, unknown>
  if ('unavailable' in result) {
    if (
      typeof result.unavailable !== 'number' ||
      ![1, 5, 6, 7].includes(result.unavailable) ||
      typeof result.stale !== 'boolean'
    )
      throw new Error('native-query-refusal-invalid')
    throw new NativeTerminalSelectionRefused(
      result.unavailable as 1 | 5 | 6 | 7,
      result.stale,
    )
  }
  return result
}
