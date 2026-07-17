import {
  FitAddon,
  Terminal as GhosttyTerminal,
  init,
  type ILink,
  type ILinkProvider,
} from 'ghostty-web'

import type { Disposer } from '../../../shared'
import type {
  OscEvent,
  TerminalPane,
  TerminalPaneEvents,
  TerminalSize,
  TerminalColorTheme,
} from './terminal-pane'
import { detectTerminalFileLinks, isFileUri } from './terminal-file-link'
import { TerminalSignalParser } from './terminal-signals'

let initializeGhostty: Promise<void> | undefined

/** Load the shared WASM instance off the first paint, then create a pane. */
export async function createGhosttyTerminalPane(
  theme: TerminalColorTheme,
): Promise<TerminalPane> {
  initializeGhostty ??= init()
  await initializeGhostty
  return new GhosttyTerminalPane(theme)
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
  private readonly fit = new FitAddon()

  constructor(theme: TerminalColorTheme) {
    this.terminal = new GhosttyTerminal({
      allowTransparency: false,
      cursorBlink: true,
      cursorStyle: 'block',
      fontFamily: "'JetBrains Mono', 'SFMono-Regular', Consolas, monospace",
      fontSize: 13,
      scrollback: 10_000,
      theme,
    })
  }

  private readonly dataListeners = new ListenerSet<string>()
  private readonly titleListeners = new ListenerSet<string>()
  private readonly bellListeners = new ListenerSet<void>()
  private readonly oscListeners = new ListenerSet<OscEvent>()
  private readonly resizeListeners = new ListenerSet<TerminalSize>()
  private readonly linkListeners = new ListenerSet<string>()
  private readonly engineDisposers: Array<{ dispose(): void }> = []
  private mounted = false
  private disposed = false
  private readonly signalParser = new TerminalSignalParser()
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
    this.terminal.loadAddon(this.fit)
    this.engineDisposers.push(
      this.terminal.onData((data) => this.dataListeners.emit(data)),
      this.terminal.onResize((size) => this.resizeListeners.emit(size)),
      this.terminal.onTitleChange((title) => this.emitTitle(title)),
    )
    this.terminal.open(container)
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

  write(data: string): void {
    if (this.disposed) return
    this.inspectSignals(data)
    this.terminal.write(data)
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

  redraw(): void {
    if (this.disposed) return
    const { renderer, wasmTerm, viewportY } = this.terminal
    if (renderer && wasmTerm) renderer.render(wasmTerm, true, viewportY)
  }

  focus(): void {
    if (!this.disposed) this.terminal.focus()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const disposer of this.engineDisposers) disposer.dispose()
    this.engineDisposers.length = 0
    const renderer = this.terminal.renderer
    const canvas = renderer?.getCanvas()
    renderer?.clear()
    if (canvas) canvas.style.visibility = 'hidden'
    this.terminal.dispose()
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

  private handleWheel(event: WheelEvent): boolean {
    if (event.deltaY === 0) return false
    const term = this.terminal.wasmTerm
    // Apps that track the mouse (tmux with `mouse on`, and mouse-aware TUIs)
    // expect real wheel events, but ghostty-web never forwards them. When SGR
    // extended reporting is active, synthesize the report ourselves (button 64
    // = wheel up, 65 = wheel down): that's what lets tmux enter copy-mode and
    // scroll its own scrollback.
    if ((term?.hasMouseTracking() ?? false) && (term?.getMode(1006) ?? false)) {
      const { col, row } = this.wheelCell(event)
      this.dataListeners.emit(`\x1b[<${event.deltaY > 0 ? 65 : 64};${col};${row}M`)
      return true
    }
    // On the alternate screen without mouse tracking (Claude Code, Codex),
    // ghostty-web's default repeats the Up/Down arrow per tick, which those
    // CLIs read as prompt-history recall — an incidental scroll silently
    // overwrites what the user typed. Send PageUp/PageDown instead: it's the
    // conventional full-screen-TUI scroll key and never collides with
    // single-line history navigation.
    if (term?.isAlternateScreen() ?? false) {
      this.dataListeners.emit(event.deltaY > 0 ? '\x1b[6~' : '\x1b[5~')
      return true
    }
    return false
  }

  /** 1-based cell under the wheel event, for SGR mouse reports. */
  private wheelCell(event: WheelEvent): { col: number; row: number } {
    const renderer = this.terminal.renderer
    const cellWidth = renderer?.charWidth || 1
    const cellHeight = renderer?.charHeight || 1
    const col = Math.floor((event.offsetX || 0) / cellWidth) + 1
    const row = Math.floor((event.offsetY || 0) / cellHeight) + 1
    return {
      col: Math.max(1, Math.min(col, this.terminal.cols)),
      row: Math.max(1, Math.min(row, this.terminal.rows)),
    }
  }
}

/** Registered after Ghostty's built-ins so file:// OSC 8 links stay inside hvir. */
class FileLinkProvider implements ILinkProvider {
  constructor(
    private readonly terminal: GhosttyTerminal,
    private readonly activateTarget: (target: string) => void,
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
      if (!target || !isFileUri(target)) continue
      let start = x
      let end = x
      while (start > 0 && line.getCell(start - 1)?.getHyperlinkId() === id) start -= 1
      while (end + 1 < line.length && line.getCell(end + 1)?.getHyperlinkId() === id) {
        end += 1
      }
      links.push(this.link(target, y, start, end))
    }

    for (const candidate of detectTerminalFileLinks(text.join(''))) {
      links.push(this.link(candidate.target, y, candidate.start, candidate.end))
    }
    callback(links.length > 0 ? links : undefined)
  }

  private link(target: string, y: number, start: number, end: number): ILink {
    return {
      text: target,
      range: { start: { x: start, y }, end: { x: end, y } },
      activate: (event) => {
        if (event.ctrlKey || event.metaKey) this.activateTarget(target)
      },
    }
  }
}
