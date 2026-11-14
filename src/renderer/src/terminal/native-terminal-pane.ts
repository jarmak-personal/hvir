import type {
  NativeTerminalInputOperation,
  NativeTerminalInputCompletion,
} from '../../../shared/native-terminal-input'
import { NativeTerminalDomInput } from './native-terminal-dom-input'
import type { NativeTerminalPresentationApi } from '../../../shared/native-terminal-presentation'
import {
  NativeTerminalSurface,
  type NativeTerminalSurfacePort,
} from './native-terminal-surface'
import type { NativeTerminalPanePort, TerminalPresentation } from './terminal-pane'

interface NativePanePort extends NativeTerminalSurfacePort {
  attach(sessionId: string): Promise<{ viewId: string; inputUnavailable?: boolean }>
  input(request: {
    viewId: string
    input: NativeTerminalInputOperation
  }): Promise<NativeTerminalInputCompletion>
  clipboardPaste(sessionId: string, fallback: string): void
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
  private binding = false
  private viewId?: string
  private inputReady = false
  private inputRevision = 0
  private sessionId?: string
  private readonly input: NativeTerminalDomInput

  constructor(
    private readonly api: NativeTerminalPresentationApi,
    private readonly port: NativePanePort,
  ) {
    this.element.className = 'terminal-engine-host native-terminal-pane'
    this.element.style.cssText =
      'position:relative;width:100%;height:100%;overflow:hidden'
    this.element.setAttribute('role', 'textbox')
    this.element.setAttribute('aria-label', 'Native terminal development preview')
    this.element.setAttribute('aria-multiline', 'true')
    this.notice.style.cssText =
      'position:absolute;top:2px;left:4px;right:4px;z-index:2;font-size:10px;pointer-events:none'
    this.notice.setAttribute('role', 'status')
    this.notice.textContent =
      'Native preview: selection, search, semantic navigation and live settings are unfinished.'
    this.element.appendChild(this.notice)
    this.input = new NativeTerminalDomInput(this.element, {
      input: (input) => {
        if (!this.viewId) return Promise.reject(new Error('native-pane-unbound'))
        return this.port.input({ viewId: this.viewId, input })
      },
      clipboardPaste: (fallback) => {
        if (this.sessionId) this.port.clipboardPaste(this.sessionId, fallback)
      },
      accepted: (text) => {
        for (const listener of this.inputListeners) listener(text)
      },
      failed: (message) => this.fail(message),
      refused: (message) => {
        this.notice.textContent = message
      },
    })
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
      this.inputReady = false
      this.input.setReady(false)
      this.inputRevision++
    }
    this.input.setEnabled(presentation === 'visible')
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
      const { viewId, inputUnavailable } = await this.port.attach(sessionId)
      if (this.disposed) {
        await this.port.detach(viewId)
        return
      }
      this.viewId = viewId
      this.sessionId = sessionId
      if (inputUnavailable)
        this.fail('Native input unavailable; terminal output remains visible')
      this.surface = new NativeTerminalSurface(viewId, this.api, {
        demand: (id) => this.port.demand(id),
        detach: (id) => this.port.detach(id),
        update: async (id, geometry) => {
          const revision = ++this.inputRevision
          this.inputReady = false
          this.input.setReady(false)
          await this.port.update(id, geometry)
          if (!this.disposed && revision === this.inputRevision) {
            this.inputReady = geometry.visible && this.presentation === 'visible'
            this.input.setReady(this.inputReady)
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
    this.input.setReadonly()
    this.element.setAttribute('aria-readonly', 'true')
  }
  onInput(listener: (text: string) => void): () => void {
    this.inputListeners.add(listener)
    return () => this.inputListeners.delete(listener)
  }
  focus(): void {
    if (!this.disposed) this.input.focus()
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    // Logical occlusion stops demand now; physical input/resource cleanup may wait.
    this.surface?.setPresentation('hidden')
    this.inputListeners.clear()
    void this.input.dispose().finally(() => this.surface?.dispose())
    this.element.remove()
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
    input: (request) => window.hvir.invoke('native-terminal:input', request),
    clipboardPaste: (id, fallbackData) =>
      window.hvir.send('terminal:paste-image', { id, fallbackData }),
  })
}
