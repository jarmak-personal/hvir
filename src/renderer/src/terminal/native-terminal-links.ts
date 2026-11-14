import type {
  NativeTerminalLinkActivation,
  NativeTerminalLinkCapture,
  NativeTerminalLinkIntent,
} from '../../../shared/native-terminal-link'

interface LinkPort {
  view(): string | undefined
  capture(intent: NativeTerminalLinkIntent): Promise<NativeTerminalLinkCapture>
  read(
    viewId: string,
    requestId: string,
  ): Promise<NativeTerminalLinkActivation | undefined>
  cancel(viewId: string, requestId: string): void
  activate(link: NativeTerminalLinkActivation): void
  refused(): void
}

/** Owns explicit native click requests; only their finite capture ACK holds input ordering. */
export class NativeTerminalLinks {
  private revision = 0
  private readonly requests = new Set<AbortController>()
  constructor(private readonly port: LinkPort) {}
  revoke(): void {
    this.revision++
    for (const request of this.requests) request.abort()
  }
  async begin(x: number, y: number): Promise<void> {
    const viewId = this.port.view()
    if (!viewId) return
    const revision = this.revision,
      requestId = crypto.randomUUID(),
      controller = new AbortController()
    let cancelled = false
    const cancel = () => {
      if (cancelled) return
      cancelled = true
      try {
        this.port.cancel(viewId, requestId)
      } catch {
        /* Owner loss settles native cleanup. */
      }
    }
    const current = () =>
      !controller.signal.aborted &&
      revision === this.revision &&
      this.port.view() === viewId
    const release = () => {
      cancel()
      controller.signal.removeEventListener('abort', cancel)
      this.requests.delete(controller)
    }
    const refused = () => {
      if (current()) this.port.refused()
    }
    controller.signal.addEventListener('abort', cancel, { once: true })
    this.requests.add(controller)
    try {
      const capture = await this.port.capture({ viewId, requestId, x, y })
      if (!current()) {
        release()
        return
      }
      if (!capture.pending) {
        if (capture.link) this.port.activate(capture.link)
        release()
        return
      }
      // Continuation has owned cancellation, but never occupies the DOM FIFO.
      void this.port
        .read(viewId, requestId)
        .then((link) => {
          if (link && current()) this.port.activate(link)
        })
        .catch(refused)
        .finally(release)
    } catch {
      try {
        refused()
      } finally {
        release()
      }
    }
  }
}
