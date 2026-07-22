// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createGhosttyTerminalPane } from '../src/renderer/src/terminal/ghostty-terminal-pane'
import { TerminalView } from '../src/renderer/src/terminal/TerminalView'
import type { TerminalRuntimeOptions } from '../src/renderer/src/terminal/terminal-runtime'
import { TerminalRuntimeRegistry } from '../src/renderer/src/terminal/terminal-runtime-registry'
import { asHarnessProfileId, localPath } from '../src/shared'

const ghosttyState = vi.hoisted(() => ({
  instances: [] as Array<{
    readonly cursorBlinkValues: boolean[]
    readonly writes: string[]
    renders: number
    disposed: boolean
  }>,
}))

vi.mock('ghostty-web', () => {
  class MockTerminal {
    readonly options: { theme?: unknown; cursorBlink?: boolean }
    readonly buffer = { active: { getLine: () => undefined } }
    readonly wasmTerm = {}
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

    constructor(options: { theme?: unknown; cursorBlink?: boolean }) {
      this.state = {
        cursorBlinkValues: [Boolean(options.cursorBlink)],
        writes: [],
        renders: 0,
        disposed: false,
      }
      ghosttyState.instances.push(this.state)
      this.options = new Proxy(
        { ...options },
        {
          set: (target, property, value) => {
            Reflect.set(target, property, value)
            if (property === 'cursorBlink') {
              this.state.cursorBlinkValues.push(Boolean(value))
            }
            return true
          },
        },
      )
    }

    attachCustomKeyEventHandler(): void {}

    attachCustomWheelEventHandler(): void {}

    onData(): { dispose(): void } {
      return { dispose: () => undefined }
    }

    onResize(): { dispose(): void } {
      return { dispose: () => undefined }
    }

    onTitleChange(): { dispose(): void } {
      return { dispose: () => undefined }
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
        getMetrics: () => ({ width: 8, height: 16 }),
        render: () => {
          this.state.renders += 1
        },
        setTheme: () => undefined,
      }
    }

    registerLinkProvider(): void {}

    getViewportY(): number {
      return 0
    }

    getScrollbackLength(): number {
      return 0
    }

    scrollToLine(): void {}

    write(data: string): void {
      this.state.writes.push(data)
    }

    resize(cols: number, rows: number): void {
      this.cols = cols
      this.rows = rows
    }

    focus(): void {}

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

  return {
    init: vi.fn(() => Promise.resolve()),
    Terminal: MockTerminal,
  }
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
    const pane = await createGhosttyTerminalPane(theme(), {
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

  it('stops hidden cursor work and restores a current repaint on reveal', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const pane = await createGhosttyTerminalPane(theme(), {
      modifiedKeyProtocol: 'modify-other-keys',
      metaEnterAliasesControl: true,
      composerSubmitMode: 'enter',
    })
    const state = ghosttyState.instances[0]!

    pane.setPresentation('hidden')
    pane.mount(container)
    pane.write('\u001b]0;Hidden output\u0007buffered')
    const hiddenRenderCount = state.renders

    expect(state.cursorBlinkValues).toEqual([true, false])
    expect(state.writes).toContain('\u001b]0;Hidden output\u0007buffered')

    pane.setPresentation('visible')

    expect(state.cursorBlinkValues).toEqual([true, false, true])
    expect(state.renders).toBeGreaterThan(hiddenRenderCount)

    pane.setPresentation('hidden')
    pane.dispose()
    const transitionsAtDisposal = [...state.cursorBlinkValues]
    pane.setPresentation('visible')

    expect(state.disposed).toBe(true)
    expect(state.cursorBlinkValues).toEqual(transitionsAtDisposal)
  })

  it('follows React presentation independently from keyboard focus', async () => {
    const invoke = vi.fn(() =>
      Promise.resolve({
        outcome: 'started' as const,
        id: 'terminal-1',
        pid: 4321,
        resumed: false,
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
    expect(state.cursorBlinkValues).toEqual([true, false])

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
    expect(state.cursorBlinkValues).toEqual([true, false, true])

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
    expect(state.cursorBlinkValues).toEqual([true, false, true, false])
    expect(invoke).toHaveBeenCalledOnce()
    expect(send).not.toHaveBeenCalledWith('pty:kill', expect.anything())

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

function theme() {
  return {
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
  }
}

function runtimeOptions(): TerminalRuntimeOptions {
  return {
    sessionId: 'terminal-1',
    profileId: asHarnessProfileId('claude-code-default'),
    launchRevision: 2,
    riskAcknowledged: false,
    supportsResume: true,
    fallbackTitle: 'Claude Code · repo',
    harnessSessionId: '05ea41ff-026f-4ab6-b930-64eb3b497806',
    resumeOnStart: true,
    position: 0,
    active: true,
    presentation: 'visible',
    modifiedKeyProtocol: 'modify-other-keys',
    metaEnterAliasesControl: true,
    composerSubmitMode: 'enter',
    cwd: localPath('/repo'),
    workspaceRoot: localPath('/repo'),
    connectionState: 'connected',
    onTitle: vi.fn(),
    onStatus: vi.fn(),
    onTelemetry: vi.fn(),
    onIdentity: vi.fn(),
    onStarted: vi.fn(),
    onFreshStarted: vi.fn(),
    onCapabilities: vi.fn(),
    onInput: vi.fn(),
    onOutput: vi.fn(),
    onBell: vi.fn(),
    onFocus: vi.fn(),
    onLink: vi.fn(),
  }
}
