import type { NativeTerminalPanePort } from '../src/renderer/src/terminal/terminal-pane'
import { TerminalSearchController } from '../src/renderer/src/terminal/terminal-search-controller'
import { describe, expect, it, vi } from 'vitest'
import { NativeTerminalRetained } from '../src/renderer/src/terminal/native-terminal-retained'
import type {
  NativeTerminalQueryRequest,
  NativeTerminalQueryResponse,
  NativeTerminalQueryUpdate,
  NativeTerminalQuerySnapshot,
} from '../src/shared/native-terminal-query'

const view = '00000000-0000-4000-8000-000000000001'
const query = '00000000-0000-4000-8000-000000000002'
const boundary = '00000000-0000-4000-8000-000000000003'
const state = { revision: 1, matchCount: 12000, pending: true, invalidated: false }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function fixture() {
  let current: string | undefined = view
  let notify: ((update: NativeTerminalQueryUpdate) => void) | undefined
  const invoke = vi.fn<
    (request: NativeTerminalQueryRequest) => Promise<NativeTerminalQueryResponse>
  >((request) => {
    const response = ((): NativeTerminalQueryResponse => {
      switch (request.kind) {
        case 'begin':
          return { kind: 'query', queryId: query, snapshot: state }
        case 'at':
          return { kind: 'occurrence', occurrenceId: '71' }
        case 'resolve':
          return { kind: 'resolved', index: 11999 }
        case 'read':
          return { kind: 'text', text: 'e\u0301🙂' }
        case 'reveal':
        case 'boundary-reveal':
          return { kind: 'revealed', revealed: true }
        case 'active-screen':
          return { kind: 'screen', screen: 'normal' }
        case 'boundary-resolve':
          return { kind: 'boundary', location: { screen: 'normal', row: 1, column: 0 } }
        case 'range-read':
          return { kind: 'text', text: 'prompt\ncommand\n' }
        default:
          return { kind: 'done' }
      }
    })()
    return Promise.resolve(response)
  })
  const cancel = vi.fn()
  const stop = vi.fn()
  const owner = new NativeTerminalRetained({
    view: () => current,
    invoke,
    cancel,
    updates: (listener) => {
      notify = listener
      return stop
    },
  })
  const pane: NativeTerminalPanePort = {
    engine: 'native',
    setAppearance: vi.fn(),
    retained: owner,
    selection: {
      status: () => Promise.resolve({ hasSelection: false }),
      read: () => Promise.resolve(undefined),
      selectAll: () => Promise.resolve(),
      clear: () => Promise.resolve(),
      reset: () => Promise.resolve(),
    },
    mount: vi.fn(),
    reparent: vi.fn(),
    setPresentation: vi.fn(),
    focus: vi.fn(),
    dispose: vi.fn(),
    paste: vi.fn(),
    viewport: () => ({ width: 640, height: 480, backingScale: 1 }),
    bind: () => Promise.resolve(),
    setReadonly: vi.fn(),
    onInput: () => () => undefined,
  }
  return {
    pane,
    owner,
    invoke,
    cancel,
    stop,
    hide: () => {
      current = undefined
      owner.revoke()
    },
    update: (
      snapshot: NativeTerminalQuerySnapshot = state,
      viewId = view,
      queryId = query,
    ) => notify?.({ viewId, queryId, snapshot }),
  }
}

describe('native retained-query renderer bridge', () => {
  it('reports a failed initial pass as unavailable without latching successful completion or reopening', async () => {
    const f = fixture()
    const controller = new TerminalSearchController(vi.fn(), vi.fn())
    controller.bind(f.pane)
    controller.open()
    controller.setQuery('hit')
    await vi.waitFor(() => expect(controller.snapshot().matchCount).toBe(12000))
    f.update({ ...state, revision: 2, pending: false, unavailable: true })
    await vi.waitFor(() => expect(controller.snapshot().unavailable).toBe(true))
    expect(controller.snapshot()).toMatchObject({ pending: false, matchIndex: undefined })
    expect(
      f.invoke.mock.calls.filter(([request]) => request.kind === 'begin'),
    ).toHaveLength(1)
    expect(
      f.invoke.mock.calls.some(
        ([request]) => request.kind === 'at' || request.kind === 'reveal',
      ),
    ).toBe(false)
    controller.close()
    f.owner.dispose()
  })
  it('keeps counts native-owned and fetches only the indexed occurrence, with no text on reveal', async () => {
    const f = fixture()
    const result = await f.owner.search('literal.*', { caseSensitive: true })
    expect(result.snapshot()).toMatchObject(state)
    expect(f.invoke.mock.calls[0]?.[0]).toMatchObject({
      kind: 'begin',
      text: 'literal.*',
      caseSensitive: true,
    })
    const occurrence = await result.at(11999)
    expect(occurrence).toEqual({ id: '71' })
    expect(await result.resolve(occurrence!)).toEqual({ index: 11999 })
    expect(await result.reveal(occurrence!)).toBe(true)
    expect(f.invoke.mock.calls.some(([request]) => request.kind === 'read')).toBe(false)
    expect(await result.read(occurrence!)).toBe('e\u0301🙂')
    const listener = vi.fn()
    result.onUpdate(listener)
    f.update({ ...state, revision: 2, matchCount: 12001, pending: false })
    expect(result.snapshot()).toMatchObject({ matchCount: 12001, pending: false })
    expect(listener).toHaveBeenCalledOnce()
    expect(
      f.invoke.mock.calls.filter(([request]) => request.kind === 'reveal'),
    ).toHaveLength(1)
    f.owner.dispose()
    expect(f.stop).toHaveBeenCalledOnce()
    expect(f.invoke.mock.calls.at(-1)?.[0]).toMatchObject({
      kind: 'close',
      queryId: query,
      viewId: view,
    })
  })

  it('buffers the one active query update before begin acknowledgement', async () => {
    const f = fixture()
    const begin = deferred<NativeTerminalQueryResponse>()
    f.invoke.mockImplementationOnce(() => begin.promise)
    const pending = f.owner.search('x', { caseSensitive: false })
    f.update({ ...state, revision: 2, matchCount: 13000, pending: false })
    f.update({ ...state, revision: 3, matchCount: 13001, pending: true })
    begin.resolve({ kind: 'query', queryId: query, snapshot: state })
    const result = await pending
    expect(result.snapshot()).toMatchObject({
      revision: 3,
      matchCount: 13001,
      pending: true,
      initialComplete: true,
    })
    f.update({ ...state, revision: 2 })
    expect(result.snapshot().revision).toBe(3)
    f.owner.dispose()
  })

  it('selects the finite initial first result even when a later streaming update is pending before begin acknowledgement', async () => {
    const f = fixture()
    const begin = deferred<NativeTerminalQueryResponse>()
    f.invoke.mockImplementationOnce(() => begin.promise)
    const controller = new TerminalSearchController(vi.fn(), vi.fn())
    controller.bind(f.pane)
    controller.open()
    controller.setQuery('x')
    f.update({ ...state, revision: 2, pending: false })
    f.update({ ...state, revision: 3, matchCount: 12001, pending: true })
    begin.resolve({ kind: 'query', queryId: query, snapshot: state })
    await vi.waitFor(() => expect(controller.snapshot().matchIndex).toBe(11999))
    expect(controller.snapshot()).toMatchObject({ matchCount: 12001, pending: true })
    expect(
      f.invoke.mock.calls
        .filter(([request]) => request.kind === 'at')
        .map(([request]) => (request.kind === 'at' ? request.index : undefined)),
    ).toEqual([0])
    controller.close()
    f.owner.dispose()
  })

  it('never auto-reveals the initial first result after explicit partial-result navigation', async () => {
    const f = fixture()
    const controller = new TerminalSearchController(vi.fn(), vi.fn())
    controller.bind(f.pane)
    controller.open()
    controller.setQuery('x')
    await vi.waitFor(() =>
      expect(controller.snapshot()).toMatchObject({ matchCount: 12000, pending: true }),
    )
    await controller.navigate('previous')
    expect(controller.snapshot().matchIndex).toBe(11999)
    f.update({ ...state, revision: 2, pending: false })
    f.update({ ...state, revision: 3, matchCount: 12001, pending: true })
    await vi.waitFor(() => expect(controller.snapshot().matchCount).toBe(12001))
    expect(
      f.invoke.mock.calls.filter(([request]) => request.kind === 'reveal'),
    ).toHaveLength(1)
    expect(
      f.invoke.mock.calls
        .filter(([request]) => request.kind === 'at')
        .map(([request]) => (request.kind === 'at' ? request.index : undefined)),
    ).toEqual([11999])
    controller.close()
    f.owner.dispose()
  })

  it('rejects forged occurrences and stale view updates without invoking native read', async () => {
    const f = fixture()
    const result = await f.owner.search('x', { caseSensitive: false })
    expect(await result.read({ id: '71' })).toBeUndefined()
    expect(await result.reveal({ id: '71' })).toBe(false)
    f.update({ ...state, revision: 3 }, boundary)
    expect(result.snapshot().revision).toBe(1)
    expect(f.invoke).toHaveBeenCalledOnce()
    f.owner.dispose()
  })

  it('cancels pending begin by its exact request and closes a late acquired query', async () => {
    const f = fixture()
    const begin = deferred<NativeTerminalQueryResponse>()
    f.invoke.mockImplementationOnce(() => begin.promise)
    const signal = new AbortController()
    const pending = f.owner.search('x', { caseSensitive: false, signal: signal.signal })
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    const request = f.invoke.mock.calls[0]![0]
    signal.abort()
    expect(f.cancel).toHaveBeenCalledWith(view, request.requestId)
    begin.resolve({ kind: 'query', queryId: query, snapshot: state })
    await rejection
    expect(f.invoke.mock.calls.at(-1)?.[0]).toMatchObject({
      kind: 'close',
      queryId: query,
      viewId: view,
    })
    f.owner.dispose()
  })

  it('never publishes a late begin after view revocation and closes its exact acquired query', async () => {
    const f = fixture()
    const begin = deferred<NativeTerminalQueryResponse>()
    f.invoke.mockImplementationOnce(() => begin.promise)
    const pending = f.owner.search('x', { caseSensitive: false })
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    f.hide()
    begin.resolve({ kind: 'query', queryId: query, snapshot: state })
    await rejected
    expect(f.invoke.mock.calls.at(-1)?.[0]).toMatchObject({
      kind: 'close',
      queryId: query,
      viewId: view,
    })
    f.owner.dispose()
  })

  it('cancels changed view read without accepting late text', async () => {
    const f = fixture()
    const result = await f.owner.search('x', { caseSensitive: false })
    const occurrence = await result.at(0)
    const read = deferred<NativeTerminalQueryResponse>()
    f.invoke.mockImplementationOnce(() => read.promise)
    const pending = result.read(occurrence!)
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    const request = f.invoke.mock.calls.at(-1)![0]
    f.hide()
    expect(f.cancel).toHaveBeenCalledWith(view, request.requestId)
    read.resolve({ kind: 'text', text: 'late' })
    await rejected
    f.owner.dispose()
  })

  it('uses authenticated boundary IDs and atomically captures an absent open-region end in Main', async () => {
    const f = fixture()
    const start = {
      id: 4,
      boundaryId: boundary,
      screen: 'normal' as const,
      row: 9,
      column: 0,
    }
    expect(
      await f.owner.resolveBoundary({ ...start, boundaryId: undefined }),
    ).toBeUndefined()
    expect(f.invoke).not.toHaveBeenCalled()
    expect(await f.owner.readRange(start)).toBe('prompt\ncommand\n')
    expect(f.invoke.mock.calls[0]?.[0]).toMatchObject({
      kind: 'range-read',
      startId: boundary,
    })
    expect(f.invoke.mock.calls[0]?.[0]).not.toHaveProperty('endId')
    f.owner.dispose()
  })

  it('aborts productive range extraction independently of the live query', async () => {
    const f = fixture()
    const result = await f.owner.search('x', { caseSensitive: false })
    const read = deferred<NativeTerminalQueryResponse>()
    f.invoke.mockImplementationOnce(() => read.promise)
    const pending = f.owner.readRange({
      id: 1,
      boundaryId: boundary,
      screen: 'normal',
      row: 0,
      column: 0,
    })
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    f.owner.cancelExtraction()
    read.resolve({ kind: 'text', text: 'late' })
    await rejected
    expect(result.snapshot()).toMatchObject(state)
    expect(await result.at(0)).toEqual({ id: '71' })
    f.owner.dispose()
  })
})
