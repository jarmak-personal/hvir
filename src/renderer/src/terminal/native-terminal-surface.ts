import type {
  NativeTerminalPresentationApi,
  NativeTerminalPresentationStatus,
} from '../../../shared/native-terminal-presentation'
import type { TerminalPresentation } from './terminal-pane'

export interface NativeTerminalSurfacePort {
  update(
    viewId: string,
    geometry: {
      width: number
      height: number
      backingScale: number
      visible: boolean
    },
  ): Promise<unknown>
  demand(viewId: string): Promise<void>
  detach(viewId: string): Promise<void>
}

/** A retained DOM/input host; native parser and PTY lifetime remain elsewhere.
 * Fits the existing Workspace/Sessions surface owner without a second widget. */
export class NativeTerminalSurface {
  private readonly element = document.createElement('div')
  private readonly message = document.createElement('div')
  private visible = false
  private disposed = false
  private pending = false
  private animation?: number
  private geometry?: string
  private lastLayout?: { width: number; height: number; backingScale: number }
  private revision = 0
  private readonly unsubscribe: () => void
  constructor(
    private readonly viewId: string,
    private readonly api: NativeTerminalPresentationApi,
    private readonly port: NativeTerminalSurfacePort,
  ) {
    this.element.id = `native-terminal-${viewId}`
    this.element.style.cssText =
      'position:relative;width:100%;height:100%;overflow:hidden'
    this.element.tabIndex = 0
    this.message.setAttribute('role', 'status')
    this.message.style.cssText =
      'position:absolute;bottom:4px;right:4px;z-index:1;font-size:11px;pointer-events:none'
    this.element.appendChild(this.message)
    this.unsubscribe = api.onStatus((status) => this.status(status))
  }
  mount(container: HTMLElement): void {
    if (this.disposed) throw new Error('native-surface-closed')
    container.appendChild(this.element)
    this.api.mount(this.viewId, this.element.id)
    this.schedule()
  }
  reparent(container: HTMLElement): void {
    this.setPresentation('hidden')
    container.appendChild(this.element)
    this.geometry = undefined
  }
  setPresentation(presentation: TerminalPresentation): void {
    if (this.disposed) return
    this.visible = presentation === 'visible'
    this.revision++
    const revision = this.revision
    if (this.visible) this.schedule()
    else {
      if (this.animation !== undefined) cancelAnimationFrame(this.animation)
      this.animation = undefined
      this.geometry = undefined
      // Retain the last usable extent; a hidden/zero DOM size is never a resize.
      const size = this.element.getBoundingClientRect()
      const layout =
        this.lastLayout ??
        (size.width >= 32 && size.height >= 32
          ? {
              width: size.width,
              height: size.height,
              backingScale: window.devicePixelRatio,
            }
          : undefined)
      if (layout)
        void this.port
          .update(this.viewId, {
            ...layout,
            visible: false,
          })
          .catch(() => {
            if (!this.disposed && this.revision === revision) this.unavailable()
          })
    }
  }
  dispose(): void {
    if (this.disposed) return
    this.setPresentation('hidden')
    this.disposed = true
    this.unsubscribe()
    this.api.unmount(this.viewId)
    this.element.remove()
    void this.port.detach(this.viewId).catch(() => undefined)
  }
  private schedule(): void {
    if (!this.visible || this.disposed || this.animation !== undefined) return
    this.animation = requestAnimationFrame(() => {
      this.animation = undefined
      void this.present()
    })
  }
  private async present(): Promise<void> {
    if (!this.visible || this.disposed || this.pending) return
    this.pending = true
    const revision = this.revision
    try {
      const size = this.element.getBoundingClientRect()
      const scale = window.devicePixelRatio
      if (size.width < 32 || size.height < 32) return
      const geometry = `${size.width}:${size.height}:${scale}`
      this.lastLayout = { width: size.width, height: size.height, backingScale: scale }
      if (geometry !== this.geometry) {
        await this.port.update(this.viewId, {
          width: size.width,
          height: size.height,
          backingScale: scale,
          visible: true,
        })
        if (this.disposed || revision !== this.revision) return
        this.geometry = geometry
      }
      if (this.visible && !this.disposed && revision === this.revision)
        await this.port.demand(this.viewId)
    } catch {
      if (!this.disposed && revision === this.revision) this.unavailable()
    } finally {
      this.pending = false
      this.schedule()
    }
  }
  private status(status: NativeTerminalPresentationStatus): void {
    if (status.viewId !== this.viewId) return
    this.message.textContent =
      status.mode === 'native-pixels'
        ? 'Compatibility rendering'
        : status.mode === 'unavailable'
          ? 'Terminal unavailable'
          : ''
    if (status.mode === 'unavailable') this.visible = false
  }
  private unavailable(): void {
    this.status({ viewId: this.viewId, mode: 'unavailable' })
  }
}
