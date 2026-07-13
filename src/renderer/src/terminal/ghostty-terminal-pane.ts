import { FitAddon, Terminal as GhosttyTerminal, init } from 'ghostty-web'

import type { Disposer } from '../../../shared'
import type {
  OscEvent,
  TerminalPane,
  TerminalPaneEvents,
  TerminalSize,
} from './terminal-pane'

let initializeGhostty: Promise<void> | undefined

/** Load the shared WASM instance off the first paint, then create a pane. */
export async function createGhosttyTerminalPane(): Promise<TerminalPane> {
  initializeGhostty ??= init()
  await initializeGhostty
  return new GhosttyTerminalPane()
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
  private readonly terminal = new GhosttyTerminal({
    allowTransparency: false,
    cursorBlink: true,
    cursorStyle: 'block',
    fontFamily: "'JetBrains Mono', 'SFMono-Regular', Consolas, monospace",
    fontSize: 13,
    scrollback: 10_000,
    theme: {
      background: '#111318',
      foreground: '#d8dee9',
      cursor: '#d8dee9',
      selectionBackground: '#39445a',
      black: '#20242c',
      red: '#e06c75',
      green: '#98c379',
      yellow: '#e5c07b',
      blue: '#61afef',
      magenta: '#c678dd',
      cyan: '#56b6c2',
      white: '#d8dee9',
    },
  })
  private readonly fit = new FitAddon()
  private readonly dataListeners = new ListenerSet<string>()
  private readonly titleListeners = new ListenerSet<string>()
  private readonly bellListeners = new ListenerSet<void>()
  private readonly oscListeners = new ListenerSet<OscEvent>()
  private readonly resizeListeners = new ListenerSet<TerminalSize>()
  private readonly engineDisposers: Array<{ dispose(): void }> = []
  private mounted = false
  private disposed = false
  private oscCarry = ''
  private lastTitle = ''

  readonly events: TerminalPaneEvents = {
    onData: (callback) => this.dataListeners.on(callback),
    onTitle: (callback) => this.titleListeners.on(callback),
    onBell: (callback) => this.bellListeners.on(callback),
    onOsc: (callback) => this.oscListeners.on(callback),
    onResize: (callback) => this.resizeListeners.on(callback),
  }

  mount(container: HTMLElement): void {
    if (this.disposed) throw new Error('Cannot mount a disposed terminal pane')
    if (this.mounted) throw new Error('Terminal pane is already mounted')
    this.mounted = true
    this.terminal.loadAddon(this.fit)
    this.engineDisposers.push(
      this.terminal.onData((data) => this.dataListeners.emit(data)),
      this.terminal.onResize((size) => this.resizeListeners.emit(size)),
      this.terminal.onBell(() => this.bellListeners.emit()),
      this.terminal.onTitleChange((title) => this.emitTitle(title)),
    )
    this.terminal.open(container)
    this.fit.fit()
    this.fit.observeResize()
    this.redraw()
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
    this.inspectOsc(data)
    this.terminal.write(data)
  }

  resize(cols: number, rows: number): void {
    if (!this.disposed) this.terminal.resize(cols, rows)
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
    this.terminal.dispose()
    this.dataListeners.clear()
    this.titleListeners.clear()
    this.bellListeners.clear()
    this.oscListeners.clear()
    this.resizeListeners.clear()
  }

  /** ghostty-web exposes title/bell but not the general xterm parser hook. */
  private inspectOsc(chunk: string): void {
    const input = this.oscCarry + chunk
    this.oscCarry = ''
    let cursor = 0

    while (cursor < input.length) {
      const start = input.indexOf('\u001b]', cursor)
      if (start < 0) {
        if (input.endsWith('\u001b')) this.oscCarry = '\u001b'
        return
      }

      const bel = input.indexOf('\u0007', start + 2)
      const st = input.indexOf('\u001b\\', start + 2)
      const usesBel = bel >= 0 && (st < 0 || bel < st)
      const end = usesBel ? bel : st
      if (end < 0) {
        // Bound malformed/unbounded OSC memory while preserving split sequences.
        this.oscCarry = input.slice(start, start + 64 * 1024)
        return
      }

      const body = input.slice(start + 2, end)
      const separator = body.indexOf(';')
      const codeText = separator < 0 ? body : body.slice(0, separator)
      const code = Number.parseInt(codeText, 10)
      const payload = separator < 0 ? '' : body.slice(separator + 1)
      if (Number.isFinite(code)) {
        if (code === 0 || code === 2) this.emitTitle(payload)
        else {
          const event = { code, data: payload }
          this.oscListeners.emit(event)
          if (code === 9) this.bellListeners.emit()
        }
      }
      cursor = end + (usesBel ? 1 : 2)
    }
  }

  private emitTitle(title: string): void {
    if (title === this.lastTitle) return
    this.lastTitle = title
    this.titleListeners.emit(title)
  }
}
