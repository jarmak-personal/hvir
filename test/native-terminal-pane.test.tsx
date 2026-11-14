// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NativeTerminalPane } from '../src/renderer/src/terminal/native-terminal-pane'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const panes: NativeTerminalPane[] = []
function fixture(
  overrides: Pick<
    ConstructorParameters<typeof NativeTerminalPane>[1],
    'metadata' | 'effects'
  > = {},
) {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(0, 0, 640, 400),
  )
  const api = { mount: vi.fn(), unmount: vi.fn(), onStatus: vi.fn(() => vi.fn()) }
  const port = {
    attach: vi.fn<ConstructorParameters<typeof NativeTerminalPane>[1]['attach']>(() =>
      Promise.resolve({ viewId: 'native-view' }),
    ),
    update: vi.fn<ConstructorParameters<typeof NativeTerminalPane>[1]['update']>(() =>
      Promise.resolve(),
    ),
    demand: vi.fn(() => Promise.resolve()),
    detach: vi.fn(() => Promise.resolve()),
    input: vi.fn<ConstructorParameters<typeof NativeTerminalPane>[1]['input']>(() =>
      Promise.resolve({ requestedMutation: 1 }),
    ),
    clipboardPaste: vi.fn(),
    ...overrides,
  }
  const pane = new NativeTerminalPane(api, port)
  panes.push(pane)
  const workspace = document.createElement('div')
  const detail = document.createElement('div')
  document.body.append(workspace, detail)
  pane.mount(workspace)
  pane.setPresentation('visible')
  const element = workspace.firstElementChild as HTMLElement
  const key = (code: string, value: string, modifiers: KeyboardEventInit = {}) =>
    element.dispatchEvent(
      new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        code,
        key: value,
        ...modifiers,
      }),
    )
  const ready = async () => {
    await pane.bind('session')
    await vi.waitFor(() => expect(port.update).toHaveBeenCalled())
  }
  return { pane, api, port, workspace, detail, element, key, ready }
}
afterEach(() => {
  for (const pane of panes.splice(0)) pane.dispose()
  document.body.replaceChildren()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('native retained pane adapter', () => {
  it('keeps a newer live title when metadata bootstrap settles with an older snapshot', async () => {
    const metadata =
      deferred<import('../src/shared/native-terminal-effects').NativeTerminalMetadata>()
    let receive!: (
      effect: import('../src/shared/native-terminal-effects').NativeTerminalProductEffect,
    ) => void
    const f = fixture({
      metadata: () => metadata.promise,
      effects: (listener) => {
        receive = listener
        return vi.fn()
      },
    })
    f.port.attach.mockResolvedValueOnce({ viewId: 'native-view', instanceId: 'instance' })
    const events = vi.fn()
    f.pane.onEffect(events)
    const binding = f.pane.bind('session')
    await vi.waitFor(() => expect(f.port.attach).toHaveBeenCalled())
    receive({
      id: 'session',
      instanceId: 'instance',
      eventSerial: 9,
      effect: { kind: 'title', title: 'new live title' },
    })
    metadata.resolve({
      instanceId: 'instance',
      title: { title: 'older bootstrap', eventSerial: 8 },
    })
    await binding
    expect(events).toHaveBeenCalledExactlyOnceWith({
      type: 'title',
      title: 'new live title',
    })
  })
  it('delivers retained pre-attach title metadata only after exact instance binding', async () => {
    const f = fixture(),
      listener = vi.fn()
    f.pane.onEffect(listener)
    f.port.attach.mockResolvedValueOnce({
      viewId: 'native-view',
      instanceId: 'instance',
      title: { title: 'x'.repeat(600), eventSerial: 5 },
    })
    await f.ready()
    expect(listener).toHaveBeenCalledExactlyOnceWith({
      type: 'title',
      title: 'x'.repeat(600),
    })
  })
  it('stops frame demand immediately while captured input cleanup still awaits acknowledgement', async () => {
    const frames = new Map<number, FrameRequestCallback>()
    let next = 0
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.set(++next, callback)
      return next
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      frames.delete(id)
    })
    const f = fixture(),
      demand = deferred<void>(),
      cleanup =
        deferred<
          import('../src/shared/native-terminal-input').NativeTerminalInputCompletion
        >()
    f.port.demand.mockReturnValue(demand.promise)
    f.port.input.mockImplementation(({ input }) =>
      input.kind === 'focus' && !input.focused
        ? cleanup.promise
        : Promise.resolve({ requestedMutation: 1 }),
    )
    await f.pane.bind('session')
    const frame = frames.entries().next().value!
    frames.delete(frame[0])
    frame[1](0)
    await vi.waitFor(() => expect(f.port.demand).toHaveBeenCalledOnce())
    f.pane.focus()
    await vi.waitFor(() =>
      expect(f.port.input).toHaveBeenCalledWith(
        expect.objectContaining({ input: { kind: 'focus', focused: true } }),
      ),
    )
    f.pane.dispose()
    expect(frames.size).toBe(0)
    expect(f.api.unmount).not.toHaveBeenCalled()
    demand.resolve()
    await vi.waitFor(() =>
      expect(f.port.input).toHaveBeenCalledWith(
        expect.objectContaining({ input: { kind: 'focus', focused: false } }),
      ),
    )
    expect(frames.size).toBe(0)
    expect(f.port.demand).toHaveBeenCalledOnce()
    cleanup.resolve({ requestedMutation: 2 })
    await vi.waitFor(() => expect(f.api.unmount).toHaveBeenCalledOnce())
    expect(frames.size).toBe(0)
  })
  it('retains display and navigation while a main-issued instance input block disables typing', async () => {
    const f = fixture()
    f.port.attach.mockResolvedValue({ viewId: 'native-view', inputUnavailable: true })
    await f.ready()
    expect(f.api.mount).toHaveBeenCalledOnce()
    const textarea = f.element.querySelector('textarea')!
    expect(textarea.disabled).toBe(true)
    expect(f.element.textContent).toContain('Native input unavailable')
    f.key('KeyA', 'a')
    expect(
      f.port.input.mock.calls.some(([request]) => request.input.kind === 'key'),
    ).toBe(false)
  })
  it('measures physical initial geometry and binds one retained view after launch', async () => {
    vi.spyOn(window, 'devicePixelRatio', 'get').mockReturnValue(2)
    const f = fixture()
    vi.spyOn(f.element, 'getBoundingClientRect').mockReturnValue(
      new DOMRect(0, 0, 640, 400),
    )
    expect(f.pane.viewport()).toEqual({ width: 1280, height: 800, backingScale: 2 })
    expect(f.port.attach).not.toHaveBeenCalled()
    await f.ready()
    expect(f.port.attach).toHaveBeenCalledExactlyOnceWith('session')
    expect(f.api.mount).toHaveBeenCalledTimes(1)
    f.pane.setPresentation('hidden')
    f.pane.reparent(f.detail)
    f.pane.setPresentation('visible')
    expect(f.detail.firstElementChild).toBe(f.element)
    expect(f.port.attach).toHaveBeenCalledTimes(1)
    expect(f.api.mount).toHaveBeenCalledTimes(1)
    f.pane.focus()
    expect(document.activeElement).toBe(f.element.querySelector('textarea'))
    expect(f.element.textContent).toContain('unfinished')
    expect('write' in f.pane).toBe(false)
    expect('searchRetainedBuffer' in f.pane).toBe(false)
  })

  it('rejects zero geometry and cleans a late attachment after disposal', async () => {
    const f = fixture()
    vi.spyOn(f.element, 'getBoundingClientRect').mockReturnValue(new DOMRect())
    expect(() => f.pane.viewport()).toThrow('measurable')
    const pending = deferred<{ viewId: string }>()
    f.port.attach.mockReturnValue(pending.promise)
    const binding = f.pane.bind('session')
    f.pane.dispose()
    pending.resolve({ viewId: 'late' })
    await binding
    expect(f.api.mount).not.toHaveBeenCalled()
    expect(f.port.detach).toHaveBeenCalledExactlyOnceWith('late')
  })

  it('routes simple keys through native encoding and notifies submission only after accepted input', async () => {
    const f = fixture()
    const input = vi.fn()
    f.pane.onInput(input)
    await f.ready()
    f.key('KeyC', 'c', { ctrlKey: true })
    f.key('Enter', 'Enter')
    f.key('ArrowUp', 'ArrowUp')
    await vi.waitFor(() =>
      expect(
        f.port.input.mock.calls.filter(([request]) => request.input.kind === 'key'),
      ).toHaveLength(3),
    )
    expect(
      f.port.input.mock.calls
        .filter(([request]) => request.input.kind === 'key')
        .map(([request]) => request.input),
    ).toEqual([
      expect.objectContaining({ key: 22, modifiers: 2, action: 1, text: 'c' }),
      expect.objectContaining({ key: 58, modifiers: 0, action: 1, text: '' }),
      expect.objectContaining({ key: 78, modifiers: 0, action: 1, text: '' }),
    ])
    expect(input.mock.calls).toEqual([['c'], ['\r'], ['']])
    f.pane.setReadonly()
    f.key('KeyA', 'a')
    expect(
      f.port.input.mock.calls.filter(([request]) => request.input.kind === 'key'),
    ).toHaveLength(3)
    expect(f.element.getAttribute('aria-readonly')).toBe('true')
  })

  it('bounds pending keys with a visible recoverable refusal', async () => {
    const f = fixture()
    await f.ready()
    const pending = deferred<{ requestedMutation: number }>()
    f.port.input.mockReturnValue(pending.promise)
    for (let i = 0; i < 35; i++) f.key('KeyA', 'a')
    expect(f.port.input).toHaveBeenCalledTimes(1)
    expect(f.element.textContent).toContain('input capacity')
    pending.resolve({ requestedMutation: 1 })
    await vi.waitFor(() =>
      expect(
        f.port.input.mock.calls.filter(([request]) => request.input.kind === 'key'),
      ).toHaveLength(30),
    )
    expect(f.element.getAttribute('aria-readonly')).not.toBe('true')
  })

  it('holds initial input until visible native geometry is acknowledged', async () => {
    const f = fixture()
    const geometry = deferred<void>()
    f.port.update.mockReturnValueOnce(geometry.promise)
    await f.pane.bind('session')
    f.key('KeyA', 'a')
    await vi.waitFor(() => expect(f.port.update).toHaveBeenCalledTimes(1))
    expect(f.port.input).not.toHaveBeenCalled()
    geometry.resolve()
    await vi.waitFor(() =>
      expect(
        f.port.input.mock.calls.filter(([request]) => request.input.kind === 'key'),
      ).toHaveLength(1),
    )
  })

  it('revokes queued keys on hide and blocks hidden clipboard gestures', async () => {
    const f = fixture()
    await f.ready()
    const pending = deferred<{ requestedMutation: number }>()
    f.port.input.mockReturnValueOnce(pending.promise)
    f.key('KeyA', 'a')
    f.key('KeyB', 'b')
    f.pane.setPresentation('hidden')
    pending.resolve({ requestedMutation: 1 })
    await Promise.resolve()
    expect(f.port.input).toHaveBeenCalledTimes(1)
    const paste = new Event('paste', { cancelable: true })
    f.element.dispatchEvent(paste)
    expect(f.port.clipboardPaste).not.toHaveBeenCalled()
  })

  it('keeps failed native input explicit and releases the view once on disposal', async () => {
    const f = fixture()
    await f.ready()
    f.port.input.mockRejectedValueOnce(new Error('revoked'))
    f.key('Enter', 'Enter')
    await vi.waitFor(() => expect(f.element.textContent).toContain('input unavailable'))
    f.pane.dispose()
    f.pane.dispose()
    await vi.waitFor(() =>
      expect(f.api.unmount).toHaveBeenCalledExactlyOnceWith('native-view'),
    )
    expect(f.port.detach).toHaveBeenCalledExactlyOnceWith('native-view')
  })

  it('ignores a revoked old key failure and flushes only fresh keys after reveal acknowledgement', async () => {
    const f = fixture()
    await f.ready()
    const input = vi.fn()
    f.pane.onInput(input)
    const pending = deferred<{ requestedMutation: number }>()
    f.port.input.mockReturnValueOnce(pending.promise)
    f.key('KeyA', 'a')
    f.key('KeyB', 'b')
    f.pane.setPresentation('hidden')
    f.pane.reparent(f.detail)
    f.pane.setPresentation('visible')
    await vi.waitFor(() =>
      expect(
        f.port.update.mock.calls.filter(([, geometry]) => geometry.visible),
      ).toHaveLength(2),
    )
    f.key('KeyC', 'c')
    expect(f.port.input).toHaveBeenCalledTimes(1)
    pending.reject(new Error('native-view-hidden'))
    await vi.waitFor(() =>
      expect(
        f.port.input.mock.calls.filter(([request]) => request.input.kind === 'key'),
      ).toHaveLength(2),
    )
    expect(
      f.port.input.mock.calls
        .filter(([request]) => request.input.kind === 'key')
        .map(([request]) => (request.input.kind === 'key' ? request.input.text : '')),
    ).toEqual(['a', 'c'])
    expect(input.mock.calls).toEqual([['c']])
    expect(f.element.getAttribute('aria-readonly')).not.toBe('true')
    expect(f.element.textContent).not.toContain('input unavailable')
  })
})
