// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createGhosttyTerminalPane } from '../src/renderer/src/terminal/ghostty-terminal-pane'
import { TerminalView } from '../src/renderer/src/terminal/TerminalView'
import {
  TerminalRuntimeRegistry,
  type TerminalRuntimeOptions,
} from '../src/renderer/src/terminal/terminal-runtime'
import { asHarnessProfileId, localPath } from '../src/shared'

vi.mock('ghostty-web', () => {
  class MockTerminal {
    readonly options: { theme?: unknown }
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

    constructor(options: { theme?: unknown }) {
      this.options = options
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
        render: () => undefined,
        setTheme: () => undefined,
      }
    }

    registerLinkProvider(): void {}

    write(): void {}

    resize(cols: number, rows: number): void {
      this.cols = cols
      this.rows = rows
    }

    focus(): void {}

    dispose(): void {
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
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
        disconnect(): void {}
      },
    )
  })

  afterEach(() => {
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
    expect(host.querySelector('.terminal-restart')?.textContent).toBe('Resume')
    const container = host.querySelector('.terminal-container')
    const firstSurface = container?.querySelector('.terminal-engine-host')

    await act(async () => {
      host.querySelector<HTMLButtonElement>('.terminal-restart')?.click()
      await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2))
      await Promise.resolve()
    })
    expect(host.querySelector('.terminal-restart')?.textContent).toBe('Resume')
    expect(container?.isConnected).toBe(true)
    expect(host.querySelector('.terminal-container')).toBe(container)
    expect(container?.querySelector('.terminal-engine-host')).not.toBe(firstSurface)

    act(() => {
      root.unmount()
      registry.dispose()
    })
    Reflect.deleteProperty(window, 'hvir')
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
    onCapabilities: vi.fn(),
    onInput: vi.fn(),
    onOutput: vi.fn(),
    onBell: vi.fn(),
    onFocus: vi.fn(),
    onLink: vi.fn(),
  }
}
