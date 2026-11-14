// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  asSessionsPtyHandle,
  asSessionsTerminalHandle,
  asSessionsWorkspaceRuntimeId,
  type HvirApi,
} from '../src/shared'
import { TerminalRuntime } from '../src/renderer/src/terminal/terminal-runtime'
import { TerminalEventRouter } from '../src/renderer/src/terminal/terminal-event-router'
import { createTerminalRuntimePane } from '../src/renderer/src/terminal/terminal-pane-factory'
import { ghosttyLifecycleRuntimeOptions } from './fixtures/ghostty-lifecycle-runtime-options'

const legacy = vi.hoisted(() => ({
  create: vi.fn(() => Promise.resolve({ legacy: true })),
}))
vi.mock('../src/renderer/src/terminal/ghostty-terminal-pane', () => ({
  createGhosttyTerminalPane: legacy.create,
}))
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose()
  document.body.replaceChildren()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  legacy.create.mockClear()
})
function fixture() {
  const listeners = new Map<string, (payload: unknown) => void>()
  const options = ghosttyLifecycleRuntimeOptions()
  const frames = new Map<number, FrameRequestCallback>()
  let nextFrame = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback)
    return nextFrame
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(0, 0, 640, 400),
  )
  vi.spyOn(window, 'devicePixelRatio', 'get').mockReturnValue(2)
  const invoke = vi.fn((channel: string, _payload: unknown): Promise<unknown> => {
    if (channel === 'native-terminal:enabled') return Promise.resolve(true)
    if (channel === 'pty:start')
      return Promise.resolve({
        outcome: 'started',
        id: 'terminal-1',
        instanceId: 'instance-1',
        pid: 123,
        resumed: false,
        capabilities: options.capabilities,
        identityStatus: 'identified',
      })
    if (channel === 'native-terminal:attach')
      return Promise.resolve({ viewId: 'native-view' })
    if (channel === 'native-terminal:demand') return Promise.resolve(true)
    if (channel === 'native-terminal:input')
      return Promise.resolve({ requestedMutation: 0 })
    return Promise.resolve()
  })
  const send = vi.fn()
  const presentation = {
    mount: vi.fn<(_viewId: string, _elementId: string) => void>(),
    unmount: vi.fn<(_viewId: string) => void>(),
    onStatus: vi.fn(() => vi.fn()),
  }
  const api = {
    invoke,
    send,
    nativeTerminalPresentation: presentation,
    on: (channel: string, listener: (payload: unknown) => void) => {
      listeners.set(channel, listener)
      return () => listeners.delete(channel)
    },
  } as unknown as HvirApi
  vi.stubGlobal('hvir', api)
  Object.defineProperty(window, 'hvir', { configurable: true, value: api })
  const router = new TerminalEventRouter(api)
  const runtime = new TerminalRuntime(
    options,
    () => router,
    vi.fn(),
    () => Promise.resolve(() => undefined),
  )
  cleanup.push(async () => {
    runtime.dispose()
    router.dispose()
    await vi.waitFor(() => {
      for (const [viewId] of presentation.mount.mock.calls) {
        expect(presentation.unmount).toHaveBeenCalledWith(viewId)
        expect(invoke).toHaveBeenCalledWith('native-terminal:detach', { viewId })
      }
    })
  })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const tick = async () => {
    const ready = [...frames.values()]
    frames.clear()
    for (const frame of ready) frame(performance.now())
    for (let i = 0; i < 8; i++) await Promise.resolve()
  }
  return { options, invoke, send, presentation, runtime, container, listeners, tick }
}

describe('native workbench runtime selection', () => {
  it('keeps legacy selection the default and propagates selection failures', async () => {
    const f = fixture()
    f.invoke.mockResolvedValueOnce(false)
    expect(await createTerminalRuntimePane(f.options)).toEqual({ legacy: true })
    expect(legacy.create).toHaveBeenCalledTimes(1)
    f.invoke.mockRejectedValueOnce(new Error('selection unavailable'))
    await expect(createTerminalRuntimePane(f.options)).rejects.toThrow(
      'selection unavailable',
    )
    expect(legacy.create).toHaveBeenCalledTimes(1)
  })

  it('starts once with physical geometry, binds after launch and never mirrors native output into a web parser', async () => {
    const f = fixture()
    f.runtime.attach(f.container)
    await vi.waitFor(() => expect(f.options.onStarted).toHaveBeenCalledTimes(1))
    const starts = f.invoke.mock.calls.filter(([channel]) => channel === 'pty:start')
    expect(starts).toHaveLength(1)
    expect(starts[0]?.[1]).toMatchObject({
      nativeViewport: { width: 1280, height: 800, backingScale: 2 },
    })
    const channels = f.invoke.mock.calls.map(([channel]) => channel)
    expect(channels.indexOf('native-terminal:attach')).toBeGreaterThan(
      channels.indexOf('pty:start'),
    )
    expect(legacy.create).not.toHaveBeenCalled()
    f.listeners.get('pty:data')?.({
      id: 'terminal-1',
      data: 'native output remains main-owned',
    })
    await f.tick()
    expect(f.options.onOutput).toHaveBeenCalledTimes(1)
    expect(f.container.textContent).not.toContain('native output remains main-owned')
    expect(
      f.invoke.mock.calls.some(([channel]) => channel === 'native-terminal:update'),
    ).toBe(true)
    expect(f.send.mock.calls.some(([channel]) => channel === 'pty:resize')).toBe(false)
    expect(f.runtime.interactions.contextMenuTarget()).toBeDefined()
    f.listeners.get('pty:exit')?.({ id: 'terminal-1', exitCode: 0 })
    expect(f.runtime.snapshot().exited).toBe(true)
    expect(f.container.querySelector('[aria-readonly="true"]')).not.toBeNull()
    expect(f.presentation.unmount).not.toHaveBeenCalled()
    f.runtime.dispose()
    expect(f.send).toHaveBeenCalledWith('pty:kill', { id: 'terminal-1' })
  })

  it('retains the same native surface while Sessions borrows it with one focus owner', async () => {
    const f = fixture()
    f.runtime.attach(f.container)
    await vi.waitFor(() => expect(f.options.onStarted).toHaveBeenCalledTimes(1))
    const surface = f.container.firstElementChild
    const input = surface?.querySelector('textarea')
    expect(input).toBeInstanceOf(HTMLTextAreaElement)
    const detail = document.createElement('div')
    document.body.appendChild(detail)
    const acquired = f.runtime.acquireSessionsSurface({
      handle: asSessionsTerminalHandle('terminal-1'),
      workspaceRuntimeId: asSessionsWorkspaceRuntimeId('workspace'),
      livePty: {
        handle: asSessionsPtyHandle('instance-1'),
        rendererOwnerId: 1,
        rendererGeneration: 1,
      },
      demandGeneration: 1,
      projectionRevision: 1,
      sourceRevision: 1,
    })
    expect(acquired.outcome).toBe('acquired')
    if (acquired.outcome !== 'acquired') throw new Error('expected retained surface')
    expect(acquired.lease.attach(detail)).toBe(true)
    expect(detail.firstElementChild).toBe(surface)
    expect(acquired.lease.focus(detail)).toBe(true)
    expect(document.activeElement).toBe(input)
    f.runtime.focus()
    expect(document.activeElement).toBe(input)
    expect(detail.firstElementChild).toBe(surface)
    expect(f.container.contains(input ?? null)).toBe(false)
    acquired.lease.release()
    expect(f.container.firstElementChild).toBe(surface)
    expect(
      f.invoke.mock.calls.filter(([channel]) => channel === 'native-terminal:attach'),
    ).toHaveLength(1)
    expect(
      f.invoke.mock.calls.filter(([channel]) => channel === 'pty:start'),
    ).toHaveLength(1)
  })

  it('does not overwrite an early PTY exit with a late successful presentation bind', async () => {
    const f = fixture()
    let resolve!: (value: unknown) => void
    const attaching = new Promise<unknown>((yes) => {
      resolve = yes
    })
    const original = f.invoke.getMockImplementation()!
    f.invoke.mockImplementation((channel, payload) =>
      channel === 'native-terminal:attach' ? attaching : original(channel, payload),
    )
    f.runtime.attach(f.container)
    await vi.waitFor(() =>
      expect(
        f.invoke.mock.calls.some(([channel]) => channel === 'native-terminal:attach'),
      ).toBe(true),
    )
    f.listeners.get('pty:exit')?.({ id: 'terminal-1', exitCode: 7 })
    resolve({ viewId: 'retained-exited-view' })
    await vi.waitFor(() => expect(f.presentation.mount).toHaveBeenCalledTimes(1))
    expect(f.runtime.snapshot()).toMatchObject({ exited: true, status: 'Exited (7)' })
    expect(f.options.onStarted).not.toHaveBeenCalled()
    expect(f.container.querySelector('[aria-readonly="true"]')).not.toBeNull()
  })

  it('does not resurrect a disposed runtime after a late presentation attachment', async () => {
    const f = fixture()
    let resolve!: (value: unknown) => void
    const attaching = new Promise<unknown>((yes) => {
      resolve = yes
    })
    const original = f.invoke.getMockImplementation()!
    f.invoke.mockImplementation((channel, payload) =>
      channel === 'native-terminal:attach' ? attaching : original(channel, payload),
    )
    f.runtime.attach(f.container)
    await vi.waitFor(() =>
      expect(
        f.invoke.mock.calls.some(([channel]) => channel === 'native-terminal:attach'),
      ).toBe(true),
    )
    f.runtime.dispose()
    resolve({ viewId: 'late-view' })
    await vi.waitFor(() =>
      expect(f.invoke).toHaveBeenCalledWith('native-terminal:detach', {
        viewId: 'late-view',
      }),
    )
    expect(f.options.onStarted).not.toHaveBeenCalled()
    expect(f.presentation.mount).not.toHaveBeenCalled()
    expect(f.send).toHaveBeenCalledWith('pty:kill', { id: 'terminal-1' })
  })

  it('reports failed native presentation without claiming the live PTY exited or switching parsers', async () => {
    const f = fixture()
    const original = f.invoke.getMockImplementation()!
    f.invoke.mockImplementation((channel, payload) =>
      channel === 'native-terminal:attach'
        ? Promise.reject(new Error('native presentation unavailable'))
        : original(channel, payload),
    )
    f.runtime.attach(f.container)
    await vi.waitFor(() =>
      expect(f.runtime.snapshot().status).toContain('native presentation unavailable'),
    )
    expect(f.runtime.snapshot().exited).toBe(false)
    expect(legacy.create).not.toHaveBeenCalled()
    expect(f.send).not.toHaveBeenCalledWith('pty:kill', expect.anything())
    f.runtime.dispose()
    expect(f.send).toHaveBeenCalledWith('pty:kill', { id: 'terminal-1' })
  })
})
