import type { TerminalEvent as GhosttyTerminalEvent } from 'ghostty-web'
import { vi } from 'vitest'

export const ghosttyState = {
  instances: [] as Array<{
    readonly cursorBlinkValues: Array<boolean | 'terminal'>
    readonly cursorStyleValues: string[]
    readonly fontFamilies: string[]
    readonly fontLigatureValues: boolean[]
    readonly fontSizes: number[]
    readonly presentationPausedValues: boolean[]
    readonly resizes: Array<{ readonly cols: number; readonly rows: number }>
    readonly scrollbackBytes: number | undefined
    readonly scrollbackLines: number | undefined
    readonly themes: unknown[]
    readonly writes: string[]
    cursorBlinkResets: number
    focusCalls: number
    emitData(data: string): void
    emitTerminalEvent(event: GhosttyTerminalEvent): void
    emitCustomKey(event: {
      readonly code: string
      readonly ctrlKey: boolean
      readonly altKey: boolean
      readonly metaKey: boolean
      readonly shiftKey: boolean
    }): boolean
    emitResize(size: { readonly cols: number; readonly rows: number }): void
    resolveClipboardFilePaste(file: File): string | undefined
    renders: number
    rendererThemeWrites: number
    scrollbackByteLimit: number
    disposed: boolean
  }>,
}

class MockTerminal {
  readonly options: {
    theme?: unknown
    cursorBlink?: boolean | 'terminal'
    cursorStyle?: string
    fontFamily?: string
    fontLigatures?: boolean
    fontSize?: number
    scrollback?: number
    scrollbackBytes?: number
    resolveClipboardFilePaste?: (file: File) => string | undefined
  }
  readonly buffer = { active: { getLine: () => undefined } }
  readonly wasmTerm = {
    getColors: () => undefined,
    getCursor: () => ({
      blinking: this.options.cursorBlink !== false,
      style: this.options.cursorStyle ?? 'block',
      default: true,
    }),
  }
  readonly viewportY = 0
  cols = 80
  rows = 24
  element?: HTMLElement
  renderer?: {
    clear(): void
    getCanvas(): HTMLCanvasElement
    getMetrics(): { width: number; height: number }
    render(): void
    setTheme(theme: unknown): void
  }
  private canvas?: HTMLCanvasElement
  private textarea?: HTMLTextAreaElement
  private readonly state: (typeof ghosttyState.instances)[number]
  private presentationPaused = false

  constructor(options: {
    theme?: unknown
    cursorBlink?: boolean | 'terminal'
    cursorStyle?: string
    fontFamily?: string
    fontLigatures?: boolean
    fontSize?: number
    scrollback?: number
    scrollbackBytes?: number
    resolveClipboardFilePaste?: (file: File) => string | undefined
  }) {
    this.state = {
      cursorBlinkValues: [options.cursorBlink ?? false],
      cursorStyleValues: [options.cursorStyle ?? 'block'],
      fontFamilies: [options.fontFamily ?? ''],
      fontLigatureValues: [options.fontLigatures ?? true],
      fontSizes: [options.fontSize ?? 0],
      presentationPausedValues: [],
      resizes: [],
      scrollbackBytes: options.scrollbackBytes,
      scrollbackLines: options.scrollback,
      themes: [options.theme],
      writes: [],
      cursorBlinkResets: 0,
      focusCalls: 0,
      emitData: () => undefined,
      emitTerminalEvent: () => undefined,
      emitCustomKey: () => false,
      emitResize: () => undefined,
      resolveClipboardFilePaste: options.resolveClipboardFilePaste ?? (() => undefined),
      renders: 0,
      rendererThemeWrites: 0,
      scrollbackByteLimit: options.scrollbackBytes ?? 0,
      disposed: false,
    }
    ghosttyState.instances.push(this.state)
    this.options = new Proxy(
      { ...options },
      {
        set: (target, property, value) => {
          Reflect.set(target, property, value)
          if (property === 'cursorBlink') {
            this.state.cursorBlinkValues.push(value as boolean | 'terminal')
          }
          if (property === 'cursorStyle') this.state.cursorStyleValues.push(String(value))
          if (property === 'fontFamily') {
            this.state.fontFamilies.push(String(value))
          }
          if (property === 'fontLigatures') {
            this.state.fontLigatureValues.push(Boolean(value))
            this.requestRender()
          }
          if (property === 'fontSize') this.state.fontSizes.push(Number(value))
          if (property === 'theme') {
            this.state.themes.push(value)
            this.requestRender()
          }
          return true
        },
      },
    )
  }

  attachCustomKeyEventHandler(
    callback: (event: {
      readonly code: string
      readonly ctrlKey: boolean
      readonly altKey: boolean
      readonly metaKey: boolean
      readonly shiftKey: boolean
    }) => boolean,
  ): void {
    this.state.emitCustomKey = callback
  }

  attachCustomWheelEventHandler(): void {}

  onData(callback: (data: string) => void): { dispose(): void } {
    this.state.emitData = callback
    return {
      dispose: () => {
        this.state.emitData = () => undefined
      },
    }
  }

  onResize(callback: (size: { readonly cols: number; readonly rows: number }) => void): {
    dispose(): void
  } {
    this.state.emitResize = callback
    return { dispose: () => (this.state.emitResize = () => undefined) }
  }

  onScroll = () => ({ dispose: () => undefined })

  onTerminalEvent(callback: (event: GhosttyTerminalEvent) => void): {
    dispose(): void
  } {
    this.state.emitTerminalEvent = callback
    return { dispose: () => (this.state.emitTerminalEvent = () => undefined) }
  }

  open(element: HTMLElement): void {
    this.element = element
    element.setAttribute('contenteditable', 'true')
    this.canvas = document.createElement('canvas')
    this.textarea = document.createElement('textarea')
    element.append(this.canvas, this.textarea)
    this.renderer = {
      clear: () => undefined,
      getCanvas: () => this.canvas!,
      getMetrics: () => {
        const fontSize = this.options.fontSize ?? 13
        return { width: fontSize * 0.6, height: fontSize * 1.2 }
      },
      render: () => {
        this.state.renders += 1
      },
      setTheme: () => this.state.rendererThemeWrites++,
    }
  }

  registerLinkProvider(): void {}

  getViewportY(): number {
    return 0
  }

  getScrollbackLength(): number {
    return 0
  }

  getScrollbackByteLimit(): number {
    return this.state.scrollbackByteLimit
  }

  scrollToLine(): void {}

  requestRender(): void {
    if (!this.presentationPaused) this.state.renders += 1
  }

  setRenderPaused(paused: boolean): void {
    if (paused === this.presentationPaused) return
    this.presentationPaused = paused
    this.state.presentationPausedValues.push(paused)
    if (!paused) this.requestRender()
  }

  resetCursorBlink(): void {
    if (!this.options.cursorBlink || this.state.disposed || this.presentationPaused)
      return
    this.state.cursorBlinkResets += 1
  }

  getRenderStats(): {
    parsedWrites: number
    renderRequests: number
    renderFrames: number
    fullRenderFrames: number
    paused: boolean
    pendingFrame: boolean
    cursorVisible: boolean
  } {
    return {
      parsedWrites: this.state.writes.length,
      renderRequests: this.state.renders,
      renderFrames: this.state.renders,
      fullRenderFrames: this.state.renders,
      paused: this.presentationPaused,
      pendingFrame: false,
      cursorVisible: true,
    }
  }

  resolveEventProvenance(provenance: { screen: 'normal' | 'alternate'; row: number }) {
    return { screen: provenance.screen, row: provenance.row, column: 0 }
  }

  cancelRetainedBufferSearch(): void {}

  cancelRetainedBufferExtraction(): void {}

  write(data: string): void {
    this.state.writes.push(data)
  }

  resize(cols: number, rows: number): void {
    if (cols === this.cols && rows === this.rows) return
    this.cols = cols
    this.rows = rows
    const size = { cols, rows }
    this.state.resizes.push(size)
    this.state.emitResize(size)
  }

  focus(): void {
    this.state.focusCalls += 1
  }

  dispose(): void {
    this.state.disposed = true
    this.canvas?.remove()
    this.textarea?.remove()
    this.element?.removeAttribute('contenteditable')
    this.canvas = undefined
    this.textarea = undefined
    this.element = undefined
    this.renderer = undefined
  }
}

export const ghosttyWebMock = {
  init: vi.fn(() => Promise.resolve()),
  Terminal: MockTerminal,
}
