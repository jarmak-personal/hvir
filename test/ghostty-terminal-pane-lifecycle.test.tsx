// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createGhosttyTerminalPane } from '../src/renderer/src/terminal/ghostty-terminal-pane'
import { terminalThemeForAppearance } from '../src/renderer/src/terminal/terminal-palette'
import { TerminalView } from '../src/renderer/src/terminal/TerminalView'
import type { TerminalRuntimeOptions } from '../src/renderer/src/terminal/terminal-runtime-options'
import { TerminalRuntimeRegistry } from '../src/renderer/src/terminal/terminal-runtime-registry'
import type { TerminalEvent } from '../src/renderer/src/terminal/terminal-pane'
import { ghosttyLifecycleRuntimeOptions as runtimeOptions } from './fixtures/ghostty-lifecycle-runtime-options'
import { ghosttyState } from './fixtures/ghostty-terminal-pane-mock'

vi.mock('ghostty-web', async () => {
  const { ghosttyWebMock } = await import('./fixtures/ghostty-terminal-pane-mock')
  return ghosttyWebMock
})
describe('GhosttyTerminalPane lifecycle', () => {
  beforeEach(() => {
    ghosttyState.instances.splice(0)
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
        disconnect(): void {}
      },
    )
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    Reflect.deleteProperty(window, 'hvir')
    document.body.replaceChildren()
  })
  it('moves and disposes only its adapter-owned surface', async () => {
    const firstContainer = document.createElement('div')
    const secondContainer = document.createElement('div')
    document.body.append(firstContainer, secondContainer)
    const pane = await createGhosttyTerminalPane(theme(), typography(), {
      cursorDefaults: cursorDefaults(),
      ligatures: true,
      modifiedKeyProtocol: 'modify-other-keys',
      metaEnterAliasesControl: true,
      composerSubmitMode: 'enter',
    })
    pane.mount(firstContainer)
    const surface = firstContainer.querySelector('.terminal-engine-host')
    expect(surface).toBeInstanceOf(HTMLDivElement)
    expect(surface?.getAttribute('contenteditable')).toBe('true')
    pane.reparent(secondContainer)
    expect(firstContainer.isConnected).toBe(true)
    expect(firstContainer.childElementCount).toBe(0)
    expect(secondContainer.firstElementChild).toBe(surface)
    pane.dispose()
    expect(secondContainer.isConnected).toBe(true)
    expect(secondContainer.childElementCount).toBe(0)
  })
  it('configures an exact byte budget and reports the engine limit', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const pane = await createGhosttyTerminalPane(theme(), typography(), {
      cursorDefaults: cursorDefaults(),
      ligatures: true,
      modifiedKeyProtocol: 'modify-other-keys',
      metaEnterAliasesControl: true,
      composerSubmitMode: 'enter',
    })
    const state = ghosttyState.instances[0]!

    expect(state.scrollbackBytes).toBe(10_000_000)
    expect(state.scrollbackLines).toBeUndefined()

    pane.mount(container)
    state.scrollbackByteLimit = 9_000_000
    const surface = container.querySelector<HTMLElement>('.terminal-engine-host')!
    const performance = Reflect.get(surface, '__hvirTerminalPerformance') as {
      readonly retainedByteLimit: number
    }

    expect(performance.retainedByteLimit).toBe(9_000_000)
    pane.dispose()
    expect(
      (
        Reflect.get(surface, '__hvirTerminalPerformance') as {
          readonly retainedByteLimit: number
        }
      ).retainedByteLimit,
    ).toBe(0)
  })
  it('uses only structured parser events and releases their source on disposal', async () => {
    const pane = await createGhosttyTerminalPane(theme(), typography(), {
      cursorDefaults: cursorDefaults(),
      ligatures: true,
      modifiedKeyProtocol: 'modify-other-keys',
      metaEnterAliasesControl: true,
      composerSubmitMode: 'enter',
    })
    const events: TerminalEvent[] = []
    pane.events.onEvent((event) => events.push(event))
    pane.setPresentation('hidden')
    pane.mount(document.createElement('div'))
    const state = ghosttyState.instances[0]!
    state.emitTerminalEvent({ type: 'title', title: 'Structured' })
    state.emitTerminalEvent({
      type: 'notification',
      source: 'osc-9',
      title: '',
      body: '',
    })
    state.emitTerminalEvent({ type: 'bell' })
    pane.write('\u001b]2;Raw duplicate\u0007')
    expect(events.map((event) => event.type)).toEqual(['title', 'notification', 'bell'])
    pane.dispose()
    state.emitTerminalEvent({ type: 'bell' })
    expect(events).toHaveLength(3)
  })
  it('stops hidden cursor work and restores a current repaint on reveal', async () => {
    const container = document.createElement('div')
    const nextContainer = document.createElement('div')
    document.body.append(container, nextContainer)
    const pane = await createGhosttyTerminalPane(theme(), typography(), {
      cursorDefaults: cursorDefaults(),
      ligatures: true,
      modifiedKeyProtocol: 'modify-other-keys',
      metaEnterAliasesControl: true,
      composerSubmitMode: 'enter',
    })
    const state = ghosttyState.instances[0]!

    pane.setPresentation('hidden')
    pane.mount(container)
    const canvas = container.querySelector('canvas')
    pane.write('\u001b]0;Hidden output\u0007buffered')
    const surface = container.querySelector<HTMLElement>('.terminal-engine-host')!
    Object.defineProperties(surface, {
      clientWidth: { configurable: true, value: 780 },
      clientHeight: { configurable: true, value: 360 },
    })
    const hiddenRenderCount = state.renders
    const hiddenResizeCount = state.resizes.length
    const { cursorText, ...lightTheme } = terminalThemeForAppearance('light')

    pane.reparent(nextContainer)
    pane.setTheme(terminalThemeForAppearance('light'))
    pane.setTypography({ fontFamily: 'Deferred Mono', fontSize: 18 })
    pane.setCursorDefaults({ shape: 'hollow-block', blink: 'steady' })
    pane.setLigatures(false)
    await settleTerminalFit()

    expect(state.cursorBlinkValues).toEqual(['terminal', false])
    expect(state.cursorStyleValues).toEqual(['block', 'block_hollow'])
    expect(state.fontLigatureValues).toEqual([true, false])
    expect(state.presentationPausedValues).toEqual([true])
    expect(state.writes).toContain('\u001b]0;Hidden output\u0007buffered')
    expect(state.themes.at(-1)).toEqual({ ...lightTheme, cursorAccent: cursorText })
    expect(state.rendererThemeWrites).toBe(0)
    expect(state.renders).toBe(hiddenRenderCount)
    expect(state.resizes).toHaveLength(hiddenResizeCount)
    expect(nextContainer.firstElementChild).toBe(surface)

    pane.setPresentation('visible')
    expect(canvas?.style.visibility).toBe('hidden')
    await settleTerminalFit()

    expect(state.cursorBlinkValues).toEqual(['terminal', false])
    expect(state.cursorStyleValues).toEqual(['block', 'block_hollow'])
    expect(state.fontLigatureValues).toEqual([true, false])
    expect(state.presentationPausedValues).toEqual([true, false])
    expect(state.renders).toBeGreaterThan(hiddenRenderCount)
    expect(state.resizes).toEqual([{ cols: 72, rows: 16 }])
    expect(nextContainer.querySelector('canvas')).toBe(canvas)
    expect(canvas?.style.visibility).toBe('')

    pane.setPresentation('hidden')
    const retainedRenderCount = state.renders
    const retainedResizeCount = state.resizes.length
    expect(canvas?.style.visibility).toBe('hidden')

    pane.setPresentation('visible')

    expect(canvas?.style.visibility).toBe('')
    expect(state.presentationPausedValues).toEqual([true, false, true])
    expect(state.renders).toBe(retainedRenderCount)
    expect(state.resizes).toHaveLength(retainedResizeCount)

    await settleTerminalFit()

    expect(state.presentationPausedValues).toEqual([true, false, true, false])
    expect(state.renders).toBeGreaterThan(retainedRenderCount)
    expect(state.resizes).toHaveLength(retainedResizeCount)

    pane.setPresentation('hidden')
    pane.dispose()
    const transitionsAtDisposal = [...state.cursorBlinkValues]
    pane.setPresentation('visible')

    expect(state.disposed).toBe(true)
    expect(state.cursorBlinkValues).toEqual(transitionsAtDisposal)
  })

  it('resets cursor blinking for ordinary and adapter-owned input only while visible', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const pane = await createGhosttyTerminalPane(theme(), typography(), {
      cursorDefaults: cursorDefaults(),
      ligatures: true,
      modifiedKeyProtocol: 'modify-other-keys',
      metaEnterAliasesControl: true,
      composerSubmitMode: 'enter',
    })
    const state = ghosttyState.instances[0]!
    const input = vi.fn()
    const clipboardPaste = vi.fn()
    pane.events.onData(input)
    pane.events.onClipboardPaste(clipboardPaste)
    pane.mount(container)
    await settleTerminalFit()

    state.emitData('a')
    const customHandled = state.emitCustomKey({
      code: 'KeyV',
      ctrlKey: true,
      altKey: false,
      metaKey: false,
      shiftKey: false,
    })

    expect(customHandled).toBe(true)
    expect(input.mock.calls).toEqual([['a']])
    expect(clipboardPaste).toHaveBeenCalledExactlyOnceWith('\x16')
    expect(state.cursorBlinkResets).toBe(2)

    pane.setPresentation('hidden')
    state.emitData('b')
    expect(input).toHaveBeenLastCalledWith('b')
    expect(state.cursorBlinkResets).toBe(2)

    pane.setPresentation('visible')
    await settleTerminalFit()
    state.emitData('c')
    expect(state.cursorBlinkResets).toBe(3)

    pane.dispose()
    state.emitData('d')
    expect(input).not.toHaveBeenCalledWith('d')
    expect(state.cursorBlinkResets).toBe(3)
  })

  it('supplies the preload file-path capability only to ghostty paste ownership', async () => {
    const resolved = '/home/user/project/requirements.txt'
    const resolveTerminalClipboardFilePaste = vi.fn(() => resolved)
    Object.defineProperty(window, 'hvir', {
      configurable: true,
      value: { resolveTerminalClipboardFilePaste },
    })
    const pane = await createGhosttyTerminalPane(theme(), typography(), {
      cursorDefaults: cursorDefaults(),
      ligatures: true,
      modifiedKeyProtocol: 'none',
      metaEnterAliasesControl: false,
      composerSubmitMode: 'enter',
    })
    const file = { name: 'requirements.txt' } as File

    expect(ghosttyState.instances[0]!.resolveClipboardFilePaste(file)).toBe(resolved)
    expect(resolveTerminalClipboardFilePaste).toHaveBeenCalledExactlyOnceWith(file)

    pane.dispose()
  })

  it('follows React presentation independently from keyboard focus', async () => {
    const invoke = vi.fn(() =>
      Promise.resolve({
        outcome: 'started' as const,
        id: 'terminal-1',
        pid: 4321,
        resumed: false,
        reattached: false,
        harnessSessionId: undefined,
        identityStatus: 'unsupported' as const,
        capabilities: {
          sessionIdentity: 'none' as const,
          exactResume: false,
          contextPresentation: 'none' as const,
        },
      }),
    )
    const send = vi.fn()
    Object.defineProperty(window, 'hvir', {
      configurable: true,
      value: {
        invoke,
        send,
        on: vi.fn(() => () => undefined),
      },
    })
    const registry = new TerminalRuntimeRegistry()
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)

    act(() => {
      root.render(
        <TerminalView
          {...runtimeOptions()}
          active={false}
          slot="primary"
          visible={false}
          themeOverride="app"
          runtimes={registry}
        />,
      )
    })
    await act(async () => {
      await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce())
    })
    const state = ghosttyState.instances[0]!
    expect(state.cursorBlinkValues).toEqual(['terminal'])

    act(() => {
      root.render(
        <TerminalView
          {...runtimeOptions()}
          active={false}
          slot="primary"
          visible
          themeOverride="app"
          runtimes={registry}
        />,
      )
    })
    expect(state.cursorBlinkValues).toEqual(['terminal'])

    act(() => {
      root.render(
        <TerminalView
          {...runtimeOptions()}
          active={false}
          slot="primary"
          visible={false}
          themeOverride="app"
          runtimes={registry}
        />,
      )
    })
    expect(state.cursorBlinkValues).toEqual(['terminal'])
    expect(invoke).toHaveBeenCalledOnce()
    expect(send).not.toHaveBeenCalledWith('pty:kill', expect.anything())

    act(() => {
      root.unmount()
      registry.dispose()
    })
  })

  it('reflows a retained pane and propagates its new grid without clearing output', async () => {
    const invoke = vi.fn(() =>
      Promise.resolve({
        outcome: 'started' as const,
        id: 'terminal-1',
        pid: 4321,
        resumed: false,
        reattached: false,
        harnessSessionId: undefined,
        identityStatus: 'unsupported' as const,
        capabilities: {
          sessionIdentity: 'none' as const,
          exactResume: false,
          contextPresentation: 'none' as const,
        },
      }),
    )
    const send = vi.fn()
    Object.defineProperty(window, 'hvir', {
      configurable: true,
      value: {
        invoke,
        send,
        on: vi.fn(() => () => undefined),
      },
    })
    const registry = new TerminalRuntimeRegistry()
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const render = (fontSize: number) => (
      <TerminalView
        {...runtimeOptions()}
        typography={{ fontFamily: 'Example Mono, monospace', fontSize }}
        slot="primary"
        visible
        themeOverride="app"
        runtimes={registry}
      />
    )

    act(() => root.render(render(13)))
    await act(async () => {
      await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce())
    })
    const state = ghosttyState.instances[0]!
    const surface = host.querySelector<HTMLElement>('.terminal-engine-host')!
    const canvas = surface.querySelector('canvas')
    Object.defineProperties(surface, {
      clientWidth: { configurable: true, value: 800 },
      clientHeight: { configurable: true, value: 320 },
    })
    state.writes.push('retained history')

    act(() => root.render(render(18)))
    await act(async () => {
      await settleTerminalFit(180)
    })

    expect(host.querySelector('.terminal-engine-host')).toBe(surface)
    expect(surface.querySelector('canvas')).toBe(canvas)
    expect(state.disposed).toBe(false)
    expect(state.writes).toContain('retained history')
    expect(state.fontFamilies).toEqual(['Example Mono, monospace'])
    expect(state.fontSizes).toEqual([13, 18])
    expect(state.resizes.at(-1)).toEqual({ cols: 74, rows: 14 })
    expect(send).toHaveBeenCalledWith('pty:resize', {
      id: 'terminal-1',
      cols: 74,
      rows: 14,
    })
    expect(send).not.toHaveBeenCalledWith('pty:kill', expect.anything())

    act(() => {
      root.unmount()
      registry.dispose()
    })
  })

  it('retains a live pane and output route while its workspace view is absent', async () => {
    let emitData: ((event: { id: string; data: string }) => void) | undefined
    const invoke = vi.fn(() =>
      Promise.resolve({
        outcome: 'started' as const,
        id: 'terminal-1',
        pid: 4321,
        resumed: false,
        reattached: false,
        harnessSessionId: undefined,
        identityStatus: 'unsupported' as const,
        capabilities: {
          sessionIdentity: 'none' as const,
          exactResume: false,
          contextPresentation: 'none' as const,
        },
      }),
    )
    const send = vi.fn()
    Object.defineProperty(window, 'hvir', {
      configurable: true,
      value: {
        invoke,
        send,
        on: vi.fn((channel: string, listener: typeof emitData) => {
          if (channel === 'pty:data') emitData = listener
          return () => undefined
        }),
      },
    })
    const registry = new TerminalRuntimeRegistry()
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const render = (
      presented: boolean,
      connectionState: TerminalRuntimeOptions['connectionState'] = 'connected',
    ) => (
      <TerminalView
        {...runtimeOptions()}
        active={presented}
        slot="primary"
        presented={presented}
        visible={presented}
        connectionState={connectionState}
        themeOverride="app"
        runtimes={registry}
      />
    )

    act(() => root.render(render(true)))
    await act(async () => {
      await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce())
    })
    const state = ghosttyState.instances[0]!
    const surface = host.querySelector('.terminal-engine-host')

    act(() => root.render(render(false)))
    expect(host.querySelector('.terminal-panel')).toBeNull()
    expect(state.disposed).toBe(false)
    expect(send).not.toHaveBeenCalledWith('pty:kill', expect.anything())

    act(() => {
      emitData?.({ id: 'terminal-1', data: 'background output' })
    })
    await vi.waitFor(() => expect(state.writes).toContain('background output'))

    act(() => root.render(render(false, 'disconnected')))
    expect(state.disposed).toBe(true)
    expect(send).not.toHaveBeenCalledWith('pty:kill', expect.anything())

    act(() => root.render(render(false, 'connected')))
    await act(async () => {
      await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2))
    })
    const reconnected = ghosttyState.instances[1]!
    act(() => {
      emitData?.({ id: 'terminal-1', data: 'reconnected background output' })
    })
    await vi.waitFor(() =>
      expect(reconnected.writes).toContain('reconnected background output'),
    )

    act(() => root.render(render(true)))
    expect(host.querySelector('.terminal-engine-host')).not.toBe(surface)
    expect(ghosttyState.instances).toHaveLength(2)
    expect(invoke).toHaveBeenCalledTimes(2)

    act(() => {
      root.unmount()
      registry.dispose()
    })
  })

  it('retains the live terminal surface and event route across a control reconnect', async () => {
    const invoke = vi.fn(() =>
      Promise.resolve({
        outcome: 'started' as const,
        id: 'terminal-1',
        pid: 4321,
        resumed: false,
        reattached: false,
        harnessSessionId: undefined,
        identityStatus: 'unsupported' as const,
        capabilities: {
          sessionIdentity: 'none' as const,
          exactResume: false,
          contextPresentation: 'none' as const,
        },
      }),
    )
    const send = vi.fn()
    const events = new Map<string, (event: never) => void>()
    Object.defineProperty(window, 'hvir', {
      configurable: true,
      value: {
        invoke,
        send,
        on: vi.fn((channel: string, listener: (event: never) => void) => {
          events.set(channel, listener)
          return () => events.delete(channel)
        }),
      },
    })
    const registry = new TerminalRuntimeRegistry()
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const render = (connectionState: TerminalRuntimeOptions['connectionState']) => (
      <TerminalView
        {...runtimeOptions()}
        supportsResume={false}
        harnessSessionId={undefined}
        resumeOnStart={false}
        connectionState={connectionState}
        slot="primary"
        visible
        themeOverride="app"
        runtimes={registry}
      />
    )

    act(() => root.render(render('connected')))
    await act(async () => {
      await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce())
    })
    const state = ghosttyState.instances[0]!
    const surface = host.querySelector('.terminal-engine-host')

    act(() => root.render(render('reconnecting')))
    expect(state.disposed).toBe(false)
    expect(host.querySelector('.terminal-engine-host')).toBe(surface)
    expect(invoke).toHaveBeenCalledOnce()
    expect(send).not.toHaveBeenCalledWith('pty:kill', expect.anything())

    act(() => {
      events.get('pty:data')?.({
        id: 'terminal-1',
        data: 'output during reconnect',
      } as never)
    })
    await vi.waitFor(() => expect(state.writes).toContain('output during reconnect'))

    act(() => root.render(render('connected')))
    expect(host.querySelector('.terminal-engine-host')).toBe(surface)
    expect(invoke).toHaveBeenCalledOnce()

    act(() => root.render(render('reconnecting')))
    act(() => {
      events.get('pty:exit')?.({
        id: 'terminal-1',
        exitCode: 255,
      } as never)
      events.get('pty:exit')?.({
        id: 'terminal-1',
        exitCode: 255,
      } as never)
    })
    act(() => root.render(render('connected')))
    await act(async () => {
      await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2))
    })
    expect(state.disposed).toBe(true)
    expect(ghosttyState.instances).toHaveLength(2)
    expect(host.querySelectorAll('.terminal-engine-host')).toHaveLength(1)

    act(() => root.render(render('disconnected')))
    expect(ghosttyState.instances[1]?.disposed).toBe(true)
    expect(host.querySelectorAll('.terminal-engine-host')).toHaveLength(0)
    expect(
      host.querySelector('.terminal-panel')?.getAttribute('data-terminal-status'),
    ).toBe('disconnected')

    act(() => {
      root.unmount()
      registry.dispose()
    })
  })

  it('retries unavailable resume without removing the React-owned container', async () => {
    const invoke = vi.fn(() =>
      Promise.resolve({
        outcome: 'resume-unavailable' as const,
        reason: 'artifact-missing' as const,
      }),
    )
    Object.defineProperty(window, 'hvir', {
      configurable: true,
      value: {
        invoke,
        send: vi.fn(),
        on: vi.fn(() => () => undefined),
      },
    })
    const registry = new TerminalRuntimeRegistry()
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    act(() => {
      root.render(
        <TerminalView
          {...runtimeOptions()}
          slot="primary"
          visible
          themeOverride="app"
          runtimes={registry}
        />,
      )
    })
    await act(async () => {
      await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce())
      await Promise.resolve()
    })
    expect(host.querySelector('.terminal-start-fresh')?.textContent).toBe('Start fresh')
    expect(host.querySelector('.terminal-restart')?.textContent).toBe('Retry recovery')
    const container = host.querySelector('.terminal-container')
    const firstSurface = container?.querySelector('.terminal-engine-host')

    await act(async () => {
      host.querySelector<HTMLButtonElement>('.terminal-restart')?.click()
      await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2))
      await Promise.resolve()
    })
    expect(host.querySelector('.terminal-restart')?.textContent).toBe('Retry recovery')
    expect(container?.isConnected).toBe(true)
    expect(host.querySelector('.terminal-container')).toBe(container)
    expect(container?.querySelector('.terminal-engine-host')).not.toBe(firstSurface)

    act(() => {
      root.unmount()
      registry.dispose()
    })
    Reflect.deleteProperty(window, 'hvir')
  })

  it('hands a retained runtime between React owners while hidden', async () => {
    const invoke = vi.fn(() =>
      Promise.resolve({
        outcome: 'started' as const,
        id: 'terminal-1',
        pid: 4321,
        resumed: false,
        reattached: false,
        harnessSessionId: undefined,
        identityStatus: 'unsupported' as const,
        capabilities: {
          sessionIdentity: 'none' as const,
          exactResume: false,
          contextPresentation: 'none' as const,
        },
      }),
    )
    Object.defineProperty(window, 'hvir', {
      configurable: true,
      value: {
        invoke,
        send: vi.fn(),
        on: vi.fn(() => () => undefined),
      },
    })
    const registry = new TerminalRuntimeRegistry()
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const renderOwner = (owner: string) => (
      <TerminalView
        key={owner}
        {...runtimeOptions()}
        slot="primary"
        visible
        themeOverride="app"
        runtimes={registry}
      />
    )

    act(() => root.render(renderOwner('source')))
    await act(async () => {
      await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce())
    })
    const state = ghosttyState.instances[0]!

    await act(async () => {
      await settleTerminalFit()
      root.render(renderOwner('target'))
      await Promise.resolve()
    })
    await settleTerminalFit()

    expect(state.presentationPausedValues).toEqual([true, false, true, false])
    expect(host.querySelectorAll('.terminal-engine-host')).toHaveLength(1)

    act(() => {
      root.unmount()
      registry.dispose()
    })
  })

  it('orders retained attachment, detachment, and focus through the current owner', async () => {
    const invoke = vi.fn(() =>
      Promise.resolve({
        outcome: 'started' as const,
        id: 'terminal-1',
        pid: 4321,
        resumed: false,
        reattached: false,
        harnessSessionId: undefined,
        identityStatus: 'unsupported' as const,
        capabilities: {
          sessionIdentity: 'none' as const,
          exactResume: false,
          contextPresentation: 'none' as const,
        },
      }),
    )
    Object.defineProperty(window, 'hvir', {
      configurable: true,
      value: {
        invoke,
        send: vi.fn(),
        on: vi.fn(() => () => undefined),
      },
    })
    const registry = new TerminalRuntimeRegistry()
    const options = runtimeOptions()
    const runtime = registry.acquire(options)
    const first = document.createElement('div')
    const second = document.createElement('div')
    const third = document.createElement('div')
    document.body.append(first, second, third)

    runtime.attach(first)
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce())
    await settleTerminalFit()
    const state = ghosttyState.instances[0]!
    const surface = first.querySelector('.terminal-engine-host')
    expect(state.presentationPausedValues).toEqual([true, false])
    expect(deliveryPresentation(first)).toBe('visible')

    // New-owner attachment may run before stale old-owner cleanup.
    runtime.attach(second)
    runtime.detach(first)
    await settleTerminalFit()
    expect(second.querySelector('.terminal-engine-host')).toBe(surface)
    expect(state.presentationPausedValues).toEqual([true, false, true, false])
    expect(deliveryPresentation(second)).toBe('visible')

    runtime.attach(second)
    runtime.detach(first)
    expect(state.presentationPausedValues).toEqual([true, false, true, false])

    // Old-owner cleanup may also run before the replacement attaches.
    runtime.detach(second)
    runtime.detach(second)
    const focusCallsWhileAttached = state.focusCalls
    const focusEventsWhileAttached = vi.mocked(options.onFocus).mock.calls.length
    runtime.focus()
    runtime.synchronizeLifecycle()
    expect(state.presentationPausedValues).toEqual([true, false, true, false, true])
    expect(deliveryPresentation(second)).toBe('hidden')
    expect(state.focusCalls).toBe(focusCallsWhileAttached)
    expect(options.onFocus).toHaveBeenCalledTimes(focusEventsWhileAttached)

    runtime.attach(third)
    await settleTerminalFit()
    expect(third.querySelector('.terminal-engine-host')).toBe(surface)
    expect(state.presentationPausedValues).toEqual([
      true,
      false,
      true,
      false,
      true,
      false,
    ])
    expect(deliveryPresentation(third)).toBe('visible')

    registry.dispose()
  })

  it('starts fresh once and keeps React ownership through the identity handoff', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('d33b09dd-bf6a-4fab-b198-446017d5f8c9')
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({
        outcome: 'resume-unavailable' as const,
        reason: 'artifact-missing' as const,
      })
      .mockResolvedValueOnce({
        outcome: 'started' as const,
        id: 'd33b09dd-bf6a-4fab-b198-446017d5f8c9',
        pid: 4321,
        resumed: false,
        reattached: false,
        harnessSessionId: 'd33b09dd-bf6a-4fab-b198-446017d5f8c9',
        identityStatus: 'identified' as const,
        capabilities: {
          sessionIdentity: 'preassigned' as const,
          exactResume: true,
          contextPresentation: 'count' as const,
        },
      })
    Object.defineProperty(window, 'hvir', {
      configurable: true,
      value: {
        invoke,
        send: vi.fn(),
        on: vi.fn(() => () => undefined),
      },
    })
    const registry = new TerminalRuntimeRegistry()
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const onFreshStarted = vi.fn()
    act(() => {
      root.render(
        <TerminalView
          {...runtimeOptions()}
          slot="primary"
          visible
          themeOverride="app"
          runtimes={registry}
          onFreshStarted={onFreshStarted}
        />,
      )
    })
    await act(async () => {
      await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce())
    })
    const container = host.querySelector('.terminal-container')
    const action = host.querySelector<HTMLButtonElement>('.terminal-start-fresh')

    await act(async () => {
      action?.click()
      action?.click()
      await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2))
    })

    expect(invoke).toHaveBeenLastCalledWith(
      'pty:start',
      expect.objectContaining({
        sessionId: 'd33b09dd-bf6a-4fab-b198-446017d5f8c9',
        replacesSessionId: 'terminal-1',
        resume: false,
        harnessSessionId: undefined,
      }),
    )
    expect(onFreshStarted).toHaveBeenCalledOnce()
    expect(container?.isConnected).toBe(true)
    expect(host.querySelector('.terminal-container')).toBe(container)
    expect(container?.querySelectorAll('.terminal-engine-host')).toHaveLength(1)

    act(() => {
      root.unmount()
      registry.dispose()
    })
  })

  it('offers both recovery choices when a retained harness exits', async () => {
    let emitExit: ((event: { id: string; exitCode: number }) => void) | undefined
    const invoke = vi.fn(() =>
      Promise.resolve({
        outcome: 'started' as const,
        id: 'terminal-1',
        pid: 4321,
        resumed: true,
        reattached: false,
        harnessSessionId: '05ea41ff-026f-4ab6-b930-64eb3b497806',
        identityStatus: 'identified' as const,
        capabilities: {
          sessionIdentity: 'preassigned' as const,
          exactResume: true,
          contextPresentation: 'count' as const,
        },
      }),
    )
    Object.defineProperty(window, 'hvir', {
      configurable: true,
      value: {
        invoke,
        send: vi.fn(),
        on: vi.fn((channel: string, listener: unknown) => {
          if (channel === 'pty:exit') {
            emitExit = listener as typeof emitExit
          }
          return () => undefined
        }),
      },
    })
    const registry = new TerminalRuntimeRegistry()
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    act(() => {
      root.render(
        <TerminalView
          {...runtimeOptions()}
          slot="primary"
          visible
          themeOverride="app"
          runtimes={registry}
        />,
      )
    })
    await act(async () => {
      await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce())
      emitExit?.({ id: 'terminal-1', exitCode: 1 })
    })

    expect(host.querySelector('.terminal-start-fresh')?.textContent).toBe('Start fresh')
    expect(host.querySelector('.terminal-restart')?.textContent).toBe('Retry recovery')

    act(() => {
      root.unmount()
      registry.dispose()
    })
  })

  it('keeps plain-shell failures on the existing restart path', async () => {
    const invoke = vi.fn(() => Promise.reject(new Error('shell failed')))
    Object.defineProperty(window, 'hvir', {
      configurable: true,
      value: {
        invoke,
        send: vi.fn(),
        on: vi.fn(() => () => undefined),
      },
    })
    const registry = new TerminalRuntimeRegistry()
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    act(() => {
      root.render(
        <TerminalView
          {...runtimeOptions()}
          supportsResume={false}
          harnessSessionId={undefined}
          resumeOnStart={false}
          slot="primary"
          visible
          themeOverride="app"
          runtimes={registry}
        />,
      )
    })
    await act(async () => {
      await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce())
    })

    expect(host.querySelector('.terminal-start-fresh')).toBeNull()
    expect(host.querySelector('.terminal-restart')?.textContent).toBe('Restart')

    act(() => {
      root.unmount()
      registry.dispose()
    })
  })
})

const theme = () => terminalThemeForAppearance('dark')
const typography = () => ({ fontFamily: 'ui-monospace, monospace', fontSize: 13 })
const cursorDefaults = () => ({ shape: 'block', blink: 'terminal' }) as const

function settleTerminalFit(delay = 100): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, delay))
}

function deliveryPresentation(container: HTMLElement): 'visible' | 'hidden' | undefined {
  return (
    container as HTMLElement & {
      readonly __hvirTerminalDelivery?: { readonly presentation: 'visible' | 'hidden' }
    }
  ).__hvirTerminalDelivery?.presentation
}
