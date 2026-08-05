// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { TerminalEvent as GhosttyTerminalEvent } from 'ghostty-web'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TerminalRuntimeRegistry } from '../src/renderer/src/terminal/terminal-runtime-registry'
import { TerminalView } from '../src/renderer/src/terminal/TerminalView'
import { asHarnessProfileId, localPath } from '../src/shared'

const terminalState = vi.hoisted(() => ({
  instances: [] as Array<{
    emit(event: GhosttyTerminalEvent): void
    resolved: Set<number>
    screen: 'normal' | 'alternate'
    scrollback: number
    scrolls: number[]
    disposed: boolean
  }>,
}))

vi.mock('ghostty-web', () => {
  class MockTerminal {
    readonly options: Record<string, unknown>
    readonly buffer = { active: { getLine: () => undefined } }
    readonly wasmTerm: { isAlternateScreen: () => boolean }
    cols = 80
    rows = 24
    element?: HTMLElement
    renderer?: {
      clear(): void
      getCanvas(): HTMLCanvasElement
      getMetrics(): { width: number; height: number }
      setTheme(): void
    }
    private listener: (event: GhosttyTerminalEvent) => void = () => undefined
    private canvas?: HTMLCanvasElement
    private readonly state: (typeof terminalState.instances)[number]

    constructor(options: Record<string, unknown>) {
      this.options = options
      this.state = {
        emit: (event) => this.listener(event),
        resolved: new Set(),
        screen: 'normal',
        scrollback: 50,
        scrolls: [],
        disposed: false,
      }
      this.wasmTerm = {
        isAlternateScreen: () => this.state.screen === 'alternate',
      }
      terminalState.instances.push(this.state)
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
      this.listener = listener
      return { dispose: () => (this.listener = () => undefined) }
    }
    open(element: HTMLElement): void {
      this.element = element
      element.tabIndex = 0
      this.canvas = document.createElement('canvas')
      element.append(this.canvas)
      this.renderer = {
        clear: () => undefined,
        getCanvas: () => this.canvas!,
        getMetrics: () => ({ width: 8, height: 16 }),
        setTheme: () => undefined,
      }
    }
    write(): void {}
    resize(cols: number, rows: number): void {
      this.cols = cols
      this.rows = rows
    }
    getViewportY(): number {
      return 0
    }
    getScrollbackLength(): number {
      return this.state.screen === 'alternate' ? 0 : this.state.scrollback
    }
    scrollToLine(line: number): void {
      this.state.scrolls.push(line)
    }
    requestRender(): void {}
    setRenderPaused(): void {}
    resetCursorBlink(): void {}
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
    resolveEventProvenance(provenance: {
      id: number
      screen: 'normal' | 'alternate'
      row: number
    }) {
      return this.state.resolved.has(provenance.id)
        ? { screen: provenance.screen, row: provenance.row }
        : null
    }
    activeEventScreen(): 'normal' | 'alternate' {
      return this.state.screen
    }
    focus(): void {
      this.element?.focus()
    }
    dispose(): void {
      this.state.disposed = true
      this.canvas?.remove()
      this.element = undefined
      this.renderer = undefined
    }
  }

  return { init: vi.fn(() => Promise.resolve()), Terminal: MockTerminal }
})

describe('semantic transcript navigation', () => {
  beforeEach(() => {
    terminalState.instances.splice(0)
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

  it('navigates only the selected visible pane without changing its canvas or PTY', async () => {
    const send = vi.fn()
    const invoke = vi.fn(() => Promise.resolve(started()))
    Object.defineProperty(window, 'hvir', {
      configurable: true,
      value: { invoke, send, on: vi.fn(() => () => undefined) },
    })
    const registry = new TerminalRuntimeRegistry()
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)

    act(() => root.render(<TerminalView {...viewProps(registry)} />))
    await act(async () => {
      await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce())
    })
    const state = terminalState.instances[0]!
    const surface = host.querySelector<HTMLElement>('.terminal-engine-host')
    const canvas = surface?.querySelector('canvas')
    emitTranscript(state, 'normal', 10)

    const previous = host.querySelector<HTMLButtonElement>(
      'button[aria-label="Previous transcript region"]',
    )
    expect(previous).toBeInstanceOf(HTMLButtonElement)
    surface?.focus()
    const focused = document.activeElement
    act(() => {
      previous?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      previous?.click()
    })

    expect(host.querySelector('.terminal-semantic-region')?.textContent).toBe(
      'Output 3 of 3',
    )
    expect(state.scrolls).toEqual([36])
    expect(document.activeElement).toBe(focused)
    expect(host.querySelector('.terminal-engine-host')).toBe(surface)
    expect(surface?.querySelector('canvas')).toBe(canvas)
    expect(invoke).toHaveBeenCalledOnce()
    expect(send).not.toHaveBeenCalledWith('pty:write', expect.anything())
    expect(send).not.toHaveBeenCalledWith('pty:kill', expect.anything())

    act(() => previous?.click())
    expect(host.querySelector('.terminal-semantic-region')?.textContent).toBe(
      'Command 2 of 3',
    )
    expect(state.scrolls.at(-1)).toBe(38)

    act(() => {
      root.unmount()
      registry.dispose()
    })
  })

  it('skips the non-presented screen and releases invalidated reset provenance', async () => {
    Object.defineProperty(window, 'hvir', {
      configurable: true,
      value: {
        invoke: vi.fn(() => Promise.resolve(started())),
        send: vi.fn(),
        on: vi.fn(() => () => undefined),
      },
    })
    const registry = new TerminalRuntimeRegistry()
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    act(() => root.render(<TerminalView {...viewProps(registry)} />))
    await act(async () => {
      await vi.waitFor(() => expect(terminalState.instances).toHaveLength(1))
    })
    const state = terminalState.instances[0]!
    emitTranscript(state, 'normal', 10)
    act(() => {
      host
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Previous transcript region"]',
        )
        ?.click()
    })
    expect(host.querySelector('.terminal-semantic-region')?.textContent).toBe(
      'Output 3 of 3',
    )
    expect(state.scrolls).toEqual([36])

    state.screen = 'alternate'
    emitTranscript(state, 'alternate', 2, 100)

    act(() => {
      host
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Previous transcript region"]',
        )
        ?.click()
    })
    expect(host.querySelector('.terminal-semantic-region')?.textContent).toBe(
      'Output 3 of 3',
    )
    expect(state.scrolls).toEqual([36, 0])

    state.resolved.clear()
    act(() => {
      host
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Previous transcript region"]',
        )
        ?.click()
    })
    expect(host.querySelector('.terminal-semantic-navigation')).toBeNull()

    emitTranscript(state, 'alternate', 4, 200)
    act(() =>
      root.render(
        <TerminalView {...viewProps(registry)} connectionState="disconnected" />,
      ),
    )
    expect(state.disposed).toBe(true)
    expect(host.querySelector('.terminal-semantic-navigation')).toBeNull()
    act(() => root.render(<TerminalView {...viewProps(registry)} />))
    await act(async () => {
      await vi.waitFor(() => expect(terminalState.instances).toHaveLength(2))
    })
    expect(host.querySelector('.terminal-semantic-navigation')).toBeNull()

    act(() => {
      root.unmount()
      registry.dispose()
    })
    expect(terminalState.instances[1]?.disposed).toBe(true)
  })
})

function emitTranscript(
  state: (typeof terminalState.instances)[number],
  screen: 'normal' | 'alternate',
  row: number,
  firstId = 1,
): void {
  const actions = [
    'fresh-line-new-prompt',
    'end-prompt-start-input',
    'end-input-start-output',
    'end-command',
  ] as const
  act(() => {
    actions.forEach((action, index) => {
      const id = firstId + index
      state.resolved.add(id)
      state.emit({
        type: 'semantic',
        action,
        options: '',
        provenance: { id, screen, row: row + index * 2 },
      })
    })
  })
}

function viewProps(registry: TerminalRuntimeRegistry) {
  return {
    sessionId: 'terminal-1',
    profileId: asHarnessProfileId('shell'),
    launchRevision: 1,
    riskAcknowledged: false,
    supportsResume: false,
    fallbackTitle: 'Shell · repo',
    harnessSessionId: undefined,
    resumeOnStart: false,
    startMode: 'interactive' as const,
    position: 0,
    slot: 'primary' as const,
    presented: true,
    visible: true,
    active: true,
    modifiedKeyProtocol: 'none' as const,
    metaEnterAliasesControl: false,
    themeOverride: 'app' as const,
    typography: { fontFamily: 'monospace', fontSize: 13 },
    composerSubmitMode: 'enter' as const,
    cwd: localPath('/repo'),
    workspaceRoot: localPath('/repo'),
    runtimes: registry,
    connectionState: 'connected' as const,
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
    onSplit: vi.fn(),
    onOpenTerminalSettings: vi.fn(),
  }
}

function started() {
  return {
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
  }
}
