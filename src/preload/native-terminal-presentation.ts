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

export interface NativeTerminalCanvasPort {
  draw(frame: unknown, metadata: NativeTerminalPresentedFrame): void
  pixels(frame: NativeTerminalPixelFrame): void
  dispose(): void
}
interface ImportedTexture {
  getVideoFrame(): { close(): void }
  release(): void
}
interface View {
  readonly elementId: string
  canvas?: NativeTerminalCanvasPort
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
    this.mounts.set(viewId, { elementId })
  }
  unmount(viewId: string): void {
    const view = this.mounts.get(viewId)
    this.mounts.delete(viewId)
    view?.canvas?.dispose()
    this.failed.delete(viewId)
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
    for (const listener of this.listeners) listener(status)
  }
  grant(value: { viewId: string; grant?: unknown }): void {
    if (!value || typeof value.viewId !== 'string') return
    if (value.grant === undefined) {
      this.grants.delete(value.viewId)
      const view = this.mounts.get(value.viewId)
      view?.canvas?.dispose()
      if (view) view.canvas = undefined
      return
    }
    if (!validNativeTerminalViewGrant(value.grant) || value.grant.viewId !== value.viewId)
      return
    if (!this.grants.has(value.viewId) && this.grants.size >= limits.maximumViews) return
    const old = this.grants.get(value.viewId)
    if (
      old &&
      old.nativeEpoch === value.grant.nativeEpoch &&
      old.attachment === value.grant.attachment &&
      value.grant.geometrySerial < old.geometrySerial
    )
      return
    this.grants.set(value.viewId, Object.freeze({ ...value.grant }))
  }
  receive(texture: ImportedTexture, metadata: unknown): void {
    let frame: ReturnType<ImportedTexture['getVideoFrame']> | undefined
    try {
      const current = this.current(metadata)
      if (!current) return
      frame = texture.getVideoFrame()
      current.canvas.draw(frame, current.metadata)
      if (this.current(current.metadata)) this.reportDraw(current.metadata)
    } catch {
      this.failure(metadata)
    } finally {
      try {
        frame?.close()
      } finally {
        texture.release()
      }
    }
  }
  pixels(value: NativeTerminalPixelFrame): boolean {
    try {
      const current = this.current(value)
      if (
        !current ||
        value.premultiplied !== false ||
        !(value.bytes instanceof Uint8Array) ||
        value.stride !== value.nativeTerminal.width * 4 ||
        value.bytes.byteLength !== value.stride * value.nativeTerminal.height ||
        value.bytes.byteLength > limits.maximumPixelBytes
      )
        return false
      current.canvas.pixels(value)
      if (this.current(current.metadata)) this.reportDraw(current.metadata)
      return true
    } catch {
      this.failure(value)
      return false
    }
  }
  dispose(): void {
    for (const id of this.mounts.keys()) this.unmount(id)
    this.grants.clear()
    this.failed.clear()
    this.listeners.clear()
  }
  private current(value: unknown):
    | {
        canvas: NativeTerminalCanvasPort
        metadata: NativeTerminalPresentedFrame
      }
    | undefined {
    if (!value || typeof value !== 'object') return
    const metadata = value as NativeTerminalPresentedFrame
    if (
      !validNativeTerminalViewGrant(metadata.nativeTerminal) ||
      ![0, 1].includes(metadata.screen) ||
      ![1, 2].includes(metadata.origin) ||
      ![1, 2].includes(metadata.colorSpace)
    )
      return
    const grant = this.grants.get(metadata.nativeTerminal.viewId)
    const view = this.mounts.get(metadata.nativeTerminal.viewId)
    if (
      !grant ||
      !view ||
      this.failed.has(grant.viewId) ||
      !sameNativeTerminalView(grant, metadata.nativeTerminal)
    )
      return
    if (!view.canvas)
      view.canvas = this.createCanvas(view.elementId, () => this.failure(metadata))
    if (!view.canvas) throw new Error('native-canvas-unavailable')
    return { canvas: view.canvas, metadata }
  }
  private failure(value: unknown): void {
    const viewId = (value as Partial<NativeTerminalPresentedFrame> | undefined)
      ?.nativeTerminal?.viewId
    if (viewId) {
      this.failed.add(viewId)
      const grant = this.grants.get(viewId)
      if (grant) this.reportFailure(grant)
      this.status({ viewId, mode: 'unavailable', reason: 'renderer-lost' })
    }
  }
}
