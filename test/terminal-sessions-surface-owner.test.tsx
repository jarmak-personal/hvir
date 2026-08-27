// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'

import { TerminalRuntimeRegistry } from '../src/renderer/src/terminal/terminal-runtime-registry'
import {
  asSessionsPtyHandle,
  asSessionsTerminalHandle,
  asSessionsWorkspaceRuntimeId,
  sessionsWorkspaceQualifier,
} from '../src/shared'
import { ghosttyLifecycleRuntimeOptions } from './fixtures/ghostty-lifecycle-runtime-options'
import { ghosttyState } from './fixtures/ghostty-terminal-pane-mock'

vi.mock('ghostty-web', async () => {
  const { ghosttyWebMock } = await import('./fixtures/ghostty-terminal-pane-mock')
  return ghosttyWebMock
})

describe('TerminalSessionsSurfaceOwner', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    Reflect.deleteProperty(window, 'hvir')
    document.body.replaceChildren()
    ghosttyState.instances.splice(0)
  })

  it('retains the exact surface, focus, and input owner across a global workspace qualifier revision', async () => {
    vi.useFakeTimers()
    const send = vi.fn()
    Object.defineProperty(window, 'hvir', {
      configurable: true,
      value: {
        invoke: vi.fn(() =>
          Promise.resolve({
            outcome: 'started' as const,
            id: 'terminal-1',
            instanceId: 'instance-1',
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
        ),
        send,
        on: vi.fn(() => () => undefined),
      },
    })
    const registry = new TerminalRuntimeRegistry()
    const options = ghosttyLifecycleRuntimeOptions()
    const runtime = registry.acquire(options)
    const workspace = document.createElement('div')
    const detail = document.createElement('div')
    document.body.append(workspace, detail)
    runtime.attach(workspace)
    await vi.runAllTimersAsync()
    await Promise.resolve()
    const surface = workspace.querySelector('.terminal-engine-host')
    const lease = registry.acquireSessionsSurface({
      handle: asSessionsTerminalHandle('terminal-1'),
      workspaceQualifier: sessionsWorkspaceQualifier(1, 0, 0),
      workspaceRuntimeId: asSessionsWorkspaceRuntimeId('workspace-runtime'),
      livePty: {
        handle: asSessionsPtyHandle('instance-1'),
        rendererOwnerId: 7,
        rendererGeneration: 2,
      },
      demandGeneration: 1,
      projectionRevision: 4,
      sourceRevision: 8,
    })
    expect(lease?.attach(detail)).toBe(true)
    expect(lease?.focus(detail)).toBe(true)
    send.mockClear()
    vi.mocked(options.onFocus).mockClear()

    expect(
      lease?.renew({
        handle: asSessionsTerminalHandle('terminal-1'),
        workspaceQualifier: sessionsWorkspaceQualifier(2, 1, 0),
        workspaceRuntimeId: asSessionsWorkspaceRuntimeId('workspace-runtime'),
        livePty: {
          handle: asSessionsPtyHandle('instance-1'),
          rendererOwnerId: 7,
          rendererGeneration: 2,
        },
        demandGeneration: 1,
        projectionRevision: 5,
        sourceRevision: 9,
      }),
    ).toBe(true)
    expect(
      lease?.renew({
        handle: asSessionsTerminalHandle('terminal-1'),
        workspaceQualifier: sessionsWorkspaceQualifier(2, 1, 0),
        workspaceRuntimeId: asSessionsWorkspaceRuntimeId('workspace-replaced'),
        livePty: {
          handle: asSessionsPtyHandle('instance-1'),
          rendererOwnerId: 7,
          rendererGeneration: 2,
        },
        demandGeneration: 1,
        projectionRevision: 6,
        sourceRevision: 10,
      }),
    ).toBe(false)
    expect(detail.querySelector('.terminal-engine-host')).toBe(surface)
    expect(options.onFocus).not.toHaveBeenCalled()
    ghosttyState.instances[0]!.emitData('input after unrelated revision')
    expect(send).toHaveBeenCalledExactlyOnceWith('pty:write', {
      id: 'terminal-1',
      data: 'input after unrelated revision',
    })
    registry.dispose()
  })
})
