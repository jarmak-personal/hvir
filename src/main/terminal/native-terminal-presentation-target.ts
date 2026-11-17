import { randomUUID } from 'node:crypto'
import type { WebFrameMain } from 'electron'
import { NativeTerminalAdmissionError } from '../../shared/native-terminal'
import {
  NativeTerminalPixelLocallyIneligibleError,
  type NativeTerminalPixelReservation,
} from './native-terminal-presenter'
import {
  NATIVE_TERMINAL_PRESENTATION as channels,
  nativeTerminalPackedPixelLayout,
  sameNativeTerminalView,
  validNativeTerminalViewGrant,
  type NativeTerminalCanvasRefit,
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
      grant: NativeTerminalViewGrant
      finish(error?: Error): void
      current(): boolean
    }
  >()
  private disposed = false
  private readonly granted = new Map<
    string,
    {
      frame: WebFrameMain
      grant: NativeTerminalViewGrant
      current(): boolean
      drawnScreen?: 0 | 1
      fail(): void
    }
  >()
  /** A successful receiver draw qualifies geometry, not old text or physical paint. */
  drawn(viewId: string, frame: WebFrameMain) {
    const view = this.granted.get(viewId)
    if (
      !view ||
      view.frame !== frame ||
      !view.current() ||
      view.drawnScreen === undefined
    )
      return
    return {
      screen: view.drawnScreen,
      geometrySerial: view.grant.geometrySerial,
      nativeEpoch: view.grant.nativeEpoch,
      attachment: view.grant.attachment,
    }
  }
  acknowledge(frame: WebFrameMain, value: unknown): void {
    if (!value || typeof value !== 'object') return
    const ack = value as {
      ticket?: string
      accepted?: boolean
      kind?: string
      grant?: unknown
      screen?: unknown
      discarded?: unknown
    }
    if (ack.kind === 'drawn' && validNativeTerminalViewGrant(ack.grant)) {
      const routed = this.granted.get(ack.grant.viewId)
      if (
        routed &&
        frame === routed.frame &&
        routed.current() &&
        sameNativeTerminalView(routed.grant, ack.grant) &&
        (ack.screen === 0 || ack.screen === 1)
      )
        routed.drawnScreen = ack.screen
      return
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
    if (
      ack.accepted === false &&
      ack.discarded === 'local-ineligible' &&
      validNativeTerminalViewGrant(ack.grant) &&
      sameNativeTerminalView(pending.grant, ack.grant)
    ) {
      pending.finish(new NativeTerminalPixelLocallyIneligibleError())
      return
    }
    pending.finish(
      ack.accepted === true && ack.discarded === undefined && pending.current()
        ? undefined
        : new Error('native-pixel-receiver-rejected'),
    )
  }
  create(frame: WebFrameMain, isCurrent: () => boolean, ready: () => boolean) {
    let viewId: string | undefined
    let failed = false
    let unavailable: ((grant: NativeTerminalViewGrant) => void) | undefined
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
      onUnavailable: (
        listener: (grant: NativeTerminalViewGrant) => void,
      ): (() => void) => {
        if (this.disposed || unavailable) throw new Error('native-target-already-bound')
        unavailable = listener
        return () => {
          if (unavailable === listener) unavailable = undefined
        }
      },
      publishGrant: (
        grant: NativeTerminalViewGrant | undefined,
        refit?: NativeTerminalCanvasRefit,
      ): void => {
        if (grant) {
          viewId = grant.viewId
          if (!this.granted.has(viewId) && this.granted.size >= channels.maximumViews)
            throw new Error('native-presentation-target-bound')
          this.granted.set(viewId, {
            frame,
            grant,
            current,
            fail: () => {
              failed = true
              unavailable?.(grant)
            },
          })
        } else if (viewId) this.granted.delete(viewId)
        // Revocation is cleanup authority and remains valid after current() fails.
        if (viewId && !this.disposed && !frame.isDestroyed())
          frame.send(channels.grantChannel, {
            viewId,
            grant,
            ...(!grant && refit ? { refit } : {}),
          })
      },
      publishStatus: (status: NativeTerminalPresentationStatus): void => {
        if (status.mode === 'unavailable' && !this.disposed && !frame.isDestroyed())
          frame.send(channels.statusChannel, status)
        else send(channels.statusChannel, status)
      },
      reservePixels: (grant: NativeTerminalViewGrant) =>
        this.reservePixels(frame, grant, current, send),
      sendPixels: async (pixels: NativeTerminalPixelFrame): Promise<void> => {
        const reservation = this.reservePixels(
          frame,
          pixels.nativeTerminal,
          current,
          send,
        )
        try {
          await reservation.send(pixels)
        } finally {
          reservation.cancel()
        }
      },
    }
  }
  private reservePixels(
    frame: WebFrameMain,
    grant: NativeTerminalViewGrant,
    current: () => boolean,
    send: (channel: string, value: unknown) => void,
  ): NativeTerminalPixelReservation {
    if (this.pending.size >= 3)
      throw new NativeTerminalAdmissionError('native-pixel-upload-bound')
    const issued = this.granted.get(grant.viewId)
    if (
      !current() ||
      !issued ||
      issued.frame !== frame ||
      !sameNativeTerminalView(issued.grant, grant)
    )
      throw new Error('native-presentation-target-stale')
    const layout = nativeTerminalPackedPixelLayout(grant.width, grant.height)
    if (!validNativeTerminalViewGrant(grant) || !layout)
      throw new Error('native-pixel-upload-bound')
    const ticket = randomUUID(),
      captured = Object.freeze({ ...grant })
    let timeout: ReturnType<typeof setTimeout> | undefined
    let closed = false,
      sent = false,
      resolveSent: (() => void) | undefined,
      rejectSent: ((error: Error) => void) | undefined
    let closedError: Error | undefined
    const finish = (error?: Error): void => {
      if (!this.pending.delete(ticket)) return
      closed = true
      closedError = error
      if (timeout) clearTimeout(timeout)
      if (error) rejectSent?.(error)
      else resolveSent?.()
    }
    this.pending.set(ticket, { frame, grant: captured, finish, current })
    return {
      cancel: () => finish(new Error('native-pixel-upload-cancelled')),
      send: (pixels) => {
        if (closed)
          return Promise.reject(
            closedError ?? new Error('native-pixel-reservation-closed'),
          )
        if (sent)
          return Promise.reject(new Error('native-pixel-reservation-already-sent'))
        const latest = this.granted.get(grant.viewId)
        if (
          !current() ||
          !latest ||
          latest.frame !== frame ||
          !pixels ||
          !validNativeTerminalViewGrant(pixels.nativeTerminal) ||
          !sameNativeTerminalView(pixels.nativeTerminal, captured) ||
          !sameNativeTerminalView(latest.grant, captured)
        ) {
          const error = new Error('native-presentation-target-stale')
          finish(error)
          return Promise.reject(error)
        }
        if (
          !(pixels.bytes instanceof Uint8Array) ||
          pixels.bytes.buffer instanceof SharedArrayBuffer ||
          pixels.stride !== layout.stride ||
          pixels.bytes.byteLength !== layout.byteLength
        ) {
          const error = new Error('native-pixel-upload-bound')
          finish(error)
          return Promise.reject(error)
        }
        sent = true
        return new Promise<void>((resolve, reject) => {
          resolveSent = resolve
          rejectSent = reject
          timeout = setTimeout(
            () => finish(new Error('native-pixel-upload-timeout')),
            5000,
          )
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
