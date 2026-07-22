import type { HvirApi, HarnessTelemetry, TerminalIdentityStatus } from '../../../shared'
import type { TerminalPresentation } from './terminal-pane'

export const TERMINAL_HIDDEN_FLUSH_MS = 40
export const TERMINAL_MAX_BUFFERED_BYTES = 64 * 1024

export interface TerminalDeliveryStats {
  readonly nativeDataEvents: number
  readonly deliveryCallbacks: number
  readonly receivedBytes: number
  readonly deliveredBytes: number
  readonly peakBufferedBytes: number
  readonly bufferedBytes: number
  readonly pending: boolean
  readonly presentation: TerminalPresentation
}

export interface TerminalEventRouterStats {
  readonly nativeSubscriptions: number
  readonly registeredSessions: number
  readonly nativeDataEvents: number
  readonly unroutedEvents: number
}

export interface TerminalEventHandlers {
  readonly onData: (data: string) => void
  readonly onExit: (exitCode: number, signal?: number) => void
  readonly onTelemetry: (telemetry: HarnessTelemetry | undefined) => void
  readonly onIdentity: (
    harnessSessionId: string | undefined,
    identityStatus: TerminalIdentityStatus,
  ) => void
}

export interface TerminalEventRoute {
  setPresentation(presentation: TerminalPresentation): void
  snapshot(): TerminalDeliveryStats
  exposeStats(target: object): void
  dispose(): void
}

export interface TerminalEventScheduler {
  requestFrame(callback: (time: number) => void): number
  cancelFrame(handle: number): void
  setTimer(callback: () => void, delayMs: number): number
  clearTimer(handle: number): void
}

export interface TerminalEventRouterOptions {
  readonly hiddenFlushMs?: number
  readonly maxBufferedBytes?: number
  readonly scheduler?: TerminalEventScheduler
  readonly byteLength?: (data: string) => number
}

/**
 * Renderer-owned PTY event boundary. One native subscription per event family
 * feeds a session map; only ordered output is coalesced before its pane owner.
 */
export class TerminalEventRouter {
  private readonly routes = new Map<string, TerminalEventRouteState>()
  private readonly disposers: Array<() => void>
  private readonly scheduler: TerminalEventScheduler
  private readonly hiddenFlushMs: number
  private readonly maxBufferedBytes: number
  private readonly byteLength: (data: string) => number
  private nativeDataEvents = 0
  private unroutedEvents = 0
  private disposed = false

  constructor(api: HvirApi, options: TerminalEventRouterOptions = {}) {
    const encoder = new TextEncoder()
    this.scheduler = options.scheduler ?? browserScheduler()
    this.hiddenFlushMs = options.hiddenFlushMs ?? TERMINAL_HIDDEN_FLUSH_MS
    this.maxBufferedBytes = options.maxBufferedBytes ?? TERMINAL_MAX_BUFFERED_BYTES
    this.byteLength = options.byteLength ?? ((data) => encoder.encode(data).byteLength)
    if (this.hiddenFlushMs > 50) {
      throw new Error('Hidden terminal output latency must not exceed 50 ms')
    }
    if (this.hiddenFlushMs <= 0 || this.maxBufferedBytes <= 0) {
      throw new Error('Terminal output delivery bounds must be positive')
    }

    this.disposers = [
      api.on('pty:data', ({ id, data }) => {
        this.nativeDataEvents += 1
        const route = this.routes.get(id)
        if (route) route.push(data)
        else this.unroutedEvents += 1
      }),
      api.on('pty:exit', ({ id, exitCode, signal }) => {
        const route = this.routes.get(id)
        if (route) route.exit(exitCode, signal)
        else this.unroutedEvents += 1
      }),
      api.on('pty:telemetry', ({ id, telemetry }) => {
        const route = this.routes.get(id)
        if (route) route.telemetry(telemetry)
        else this.unroutedEvents += 1
      }),
      api.on('pty:identity', ({ id, harnessSessionId, identityStatus }) => {
        const route = this.routes.get(id)
        if (route) route.identity(harnessSessionId, identityStatus)
        else this.unroutedEvents += 1
      }),
    ]
  }

  register(
    sessionId: string,
    presentation: TerminalPresentation,
    handlers: TerminalEventHandlers,
  ): TerminalEventRoute {
    if (this.disposed) throw new Error('Terminal event router is disposed')
    if (this.routes.has(sessionId)) {
      throw new Error(`Terminal event route '${sessionId}' is already registered`)
    }
    const route = new TerminalEventRouteState(
      presentation,
      handlers,
      this.scheduler,
      this.hiddenFlushMs,
      this.maxBufferedBytes,
      this.byteLength,
      () => {
        if (this.routes.get(sessionId) === route) this.routes.delete(sessionId)
      },
    )
    this.routes.set(sessionId, route)
    return route
  }

  snapshot(): TerminalEventRouterStats {
    return {
      nativeSubscriptions: this.disposers.length,
      registeredSessions: this.routes.size,
      nativeDataEvents: this.nativeDataEvents,
      unroutedEvents: this.unroutedEvents,
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const route of [...this.routes.values()]) route.dispose()
    for (const dispose of this.disposers) dispose()
  }
}

class TerminalEventRouteState implements TerminalEventRoute {
  private readonly chunks: string[] = []
  private pendingHandle?: number
  private pendingKind?: 'frame' | 'timer'
  private bufferedBytes = 0
  private nativeDataEvents = 0
  private deliveryCallbacks = 0
  private receivedBytes = 0
  private deliveredBytes = 0
  private peakBufferedBytes = 0
  private disposed = false

  constructor(
    private presentation: TerminalPresentation,
    private readonly handlers: TerminalEventHandlers,
    private readonly scheduler: TerminalEventScheduler,
    private readonly hiddenFlushMs: number,
    private readonly maxBufferedBytes: number,
    private readonly byteLength: (data: string) => number,
    private readonly unregister: () => void,
  ) {}

  push(data: string): void {
    if (this.disposed || !data) return
    const bytes = this.byteLength(data)
    this.nativeDataEvents += 1
    this.receivedBytes += bytes

    if (bytes >= this.maxBufferedBytes) {
      this.flush()
      this.deliver(data, bytes)
      return
    }
    if (this.bufferedBytes + bytes > this.maxBufferedBytes) this.flush()
    this.chunks.push(data)
    this.bufferedBytes += bytes
    this.peakBufferedBytes = Math.max(this.peakBufferedBytes, this.bufferedBytes)
    if (this.bufferedBytes >= this.maxBufferedBytes) this.flush()
    else this.schedule()
  }

  exit(exitCode: number, signal?: number): void {
    if (this.disposed) return
    this.flush()
    try {
      this.handlers.onExit(exitCode, signal)
    } finally {
      this.dispose()
    }
  }

  telemetry(telemetry: HarnessTelemetry | undefined): void {
    if (!this.disposed) this.handlers.onTelemetry(telemetry)
  }

  identity(
    harnessSessionId: string | undefined,
    identityStatus: TerminalIdentityStatus,
  ): void {
    if (!this.disposed) this.handlers.onIdentity(harnessSessionId, identityStatus)
  }

  setPresentation(presentation: TerminalPresentation): void {
    if (this.disposed || presentation === this.presentation) return
    this.presentation = presentation
    if (!this.chunks.length) return
    this.cancelPending()
    this.schedule()
  }

  snapshot(): TerminalDeliveryStats {
    return {
      nativeDataEvents: this.nativeDataEvents,
      deliveryCallbacks: this.deliveryCallbacks,
      receivedBytes: this.receivedBytes,
      deliveredBytes: this.deliveredBytes,
      peakBufferedBytes: this.peakBufferedBytes,
      bufferedBytes: this.bufferedBytes,
      pending: this.pendingHandle !== undefined,
      presentation: this.presentation,
    }
  }

  exposeStats(target: object): void {
    Object.defineProperty(target, '__hvirTerminalDelivery', {
      configurable: true,
      get: () => this.snapshot(),
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.cancelPending()
    this.chunks.splice(0)
    this.bufferedBytes = 0
    this.unregister()
  }

  private schedule(): void {
    if (this.pendingHandle !== undefined) return
    if (this.presentation === 'visible') {
      this.pendingKind = 'frame'
      this.pendingHandle = this.scheduler.requestFrame(() => this.flush())
    } else {
      this.pendingKind = 'timer'
      this.pendingHandle = this.scheduler.setTimer(() => this.flush(), this.hiddenFlushMs)
    }
  }

  private flush(): void {
    if (this.disposed || !this.chunks.length) {
      this.cancelPending()
      return
    }
    this.cancelPending()
    const data = this.chunks.join('')
    const bytes = this.bufferedBytes
    this.chunks.splice(0)
    this.bufferedBytes = 0
    this.deliver(data, bytes)
  }

  private deliver(data: string, bytes: number): void {
    this.deliveryCallbacks += 1
    this.deliveredBytes += bytes
    this.handlers.onData(data)
  }

  private cancelPending(): void {
    if (this.pendingHandle === undefined) return
    if (this.pendingKind === 'frame') this.scheduler.cancelFrame(this.pendingHandle)
    else this.scheduler.clearTimer(this.pendingHandle)
    this.pendingHandle = undefined
    this.pendingKind = undefined
  }
}

function browserScheduler(): TerminalEventScheduler {
  const scope = globalThis as unknown as {
    requestAnimationFrame(callback: (time: number) => void): number
    cancelAnimationFrame(handle: number): void
    setTimeout(callback: () => void, delayMs: number): number
    clearTimeout(handle: number): void
  }
  return {
    requestFrame: (callback) => scope.requestAnimationFrame(callback),
    cancelFrame: (handle) => scope.cancelAnimationFrame(handle),
    setTimer: (callback, delayMs) => scope.setTimeout(callback, delayMs),
    clearTimer: (handle) => scope.clearTimeout(handle),
  }
}
