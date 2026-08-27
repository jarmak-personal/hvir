import {
  Terminal as GhosttyTerminal,
  init,
  type CursorBlink as GhosttyCursorBlink,
  type CursorStyle as GhosttyCursorStyle,
  type ITheme as GhosttyTheme,
  type IRetainedBufferRange as GhosttyRetainedBufferRange,
  type IRetainedBufferSearchResult as GhosttyRetainedBufferSearchResult,
  type ILink,
  type ILinkProvider,
  type TerminalEventProvenance as GhosttyTerminalEventProvenance,
} from 'ghostty-web'
import ghosttyWasmUrl from 'ghostty-web/ghostty-vt.wasm?url'

import type {
  ComposerSubmitMode,
  Disposer,
  HarnessModifiedKeyProtocol,
} from '../../../shared'
import type {
  TerminalEvent,
  TerminalEventLocation,
  TerminalEventProvenance,
  TerminalEventScreen,
  TerminalPane,
  TerminalPaneDataSource,
  TerminalPaneEvents,
  TerminalPresentation,
  TerminalSize,
  TerminalColorTheme,
  TerminalCursorDefaults,
  TerminalLinkActivation,
  TerminalRetainedBufferRange,
  TerminalRetainedBufferSearch,
  TerminalTypography,
} from './terminal-pane'
import { translateGhosttyTerminalEvent } from './ghostty-terminal-events'
import { terminalColorThemeEquals } from './terminal-palette'
import {
  detectTerminalFileLinks,
  detectTerminalWebLinks,
  isFileUri,
  isTerminalWebTarget,
} from './terminal-file-link'
import { TerminalFitController } from './ghostty-terminal-fit'
import { resolveGhosttyTerminalFilePaste } from './ghostty-terminal-file-paste'
import {
  ghosttyClipboardPasteFallback,
  ghosttyKeyboardOverride,
} from './ghostty-terminal-keyboard'
import { writePreservingViewport } from './terminal-viewport'
import { TerminalWheelController } from './terminal-wheel'

let initializeGhostty: Promise<void> | undefined
const TERMINAL_SCROLLBACK_BYTES = 10_000_000

function toGhosttyTheme(theme: TerminalColorTheme): GhosttyTheme {
  return {
    background: theme.background,
    foreground: theme.foreground,
    cursor: theme.cursor,
    cursorAccent: theme.cursorText,
    selectionBackground: theme.selectionBackground,
    selectionForeground: theme.selectionForeground,
    black: theme.black,
    red: theme.red,
    green: theme.green,
    yellow: theme.yellow,
    blue: theme.blue,
    magenta: theme.magenta,
    cyan: theme.cyan,
    white: theme.white,
    brightBlack: theme.brightBlack,
    brightRed: theme.brightRed,
    brightGreen: theme.brightGreen,
    brightYellow: theme.brightYellow,
    brightBlue: theme.brightBlue,
    brightMagenta: theme.brightMagenta,
    brightCyan: theme.brightCyan,
    brightWhite: theme.brightWhite,
  }
}

function toGhosttyCursorStyle(
  shape: TerminalCursorDefaults['shape'],
): GhosttyCursorStyle {
  return shape === 'hollow-block' ? 'block_hollow' : shape
}

function toGhosttyCursorBlink(
  policy: TerminalCursorDefaults['blink'],
): GhosttyCursorBlink {
  if (policy === 'blinking') return true
  if (policy === 'steady') return false
  return 'terminal'
}

export interface GhosttyTerminalPaneOptions {
  readonly cursorDefaults: TerminalCursorDefaults
  readonly ligatures: boolean
  readonly modifiedKeyProtocol: HarnessModifiedKeyProtocol
  readonly metaEnterAliasesControl: boolean
  readonly composerSubmitMode: ComposerSubmitMode
}

/** Load the shared WASM instance off the first paint, then create a pane. */
export async function createGhosttyTerminalPane(
  theme: TerminalColorTheme,
  typography: TerminalTypography,
  options: GhosttyTerminalPaneOptions,
): Promise<TerminalPane> {
  initializeGhostty ??= init({ wasmUrl: ghosttyWasmUrl })
  await initializeGhostty
  return new GhosttyTerminalPane(theme, typography, options)
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

class DataListenerSet {
  private readonly listeners = new Set<
    (data: string, source: TerminalPaneDataSource) => void
  >()

  on(callback: (data: string, source: TerminalPaneDataSource) => void): Disposer {
    this.listeners.add(callback)
    return () => {
      this.listeners.delete(callback)
    }
  }

  emit(data: string, source: TerminalPaneDataSource): void {
    for (const callback of this.listeners) callback(data, source)
  }

  clear(): void {
    this.listeners.clear()
  }
}

class GhosttyTerminalPane implements TerminalPane {
  private readonly terminal: GhosttyTerminal
  private readonly fit: TerminalFitController
  private readonly nativeProvenance = new WeakMap<
    TerminalEventProvenance,
    GhosttyTerminalEventProvenance
  >()
  private cursorDefaults: TerminalCursorDefaults
  private ligatures: boolean

  constructor(
    private theme: TerminalColorTheme,
    private typography: TerminalTypography,
    options: GhosttyTerminalPaneOptions,
  ) {
    this.cursorDefaults = options.cursorDefaults
    this.ligatures = options.ligatures
    this.terminal = new GhosttyTerminal({
      allowTransparency: false,
      cursorBlink: toGhosttyCursorBlink(options.cursorDefaults.blink),
      cursorStyle: toGhosttyCursorStyle(options.cursorDefaults.shape),
      fontFamily: typography.fontFamily,
      fontLigatures: options.ligatures,
      fontSize: typography.fontSize,
      scrollbackBytes: TERMINAL_SCROLLBACK_BYTES,
      theme: toGhosttyTheme(theme),
      disableContextMenu: true,
      resolveClipboardFilePaste: (file) =>
        resolveGhosttyTerminalFilePaste(window.hvir, file),
    })
    this.fit = new TerminalFitController(this.terminal)
    this.terminal.attachCustomKeyEventHandler((event) => {
      const pasteFallback = ghosttyClipboardPasteFallback(event)
      if (pasteFallback !== undefined) {
        this.emitClipboardPaste(pasteFallback)
        return true
      }
      const data = ghosttyKeyboardOverride(event, options)
      if (data === undefined) return false
      this.emitData(data, 'user')
      return true
    })
  }

  private readonly dataListeners = new DataListenerSet()
  private readonly clipboardPasteListeners = new ListenerSet<string>()
  private readonly eventListeners = new ListenerSet<TerminalEvent>()
  private readonly resizeListeners = new ListenerSet<TerminalSize>()
  private readonly linkListeners = new ListenerSet<TerminalLinkActivation>()
  private readonly engineDisposers: Array<{ dispose(): void }> = []
  private surface?: HTMLDivElement
  private mounted = false
  private disposed = false
  private presentation: TerminalPresentation = 'visible'
  private readonly wheel = new TerminalWheelController()
  private searchHighlight?: Readonly<{
    owner: object
    range: GhosttyRetainedBufferRange
  }>
  private searchHighlightLayer?: HTMLDivElement
  private hasPresentedFrame = false
  private processingPtyOutput = 0

  readonly events: TerminalPaneEvents = {
    onData: (callback) => this.dataListeners.on(callback),
    onClipboardPaste: (callback) => this.clipboardPasteListeners.on(callback),
    onEvent: (callback) => this.eventListeners.on(callback),
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
      get: () => ({
        ...this.terminal.getRenderStats(),
        cols: this.terminal.cols,
        rows: this.terminal.rows,
        retainedRows: this.terminal.getScrollbackLength(),
        retainedByteLimit: this.disposed ? 0 : this.terminal.getScrollbackByteLimit(),
        palette: this.theme,
        effectiveColors: this.terminal.wasmTerm?.getColors(),
        fontFamily: this.typography.fontFamily,
        fontSize: this.typography.fontSize,
        fontLigatures: this.ligatures,
      }),
    })
    Object.defineProperty(surface, '__hvirTerminalCursor', {
      configurable: true,
      get: () => ({
        defaults: this.cursorDefaults,
        effective: this.terminal.wasmTerm?.getCursor(),
      }),
    })
    container.append(surface)
    this.surface = surface
    this.terminal.setRenderPaused(true)
    this.engineDisposers.push(
      this.terminal.onData((data) =>
        this.emitData(
          data,
          this.processingPtyOutput > 0 ? 'terminal-response' : 'user',
        ),
      ),
      this.terminal.onResize((size) => {
        this.resizeListeners.emit(size)
        this.renderSearchHighlight()
      }),
      this.terminal.onScroll(() => this.renderSearchHighlight()),
      this.terminal.onTerminalEvent((event) => {
        const translated = translateGhosttyTerminalEvent(event, (provenance) =>
          this.retainProvenance(provenance),
        )
        if (translated) this.eventListeners.emit(translated)
      }),
    )
    this.terminal.open(surface)
    const searchHighlightLayer = document.createElement('div')
    searchHighlightLayer.className = 'terminal-search-match-highlight-layer'
    searchHighlightLayer.setAttribute('aria-hidden', 'true')
    surface.append(searchHighlightLayer)
    this.searchHighlightLayer = searchHighlightLayer
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
    this.revealAfterSettledFit()
  }

  reparent(container: HTMLElement): void {
    if (this.disposed) throw new Error('Cannot move a disposed terminal pane')
    if (!this.mounted || !this.surface) {
      throw new Error('Cannot move a terminal pane before it is mounted')
    }
    container.append(this.surface)
    this.revealAfterSettledFit()
  }

  write(data: string): void {
    if (this.disposed) return
    this.processingPtyOutput += 1
    try {
      writePreservingViewport(this.terminal, data)
      this.renderSearchHighlight()
    } finally {
      this.processingPtyOutput -= 1
    }
  }

  resize(cols: number, rows: number): void {
    if (!this.disposed) this.terminal.resize(cols, rows)
  }

  setTheme(theme: TerminalColorTheme): void {
    if (this.disposed || terminalColorThemeEquals(theme, this.theme)) return
    this.terminal.options.theme = toGhosttyTheme(theme)
    this.theme = theme
  }

  setTypography(typography: TerminalTypography): void {
    if (
      this.disposed ||
      (typography.fontFamily === this.typography.fontFamily &&
        typography.fontSize === this.typography.fontSize)
    ) {
      return
    }
    const previous = this.typography
    this.typography = typography
    if (typography.fontFamily !== previous.fontFamily) {
      this.terminal.options.fontFamily = typography.fontFamily
    }
    if (typography.fontSize !== previous.fontSize) {
      this.terminal.options.fontSize = typography.fontSize
    }
    this.revealAfterSettledFit()
  }

  setCursorDefaults(defaults: TerminalCursorDefaults): void {
    if (this.disposed) return
    if (defaults.shape !== this.cursorDefaults.shape) {
      this.terminal.options.cursorStyle = toGhosttyCursorStyle(defaults.shape)
    }
    if (defaults.blink !== this.cursorDefaults.blink) {
      this.terminal.options.cursorBlink = toGhosttyCursorBlink(defaults.blink)
    }
    this.cursorDefaults = defaults
  }

  setLigatures(enabled: boolean): void {
    if (this.disposed || enabled === this.ligatures) return
    this.terminal.options.fontLigatures = enabled
    this.ligatures = enabled
  }

  setPresentation(presentation: TerminalPresentation): void {
    if (this.disposed || presentation === this.presentation) return
    this.presentation = presentation
    if (presentation === 'hidden') {
      this.fit.suspend()
      this.terminal.setRenderPaused(true)
      const canvas = this.terminal.renderer?.getCanvas()
      if (canvas) canvas.style.visibility = 'hidden'
      this.renderSearchHighlight()
    } else {
      this.revealAfterSettledFit()
    }
  }

  redraw(): void {
    if (this.disposed) return
    this.terminal.requestRender(true)
  }

  resolveEventProvenance(
    provenance: TerminalEventProvenance,
  ): TerminalEventLocation | undefined {
    if (this.disposed) return undefined
    const native = this.nativeProvenance.get(provenance)
    if (!native) return undefined
    const location = this.terminal.resolveEventProvenance(native)
    return location
      ? { screen: location.screen, row: location.row, column: location.column }
      : undefined
  }

  activeEventScreen(): TerminalEventScreen {
    return this.terminal.wasmTerm?.isAlternateScreen() ? 'alternate' : 'normal'
  }

  revealEventLocation(location: TerminalEventLocation): boolean {
    if (this.disposed || !this.mounted) return false
    if (location.screen !== this.activeEventScreen()) return false

    const scrollbackLength = this.terminal.getScrollbackLength()
    const retainedRows = scrollbackLength + this.terminal.rows
    if (location.row < 0 || location.row >= retainedRows) return false
    this.terminal.scrollToLine(Math.max(0, scrollbackLength - location.row))
    this.redraw()
    return true
  }

  async searchRetainedBuffer(
    query: string,
    options: Readonly<{ caseSensitive: boolean; signal?: AbortSignal }>,
  ): Promise<TerminalRetainedBufferSearch> {
    if (this.disposed) throw new Error('Cannot search a disposed terminal pane')
    const result = await this.terminal.searchRetainedBuffer(query, options)
    if (this.disposed) {
      result.dispose()
      throw new Error('Terminal pane was disposed during search')
    }
    const owner = {}
    return new GhosttyRetainedBufferSearch(
      result,
      (match) => this.revealRetainedBufferRange(owner, match),
      () => this.clearSearchHighlight(owner),
    )
  }

  cancelRetainedBufferSearch(): void {
    if (!this.disposed) this.terminal.cancelRetainedBufferSearch()
  }

  captureRetainedBufferBoundary(): TerminalEventProvenance | undefined {
    if (this.disposed) return undefined
    return this.retainProvenance(this.terminal.captureRetainedBufferBoundary())
  }

  extractRetainedBufferRange(
    start: TerminalEventProvenance,
    end: TerminalEventProvenance,
    options: Readonly<{ signal?: AbortSignal }> = {},
  ): Promise<string> {
    if (this.disposed) return Promise.reject(new Error('Terminal pane is disposed'))
    const nativeStart = this.nativeProvenance.get(start)
    const nativeEnd = this.nativeProvenance.get(end)
    if (!nativeStart || !nativeEnd) {
      return Promise.reject(new Error('Terminal region boundaries are stale or foreign'))
    }
    return this.terminal.extractRetainedBufferRange(nativeStart, nativeEnd, options)
  }

  cancelRetainedBufferExtraction(): void {
    if (!this.disposed) this.terminal.cancelRetainedBufferExtraction()
  }

  hasSelection(): boolean {
    return !this.disposed && this.terminal.hasSelection()
  }

  getSelection(): string {
    return this.disposed ? '' : this.terminal.getSelection()
  }

  paste(data: string): void {
    if (!this.disposed) this.terminal.paste(data)
  }

  selectAll(): void {
    if (!this.disposed) this.terminal.selectAll()
  }

  clear(): void {
    if (this.disposed) return
    this.terminal.clear()
    this.releaseSearchHighlight()
  }

  reset(): void {
    if (this.disposed) return
    this.terminal.reset()
    this.releaseSearchHighlight()
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
    this.searchHighlight = undefined
    this.searchHighlightLayer?.remove()
    this.searchHighlightLayer = undefined
    this.surface?.remove()
    this.surface = undefined
    this.dataListeners.clear()
    this.clipboardPasteListeners.clear()
    this.eventListeners.clear()
    this.resizeListeners.clear()
    this.linkListeners.clear()
  }

  private emitData(data: string, source: TerminalPaneDataSource): void {
    if (source === 'user') this.terminal.resetCursorBlink()
    this.dataListeners.emit(data, source)
  }

  private retainProvenance(
    provenance: GhosttyTerminalEventProvenance,
  ): TerminalEventProvenance {
    const retained: TerminalEventProvenance = Object.freeze({
      id: provenance.id,
      screen: provenance.screen,
      row: provenance.row,
      column: provenance.column,
    })
    this.nativeProvenance.set(retained, provenance)
    return retained
  }

  private revealRetainedBufferRange(
    owner: object,
    match: GhosttyRetainedBufferRange,
  ): boolean {
    const revealed = this.revealEventLocation({
      screen: 'normal',
      row: match.start.row,
      column: match.start.column,
    })
    if (!revealed) return false
    this.searchHighlight = { owner, range: match }
    this.renderSearchHighlight()
    return true
  }

  private clearSearchHighlight(owner: object): void {
    if (this.searchHighlight?.owner !== owner) return
    this.releaseSearchHighlight()
  }

  private releaseSearchHighlight(): void {
    this.searchHighlight = undefined
    this.searchHighlightLayer?.replaceChildren()
  }

  private renderSearchHighlight(): void {
    const highlight = this.searchHighlight
    if (!highlight) return
    const layer = this.searchHighlightLayer
    if (!layer) return
    layer.replaceChildren()
    const renderer = this.terminal.renderer
    if (
      !highlight ||
      this.presentation === 'hidden' ||
      this.activeEventScreen() !== 'normal' ||
      !renderer
    ) {
      return
    }
    const metrics = renderer.getMetrics()
    if (metrics.width <= 0 || metrics.height <= 0) return
    const scrollbackLength = this.terminal.getScrollbackLength()
    const viewportY = Math.max(0, Math.floor(this.terminal.getViewportY()))
    const firstVisibleRow = scrollbackLength - viewportY
    const lastVisibleRow = firstVisibleRow + this.terminal.rows - 1
    const firstMatchRow = Math.max(highlight.range.start.row, firstVisibleRow)
    const lastMatchRow = Math.min(highlight.range.end.row, lastVisibleRow)
    const canvas = renderer.getCanvas()
    const cols = this.terminal.cols
    if (firstMatchRow > lastMatchRow || cols <= 0) return

    for (let row = firstMatchRow; row <= lastMatchRow; row += 1) {
      const startColumn = Math.max(
        0,
        Math.min(
          cols - 1,
          row === highlight.range.start.row ? highlight.range.start.column : 0,
        ),
      )
      const endColumn = Math.max(
        0,
        Math.min(
          cols - 1,
          row === highlight.range.end.row ? highlight.range.end.column : cols - 1,
        ),
      )
      if (endColumn < startColumn) continue
      const segment = document.createElement('div')
      segment.className = 'terminal-search-match-highlight'
      segment.dataset.retainedRow = String(row)
      segment.style.left = `${canvas.offsetLeft + startColumn * metrics.width}px`
      segment.style.top = `${
        canvas.offsetTop + (row - firstVisibleRow) * metrics.height
      }px`
      segment.style.width = `${(endColumn - startColumn + 1) * metrics.width}px`
      segment.style.height = `${metrics.height}px`
      layer.append(segment)
    }
  }

  private emitClipboardPaste(fallbackData: string): void {
    this.terminal.resetCursorBlink()
    this.clipboardPasteListeners.emit(fallbackData)
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
      this.emitData(data, 'user')
    }
    return result.handled
  }

  private revealAfterSettledFit(): void {
    if (this.disposed || this.presentation !== 'visible' || !this.mounted) return
    const retainedCanvas = this.terminal.renderer?.getCanvas()
    if (this.hasPresentedFrame && retainedCanvas) retainedCanvas.style.visibility = ''
    this.fit.resume(() => {
      if (this.disposed || this.presentation !== 'visible' || !this.mounted) return
      this.terminal.setRenderPaused(false)
      // Paint the complete retained grid after final reveal geometry settles.
      // Canvas/GPU backing stores can otherwise remain stale until a later
      // physical resize happens to force a full render.
      this.redraw()
      this.renderSearchHighlight()
      const canvas = this.terminal.renderer?.getCanvas()
      this.hasPresentedFrame = true
      if (canvas) canvas.style.visibility = ''
    })
  }
}

class GhosttyRetainedBufferSearch implements TerminalRetainedBufferSearch {
  readonly query: string
  readonly caseSensitive: boolean
  readonly matches: readonly TerminalRetainedBufferRange[]
  private readonly nativeRanges = new WeakMap<
    TerminalRetainedBufferRange,
    GhosttyRetainedBufferRange
  >()
  private disposed = false

  constructor(
    private readonly native: GhosttyRetainedBufferSearchResult,
    private readonly revealRange: (match: GhosttyRetainedBufferRange) => boolean,
    private readonly clearRevealedRange: () => void,
  ) {
    this.query = native.query
    this.caseSensitive = native.caseSensitive
    this.matches = native.matches.map((match) => {
      const retained: TerminalRetainedBufferRange = Object.freeze({
        start: Object.freeze({ row: match.start.row, column: match.start.column }),
        end: Object.freeze({ row: match.end.row, column: match.end.column }),
      })
      this.nativeRanges.set(retained, match)
      return retained
    })
  }

  reveal(match: TerminalRetainedBufferRange): boolean {
    const native = this.nativeRange(match)
    if (!native || this.native.extract(native) === undefined) return false
    return this.revealRange(native)
  }

  extract(match: TerminalRetainedBufferRange): string | undefined {
    const native = this.nativeRange(match)
    return native ? this.native.extract(native) : undefined
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.clearRevealedRange()
    this.native.dispose()
  }

  private nativeRange(
    match: TerminalRetainedBufferRange,
  ): GhosttyRetainedBufferRange | undefined {
    return this.disposed ? undefined : this.nativeRanges.get(match)
  }
}

/** Registered with custom-provider priority so file:// OSC 8 links stay inside hvir. */
export class FileLinkProvider implements ILinkProvider {
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
    const visitedHyperlinkColumns = new Set<number>()
    const wasmTerm = this.terminal.wasmTerm
    const scrollbackLength = wasmTerm?.getScrollbackLength() ?? 0
    const viewportRow = y - scrollbackLength
    const hyperlinkTargetAt = (column: number): string | null => {
      if (!wasmTerm) return null
      return viewportRow < 0
        ? wasmTerm.getScrollbackHyperlinkUri(y, column)
        : wasmTerm.getHyperlinkUri(viewportRow, column)
    }
    for (let x = 0; x < line.length; x += 1) {
      const cell = line.getCell(x)
      const codepoint = cell?.getCodepoint() ?? 0
      text.push(codepoint < 32 ? ' ' : String.fromCodePoint(codepoint))
      const id = cell?.getHyperlinkId() ?? 0
      if (id <= 0 || visitedHyperlinkColumns.has(x)) continue
      const target = hyperlinkTargetAt(x)
      if (!target || (!isFileUri(target) && !isTerminalWebTarget(target))) continue
      let start = x
      let end = x
      while (
        start > 0 &&
        (line.getCell(start - 1)?.getHyperlinkId() ?? 0) > 0 &&
        hyperlinkTargetAt(start - 1) === target
      ) {
        start -= 1
      }
      while (
        end + 1 < line.length &&
        (line.getCell(end + 1)?.getHyperlinkId() ?? 0) > 0 &&
        hyperlinkTargetAt(end + 1) === target
      ) {
        end += 1
      }
      for (let column = start; column <= end; column += 1) {
        visitedHyperlinkColumns.add(column)
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
    // Custom providers take priority over Ghostty's built-in URL detector, so
    // these exact ranges replace global window.open with typed provenance.
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
