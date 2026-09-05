import type { HarnessTelemetry } from '../../shared'
import type { Disposer, PtyExit, PtyProcess } from '../project-host/project-host'
import type { PtyStreamHandlers } from './pty-contract'

const MAX_INITIAL_REPLAY_LENGTH = 256 * 1024

/** Owns stream subscriptions and bounded attachment replay, never renderer authority. */
export class PtyStreamAttachment {
  private readonly dataListeners = new Set<(data: string) => void>()
  private readonly exitListeners = new Set<(exit: PtyExit) => void>()
  private readonly telemetryListeners = new Set<
    (telemetry: HarnessTelemetry | undefined) => void
  >()
  private readonly replay: string[] = []
  private replayLength = 0
  private replayPending = true
  private telemetry?: HarnessTelemetry
  private disposeData?: Disposer
  private disposed = false

  get attached(): boolean {
    return this.dataListeners.size > 0
  }

  start(
    source: Pick<PtyProcess, 'onData'>,
    recordLaunchOutput: (data: string) => void,
  ): void {
    const dispose = source.onData((data) => {
      if (this.disposed) return
      recordLaunchOutput(data)
      if (this.replayPending && !this.attached) this.retainReplay(data)
      for (const listener of this.dataListeners) listener(data)
    })
    if (this.disposed) void dispose()
    else this.disposeData = dispose
  }

  attach(handlers: PtyStreamHandlers): Disposer {
    if (handlers.onData) this.dataListeners.add(handlers.onData)
    if (handlers.onExit) this.exitListeners.add(handlers.onExit)
    if (handlers.onTelemetry) this.telemetryListeners.add(handlers.onTelemetry)
    if (handlers.onData && this.replayPending) {
      this.replayPending = false
      const replay = this.replay.splice(0)
      this.replayLength = 0
      for (const data of replay) handlers.onData(data)
    }
    if (handlers.onTelemetry && this.telemetry) handlers.onTelemetry(this.telemetry)
    return () => {
      if (handlers.onData) this.dataListeners.delete(handlers.onData)
      if (handlers.onExit) this.exitListeners.delete(handlers.onExit)
      if (handlers.onTelemetry) this.telemetryListeners.delete(handlers.onTelemetry)
    }
  }

  publishExit(exit: PtyExit): void {
    for (const listener of this.exitListeners) listener(exit)
  }

  publishTelemetry(telemetry: HarnessTelemetry | undefined): void {
    this.telemetry = telemetry
    for (const listener of this.telemetryListeners) listener(telemetry)
  }

  detachForTransfer(): void {
    this.clearListeners()
    this.replayPending = true
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    void this.disposeData?.()
    this.clearListeners()
    this.replay.length = 0
    this.replayLength = 0
  }

  private clearListeners(): void {
    this.dataListeners.clear()
    this.exitListeners.clear()
    this.telemetryListeners.clear()
  }

  private retainReplay(data: string): void {
    if (data.length >= MAX_INITIAL_REPLAY_LENGTH) {
      this.replay.splice(0, this.replay.length, data.slice(-MAX_INITIAL_REPLAY_LENGTH))
      this.replayLength = MAX_INITIAL_REPLAY_LENGTH
      return
    }
    this.replay.push(data)
    this.replayLength += data.length
    while (this.replayLength > MAX_INITIAL_REPLAY_LENGTH && this.replay.length > 0) {
      const overflow = this.replayLength - MAX_INITIAL_REPLAY_LENGTH
      const first = this.replay[0] ?? ''
      if (first.length <= overflow) {
        this.replay.shift()
        this.replayLength -= first.length
      } else {
        this.replay[0] = first.slice(overflow)
        this.replayLength -= overflow
      }
    }
  }
}
