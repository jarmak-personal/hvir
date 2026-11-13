import { randomUUID } from 'node:crypto'
import type { WebFrameMain } from 'electron'
import {
  NATIVE_TERMINAL_PRESENTATION as channels,
  sameNativeTerminalView,
  validNativeTerminalViewGrant,
  type NativeTerminalPixelFrame,
  type NativeTerminalPresentationStatus,
  type NativeTerminalViewGrant,
} from '../../shared/native-terminal-presentation'

/** Private preload acknowledgements qualify the actual frame, never a claimed
 * terminal/session label. One application owner bounds all copied uploads. */
export class NativeTerminalPresentationTargets {
  private readonly pending = new Map<
    string,
    {
      frame: WebFrameMain
      finish(error?: Error): void
      current(): boolean
    }
  >()
  private disposed = false
  private readonly granted = new Map<
    string,
    { frame: WebFrameMain; grant: NativeTerminalViewGrant; fail(): void }
  >()
  acknowledge(frame: WebFrameMain, value: unknown): void {
    if (!value || typeof value !== 'object') return
    const ack = value as {
      ticket?: string
      accepted?: boolean
      kind?: string
      grant?: unknown
    }
    if (ack.kind === 'renderer-failure' && validNativeTerminalViewGrant(ack.grant)) {
      const routed = this.granted.get(ack.grant.viewId)
      if (
        routed &&
        frame === routed.frame &&
        sameNativeTerminalView(routed.grant, ack.grant)
      )
        routed.fail()
      return
    }
    if (ack.kind !== 'pixels' || typeof ack.ticket !== 'string') return
    const pending = this.pending.get(ack.ticket)
    if (!pending || frame !== pending.frame) return
    pending.finish(
      ack.accepted === true && pending.current()
        ? undefined
        : new Error('native-pixel-receiver-rejected'),
    )
  }
  create(frame: WebFrameMain, isCurrent: () => boolean, ready: () => boolean) {
    let viewId: string | undefined
    let failed = false
    const current = (): boolean =>
      !this.disposed && !failed && !frame.isDestroyed() && isCurrent() && ready()
    const send = (channel: string, value: unknown): void => {
      if (!current()) throw new Error('native-presentation-target-stale')
      frame.send(channel, value)
    }
    return {
      frame,
      get ready(): boolean {
        return ready()
      },
      isCurrent: current,
      publishGrant: (grant: NativeTerminalViewGrant | undefined): void => {
        if (grant) {
          viewId = grant.viewId
          if (!this.granted.has(viewId) && this.granted.size >= channels.maximumViews)
            throw new Error('native-presentation-target-bound')
          this.granted.set(viewId, {
            frame,
            grant,
            fail: () => {
              failed = true
            },
          })
        } else if (viewId) this.granted.delete(viewId)
        // Revocation is cleanup authority and remains valid after current() fails.
        if (viewId && !this.disposed && !frame.isDestroyed())
          frame.send(channels.grantChannel, { viewId, grant })
      },
      publishStatus: (status: NativeTerminalPresentationStatus): void => {
        send(channels.statusChannel, status)
      },
      sendPixels: (pixels: NativeTerminalPixelFrame): Promise<void> => {
        if (
          this.pending.size >= 3 ||
          pixels.bytes.byteLength > channels.maximumPixelBytes
        )
          return Promise.reject(new Error('native-pixel-upload-bound'))
        if (!current())
          return Promise.reject(new Error('native-presentation-target-stale'))
        const ticket = randomUUID()
        return new Promise((resolve, reject) => {
          const timeout = setTimeout(
            () => finish(new Error('native-pixel-upload-timeout')),
            5000,
          )
          const finish = (error?: Error): void => {
            if (!this.pending.delete(ticket)) return
            clearTimeout(timeout)
            if (error) reject(error)
            else resolve()
          }
          this.pending.set(ticket, { frame, finish, current })
          try {
            send(channels.pixelsChannel, { ticket, frame: pixels })
          } catch {
            finish(new Error('native-pixel-upload-failed'))
          }
        })
      },
    }
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.granted.clear()
    for (const pending of this.pending.values())
      pending.finish(new Error('native-presentation-closed'))
  }
}
