import { NativeTerminalLinks } from './native-terminal-links'
import type {
  NativeTerminalLinkIntent,
  NativeTerminalLinkCapture,
  NativeTerminalLinkActivation,
} from '../../../shared/native-terminal-link'
import { NativeTerminalSelection } from './native-terminal-selection'
import { writeApplicationClipboard } from './terminal-clipboard'
import { resolveTerminalFilePaste } from './terminal-file-paste'
import type {
  NativeTerminalSelectionRequest,
  NativeTerminalSelectionReadRequest,
  NativeTerminalSelectionResponse,
} from '../../../shared/native-terminal-selection'
import { NativeTerminalPaneEffects } from './native-terminal-pane-effects'
import type { NativeTerminalProductEffect } from '../../../shared/native-terminal-effects'
import type { TerminalEvent, TerminalLinkActivation } from './terminal-pane'
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
  attach(sessionId: string): Promise<{
    viewId: string
    instanceId?: string
    inputUnavailable?: boolean
    title?: { title: string; eventSerial: number }
  }>
  input(request: {
    viewId: string
    input: NativeTerminalInputOperation
  }): Promise<NativeTerminalInputCompletion>
  clipboardPaste(sessionId: string, fallback: string): void
  selection(
    request: NativeTerminalSelectionRequest,
  ): Promise<NativeTerminalSelectionResponse>
  readSelection(
    request: NativeTerminalSelectionReadRequest,
  ): Promise<NativeTerminalSelectionResponse>
  link(request: NativeTerminalLinkIntent): Promise<NativeTerminalLinkCapture>
  readLink(
    viewId: string,
    requestId: string,
  ): Promise<NativeTerminalLinkActivation | undefined>
  cancelSelection(viewId: string, requestId: string): void
  resolveFilePaste?(
    file: File | undefined,
  ): string | undefined | Promise<string | undefined>
  metadata?(
    id: string,
  ): Promise<import('../../../shared/native-terminal-effects').NativeTerminalMetadata>
  effects?(listener: (effect: NativeTerminalProductEffect) => void): () => void
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
  private readonly effectEvents = new NativeTerminalPaneEffects(() => ({
    sessionId: this.sessionId,
    instanceId: this.instanceId,
    disposed: this.disposed,
  }))
  private instanceId?: string
  private readonly stopEffects?: () => void
  private readonly input: NativeTerminalDomInput
  private readonly links: NativeTerminalLinks
  private readonly linkListeners = new Set<(link: TerminalLinkActivation) => void>()
  private readonly selectionOwner: NativeTerminalSelection
  get selection() {
    return this.selectionOwner.capability
  }

  constructor(
    private readonly api: NativeTerminalPresentationApi,
    private readonly port: NativePanePort,
  ) {
    this.stopEffects = this.port.effects?.((effect) => this.effectEvents.accept(effect))
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
      'Native preview: search, semantic navigation and live settings are unfinished.'
    this.element.appendChild(this.notice)
    this.selectionOwner = new NativeTerminalSelection({
      view: () =>
        !this.disposed && this.inputReady && this.presentation === 'visible'
          ? this.viewId
          : undefined,
      perform: (action, requestId, signal) =>
        this.input.selection(action, requestId, signal),
      readSelection: (viewId, requestId) =>
        this.port.readSelection({ viewId, requestId }),
      cancel: (viewId, requestId) => this.port.cancelSelection(viewId, requestId),
    })
    this.links = new NativeTerminalLinks({
      view: () =>
        !this.disposed && this.inputReady && this.presentation === 'visible'
          ? this.viewId
          : undefined,
      capture: (request) => this.port.link(request),
      read: (viewId, requestId) => this.port.readLink(viewId, requestId),
      cancel: (viewId, requestId) => this.port.cancelSelection(viewId, requestId),
      activate: (link) => {
        if (link.kind === 'external-http')
          window.open(link.target, '_blank', 'noopener,noreferrer')
        else
          for (const listener of this.linkListeners)
            listener({
              kind: link.kind,
              target: link.target,
              workspaceRoot: link.workspaceRoot,
            })
      },
      refused: () => {
        this.notice.textContent = 'Could not open the terminal link'
      },
    })
    this.input = new NativeTerminalDomInput(this.element, {
      input: (input) => {
        if (!this.viewId) return Promise.reject(new Error('native-pane-unbound'))
        return this.port.input({ viewId: this.viewId, input })
      },
      selection: (action, requestId) => {
        if (!this.viewId) return Promise.reject(new Error('native-pane-unbound'))
        return this.port.selection({
          viewId: this.viewId,
          action,
          ...(requestId ? { requestId } : {}),
        })
      },
      activateLink: (x, y) => this.links.begin(x, y),
      copySelection: () => this.selectionOwner.copy(writeApplicationClipboard),
      resolveFilePaste: (file) => this.port.resolveFilePaste?.(file),
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
      this.selectionOwner.revoke()
      this.links.revoke()
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
      const { viewId, instanceId, inputUnavailable, title } =
        await this.port.attach(sessionId)
      if (this.disposed) {
        await this.port.detach(viewId)
        return
      }
      this.instanceId = instanceId
      this.viewId = viewId
      this.sessionId = sessionId
      this.effectEvents.restoreTitle(title)
      if (this.port.metadata && instanceId) {
        const metadata = await this.port.metadata(sessionId)
        if (this.disposed) {
          this.viewId = undefined
          await this.port.detach(viewId)
          return
        }
        if (this.viewId !== viewId || metadata.instanceId !== instanceId)
          throw new Error('native-pane-binding-stale')
        this.effectEvents.restoreTitle(metadata.title)
      }
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
      if (this.viewId && !this.surface) {
        const view = this.viewId
        this.viewId = undefined
        try {
          await this.port.detach(view)
        } catch (cleanup) {
          throw new AggregateError(
            [error, cleanup],
            'Native terminal binding cleanup failed',
            { cause: cleanup },
          )
        }
      }
      this.fail('Native terminal unavailable')
      throw error
    } finally {
      this.binding = false
    }
  }
  paste(data: string): void {
    this.input.pasteText(data)
  }
  setReadonly(): void {
    this.selectionOwner.revoke()
    this.links.revoke()
    this.input.setReadonly()
    this.element.setAttribute('aria-readonly', 'true')
  }
  onInput(listener: (text: string) => void): () => void {
    this.inputListeners.add(listener)
    return () => this.inputListeners.delete(listener)
  }
  onLink(listener: (link: TerminalLinkActivation) => void): () => void {
    this.linkListeners.add(listener)
    return () => this.linkListeners.delete(listener)
  }
  onEffect(listener: (event: TerminalEvent) => void): () => void {
    return this.effectEvents.subscribe(listener)
  }
  focus(): void {
    if (!this.disposed) this.input.focus()
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.selectionOwner.revoke()
    this.links.revoke()
    // Logical occlusion stops demand now; physical input/resource cleanup may wait.
    this.surface?.setPresentation('hidden')
    this.inputListeners.clear()
    this.linkListeners.clear()
    this.stopEffects?.()
    this.effectEvents.clear()
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
    metadata: (id) => window.hvir.invoke('native-terminal:metadata', { id }),
    effects: (listener) => window.hvir.on('native-terminal:effect', listener),
    attach: (id) => window.hvir.invoke('native-terminal:attach', { id }),
    update: (viewId, geometry) =>
      window.hvir.invoke('native-terminal:update', { viewId, ...geometry }),
    demand: async (viewId) => {
      await window.hvir.invoke('native-terminal:demand', { viewId })
    },
    detach: (viewId) => window.hvir.invoke('native-terminal:detach', { viewId }),
    input: (request) => window.hvir.invoke('native-terminal:input', request),
    selection: (request) => window.hvir.invoke('native-terminal:selection', request),
    link: (request) => window.hvir.invoke('native-terminal:link', request),
    readLink: (viewId, requestId) =>
      window.hvir.invoke('native-terminal:link-read', { viewId, requestId }),
    readSelection: (request) =>
      window.hvir.invoke('native-terminal:selection-read', request),
    cancelSelection: (viewId, requestId) =>
      window.hvir.send('native-terminal:selection-cancel', { viewId, requestId }),
    resolveFilePaste: (file) => resolveTerminalFilePaste(window.hvir, file),
    clipboardPaste: (id, fallbackData) =>
      window.hvir.send('terminal:paste-image', { id, fallbackData }),
  })
}
