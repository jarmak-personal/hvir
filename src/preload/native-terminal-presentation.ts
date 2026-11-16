import {
  NATIVE_TERMINAL_PRESENTATION as limits,
  sameNativeTerminalView,
  validNativeTerminalViewGrant,
  type NativeTerminalPixelFrame,
  type NativeTerminalPresentationApi,
  type NativeTerminalPresentationStatus,
  type NativeTerminalPresentedFrame,
  type NativeTerminalViewGrant,
} from '../shared/native-terminal-presentation'
import {
  nativePresentationSpanEnd,
  nativePresentationSpanStart,
  nativePresentationFailure,
  nativePresentationResourceStage,
  type NativePresentationFailureStage,
} from './native-terminal-presentation-smoke'

export interface NativeTerminalCanvasPort {
  draw(frame: unknown, metadata: NativeTerminalPresentedFrame): void
  pixels(frame: NativeTerminalPixelFrame): void
  dispose(): void
  suspendForRefit?(): void
}
interface ImportedTexture {
  getVideoFrame(): { close(): void }
  release(): void
}
interface View {
  readonly elementId: string
  eligible: boolean
  canvas?: NativeTerminalCanvasPort
  binding?: symbol
  issued?: { attachment: number; nativeEpoch: string; geometrySerial: number }
}
interface CurrentFrame {
  canvas: NativeTerminalCanvasPort
  metadata: NativeTerminalPresentedFrame
  view: View
  binding: symbol
}
function validMetadata(value: unknown): value is NativeTerminalPresentedFrame {
  if (!value || typeof value !== 'object') return false
  const metadata = value as NativeTerminalPresentedFrame
  return (
    validNativeTerminalViewGrant(metadata.nativeTerminal) &&
    [0, 1].includes(metadata.screen) &&
    [1, 2].includes(metadata.origin) &&
    [1, 2].includes(metadata.colorSpace)
  )
}

/** One isolated-world receiver multiplexes main-issued grants. DOM registration
 * alone never authorizes a frame, and no GPU object crosses contextBridge. */
export class NativeTerminalPresentationReceiver implements NativeTerminalPresentationApi {
  private readonly mounts = new Map<string, View>()
  private readonly grants = new Map<string, NativeTerminalViewGrant>()
  private readonly failed = new Set<string>()
  private readonly listeners = new Set<
    (status: NativeTerminalPresentationStatus) => void
  >()
  constructor(
    private readonly createCanvas: (
      elementId: string,
      lost: () => void,
    ) => NativeTerminalCanvasPort | undefined,
    private readonly reportFailure: (grant: NativeTerminalViewGrant) => void = () =>
      undefined,
    private readonly reportDraw: (metadata: NativeTerminalPresentedFrame) => void = () =>
      undefined,
  ) {}

  mount(viewId: string, elementId: string): void {
    if (!/^[a-f0-9-]{36}$/.test(viewId) || !/^[A-Za-z0-9_-]{1,128}$/.test(elementId))
      throw new Error('native-mount-invalid')
    if (this.mounts.has(viewId)) this.unmount(viewId)
    if (this.mounts.size >= limits.maximumViews) throw new Error('native-mount-bound')
    const grant = this.grants.get(viewId)
    this.mounts.set(viewId, {
      elementId,
      eligible: true,
      issued: grant && {
        attachment: grant.attachment,
        nativeEpoch: grant.nativeEpoch,
        geometrySerial: grant.geometrySerial,
      },
    })
  }
  unmount(viewId: string): void {
    const view = this.mounts.get(viewId)
    this.mounts.delete(viewId)
    this.grants.delete(viewId)
    if (view) this.disposeCanvas(view)
    this.failed.delete(viewId)
  }
  setEligible(viewId: string, eligible: boolean): void {
    const view = this.mounts.get(viewId)
    if (!view || typeof eligible !== 'boolean') return
    view.eligible = eligible
    if (!eligible) {
      this.grants.delete(viewId)
      this.disposeCanvas(view)
    }
  }
  onStatus(listener: (status: NativeTerminalPresentationStatus) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  status(status: NativeTerminalPresentationStatus): void {
    if (
      !status ||
      !this.mounts.has(status.viewId) ||
      !['native-gpu', 'native-pixels', 'unavailable'].includes(status.mode)
    )
      return
    if (this.failed.has(status.viewId) && status.mode !== 'unavailable') return
    if (status.mode === 'unavailable') {
      this.grants.delete(status.viewId)
      const view = this.mounts.get(status.viewId)
      if (view) this.disposeCanvas(view)
    }
    for (const listener of this.listeners) listener(status)
  }
  grant(value: { viewId: string; grant?: unknown; refit?: unknown }): void {
    if (!value || typeof value.viewId !== 'string') return
    const view = this.mounts.get(value.viewId)
    if (value.grant === undefined) {
      // Authority is withdrawn before any GPU callback or resource operation.
      this.grants.delete(value.viewId)
      if (!view) return
      const refit = value.refit as
        { attachment?: unknown; nativeEpoch?: unknown } | undefined
      if (
        view.canvas?.suspendForRefit &&
        view.issued &&
        !this.failed.has(value.viewId) &&
        refit &&
        typeof refit === 'object' &&
        !Array.isArray(refit) &&
        Object.keys(refit).length === 2 &&
        Object.hasOwn(refit, 'attachment') &&
        Object.hasOwn(refit, 'nativeEpoch') &&
        refit.attachment === view.issued.attachment &&
        refit.nativeEpoch === view.issued.nativeEpoch
      ) {
        const binding = view.binding
        try {
          view.canvas.suspendForRefit()
        } catch {
          if (binding) this.failure(value.viewId, view, binding, 'receiver-refit-suspend')
        }
      } else this.disposeCanvas(view)
      return
    }
    if (!validNativeTerminalViewGrant(value.grant) || value.grant.viewId !== value.viewId)
      return
    const grant = value.grant
    if (!this.grants.has(value.viewId) && this.grants.size >= limits.maximumViews) return
    const old = this.grants.get(value.viewId)
    const issued = view?.issued ?? old
    const sameScope =
      issued?.nativeEpoch === grant.nativeEpoch && issued.attachment === grant.attachment
    if (
      sameScope &&
      issued &&
      (grant.geometrySerial < issued.geometrySerial ||
        (!old && grant.geometrySerial === issued.geometrySerial))
    )
      return
    if (
      old &&
      sameScope &&
      grant.geometrySerial === old.geometrySerial &&
      !sameNativeTerminalView(old, grant)
    )
      return
    if (view) {
      if (issued && !sameScope) {
        this.grants.delete(value.viewId)
        this.disposeCanvas(view)
      }
      // Record issuance, not drawing: another refit may arrive before any frame.
      view.issued = {
        attachment: grant.attachment,
        nativeEpoch: grant.nativeEpoch,
        geometrySerial: grant.geometrySerial,
      }
      if (this.failed.has(value.viewId)) {
        this.grants.delete(value.viewId)
        this.reportFailure(Object.freeze({ ...grant }))
        return
      }
      if (!view.eligible) return
    }
    this.grants.set(value.viewId, Object.freeze({ ...grant }))
  }
  receive(texture: ImportedTexture, metadata: unknown): void {
    let frame: ReturnType<ImportedTexture['getVideoFrame']> | undefined
    let current: CurrentFrame | undefined
    let failureStage: NativePresentationFailureStage = 'receiver-draw'
    if (typeof __HVIR_SMOKE_BUILD__ !== 'undefined' && __HVIR_SMOKE_BUILD__)
      nativePresentationResourceStage('receiver-entry', metadata)
    try {
      current = this.current(metadata)
      if (!current) {
        if (typeof __HVIR_SMOKE_BUILD__ !== 'undefined' && __HVIR_SMOKE_BUILD__)
          nativePresentationResourceStage('receiver-ineligible', metadata)
        return
      }
      let started: number | undefined
      if (typeof __HVIR_SMOKE_BUILD__ !== 'undefined' && __HVIR_SMOKE_BUILD__)
        started = nativePresentationSpanStart()
      try {
        frame = texture.getVideoFrame()
        if (typeof __HVIR_SMOKE_BUILD__ !== 'undefined' && __HVIR_SMOKE_BUILD__)
          nativePresentationResourceStage('video-frame-acquired', metadata)
      } catch (error) {
        failureStage = 'receiver-get-video-frame'
        throw error
      } finally {
        if (typeof __HVIR_SMOKE_BUILD__ !== 'undefined' && __HVIR_SMOKE_BUILD__)
          nativePresentationSpanEnd('get-video-frame', started)
      }
      if (!this.isCurrentFrame(current)) return
      current.canvas.draw(frame, current.metadata)
      if (typeof __HVIR_SMOKE_BUILD__ !== 'undefined' && __HVIR_SMOKE_BUILD__)
        nativePresentationResourceStage('canvas-submitted', metadata)
      if (this.isCurrentFrame(current)) this.reportDraw(current.metadata)
    } catch {
      if (current)
        this.failure(
          current.metadata.nativeTerminal.viewId,
          current.view,
          current.binding,
          failureStage,
        )
    } finally {
      try {
        let started: number | undefined
        if (typeof __HVIR_SMOKE_BUILD__ !== 'undefined' && __HVIR_SMOKE_BUILD__)
          started = nativePresentationSpanStart()
        let closed = false
        try {
          if (
            frame &&
            typeof __HVIR_SMOKE_BUILD__ !== 'undefined' &&
            __HVIR_SMOKE_BUILD__
          )
            nativePresentationResourceStage('frame-close-enter', metadata)
          frame?.close()
          closed = true
          if (
            frame &&
            typeof __HVIR_SMOKE_BUILD__ !== 'undefined' &&
            __HVIR_SMOKE_BUILD__
          )
            nativePresentationResourceStage('frame-close-return', metadata)
        } finally {
          if (
            !closed &&
            frame &&
            typeof __HVIR_SMOKE_BUILD__ !== 'undefined' &&
            __HVIR_SMOKE_BUILD__
          )
            nativePresentationResourceStage('frame-close-rejected', metadata)
          if (typeof __HVIR_SMOKE_BUILD__ !== 'undefined' && __HVIR_SMOKE_BUILD__)
            nativePresentationSpanEnd('frame-close', started)
        }
      } finally {
        let started: number | undefined
        if (typeof __HVIR_SMOKE_BUILD__ !== 'undefined' && __HVIR_SMOKE_BUILD__)
          started = nativePresentationSpanStart()
        let released = false
        try {
          if (typeof __HVIR_SMOKE_BUILD__ !== 'undefined' && __HVIR_SMOKE_BUILD__)
            nativePresentationResourceStage('texture-release-enter', metadata)
          texture.release()
          released = true
          if (typeof __HVIR_SMOKE_BUILD__ !== 'undefined' && __HVIR_SMOKE_BUILD__)
            nativePresentationResourceStage('texture-release-return', metadata)
        } finally {
          if (
            !released &&
            typeof __HVIR_SMOKE_BUILD__ !== 'undefined' &&
            __HVIR_SMOKE_BUILD__
          )
            nativePresentationResourceStage('texture-release-rejected', metadata)
          if (typeof __HVIR_SMOKE_BUILD__ !== 'undefined' && __HVIR_SMOKE_BUILD__)
            nativePresentationSpanEnd('texture-release', started)
        }
      }
    }
  }
  pixels(value: NativeTerminalPixelFrame): boolean | 'local-ineligible' {
    let current: CurrentFrame | undefined
    try {
      if (
        !validMetadata(value) ||
        value.premultiplied !== false ||
        !(value.bytes instanceof Uint8Array) ||
        value.stride !== value.nativeTerminal.width * 4 ||
        value.bytes.byteLength !== value.stride * value.nativeTerminal.height ||
        value.bytes.byteLength > limits.maximumPixelBytes
      )
        return false
      if (this.locallyIneligible(value)) return 'local-ineligible'
      current = this.current(value)
      if (!current) return this.locallyIneligible(value) ? 'local-ineligible' : false
      current.canvas.pixels(value)
      const accepted = this.isCurrentFrame(current)
      if (accepted) this.reportDraw(current.metadata)
      return accepted || (this.locallyIneligible(value) ? 'local-ineligible' : false)
    } catch {
      if (current)
        this.failure(
          current.metadata.nativeTerminal.viewId,
          current.view,
          current.binding,
          'receiver-pixels',
        )
      return false
    }
  }
  dispose(): void {
    for (const id of this.mounts.keys()) this.unmount(id)
    this.grants.clear()
    this.failed.clear()
    this.listeners.clear()
  }
  private locallyIneligible(metadata: NativeTerminalPresentedFrame): boolean {
    const grant = metadata.nativeTerminal
    const view = this.mounts.get(grant.viewId)
    const issued = view?.issued
    return !!(
      view &&
      !view.eligible &&
      !this.failed.has(grant.viewId) &&
      issued?.attachment === grant.attachment &&
      issued.nativeEpoch === grant.nativeEpoch &&
      issued.geometrySerial >= grant.geometrySerial
    )
  }
  private current(value: unknown): CurrentFrame | undefined {
    if (!validMetadata(value)) return
    const metadata = value
    const grant = this.grants.get(metadata.nativeTerminal.viewId)
    const view = this.mounts.get(metadata.nativeTerminal.viewId)
    if (
      !grant ||
      !view ||
      !view.eligible ||
      this.failed.has(grant.viewId) ||
      !sameNativeTerminalView(grant, metadata.nativeTerminal)
    )
      return
    if (!view.canvas) {
      const binding = Symbol('native-terminal-canvas')
      view.binding = binding
      let started: number | undefined
      if (typeof __HVIR_SMOKE_BUILD__ !== 'undefined' && __HVIR_SMOKE_BUILD__)
        started = nativePresentationSpanStart()
      let canvas: NativeTerminalCanvasPort | undefined
      try {
        canvas = this.createCanvas(view.elementId, () =>
          this.failure(grant.viewId, view, binding, 'receiver-canvas-loss-callback'),
        )
      } catch {
        this.failure(grant.viewId, view, binding, 'receiver-factory-throw')
        return
      } finally {
        if (typeof __HVIR_SMOKE_BUILD__ !== 'undefined' && __HVIR_SMOKE_BUILD__)
          nativePresentationSpanEnd('canvas-create', started)
      }
      if (
        this.mounts.get(grant.viewId) !== view ||
        view.binding !== binding ||
        !view.eligible ||
        this.failed.has(grant.viewId) ||
        !this.grants.has(grant.viewId) ||
        !sameNativeTerminalView(this.grants.get(grant.viewId)!, grant)
      ) {
        if (view.binding === binding) view.binding = undefined
        canvas?.dispose()
        return
      }
      if (!canvas) {
        this.failure(grant.viewId, view, binding, 'receiver-factory-absent')
        return
      }
      view.canvas = canvas
    }
    if (!view.binding) return
    return { canvas: view.canvas, metadata, view, binding: view.binding }
  }
  private isCurrentFrame(current: CurrentFrame): boolean {
    const grant = this.grants.get(current.metadata.nativeTerminal.viewId)
    return (
      this.mounts.get(current.metadata.nativeTerminal.viewId) === current.view &&
      current.view.eligible &&
      current.view.binding === current.binding &&
      current.view.canvas === current.canvas &&
      !!grant &&
      !this.failed.has(grant.viewId) &&
      sameNativeTerminalView(grant, current.metadata.nativeTerminal)
    )
  }
  private disposeCanvas(view: View): void {
    const canvas = view.canvas
    // A disposed/factory-era callback must never affect a replacement binding.
    view.binding = undefined
    view.canvas = undefined
    canvas?.dispose()
  }
  private failure(
    viewId: string,
    view: View,
    binding: symbol,
    stage: NativePresentationFailureStage,
  ): void {
    if (this.mounts.get(viewId) !== view || view.binding !== binding) return
    const grant = this.grants.get(viewId)
    let facts: Parameters<typeof nativePresentationFailure>[1] | undefined
    if (typeof __HVIR_SMOKE_BUILD__ !== 'undefined' && __HVIR_SMOKE_BUILD__) {
      try {
        const parent = document.getElementById(view.elementId)
        facts = {
          parentPresent: !!parent,
          parentConnected: parent?.isConnected ?? false,
          canvasConnected: parent?.querySelector('canvas')?.isConnected ?? false,
          mounted: true,
          bindingCurrent: true,
          grantPresent: !!grant,
        }
      } catch {
        /* Failure evidence cannot interfere with receiver cleanup. */
      }
    }
    this.grants.delete(viewId)
    this.failed.add(viewId)
    if (typeof __HVIR_SMOKE_BUILD__ !== 'undefined' && __HVIR_SMOKE_BUILD__ && facts)
      nativePresentationFailure(stage, facts)
    const errors: unknown[] = []
    try {
      this.disposeCanvas(view)
    } catch (error) {
      errors.push(error)
    }
    try {
      this.status({ viewId, mode: 'unavailable', reason: 'renderer-lost' })
    } catch (error) {
      errors.push(error)
    }
    // Cleanup and local listeners cannot prevent the existing main failure ACK.
    try {
      if (grant) this.reportFailure(grant)
    } catch (error) {
      errors.push(error)
    }
    if (errors.length === 1 && errors[0] instanceof Error) throw errors[0]
    if (errors.length)
      throw new AggregateError(errors, 'Native renderer failure cleanup failed')
  }
}
