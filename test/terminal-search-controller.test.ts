import { describe, expect, it, vi } from 'vitest'

import type {
  TerminalPane,
  TerminalRuntimePane,
  TerminalRetainedQuery,
  TerminalRetainedBufferRange,
  TerminalRetainedBufferSearch,
} from '../src/renderer/src/terminal/terminal-pane'
import { legacyTerminalRetainedQuery } from '../src/renderer/src/terminal/terminal-retained-query'
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
    expect(await controller.currentMatchText()).toBe('build')

    await controller.navigate('previous')
    expect(controller.snapshot().matchIndex).toBe(1)
    expect(await controller.currentMatchText()).toBe('e\u0301🙂wrap')
    await controller.navigate('next')
    expect(controller.snapshot().matchIndex).toBe(0)

    controller.setCaseSensitive(true)
    await vi.waitFor(() => expect(controller.snapshot().matchCount).toBe(1))
    expect(search.mock.calls[1]?.[0]).toBe('build')
    expect(search.mock.calls[1]?.[1].caseSensitive).toBe(true)
    expect(search.mock.calls[1]?.[1].signal).toBeInstanceOf(AbortSignal)
  })

  it('honors Next after delayed initial selection completes even if an earlier observation had only a count', async () => {
    const pane = paneFixture(vi.fn())
    let finishAt!: (occurrence: { id: string }) => void
    let finishReveal!: (revealed: boolean) => void
    let finishResolve!: (location: { index: number }) => void
    const at = vi
      .fn<TerminalRetainedQuery['at']>()
      .mockImplementationOnce(
        () =>
          new Promise((done) => {
            finishAt = done
          }),
      )
      .mockImplementation((index) => Promise.resolve({ id: String(index) }))
    const reveal = vi
      .fn<TerminalRetainedQuery['reveal']>()
      .mockImplementationOnce(
        () =>
          new Promise((done) => {
            finishReveal = done
          }),
      )
      .mockResolvedValue(true)
    const resolve = vi
      .fn<TerminalRetainedQuery['resolve']>()
      .mockImplementationOnce(
        () =>
          new Promise((done) => {
            finishResolve = done
          }),
      )
      .mockImplementation((occurrence) =>
        Promise.resolve({ index: Number(occurrence.id) }),
      )
    const indexed: TerminalRetainedQuery = {
      snapshot: () => ({
        revision: 1,
        matchCount: 3,
        pending: false,
        invalidated: false,
      }),
      onUpdate: () => () => undefined,
      at,
      reveal,
      resolve,
      read: (occurrence) => Promise.resolve(occurrence.id === '1' ? 'second' : 'first'),
      clearReveal: vi.fn(),
      dispose: vi.fn(),
    }
    const controller = new TerminalSearchController(vi.fn(), vi.fn())
    controller.bind({
      ...pane,
      retained: {
        ...legacyTerminalRetainedQuery(pane),
        search: () => Promise.resolve(indexed),
      },
    })
    controller.open()
    controller.setQuery('hit')
    await vi.waitFor(() => expect(at).toHaveBeenCalledOnce())
    const countOnlyObservation = controller.snapshot()
    expect(countOnlyObservation).toMatchObject({ matchCount: 3, matchIndex: undefined })

    finishAt({ id: '0' })
    await vi.waitFor(() => expect(reveal).toHaveBeenCalledOnce())
    finishReveal(true)
    await vi.waitFor(() => expect(resolve).toHaveBeenCalledOnce())
    finishResolve({ index: 0 })
    await vi.waitFor(() => expect(controller.snapshot().matchIndex).toBe(0))
    expect(controller.snapshot().matchCount).toBe(3)

    // A separately delivered user action is relative to current selection, not this old read.
    if (countOnlyObservation.matchIndex === undefined) await controller.navigate('next')
    expect(controller.snapshot()).toMatchObject({ matchCount: 3, matchIndex: 1 })
    expect(at.mock.calls.map(([index]) => index)).toEqual([0, 1])
    expect(reveal.mock.calls.map(([occurrence]) => occurrence.id)).toEqual(['0', '1'])
    expect(await controller.currentMatchText()).toBe('second')
    controller.close()
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

  it('keeps a non-first occurrence selected across updates without revealing it again', async () => {
    const first = range(1, 0, 1, 3)
    const second = range(2, 0, 2, 3)
    const third = range(3, 0, 3, 3)
    const live = liveResult(
      [first, second],
      new Map([
        [first, 'first'],
        [second, 'second'],
      ]),
    )
    const search = vi.fn<TerminalPane['searchRetainedBuffer']>().mockResolvedValue(live)
    const controller = new TerminalSearchController(vi.fn(), vi.fn())
    controller.bind(paneFixture(search))
    controller.open()
    controller.setQuery('hit')
    await vi.waitFor(() => expect(controller.snapshot().matchCount).toBe(2))
    await controller.navigate('next')
    expect(await controller.currentMatchText()).toBe('second')
    const revealed = live.reveal.mock.calls.length
    live.update([first, second, third], true)
    for (let index = 0; index < 200; index++) controller.retainedBufferChanged()
    expect(controller.snapshot()).toMatchObject({
      pending: true,
      matchCount: 3,
      matchIndex: 1,
    })
    expect(await controller.currentMatchText()).toBe('second')
    live.update([first, second, third], false)
    await vi.waitFor(() => expect(controller.snapshot().pending).toBe(false))
    expect(controller.snapshot()).toMatchObject({
      pending: false,
      matchCount: 3,
      matchIndex: 1,
    })
    expect(live.reveal).toHaveBeenCalledTimes(revealed)
    expect(search).toHaveBeenCalledOnce()
    await controller.navigate('next')
    expect(controller.snapshot().matchIndex).toBe(2)
    controller.close()
    expect(live.listenerCount()).toBe(0)
  })

  it('keeps pending scans alive through continuous writes', async () => {
    let complete: ((value: TerminalRetainedBufferSearch) => void) | undefined
    const search = vi.fn<TerminalPane['searchRetainedBuffer']>(
      () =>
        new Promise((resolve) => {
          complete = resolve
        }),
    )
    const controller = new TerminalSearchController(vi.fn(), vi.fn())
    controller.bind(paneFixture(search))
    controller.open()
    controller.setQuery('hit')
    for (let i = 0; i < 200; i++) controller.retainedBufferChanged()
    expect(search).toHaveBeenCalledOnce()
    expect(search.mock.calls[0]?.[1].signal?.aborted).toBe(false)
    complete?.(result('hit', false, [range(2, 0, 2, 3)]))
    await vi.waitFor(() => expect(controller.snapshot().pending).toBe(false))
    expect(controller.snapshot().matchCount).toBe(1)
  })

  it('loses overwritten or evicted selection and waits for explicit navigation', async () => {
    const first = range(1, 0, 1, 3)
    const second = range(2, 0, 2, 3)
    const identicalReplacement = range(2, 0, 2, 3)
    const live = liveResult([first, second])
    const controller = new TerminalSearchController(vi.fn(), vi.fn())
    controller.bind(paneFixture(vi.fn().mockResolvedValue(live)))
    controller.open()
    controller.setQuery('hit')
    await vi.waitFor(() => expect(controller.snapshot().matchCount).toBe(2))
    await controller.navigate('next')
    live.update([first, identicalReplacement], false)
    await vi.waitFor(() => expect(controller.snapshot().unavailable).toBe(true))
    expect(controller.snapshot()).toMatchObject({
      matchCount: 2,
      matchIndex: undefined,
      unavailable: true,
    })
    expect(live.clearReveal).toHaveBeenCalled()
    await expect(controller.currentMatchText()).rejects.toThrow(/no longer retained/)
    const calls = live.reveal.mock.calls.length
    live.update([identicalReplacement], false)
    expect(live.reveal).toHaveBeenCalledTimes(calls)
    await controller.navigate('previous')
    expect(controller.snapshot()).toMatchObject({ matchIndex: 0, unavailable: false })
  })

  it('reflow starts a fresh query without claiming old selection; replacement revokes subscriptions', async () => {
    const old = liveResult([range(1, 0, 1, 3)])
    const fresh = liveResult([range(1, 0, 1, 3)])
    const search = vi
      .fn<TerminalPane['searchRetainedBuffer']>()
      .mockResolvedValueOnce(old)
      .mockResolvedValueOnce(fresh)
    const controller = new TerminalSearchController(vi.fn(), vi.fn())
    controller.bind(paneFixture(search))
    controller.open()
    controller.setQuery('hit')
    await vi.waitFor(() => expect(controller.snapshot().matchCount).toBe(1))
    old.invalidate()
    await vi.waitFor(() => expect(controller.snapshot().pending).toBe(false))
    expect(search).toHaveBeenCalledTimes(2)
    expect(controller.snapshot()).toMatchObject({
      matchCount: 1,
      matchIndex: undefined,
      unavailable: true,
    })
    expect(fresh.reveal).not.toHaveBeenCalled()
    expect(old.listenerCount()).toBe(0)
    await controller.navigate('next')
    expect(controller.snapshot().matchIndex).toBe(0)
    controller.bind(paneFixture(vi.fn()))
    expect(fresh.listenerCount()).toBe(0)
    expect(search.mock.calls.every((call) => call[1].signal?.aborted)).toBe(true)
    fresh.update([], false)
    expect(controller.snapshot().open).toBe(false)
  })

  it('does not report lost selection on reflow when the query had no matches', async () => {
    const old = liveResult([])
    const fresh = liveResult([range(1, 0, 1, 3)])
    const search = vi
      .fn<TerminalPane['searchRetainedBuffer']>()
      .mockResolvedValueOnce(old)
      .mockResolvedValueOnce(fresh)
    const controller = new TerminalSearchController(vi.fn(), vi.fn())
    controller.bind(paneFixture(search))
    controller.open()
    controller.setQuery('hit')
    await vi.waitFor(() => expect(controller.snapshot().pending).toBe(false))
    old.invalidate()
    await vi.waitFor(() => expect(controller.snapshot().matchCount).toBe(1))
    expect(controller.snapshot()).toMatchObject({
      matchIndex: undefined,
      unavailable: false,
    })
    expect(fresh.reveal).not.toHaveBeenCalled()
  })

  it.each(['previous', 'next'] as const)(
    'preserves a valid selection when %s cannot reveal the normal buffer',
    async (direction) => {
      const matches = [range(1, 0, 1, 3), range(2, 0, 2, 3), range(3, 0, 3, 3)]
      const live = liveResult(matches, new Map([[matches[1]!, 'second']]))
      const search = vi.fn<TerminalPane['searchRetainedBuffer']>().mockResolvedValue(live)
      const controller = new TerminalSearchController(vi.fn(), vi.fn())
      controller.bind(paneFixture(search))
      controller.open()
      controller.setQuery('hit')
      await vi.waitFor(() => expect(controller.snapshot().matchCount).toBe(3))
      await controller.navigate('next')
      const selected = controller.snapshot()
      expect(selected.matchIndex).toBe(1)

      live.reveal.mockReturnValue(false)
      await controller.navigate(direction)
      expect(controller.snapshot()).toBe(selected)
      expect(await controller.currentMatchText()).toBe('second')
      expect(live.clearReveal).not.toHaveBeenCalled()

      live.reveal.mockReturnValue(true)
      await controller.navigate(direction)
      expect(controller.snapshot()).toMatchObject({
        matchIndex: direction === 'previous' ? 0 : 2,
        unavailable: false,
      })
      expect(search).toHaveBeenCalledOnce()

      // A failed reveal must still clear a selection whose identity was revoked.
      live.reveal.mockReturnValue(false)
      vi.spyOn(live, 'resolve').mockReturnValue(undefined)
      await controller.navigate(direction)
      expect(controller.snapshot()).toMatchObject({
        matchIndex: undefined,
        unavailable: true,
      })
      expect(live.clearReveal).toHaveBeenCalledOnce()
      controller.close()
    },
  )

  it('keeps unavailable alternate-screen matches navigable after returning to normal', async () => {
    const match = range(3, 0, 3, 4)
    const live = liveResult([match])
    live.reveal.mockReturnValue(false)
    const search = vi.fn<TerminalPane['searchRetainedBuffer']>().mockResolvedValue(live)
    const controller = new TerminalSearchController(vi.fn(), vi.fn())
    controller.bind(paneFixture(search))
    controller.open()
    controller.setQuery('hit')
    await vi.waitFor(() => expect(controller.snapshot().pending).toBe(false))
    expect(controller.snapshot()).toMatchObject({
      matchCount: 1,
      matchIndex: undefined,
      unavailable: false,
    })
    live.reveal.mockReturnValue(true)
    controller.retainedBufferChanged()
    expect(search).toHaveBeenCalledOnce()
    await controller.navigate('next')
    expect(controller.snapshot().matchIndex).toBe(0)
  })

  it('consumes indexed native-sized counts while retaining only a non-first occurrence across streaming updates', async () => {
    const pane = paneFixture(vi.fn())
    let state = { revision: 1, matchCount: 12000, pending: true, invalidated: false }
    let update: (() => void) | undefined
    const at = vi.fn<TerminalRetainedQuery['at']>((index) =>
      Promise.resolve({ id: String(index) }),
    )
    const reveal = vi.fn<TerminalRetainedQuery['reveal']>(() => Promise.resolve(true))
    const dispose = vi.fn()
    const result: TerminalRetainedQuery = {
      snapshot: () => state,
      onUpdate: (listener) => {
        update = listener
        return () => {
          update = undefined
        }
      },
      at,
      resolve: (occurrence) => Promise.resolve({ index: Number(occurrence.id) }),
      reveal,
      read: (occurrence) => Promise.resolve(occurrence.id === '1' ? 'second🙂' : 'first'),
      clearReveal: vi.fn(),
      dispose,
    }
    const controller = new TerminalSearchController(vi.fn(), vi.fn())
    controller.bind({
      ...pane,
      retained: {
        ...legacyTerminalRetainedQuery(pane),
        search: () => Promise.resolve(result),
      },
    })
    controller.open()
    controller.setQuery('literal')
    await vi.waitFor(() =>
      expect(controller.snapshot()).toMatchObject({ matchCount: 12000, pending: true }),
    )
    expect(controller.snapshot().matchIndex).toBeUndefined()
    expect(at).not.toHaveBeenCalled()
    state = { ...state, revision: 2, pending: false }
    update?.()
    await vi.waitFor(() => expect(controller.snapshot().matchIndex).toBe(0))
    await controller.navigate('next')
    expect(await controller.currentMatchText()).toBe('second🙂')
    state = { ...state, revision: 3, matchCount: 12001, pending: false }
    update?.()
    await vi.waitFor(() =>
      expect(controller.snapshot()).toMatchObject({
        matchCount: 12001,
        matchIndex: 1,
        pending: false,
      }),
    )
    expect(at).toHaveBeenCalledTimes(2)
    expect(reveal).toHaveBeenCalledTimes(2)
    expect(await controller.currentMatchText()).toBe('second🙂')
    controller.close()
    expect(dispose).toHaveBeenCalledOnce()
    expect(update).toBeUndefined()
  })

  it('cancels an exact semantic-region extraction when search closes', () => {
    let extractionSignal: AbortSignal | undefined
    const extractRegion = vi.fn((_pane: TerminalRuntimePane, signal: AbortSignal) => {
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

let nextRangeId = 1

function range(
  startRow: number,
  startColumn: number,
  endRow: number,
  endColumn: number,
): TerminalRetainedBufferRange {
  return {
    id: nextRangeId++,
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
    pending: false,
    invalidated: false,
    onUpdate: () => () => undefined,
    resolve: (match) => (retained() && matches.includes(match) ? match : undefined),
    clearReveal: vi.fn(),
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

function liveResult(
  initial: readonly TerminalRetainedBufferRange[],
  text = new Map<TerminalRetainedBufferRange, string>(),
) {
  const listeners = new Set<() => void>()
  const live = {
    ...result('hit', false, initial, text),
    clearReveal: vi.fn(),
    matches: initial,
    pending: false,
    invalidated: false,
    reveal: vi.fn((match: TerminalRetainedBufferRange) => live.matches.includes(match)),
    resolve: (match: TerminalRetainedBufferRange) =>
      live.matches.includes(match) ? match : undefined,
    extract: (match: TerminalRetainedBufferRange) =>
      live.resolve(match) ? (text.get(match) ?? 'hit') : undefined,
    onUpdate: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    dispose: vi.fn(() => listeners.clear()),
    listenerCount: () => listeners.size,
    update(matches: readonly TerminalRetainedBufferRange[], pending: boolean) {
      live.matches = matches
      live.pending = pending
      for (const listener of [...listeners]) listener()
    },
    invalidate() {
      live.invalidated = true
      live.update([], false)
    },
  }
  return live
}
