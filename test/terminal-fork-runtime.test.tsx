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
})
