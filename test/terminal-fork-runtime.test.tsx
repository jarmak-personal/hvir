// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TerminalRuntimeRegistry } from '../src/renderer/src/terminal/terminal-runtime-registry'
import { TerminalView } from '../src/renderer/src/terminal/TerminalView'
import { ghosttyLifecycleRuntimeOptions as runtimeOptions } from './fixtures/ghostty-lifecycle-runtime-options'
import { ghosttyState } from './fixtures/ghostty-terminal-pane-mock'

vi.mock('ghostty-web', async () => {
  const { ghosttyWebMock } = await import('./fixtures/ghostty-terminal-pane-mock')
  return ghosttyWebMock
})

describe('terminal fork runtime', () => {
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

  it('starts a hidden sibling through the exact fork request without focusing it', async () => {
    let emitExit: ((event: { id: string; exitCode: number }) => void) | undefined
    const invoke = vi.fn(() =>
      Promise.resolve({
        outcome: 'started' as const,
        id: 'fork-child',
        instanceId: 'fork-instance',
        pid: 4321,
        resumed: false,
        reattached: false,
        harnessSessionId: '129ab123-4567-7890-abcd-ef0123456789',
        identityStatus: 'identified' as const,
        capabilities: {
          sessionIdentity: 'preassigned' as const,
          exactResume: true,
          exactFork: true as const,
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
          if (channel === 'pty:exit') emitExit = listener as typeof emitExit
          return () => undefined
        }),
      },
    })
    const registry = new TerminalRuntimeRegistry()
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const onIdentity = vi.fn()
    const onFocus = vi.fn()
    const onStartFailed = vi.fn()
    const launchOptions = runtimeOptions()
    act(() => {
      root.render(
        <TerminalView
          {...launchOptions}
          sessionId="fork-child"
          harnessSessionId={undefined}
          resumeOnStart={false}
          active={false}
          visible={false}
          slot="primary"
          forkRequest={{
            sourceSessionId: 'fork-source',
            parentHarnessSessionId: '019ab123-4567-7890-abcd-ef0123456789',
          }}
          themeOverride="app"
          runtimes={registry}
          onIdentity={onIdentity}
          onFocus={onFocus}
          onStartFailed={onStartFailed}
        />,
      )
    })

    await act(async () => {
      await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce())
    })

    expect(invoke).toHaveBeenCalledWith(
      'pty:start',
      expect.objectContaining({
        sessionId: 'fork-child',
        workspaceRoot: launchOptions.workspaceRoot,
        launchMode: 'fork',
        forkSourceSessionId: 'fork-source',
        parentHarnessSessionId: '019ab123-4567-7890-abcd-ef0123456789',
        resume: false,
        active: false,
      }),
    )
    expect(onIdentity).toHaveBeenCalledWith(
      '129ab123-4567-7890-abcd-ef0123456789',
      'identified',
    )
    expect(onFocus).not.toHaveBeenCalled()

    act(() => emitExit?.({ id: 'fork-child', exitCode: 1 }))
    expect(onStartFailed).toHaveBeenCalledWith(
      'The sibling terminal exited before its conversation was identified (1).',
    )

    act(() => {
      root.unmount()
      registry.dispose()
    })
  })

  it('reports a missing fork parent without presenting a resume recovery failure', async () => {
    const invoke = vi.fn(() =>
      Promise.resolve({
        outcome: 'fork-unavailable' as const,
        reason: 'parent-artifact-missing' as const,
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
    const onStatus = vi.fn()
    const onStartFailed = vi.fn()
    act(() => {
      root.render(
        <TerminalView
          {...runtimeOptions()}
          sessionId="fork-child"
          harnessSessionId={undefined}
          resumeOnStart={false}
          active={false}
          visible={false}
          slot="primary"
          forkRequest={{
            sourceSessionId: 'fork-source',
            parentHarnessSessionId: '019ab123-4567-7890-abcd-ef0123456789',
          }}
          themeOverride="app"
          runtimes={registry}
          onStatus={onStatus}
          onStartFailed={onStartFailed}
        />,
      )
    })

    await act(async () => {
      await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce())
    })

    const status = 'Fork unavailable · source conversation data is missing'
    expect(onStatus).toHaveBeenCalledWith(status)
    expect(onStartFailed).toHaveBeenCalledWith(status)
    expect(registry.sessionSnapshot('fork-child')).toEqual({
      title: 'Claude Code · repo',
      status,
      exited: true,
      recoveryFailure: undefined,
    })

    act(() => {
      root.unmount()
      registry.dispose()
    })
  })

  it('publishes later identity events through the current TerminalRuntime callback', async () => {
    let emitIdentity:
      | ((event: {
          id: string
          harnessSessionId?: string
          identityStatus: 'identified'
          identityDiverged?: true
        }) => void)
      | undefined
    const invoke = vi.fn(() =>
      Promise.resolve({
        outcome: 'started' as const,
        id: 'identity-current',
        instanceId: 'identity-instance',
        pid: 4321,
        resumed: false,
        reattached: false,
        harnessSessionId: '019ab123-4567-7890-abcd-ef0123456789',
        identityStatus: 'identified' as const,
        capabilities: runtimeOptions().capabilities,
      }),
    )
    Object.defineProperty(window, 'hvir', {
      configurable: true,
      value: {
        invoke,
        send: vi.fn(),
        on: vi.fn((channel: string, listener: unknown) => {
          if (channel === 'pty:identity') emitIdentity = listener as typeof emitIdentity
          return () => undefined
        }),
      },
    })
    const registry = new TerminalRuntimeRegistry()
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const staleIdentity = vi.fn()
    const currentIdentity = vi.fn()
    const view = (onIdentity: typeof staleIdentity) => (
      <TerminalView
        {...runtimeOptions()}
        sessionId="identity-current"
        resumeOnStart={false}
        visible
        slot="primary"
        themeOverride="app"
        runtimes={registry}
        onIdentity={onIdentity}
      />
    )

    act(() => root.render(view(staleIdentity)))
    await act(async () => {
      await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce())
    })
    staleIdentity.mockClear()
    act(() => root.render(view(currentIdentity)))
    act(() =>
      emitIdentity?.({
        id: 'identity-current',
        harnessSessionId: '129ab123-4567-7890-abcd-ef0123456789',
        identityStatus: 'identified',
        identityDiverged: true,
      }),
    )

    expect(staleIdentity).not.toHaveBeenCalled()
    expect(currentIdentity).toHaveBeenCalledWith(
      '129ab123-4567-7890-abcd-ef0123456789',
      'identified',
      true,
    )

    act(() => {
      root.unmount()
      registry.dispose()
    })
  })
})
