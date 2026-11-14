import type { TerminalSelectionCapability } from './terminal-pane'
import type {
  NativeTerminalSelectionAction,
  NativeTerminalSelectionResponse,
} from '../../../shared/native-terminal-selection'

interface SelectionPort {
  view(): string | undefined
  perform(
    action: NativeTerminalSelectionAction,
    requestId: string | undefined,
    signal: AbortSignal,
  ): Promise<NativeTerminalSelectionResponse>
  readSelection(
    viewId: string,
    requestId: string,
    signal: AbortSignal,
  ): Promise<NativeTerminalSelectionResponse>
  cancel(viewId: string, requestId: string): void
}
const aborted = () => new DOMException('Terminal selection source changed', 'AbortError')

/** Revocable view capabilities and request cancellation only; selected text is never cached. */
export class NativeTerminalSelection {
  private revision = 0
  private readonly requests = new Set<AbortController>()
  private current = this.capabilityFor(0)
  constructor(private readonly port: SelectionPort) {}
  get capability(): TerminalSelectionCapability {
    return this.current
  }
  revoke(): void {
    this.revision++
    for (const request of this.requests) request.abort()
    this.current = this.capabilityFor(this.revision)
  }
  private capabilityFor(revision: number): TerminalSelectionCapability {
    return {
      status: async (signal) => ({
        hasSelection: (await this.run(revision, 'state', signal)).hasSelection,
      }),
      read: async (signal) => (await this.run(revision, 'copy', signal)).text,
      selectAll: async (signal) => {
        this.cancelReads()
        await this.run(revision, 'select-all', signal)
      },
      clear: async (signal) => {
        this.cancelReads()
        await this.run(revision, 'clear', signal)
      },
      reset: async (signal) => {
        this.cancelReads()
        await this.run(revision, 'reset', signal)
      },
    }
  }
  private cancelReads(): void {
    for (const request of this.requests) request.abort()
  }
  private async run(
    revision: number,
    action: NativeTerminalSelectionAction,
    signal?: AbortSignal,
  ): Promise<NativeTerminalSelectionResponse> {
    const view = this.port.view()
    if (!view || revision !== this.revision || signal?.aborted) throw aborted()
    const request = new AbortController(),
      requestId = action === 'copy' ? crypto.randomUUID() : undefined
    let cancellationSent = false
    const cancel = () => request.abort()
    const cancelNative = () => {
      if (requestId && !cancellationSent) {
        cancellationSent = true
        this.port.cancel(view, requestId)
      }
    }
    signal?.addEventListener('abort', cancel, { once: true })
    request.signal.addEventListener('abort', cancelNative, { once: true })
    this.requests.add(request)
    try {
      let result = await this.port.perform(action, requestId, request.signal)
      const current = () =>
        !request.signal.aborted && revision === this.revision && this.port.view() === view
      if (!current()) throw aborted()
      if (requestId && !result.hasSelection)
        return { hasSelection: false, selectionSerial: result.selectionSerial }
      // The FIFO owns only native begin acknowledgement. Productive chunk reads
      // yield between caller jobs and must not block later typing or cleanup.
      if (requestId) {
        result = await this.port.readSelection(view, requestId, request.signal)
        if (!current()) throw aborted()
      }
      return result
    } finally {
      // Exact-request cleanup also covers a stale begin or failed continuation.
      // If its transport is already gone, main's owner/lease cleanup still owns it.
      try {
        cancelNative()
      } catch {
        // Cleanup cannot replace the original operation's outcome.
      }
      this.requests.delete(request)
      signal?.removeEventListener('abort', cancel)
      request.signal.removeEventListener('abort', cancelNative)
    }
  }
  async copy(write: (text: string) => Promise<void>): Promise<void> {
    const capability = this.current,
      view = this.port.view()
    const text = await capability.read()
    if (this.current !== capability || !view || this.port.view() !== view) throw aborted()
    if (text !== undefined) await write(text)
  }
}
