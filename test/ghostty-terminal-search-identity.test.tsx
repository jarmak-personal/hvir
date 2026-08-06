// @vitest-environment happy-dom

import type {
  IRetainedBufferRange,
  TerminalEvent as GhosttyTerminalEvent,
  TerminalEventProvenance as GhosttyTerminalEventProvenance,
} from 'ghostty-web'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createGhosttyTerminalPane } from '../src/renderer/src/terminal/ghostty-terminal-pane'
import { terminalThemeForAppearance } from '../src/renderer/src/terminal/terminal-palette'
import type { TerminalEvent } from '../src/renderer/src/terminal/terminal-pane'

const state = vi.hoisted(() => ({
  emit: (_event: GhosttyTerminalEvent): void => undefined,
  resolved: undefined as GhosttyTerminalEventProvenance | undefined,
  extracted: undefined as
    readonly [GhosttyTerminalEventProvenance, GhosttyTerminalEventProvenance] | undefined,
  searchRange: Object.freeze({
    start: Object.freeze({ row: 8, column: 79 }),
    end: Object.freeze({ row: 9, column: 3 }),
  }),
  searchExtracted: undefined as IRetainedBufferRange | undefined,
  alternateScreen: false,
}))

vi.mock('ghostty-web', () => {
  class MockTerminal {
    readonly options: Record<string, unknown>
    readonly buffer = { active: { getLine: () => undefined } }
    readonly wasmTerm = { isAlternateScreen: () => state.alternateScreen }
    cols = 80
    rows = 24
    renderer?: {
      clear(): void
      getCanvas(): HTMLCanvasElement
      getMetrics(): { width: number; height: number }
      setTheme(): void
      setCursorDefaults(): void
    }

    constructor(options: Record<string, unknown>) {
      this.options = options
    }

    attachCustomKeyEventHandler(): void {}
    attachCustomWheelEventHandler(): void {}
    registerLinkProvider(): void {}
    onData(): { dispose(): void } {
      return { dispose: () => undefined }
    }
    onResize(): { dispose(): void } {
      return { dispose: () => undefined }
    }
    onTerminalEvent(listener: (event: GhosttyTerminalEvent) => void): {
      dispose(): void
    } {
      state.emit = listener
      return { dispose: () => (state.emit = () => undefined) }
    }
    open(element: HTMLElement): void {
      const canvas = document.createElement('canvas')
      element.append(canvas)
      this.renderer = {
        clear: () => undefined,
        getCanvas: () => canvas,
        getMetrics: () => ({ width: 8, height: 16 }),
        setTheme: () => undefined,
        setCursorDefaults: () => undefined,
      }
    }
    write(): void {}
    resize(): void {}
    requestRender(): void {}
    resetCursorBlink(): void {}
    getViewportY(): number {
      return 0
    }
    getScrollbackLength(): number {
      return 0
    }
    scrollToLine(): void {}
    getRenderStats() {
      return {
        parsedWrites: 0,
        renderRequests: 0,
        renderFrames: 0,
        fullRenderFrames: 0,
        paused: false,
        pendingFrame: false,
        cursorVisible: true,
      }
    }
    resolveEventProvenance(provenance: GhosttyTerminalEventProvenance) {
      state.resolved = provenance
      return {
        screen: provenance.screen,
        row: provenance.row,
        column: provenance.column,
      }
    }
    searchRetainedBuffer(query: string, options: { caseSensitive: boolean }) {
      return Promise.resolve({
        query,
        caseSensitive: options.caseSensitive,
        matches: [state.searchRange],
        extract: (range: IRetainedBufferRange) => {
          state.searchExtracted = range
          return range === state.searchRange ? 'e\u0301🙂wrap' : undefined
        },
        dispose: () => undefined,
      })
    }
    cancelRetainedBufferSearch(): void {}
    captureRetainedBufferBoundary(): GhosttyTerminalEventProvenance {
      return Object.freeze({ id: 999, screen: 'normal', row: 0, column: 0 })
    }
    extractRetainedBufferRange(
      start: GhosttyTerminalEventProvenance,
      end: GhosttyTerminalEventProvenance,
    ): Promise<string> {
      state.extracted = [start, end]
      return Promise.resolve('exact region')
    }
    cancelRetainedBufferExtraction(): void {}
    focus(): void {}
    dispose(): void {}
  }

  return { init: vi.fn(() => Promise.resolve()), Terminal: MockTerminal }
})

describe('Ghostty terminal search identity', () => {
  beforeEach(() => {
    state.emit = () => undefined
    state.resolved = undefined
    state.extracted = undefined
    state.searchExtracted = undefined
    state.alternateScreen = false
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
        disconnect(): void {}
      },
    )
  })

  afterEach(() => {
    document.body.replaceChildren()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('keeps opaque native provenance private and returns exact identity to Ghostty', async () => {
    const pane = await createPane()
    const events: TerminalEvent[] = []
    pane.events.onEvent((event) => events.push(event))
    const start = provenance(71, 4, 7)
    const end = provenance(72, 5, 11)
    state.emit(semantic('prompt-start', start))
    state.emit(semantic('end-prompt-start-input', end))
    const retained = events.filter(
      (event): event is Extract<TerminalEvent, { type: 'semantic' }> =>
        event.type === 'semantic',
    )

    expect(retained[0]!.provenance).not.toBe(start)
    expect(Object.keys(retained[0]!.provenance)).toEqual([
      'id',
      'screen',
      'row',
      'column',
    ])
    expect(pane.resolveEventProvenance(retained[0]!.provenance)).toEqual({
      screen: 'normal',
      row: 4,
      column: 7,
    })
    expect(state.resolved).toBe(start)
    await expect(
      pane.extractRetainedBufferRange(retained[0]!.provenance, retained[1]!.provenance),
    ).resolves.toBe('exact region')
    expect(state.extracted?.[0]).toBe(start)
    expect(state.extracted?.[1]).toBe(end)
    pane.dispose()
  })

  it('keeps native search ranges private while copying exact Unicode text', async () => {
    const pane = await createPane()
    const search = await pane.searchRetainedBuffer('🙂wrap', { caseSensitive: false })

    expect(search.matches[0]).not.toBe(state.searchRange)
    expect(search.matches[0]).toEqual({
      start: { row: 8, column: 79 },
      end: { row: 9, column: 3 },
    })
    expect(search.extract(search.matches[0]!)).toBe('e\u0301🙂wrap')
    expect(state.searchExtracted).toBe(state.searchRange)
    search.dispose()
    pane.dispose()
  })

  it('fails closed when an alternate screen cannot reveal a normal-buffer match', async () => {
    state.alternateScreen = true
    const pane = await createPane()
    const search = await pane.searchRetainedBuffer('normal output', {
      caseSensitive: false,
    })

    expect(search.reveal(search.matches[0]!)).toBe(false)
    expect(state.searchExtracted).toBe(state.searchRange)
    search.dispose()
    pane.dispose()
  })
})

async function createPane() {
  const pane = await createGhosttyTerminalPane(
    terminalThemeForAppearance('dark'),
    { fontFamily: 'monospace', fontSize: 13 },
    {
      cursorDefaults: { shape: 'block', blink: 'terminal' },
      modifiedKeyProtocol: 'modify-other-keys',
      metaEnterAliasesControl: true,
      composerSubmitMode: 'enter',
    },
  )
  pane.mount(document.body)
  return pane
}

function provenance(
  id: number,
  row: number,
  column: number,
): GhosttyTerminalEventProvenance {
  return Object.freeze({ id, screen: 'normal', row, column })
}

function semantic(
  action: 'prompt-start' | 'end-prompt-start-input',
  source: GhosttyTerminalEventProvenance,
): GhosttyTerminalEvent {
  return { type: 'semantic', action, options: '', provenance: source }
}
