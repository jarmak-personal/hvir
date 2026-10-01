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
    id: 1,
    start: Object.freeze({ row: 8, column: 79 }),
    end: Object.freeze({ row: 9, column: 3 }),
  }),
  searchValid: true,
  emitSearchUpdate: (): void => undefined,
  searchListeners: 0,
  searchExtracted: undefined as IRetainedBufferRange | undefined,
  alternateScreen: false,
  emitScroll: (_viewportY: number): void => undefined,
  selectCalls: 0,
  scrollbackLength: 12,
}))

vi.mock('ghostty-web', async () => {
  class MockTerminal {
    readonly options: Record<string, unknown>
    readonly buffer = { active: { getLine: () => undefined } }
    readonly wasmTerm = { isAlternateScreen: () => state.alternateScreen }
    cols = 80
    rows = 24
    viewportY = 0
    private presentationPaused = false
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
    private readonly addons: Array<{ dispose(): void }> = []
    loadAddon(addon: { activate(terminal: unknown): void; dispose(): void }): void {
      this.addons.push(addon)
      addon.activate(this)
    }
    attachCustomWheelEventHandler(): void {}
    registerLinkProvider(): void {}
    onData(): { dispose(): void } {
      return { dispose: () => undefined }
    }
    onResize(): { dispose(): void } {
      return { dispose: () => undefined }
    }
    onScroll(listener: (viewportY: number) => void): { dispose(): void } {
      state.emitScroll = (viewportY) => {
        this.viewportY = viewportY
        listener(viewportY)
      }
      return { dispose: () => (state.emitScroll = () => undefined) }
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
    setRenderPaused(paused: boolean): void {
      this.presentationPaused = paused
    }
    resetCursorBlink(): void {}
    getViewportY(): number {
      return this.viewportY
    }
    getScrollbackLength(): number {
      return state.scrollbackLength
    }
    scrollToLine(viewportY: number): void {
      state.emitScroll(viewportY)
    }
    select(): void {
      state.selectCalls += 1
    }
    getRenderStats() {
      return {
        parsedWrites: 0,
        renderRequests: 0,
        renderFrames: 0,
        fullRenderFrames: 0,
        paused: this.presentationPaused,
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
      const listeners = new Set<() => void>()
      let disposed = false
      state.emitSearchUpdate = () => {
        for (const listener of [...listeners]) listener()
      }
      return Promise.resolve({
        query,
        caseSensitive: options.caseSensitive,
        get matches() {
          return state.searchValid ? [state.searchRange] : []
        },
        pending: false,
        get invalidated() {
          return !state.searchValid
        },
        onUpdate: (listener: () => void) => {
          listeners.add(listener)
          state.searchListeners = listeners.size
          return {
            dispose: () => {
              listeners.delete(listener)
              state.searchListeners = listeners.size
            },
          }
        },
        resolve: (range: IRetainedBufferRange) =>
          !disposed && state.searchValid && range === state.searchRange
            ? state.searchRange
            : undefined,
        extract: (range: IRetainedBufferRange) => {
          state.searchExtracted = range
          return !disposed && state.searchValid && range === state.searchRange
            ? 'e\u0301🙂wrap'
            : undefined
        },
        dispose: () => {
          disposed = true
          listeners.clear()
          state.searchListeners = 0
        },
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
    dispose(): void {
      for (const addon of this.addons) addon.dispose()
    }
  }

  return {
    init: vi.fn(() => Promise.resolve()),
    Terminal: MockTerminal,
    FitAddon: (await vi.importActual<typeof import('ghostty-web')>('ghostty-web'))
      .FitAddon,
  }
})

describe('Ghostty terminal search identity', () => {
  beforeEach(() => {
    state.emit = () => undefined
    state.resolved = undefined
    state.extracted = undefined
    state.searchExtracted = undefined
    state.searchValid = true
    state.searchListeners = 0
    state.emitSearchUpdate = () => undefined
    state.alternateScreen = false
    state.emitScroll = () => undefined
    state.selectCalls = 0
    state.scrollbackLength = 12
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

  it('reuses authenticated immutable cell metadata while copying exact Unicode text', async () => {
    const pane = await createPane()
    const search = await pane.searchRetainedBuffer('🙂wrap', { caseSensitive: false })

    expect(search.matches[0]).toBe(state.searchRange)
    expect(Object.isFrozen(search.matches[0])).toBe(true)
    expect(search.matches[0]).toEqual({
      id: 1,
      start: { row: 8, column: 79 },
      end: { row: 9, column: 3 },
    })
    expect(search.extract(search.matches[0]!)).toBe('e\u0301🙂wrap')
    expect(state.searchExtracted).toBe(state.searchRange)
    search.dispose()
    pane.dispose()
  })

  it('highlights only the revealed retained range without mutating selection', async () => {
    const pane = await createPane()
    const search = await pane.searchRetainedBuffer('🙂wrap', { caseSensitive: false })

    expect(search.reveal(search.matches[0]!)).toBe(true)
    const segments = [
      ...document.querySelectorAll<HTMLElement>('.terminal-search-match-highlight'),
    ]
    expect(segments).toHaveLength(2)
    expect(segments.map((segment) => segment.dataset.retainedRow)).toEqual(['8', '9'])
    expect(segments[0]!.style.cssText).toContain(
      'left: 632px; top: 0px; width: 8px; height: 16px',
    )
    expect(segments[1]!.style.cssText).toContain(
      'left: 0px; top: 16px; width: 32px; height: 16px',
    )
    expect(state.selectCalls).toBe(0)

    state.emitScroll(3)
    const shifted = [
      ...document.querySelectorAll<HTMLElement>('.terminal-search-match-highlight'),
    ]
    expect(shifted).toHaveLength(1)
    expect(shifted[0]!.dataset.retainedRow).toBe('9')
    expect(shifted[0]!.style.top).toBe('0px')

    state.alternateScreen = true
    pane.write('\u001b[?1049h')
    expect(document.querySelectorAll('.terminal-search-match-highlight')).toHaveLength(0)
    state.alternateScreen = false
    state.scrollbackLength = 13
    pane.write('new output')
    expect(document.querySelectorAll('.terminal-search-match-highlight')).toHaveLength(0)

    expect(search.reveal(search.matches[0]!)).toBe(true)
    search.dispose()
    expect(document.querySelectorAll('.terminal-search-match-highlight')).toHaveLength(0)
    pane.dispose()
  })

  it('fails closed when an alternate screen cannot reveal a normal-buffer match', async () => {
    state.alternateScreen = true
    const pane = await createPane()
    const search = await pane.searchRetainedBuffer('normal output', {
      caseSensitive: false,
    })

    expect(search.reveal(search.matches[0]!)).toBe(false)
    search.dispose()
    pane.dispose()
  })

  it('validates highlights on updates without moving the viewport and revokes subscriptions', async () => {
    const pane = await createPane()
    const search = await pane.searchRetainedBuffer('hit', { caseSensitive: false })
    const selected = search.matches[0]!
    expect(search.reveal(selected)).toBe(true)
    const scroll = vi.fn()
    pane.events.onResize(scroll)
    const update = vi.fn()
    const detach = search.onUpdate(update)
    expect(state.searchListeners).toBe(1)
    const highlight = document.querySelector('.terminal-search-match-highlight')
    state.emitSearchUpdate()
    expect(document.querySelector('.terminal-search-match-highlight')).toBe(highlight)
    expect(search.matches[0]).toBe(selected)
    expect(search.resolve(selected)?.id).toBe(selected.id)
    expect(search.reveal({ ...selected })).toBe(false)
    expect(search.extract({ ...selected })).toBeUndefined()
    expect(document.querySelectorAll('.terminal-search-match-highlight')).toHaveLength(2)
    state.searchValid = false
    state.emitSearchUpdate()
    expect(search.invalidated).toBe(true)
    expect(search.matches).toEqual([])
    expect(search.resolve(selected)).toBeUndefined()
    expect(search.extract(selected)).toBeUndefined()
    expect(document.querySelectorAll('.terminal-search-match-highlight')).toHaveLength(0)
    expect(update).toHaveBeenCalledTimes(2)
    detach()
    search.dispose()
    search.dispose()
    expect(state.searchListeners).toBe(0)
    pane.dispose()
  })
})

async function createPane() {
  const pane = await createGhosttyTerminalPane(
    terminalThemeForAppearance('dark'),
    { fontFamily: 'monospace', fontSize: 13 },
    {
      cursorDefaults: { shape: 'block', blink: 'terminal' },
      ligatures: true,
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
