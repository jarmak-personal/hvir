import type { NativeTerminalPresentationApi } from '../../../shared/native-terminal-presentation'
import {
  NativeTerminalSurface,
  type NativeTerminalSurfacePort,
} from './native-terminal-surface'
import type { NativeTerminalPanePort, TerminalPresentation } from './terminal-pane'

interface NativePanePort extends NativeTerminalSurfacePort {
  attach(sessionId: string): Promise<{ viewId: string }>
  key(request: {
    viewId: string
    key: number
    modifiers: number
    action: 0 | 1 | 2
    text: string
  }): Promise<void>
}
// Concrete pinned engine adapter only: ghostty.h's W3C-code enum (ABI4).
// Rich IME, paste, pointer and modified-key policy belong to the following input slice.
const functionalKeys: Readonly<Record<string, number>> = {
  Backspace: 53,
  Enter: 58,
  Space: 63,
  Tab: 64,
  ArrowDown: 75,
  ArrowLeft: 76,
  ArrowRight: 77,
  ArrowUp: 78,
  Escape: 120,
}

/** Retains one DOM/presentation surface without a renderer parser or output mirror. */
export class NativeTerminalPane implements NativeTerminalPanePort {
  readonly engine = 'native' as const
  private readonly element = document.createElement('div')
  private readonly notice = document.createElement('div')
  private readonly inputListeners = new Set<(text: string) => void>()
  private surface?: NativeTerminalSurface
  private presentation: TerminalPresentation = 'hidden'
  private disposed = false
  private readonlyState = false
  private binding = false
  private viewId?: string
  private activeInput = false
  private inputReady = false
  private inputRevision = 0
  private readonly keys: Array<{
    key: number
    modifiers: number
    action: 0 | 1 | 2
    text: string
  }> = []

  constructor(
    private readonly api: NativeTerminalPresentationApi,
    private readonly port: NativePanePort,
  ) {
    this.element.className = 'terminal-engine-host native-terminal-pane'
    this.element.style.cssText =
      'position:relative;width:100%;height:100%;overflow:hidden'
    this.element.tabIndex = 0
    this.element.setAttribute('role', 'textbox')
    this.element.setAttribute('aria-label', 'Native terminal development preview')
    this.element.setAttribute('aria-multiline', 'true')
    this.notice.style.cssText =
      'position:absolute;top:2px;left:4px;right:4px;z-index:2;font-size:10px;pointer-events:none'
    this.notice.setAttribute('role', 'status')
    this.notice.textContent =
      'Native preview: search, selection, semantic navigation, scrolling, clipboard/IME and live settings are unfinished.'
    this.element.appendChild(this.notice)
    this.element.addEventListener('keydown', this.keydown)
    this.element.addEventListener('paste', this.unsupportedInput)
    this.element.addEventListener('compositionstart', this.unsupportedInput)
  }
  mount(container: HTMLElement): void {
    if (this.disposed) throw new Error('native-pane-closed')
    container.appendChild(this.element)
  }
  reparent(container: HTMLElement): void {
    this.setPresentation('hidden')
    container.appendChild(this.element)
  }
  setPresentation(presentation: TerminalPresentation): void {
    this.presentation = presentation
    if (presentation === 'hidden') {
      this.keys.length = 0
      this.inputReady = false
      this.inputRevision++
    }
    this.surface?.setPresentation(presentation)
  }
  viewport(): { width: number; height: number; backingScale: number } {
    const bounds = this.element.getBoundingClientRect()
    const backingScale = window.devicePixelRatio
    const width = Math.round(bounds.width * backingScale)
    const height = Math.round(bounds.height * backingScale)
    if (
      !Number.isFinite(backingScale) ||
      backingScale < 1 ||
      backingScale > 4 ||
      width < 32 ||
      height < 32 ||
      width > 8192 ||
      height > 8192
    )
      throw new Error('Native terminal requires a measurable visible pane')
    return { width, height, backingScale }
  }
  async bind(sessionId: string): Promise<void> {
    if (this.disposed || this.binding || this.viewId)
      throw new Error('native-pane-bind-stale')
    this.binding = true
    try {
      const { viewId } = await this.port.attach(sessionId)
      if (this.disposed) {
        await this.port.detach(viewId)
        return
      }
      this.viewId = viewId
      this.surface = new NativeTerminalSurface(viewId, this.api, {
        demand: (id) => this.port.demand(id),
        detach: (id) => this.port.detach(id),
        update: async (id, geometry) => {
          const revision = ++this.inputRevision
          this.inputReady = false
          await this.port.update(id, geometry)
          if (!this.disposed && revision === this.inputRevision) {
            this.inputReady = geometry.visible && this.presentation === 'visible'
            if (this.inputReady) void this.flushKeys()
          }
        },
      })
      this.surface.mount(this.element)
      this.surface.setPresentation(this.presentation)
    } catch (error) {
      this.fail('Native terminal unavailable')
      throw error
    } finally {
      this.binding = false
    }
  }
  setReadonly(): void {
    this.readonlyState = true
    this.keys.length = 0
    this.element.setAttribute('aria-readonly', 'true')
  }
  onInput(listener: (text: string) => void): () => void {
    this.inputListeners.add(listener)
    return () => this.inputListeners.delete(listener)
  }
  focus(): void {
    if (!this.disposed) this.element.focus()
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.keys.length = 0
    this.inputListeners.clear()
    this.element.removeEventListener('keydown', this.keydown)
    this.element.removeEventListener('paste', this.unsupportedInput)
    this.element.removeEventListener('compositionstart', this.unsupportedInput)
    this.surface?.dispose()
    this.element.remove()
  }
  private readonly unsupportedInput = (event: Event): void => {
    event.preventDefault()
    this.notice.textContent =
      'Native preview: clipboard paste and IME are not available yet.'
  }
  private readonly keydown = (event: KeyboardEvent): void => {
    if (
      this.disposed ||
      this.readonlyState ||
      !this.viewId ||
      this.presentation !== 'visible' ||
      event.defaultPrevented ||
      event.isComposing ||
      event.metaKey
    )
      return
    let key = functionalKeys[event.code]
    if (/^Key[A-Z]$/.test(event.code)) key = 20 + event.code.charCodeAt(3) - 65
    const text = event.key.length === 1 ? event.key : ''
    if (key === undefined && !text) return
    if ((event.ctrlKey || event.altKey) && key === undefined) return
    event.preventDefault()
    if (this.keys.length >= 32) {
      this.fail('Native terminal input capacity reached')
      return
    }
    this.keys.push({
      key: key ?? 0,
      modifiers:
        Number(event.shiftKey) |
        (Number(event.ctrlKey) << 1) |
        (Number(event.altKey) << 2),
      action: event.repeat ? 2 : 1,
      text,
    })
    void this.flushKeys()
  }
  private async flushKeys(): Promise<void> {
    if (this.activeInput || !this.inputReady) return
    this.activeInput = true
    try {
      while (
        this.keys.length &&
        this.viewId &&
        !this.disposed &&
        !this.readonlyState &&
        this.inputReady &&
        this.presentation === 'visible'
      ) {
        const request = this.keys.shift()!
        const revision = this.inputRevision
        try {
          await this.port.key({ viewId: this.viewId, ...request })
        } catch (error) {
          // Hide/reparent revokes the old input admission. A newly acknowledged
          // view may already have fresh keys waiting behind this physical call.
          if (revision !== this.inputRevision) continue
          throw error
        }
        if (!this.disposed && !this.readonlyState && revision === this.inputRevision)
          for (const listener of this.inputListeners)
            listener(request.key === 58 ? '\r' : request.text)
      }
    } catch {
      if (!this.disposed) this.fail('Native terminal input unavailable')
    } finally {
      this.activeInput = false
    }
  }
  private fail(message: string): void {
    this.setReadonly()
    this.notice.textContent = message
  }
}

export function createNativeTerminalPane(): NativeTerminalPane {
  return new NativeTerminalPane(window.hvir.nativeTerminalPresentation, {
    attach: (id) => window.hvir.invoke('native-terminal:attach', { id }),
    update: (viewId, geometry) =>
      window.hvir.invoke('native-terminal:update', { viewId, ...geometry }),
    demand: async (viewId) => {
      await window.hvir.invoke('native-terminal:demand', { viewId })
    },
    detach: (viewId) => window.hvir.invoke('native-terminal:detach', { viewId }),
    key: (request) => window.hvir.invoke('native-terminal:key', request),
  })
}
