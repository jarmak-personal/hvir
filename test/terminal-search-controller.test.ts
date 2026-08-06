import { describe, expect, it, vi } from 'vitest'

import type {
  TerminalPane,
  TerminalRetainedBufferRange,
  TerminalRetainedBufferSearch,
} from '../src/renderer/src/terminal/terminal-pane'
import { TerminalSearchController } from '../src/renderer/src/terminal/terminal-search-controller'

describe('terminal search controller', () => {
  it('uses literal pane search, explicit case policy, exact Unicode text, and wrapping navigation', async () => {
    const first = range(4, 2, 4, 6)
    const wrappedUnicode = range(8, 79, 9, 3)
    const search = vi
      .fn<TerminalPane['searchRetainedBuffer']>()
      .mockResolvedValueOnce(
        result(
          'build',
          false,
          [first, wrappedUnicode],
          new Map([
            [first, 'build'],
            [wrappedUnicode, 'e\u0301🙂wrap'],
          ]),
        ),
      )
      .mockResolvedValueOnce(result('build', true, [first], new Map([[first, 'build']])))
    const pane = paneFixture(search)
    const controller = new TerminalSearchController(vi.fn(), vi.fn())
    controller.bind(pane)
    expect(controller.open()).toBe(true)

    controller.setQuery('build')
    await vi.waitFor(() => expect(controller.snapshot().matchCount).toBe(2))
    expect(search.mock.calls[0]?.[0]).toBe('build')
    expect(search.mock.calls[0]?.[1].caseSensitive).toBe(false)
    expect(search.mock.calls[0]?.[1].signal).toBeInstanceOf(AbortSignal)
    expect(controller.currentMatchText()).toBe('build')

    controller.navigate('previous')
    expect(controller.snapshot().matchIndex).toBe(1)
    expect(controller.currentMatchText()).toBe('e\u0301🙂wrap')
    controller.navigate('next')
    expect(controller.snapshot().matchIndex).toBe(0)

    controller.setCaseSensitive(true)
    await vi.waitFor(() => expect(controller.snapshot().matchCount).toBe(1))
    expect(search.mock.calls[1]?.[0]).toBe('build')
    expect(search.mock.calls[1]?.[1].caseSensitive).toBe(true)
    expect(search.mock.calls[1]?.[1].signal).toBeInstanceOf(AbortSignal)
  })

  it('publishes only the latest query and cancels on close, replacement, and disposal', async () => {
    const pending: Array<{
      resolve: (value: TerminalRetainedBufferSearch) => void
      signal?: AbortSignal
    }> = []
    const search = vi.fn<TerminalPane['searchRetainedBuffer']>(
      (_query, options) =>
        new Promise((resolve) => pending.push({ resolve, signal: options.signal })),
    )
    const pane = paneFixture(search)
    const cancelSearch = vi.spyOn(pane, 'cancelRetainedBufferSearch')
    const cancelExtraction = vi.spyOn(pane, 'cancelRetainedBufferExtraction')
    const controller = new TerminalSearchController(vi.fn(), vi.fn())
    controller.bind(pane)
    controller.open()
    controller.setQuery('old')
    controller.setQuery('new')

    expect(pending[0]?.signal?.aborted).toBe(true)
    let staleDisposed = false
    const stale = {
      ...result('old', false, [range(1, 0, 1, 2)]),
      dispose: () => {
        staleDisposed = true
      },
    }
    pending[0]!.resolve(stale)
    pending[1]!.resolve(result('new', false, [range(2, 0, 2, 2)]))
    await vi.waitFor(() => expect(controller.snapshot().matchCount).toBe(1))
    expect(controller.snapshot().query).toBe('new')
    expect(staleDisposed).toBe(true)

    controller.close()
    expect(controller.snapshot()).toMatchObject({ open: false, query: '', matchCount: 0 })
    expect(cancelSearch).toHaveBeenCalled()
    expect(cancelExtraction).toHaveBeenCalled()

    controller.bind(pane)
    controller.open()
    controller.revoke()
    expect(controller.open()).toBe(false)
  })

  it('drops stale match metadata and refreshes after retained-buffer eviction', async () => {
    const match = range(1, 0, 1, 3)
    let retained = true
    const search = vi.fn<TerminalPane['searchRetainedBuffer']>((query, options) =>
      Promise.resolve(
        result(
          query,
          options.caseSensitive,
          retained ? [match] : [],
          new Map([[match, 'hit']]),
          () => retained,
        ),
      ),
    )
    const controller = new TerminalSearchController(vi.fn(), vi.fn())
    controller.bind(paneFixture(search))
    controller.open()
    controller.setQuery('hit')
    await vi.waitFor(() => expect(controller.snapshot().matchCount).toBe(1))

    retained = false
    expect(() => controller.currentMatchText()).toThrow(/no longer retained/)
    expect(controller.snapshot()).toMatchObject({ pending: true, matchCount: 0 })
    await vi.waitFor(() => expect(controller.snapshot().pending).toBe(false))
    expect(controller.snapshot().matchCount).toBe(0)
  })

  it('settles an unrevealable normal-buffer match without searching in a loop', async () => {
    const match = range(3, 0, 3, 4)
    const dispose = vi.fn()
    const blocked = {
      ...result('build', false, [match], new Map([[match, 'build']]), () => false),
      dispose,
    }
    const search = vi
      .fn<TerminalPane['searchRetainedBuffer']>()
      .mockResolvedValueOnce(blocked)
      .mockImplementationOnce(() => new Promise(() => undefined))
    const controller = new TerminalSearchController(vi.fn(), vi.fn())
    controller.bind(paneFixture(search))
    controller.open()
    controller.setQuery('build')

    await vi.waitFor(() => expect(controller.snapshot().pending).toBe(false))
    expect(search).toHaveBeenCalledOnce()
    expect(dispose).toHaveBeenCalledOnce()
    expect(controller.snapshot()).toMatchObject({
      open: true,
      query: 'build',
      pending: false,
      matchCount: 0,
    })

    controller.retainedBufferChanged()
    await vi.waitFor(() => expect(search).toHaveBeenCalledTimes(2))
    controller.close()
  })

  it('bounds continuous-output refreshes and preserves the current result until replacement', async () => {
    vi.useFakeTimers()
    try {
      const first = range(1, 0, 1, 3)
      const second = range(2, 0, 2, 3)
      const replacement = range(3, 0, 3, 3)
      const initialDispose = vi.fn()
      const initial = {
        ...result(
          'hit',
          false,
          [first, second],
          new Map([
            [first, 'first'],
            [second, 'second'],
          ]),
        ),
        dispose: initialDispose,
      }
      let resolveReplacement: ((value: TerminalRetainedBufferSearch) => void) | undefined
      const refreshSignals: AbortSignal[] = []
      const search = vi
        .fn<TerminalPane['searchRetainedBuffer']>()
        .mockResolvedValueOnce(initial)
        .mockImplementation(
          (_query, options) =>
            new Promise((resolve) => {
              resolveReplacement = resolve
              refreshSignals.push(options.signal!)
            }),
        )
      const controller = new TerminalSearchController(vi.fn(), vi.fn())
      controller.bind(paneFixture(search))
      controller.open()
      controller.setQuery('hit')
      await Promise.resolve()
      await Promise.resolve()
      controller.navigate('next')
      expect(controller.snapshot()).toMatchObject({
        pending: false,
        matchCount: 2,
        matchIndex: 1,
      })

      controller.retainedBufferChanged()
      for (let index = 0; index < 20; index += 1) {
        vi.advanceTimersByTime(10)
        controller.retainedBufferChanged()
      }

      expect(search).toHaveBeenCalledTimes(3)
      expect(refreshSignals[0]?.aborted).toBe(true)
      expect(controller.snapshot()).toMatchObject({
        pending: true,
        matchCount: 2,
        matchIndex: 1,
      })
      expect(controller.currentMatchText()).toBe('second')

      vi.advanceTimersByTime(34)
      expect(search).toHaveBeenCalledTimes(3)
      vi.advanceTimersByTime(1)
      expect(search).toHaveBeenCalledTimes(4)
      expect(controller.snapshot()).toMatchObject({
        pending: true,
        matchCount: 2,
        matchIndex: 1,
      })

      resolveReplacement?.(result('hit', false, [replacement]))
      await Promise.resolve()
      await Promise.resolve()
      expect(controller.snapshot()).toMatchObject({
        pending: false,
        matchCount: 1,
        matchIndex: 0,
      })
      expect(initialDispose).toHaveBeenCalledOnce()

      controller.retainedBufferChanged()
      controller.revoke()
      vi.advanceTimersByTime(75)
      expect(search).toHaveBeenCalledTimes(4)
      expect(controller.open()).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels an exact semantic-region extraction when search closes', () => {
    let extractionSignal: AbortSignal | undefined
    const extractRegion = vi.fn((_pane: TerminalPane, signal: AbortSignal) => {
      extractionSignal = signal
      return new Promise<string>(() => undefined)
    })
    const pane = paneFixture(vi.fn(() => Promise.resolve(result('', false, []))))
    const restoreFocus = vi.fn()
    const controller = new TerminalSearchController(restoreFocus, extractRegion)
    controller.bind(pane)
    controller.open()

    void controller.extractCurrentRegion()
    expect(extractionSignal?.aborted).toBe(false)
    controller.close(true)
    expect(extractionSignal?.aborted).toBe(true)
    expect(restoreFocus).toHaveBeenCalledOnce()
  })
})

function range(
  startRow: number,
  startColumn: number,
  endRow: number,
  endColumn: number,
): TerminalRetainedBufferRange {
  return {
    start: { row: startRow, column: startColumn },
    end: { row: endRow, column: endColumn },
  }
}

function result(
  query: string,
  caseSensitive: boolean,
  matches: readonly TerminalRetainedBufferRange[],
  text = new Map<TerminalRetainedBufferRange, string>(),
  retained: () => boolean = () => true,
): TerminalRetainedBufferSearch {
  return {
    query,
    caseSensitive,
    matches,
    reveal: (match) => retained() && matches.includes(match),
    extract: (match) => (retained() ? (text.get(match) ?? query) : undefined),
    dispose: vi.fn(),
  }
}

function paneFixture(
  searchRetainedBuffer: TerminalPane['searchRetainedBuffer'],
): TerminalPane {
  const listen = () => () => undefined
  return {
    mount: vi.fn(),
    reparent: vi.fn(),
    dispose: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    setTheme: vi.fn(),
    setTypography: vi.fn(),
    setCursorDefaults: vi.fn(),
    setLigatures: vi.fn(),
    setPresentation: vi.fn(),
    redraw: vi.fn(),
    resolveEventProvenance: vi.fn(() => undefined),
    activeEventScreen: vi.fn(() => 'normal' as const),
    revealEventLocation: vi.fn(() => false),
    searchRetainedBuffer,
    cancelRetainedBufferSearch: vi.fn(),
    captureRetainedBufferBoundary: vi.fn(() => undefined),
    extractRetainedBufferRange: vi.fn(() => Promise.resolve('')),
    cancelRetainedBufferExtraction: vi.fn(),
    hasSelection: vi.fn(() => false),
    getSelection: vi.fn(() => ''),
    paste: vi.fn(),
    selectAll: vi.fn(),
    clear: vi.fn(),
    reset: vi.fn(),
    focus: vi.fn(),
    events: {
      onData: listen,
      onClipboardPaste: listen,
      onEvent: listen,
      onResize: listen,
      onLink: listen,
    },
  }
}
