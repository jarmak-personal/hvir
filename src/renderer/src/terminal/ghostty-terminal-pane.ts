import {
  Terminal as GhosttyTerminal,
  init,
  type ILink,
  type ILinkProvider,
} from 'ghostty-web'

import type {
  ComposerSubmitMode,
  Disposer,
  HarnessModifiedKeyProtocol,
} from '../../../shared'
import type {
  OscEvent,
  TerminalPane,
  TerminalPaneEvents,
  TerminalPresentation,
  TerminalSize,
  TerminalColorTheme,
  TerminalLinkActivation,
} from './terminal-pane'
import {
  detectTerminalFileLinks,
  detectTerminalWebLinks,
  isFileUri,
  isTerminalWebTarget,
} from './terminal-file-link'
import { TerminalFitController } from './ghostty-terminal-fit'
import { ghosttyKeyboardOverride } from './ghostty-terminal-keyboard'
import { TerminalSignalParser } from './terminal-signals'
import { writePreservingViewport } from './terminal-viewport'
import { TerminalWheelController } from './terminal-wheel'

let initializeGhostty: Promise<void> | undefined

export interface GhosttyTerminalPaneOptions {
  readonly modifiedKeyProtocol: HarnessModifiedKeyProtocol
  readonly metaEnterAliasesControl: boolean
  readonly composerSubmitMode: ComposerSubmitMode
}

/** Load the shared WASM instance off the first paint, then create a pane. */
export async function createGhosttyTerminalPane(
  theme: TerminalColorTheme,
  options: GhosttyTerminalPaneOptions,
): Promise<TerminalPane> {
  initializeGhostty ??= init()
  await initializeGhostty
  return new GhosttyTerminalPane(theme, options)
}

class ListenerSet<T> {
  private readonly listeners = new Set<(value: T) => void>()

  on(callback: (value: T) => void): Disposer {
    this.listeners.add(callback)
    return () => {
      this.listeners.delete(callback)
    }
  }

  emit(value: T): void {
    for (const callback of this.listeners) callback(value)
  }

  clear(): void {
    this.listeners.clear()
  }
}

class GhosttyTerminalPane implements TerminalPane {
  private readonly terminal: GhosttyTerminal
  private readonly fit: TerminalFitController

  constructor(theme: TerminalColorTheme, options: GhosttyTerminalPaneOptions) {
    this.terminal = new GhosttyTerminal({
      allowTransparency: false,
      cursorBlink: true,
      cursorStyle: 'block',
      fontFamily: "'JetBrains Mono', 'SFMono-Regular', Consolas, monospace",
      fontSize: 13,
      scrollback: 10_000,
      theme,
    })
    this.fit = new TerminalFitController(this.terminal)
    this.terminal.attachCustomKeyEventHandler((event) => {
      const data = ghosttyKeyboardOverride(event, options)
      if (data === undefined) return false
      this.emitInput(data)
      return true
    })
  }

  private readonly dataListeners = new ListenerSet<string>()
  private readonly titleListeners = new ListenerSet<string>()
  private readonly bellListeners = new ListenerSet<void>()
  private readonly oscListeners = new ListenerSet<OscEvent>()
  private readonly resizeListeners = new ListenerSet<TerminalSize>()
  private readonly linkListeners = new ListenerSet<TerminalLinkActivation>()
  private readonly engineDisposers: Array<{ dispose(): void }> = []
  private surface?: HTMLDivElement
  private mounted = false
  private disposed = false
  private presentation: TerminalPresentation = 'visible'
  private readonly signalParser = new TerminalSignalParser()
  private readonly wheel = new TerminalWheelController()
  private lastTitle = ''

  readonly events: TerminalPaneEvents = {
    onData: (callback) => this.dataListeners.on(callback),
    onTitle: (callback) => this.titleListeners.on(callback),
    onBell: (callback) => this.bellListeners.on(callback),
    onOsc: (callback) => this.oscListeners.on(callback),
    onResize: (callback) => this.resizeListeners.on(callback),
    onLink: (callback) => this.linkListeners.on(callback),
  }

  mount(container: HTMLElement): void {
    if (this.disposed) throw new Error('Cannot mount a disposed terminal pane')
    if (this.mounted) throw new Error('Terminal pane is already mounted')
    this.mounted = true
    const surface = document.createElement('div')
    surface.className = 'terminal-engine-host'
    // Read-only smoke/capacity telemetry. Keep it on the concrete adapter so
    // the engine-neutral TerminalPane seam does not learn ghostty counters.
    Object.defineProperty(surface, '__hvirTerminalPerformance', {
      configurable: true,
      get: () => this.terminal.getRenderStats(),
    })
    container.append(surface)
    this.surface = surface
    this.engineDisposers.push(
      this.terminal.onData((data) => this.emitInput(data)),
      this.terminal.onResize((size) => this.resizeListeners.emit(size)),
      this.terminal.onTitleChange((title) => this.emitTitle(title)),
    )
    this.terminal.open(surface)
    this.terminal.registerLinkProvider(
      new FileLinkProvider(this.terminal, (target) => this.linkListeners.emit(target)),
    )
    this.terminal.attachCustomWheelEventHandler((event) => this.handleWheel(event))
    const canvas = this.terminal.renderer?.getCanvas()
    if (canvas) canvas.style.visibility = 'hidden'
    this.fit.fit()
    // A fresh pane must begin from an explicitly reset VT buffer. Depending on
    // WASM allocator reuse, construction can expose cells and rendition from
    // the terminal just freed during reconnect. Reset only after the initial
    // fit: resizing the temporary 80x24 buffer can copy recycled cells back in.
    this.terminal.write('\u001bc')
    this.fit.observeResize()
    this.redraw()
    if (canvas) canvas.style.visibility = ''
    requestAnimationFrame(() => {
      if (!this.disposed) {
        this.fit.fit()
        // Paint the complete blank grid as well as dirty cells. Canvas/GPU
        // backing stores can otherwise expose pixels from a disposed terminal
        // until the first physical resize forces a full render.
        this.redraw()
      }
    })
  }

  reparent(container: HTMLElement): void {
    if (this.disposed) throw new Error('Cannot move a disposed terminal pane')
    if (!this.mounted || !this.surface) {
      throw new Error('Cannot move a terminal pane before it is mounted')
    }
    container.append(this.surface)
    this.fit.fit()
    this.redraw()
  }

  write(data: string): void {
    if (this.disposed) return
    this.inspectSignals(data)
    writePreservingViewport(this.terminal, data)
  }

  resize(cols: number, rows: number): void {
    if (!this.disposed) this.terminal.resize(cols, rows)
  }

  setTheme(theme: TerminalColorTheme): void {
    if (this.disposed) return
    this.terminal.options.theme = theme
    // ghostty-web's mutable option currently records the value but does not
    // forward it to the canvas renderer. Keep the seam correct for engines and
    // call the renderer's public theme method while upstream support matures.
    this.terminal.renderer?.setTheme(theme)
    this.redraw()
  }

  setPresentation(presentation: TerminalPresentation): void {
    if (this.disposed || presentation === this.presentation) return
    this.presentation = presentation
    this.terminal.options.cursorBlink = presentation === 'visible'
    if (presentation === 'hidden') {
      this.terminal.setRenderPaused(true)
    } else {
      if (this.mounted) this.fit.fit()
      this.terminal.setRenderPaused(false)
    }
  }

  redraw(): void {
    if (this.disposed) return
    this.terminal.requestRender(true)
  }

  focus(): void {
    if (!this.disposed) this.terminal.focus()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.fit.dispose()
    for (const disposer of this.engineDisposers) disposer.dispose()
    this.engineDisposers.length = 0
    const renderer = this.terminal.renderer
    const canvas = renderer?.getCanvas()
    renderer?.clear()
    if (canvas) canvas.style.visibility = 'hidden'
    this.terminal.dispose()
    this.surface?.remove()
    this.surface = undefined
    this.dataListeners.clear()
    this.titleListeners.clear()
    this.bellListeners.clear()
    this.oscListeners.clear()
    this.resizeListeners.clear()
    this.linkListeners.clear()
    this.signalParser.reset()
  }

  /** ghostty-web does not distinguish real BEL from BEL-terminated OSC. */
  private inspectSignals(chunk: string): void {
    const signals = this.signalParser.consume(chunk)
    for (const title of signals.titles) this.emitTitle(title)
    for (const event of signals.oscillators) this.oscListeners.emit(event)
    for (let index = 0; index < signals.bells; index += 1) {
      this.bellListeners.emit()
    }
  }

  private emitTitle(title: string): void {
    if (title === this.lastTitle) return
    this.lastTitle = title
    this.titleListeners.emit(title)
  }

  private emitInput(data: string): void {
    this.terminal.resetCursorBlink()
    this.dataListeners.emit(data)
  }

  private handleWheel(event: WheelEvent): boolean {
    const term = this.terminal.wasmTerm
    const renderer = this.terminal.renderer
    const result = this.wheel.handle(event, {
      alternateScreen: term?.isAlternateScreen() ?? false,
      mouseTracking: term?.hasMouseTracking() ?? false,
      sgrMouse: term?.getMode(1006) ?? false,
      cols: this.terminal.cols,
      rows: this.terminal.rows,
      cellWidth: renderer?.charWidth ?? 1,
      cellHeight: renderer?.charHeight ?? 16,
    })
    for (const data of result.data) {
      this.dataListeners.emit(data)
    }
    return result.handled
  }
}

/** Registered after Ghostty's built-ins so file:// OSC 8 links stay inside hvir. */
class FileLinkProvider implements ILinkProvider {
  constructor(
    private readonly terminal: GhosttyTerminal,
    private readonly activateTarget: (activation: TerminalLinkActivation) => void,
  ) {}

  provideLinks(y: number, callback: (links: ILink[] | undefined) => void): void {
    const line = this.terminal.buffer.active.getLine(y)
    if (!line) {
      callback(undefined)
      return
    }

    const text: string[] = []
    const links: ILink[] = []
    const hyperlinkIds = new Set<number>()
    for (let x = 0; x < line.length; x += 1) {
      const cell = line.getCell(x)
      const codepoint = cell?.getCodepoint() ?? 0
      text.push(codepoint < 32 ? ' ' : String.fromCodePoint(codepoint))
      const id = cell?.getHyperlinkId() ?? 0
      if (id <= 0 || hyperlinkIds.has(id)) continue
      hyperlinkIds.add(id)
      const target = this.terminal.wasmTerm?.getHyperlinkUri(id)
      if (!target || (!isFileUri(target) && !isTerminalWebTarget(target))) continue
      let start = x
      let end = x
      while (start > 0 && line.getCell(start - 1)?.getHyperlinkId() === id) start -= 1
      while (end + 1 < line.length && line.getCell(end + 1)?.getHyperlinkId() === id) {
        end += 1
      }
      links.push(
        this.link(
          { kind: isFileUri(target) ? 'file' : 'loopback-http', target },
          y,
          start,
          end,
        ),
      )
    }

    const lineText = text.join('')
    for (const candidate of detectTerminalFileLinks(lineText)) {
      links.push(
        this.link(
          { kind: 'file', target: candidate.target },
          y,
          candidate.start,
          candidate.end,
        ),
      )
    }
    // Registered after Ghostty's built-in URL detector, so these exact ranges
    // replace its global window.open activations with typed terminal provenance.
    for (const candidate of detectTerminalWebLinks(lineText)) {
      links.push(
        this.link(
          { kind: 'loopback-http', target: candidate.target },
          y,
          candidate.start,
          candidate.end,
        ),
      )
    }
    callback(links.length > 0 ? links : undefined)
  }

  private link(
    activation: TerminalLinkActivation,
    y: number,
    start: number,
    end: number,
  ): ILink {
    return {
      text: activation.target,
      range: { start: { x: start, y }, end: { x: end, y } },
      activate: (event) => {
        if (event.ctrlKey || event.metaKey) this.activateTarget(activation)
      },
    }
  }
}
