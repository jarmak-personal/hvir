// @vitest-environment happy-dom

import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useTerminalWorkspaceRuntime } from '../src/renderer/src/terminal/use-terminal-workspace-runtime'
import {
  asSessionsPtyHandle,
  asSessionsTerminalHandle,
  asSessionsWorkspaceRuntimeId,
  localPath,
  type ProjectState,
} from '../src/shared'
import { ghosttyLifecycleRuntimeOptions } from './fixtures/ghostty-lifecycle-runtime-options'
import { ghosttyState } from './fixtures/ghostty-terminal-pane-mock'

vi.mock('ghostty-web', async () => {
  const { ghosttyWebMock } = await import('./fixtures/ghostty-terminal-pane-mock')
  return ghosttyWebMock
})

const workspaceRoot = localPath('/repo')
const projectState: ProjectState = {
  revision: 1,
  root: workspaceRoot,
  connectionState: 'connected',
  watchTier: 'native',
  activeProjectId: 'project-a',
  activeWorkspaceId: 'workspace-a',
  projects: [
    {
      id: 'project-a',
      registeredRoot: workspaceRoot,
      displayName: 'repo',
      connectionState: 'connected',
      watchTier: 'native',
      activeWorkspaceId: 'workspace-a',
      workspaces: [
        {
          id: 'workspace-a',
          root: workspaceRoot,
          name: 'main',
          branch: 'main',
          main: true,
          closed: false,
          missing: false,
          repository: true,
          changedFiles: 0,
        },
      ],
    },
  ],
}

let host: HTMLDivElement
let reactRoot: Root
let current!: ReturnType<typeof useTerminalWorkspaceRuntime>

describe('useTerminalWorkspaceRuntime', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
        disconnect(): void {}
      },
    )
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
        send: vi.fn(),
        on: vi.fn(() => () => undefined),
      },
    })
    ghosttyState.instances.splice(0)
    host = document.createElement('div')
    document.body.append(host)
    reactRoot = createRoot(host)
  })

  afterEach(() => {
    act(() => reactRoot.unmount())
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    Reflect.deleteProperty(window, 'hvir')
    document.body.replaceChildren()
  })

  it('keeps its window-scoped terminal owner live through StrictMode effect replay', async () => {
    act(() =>
      reactRoot.render(
        <StrictMode>
          <Harness />
        </StrictMode>,
      ),
    )

    const project = projectState.projects[0]!
    const workspace = project.workspaces[0]!
    const terminal = current
      .moveProps(project, workspace)
      .runtimes.acquire(ghosttyLifecycleRuntimeOptions())
    const workspaceSurface = document.createElement('div')
    document.body.append(workspaceSurface)
    terminal.attach(workspaceSurface)
    await act(async () => {
      await vi.runAllTimersAsync()
      await Promise.resolve()
    })

    const request = {
      handle: asSessionsTerminalHandle('terminal-1'),
      workspaceRuntimeId: asSessionsWorkspaceRuntimeId('workspace-a'),
      livePty: {
        handle: asSessionsPtyHandle('instance-1'),
        rendererOwnerId: 8,
        rendererGeneration: 3,
      },
      demandGeneration: 1,
      projectionRevision: 2,
      sourceRevision: 3,
    }
    const acquisition = current.sessionsSurface.acquire(request)

    expect(acquisition.outcome).toBe('acquired')
    if (acquisition.outcome !== 'acquired') throw new Error('Expected surface lease')
    acquisition.lease.release()

    window.dispatchEvent(new Event('pagehide'))
    expect(current.sessionsSurface.acquire(request)).toEqual({
      outcome: 'unavailable',
      reason: 'runtime-not-ready',
    })
  })
})

function Harness(): null {
  current = useTerminalWorkspaceRuntime({
    projectState,
    acceptProjectState: vi.fn(),
    forgetWebViews: vi.fn(),
    acknowledgeWorkspaces: vi.fn(() => Promise.resolve()),
    onError: vi.fn(),
  })
  return null
}
