// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useProjectSession } from '../src/renderer/src/workspaces/project-session'
import {
  asHostId,
  hostPath,
  localPath,
  type HostPath,
  type ProjectState,
} from '../src/shared'

let host: HTMLDivElement
let reactRoot: Root
let session: ReturnType<typeof useProjectSession>
let handlers: Map<string, (payload: unknown) => void>
let invoke: ReturnType<typeof createInvokeMock>
let mounted: boolean

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div')
  document.body.append(host)
  reactRoot = createRoot(host)
  handlers = new Map()
  invoke = createInvokeMock()
  mounted = true
  Object.defineProperty(window, 'hvir', {
    configurable: true,
    value: {
      invoke,
      on: vi.fn((channel: string, handler: (payload: unknown) => void) => {
        handlers.set(channel, handler)
        return () => {
          if (handlers.get(channel) === handler) handlers.delete(channel)
        }
      }),
      send: vi.fn(),
    },
  })
})

afterEach(() => {
  if (mounted) act(() => reactRoot.unmount())
  host.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('project session state delivery', () => {
  it.each([
    ['local native-watch', localPath('/repo/.git/index')],
    ['SSH polling', hostPath(asHostId('ssh-session'), '/repo/.git/index')],
  ])('classifies %s Git metadata events identically', async (_source, path) => {
    vi.useFakeTimers()
    try {
      const initial = projectState(0, 'workspace-main')
      invoke.mockImplementation((channel: string) => {
        if (channel === 'project:root') return Promise.resolve(initial)
        if (channel === 'harness:configure-composer-submit') {
          return Promise.resolve(undefined)
        }
        return Promise.reject(new Error(`Unexpected IPC channel: ${channel}`))
      })

      await act(async () => {
        reactRoot.render(<ProjectSessionHarness onProjectState={vi.fn()} />)
        await Promise.resolve()
        await Promise.resolve()
      })
      const before = session.versions

      act(() => {
        handlers.get('project:watch')?.(gitMetadataChange(path))
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(250)
      })

      expect(session.versions).toEqual({
        watch: before.watch + 1,
        ignored: before.ignored,
        content: before.content + 1,
        git: before.git + 1,
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it.each(['event-first', 'response-first'] as const)(
    'fans a switch state out once with %s delivery',
    async (arrivalOrder) => {
      const initial = projectState(0, 'workspace-main')
      const switched = projectState(1, 'workspace-feature')
      const onProjectState = vi.fn()
      invoke.mockImplementation((channel: string) => {
        if (channel === 'project:root') return Promise.resolve(initial)
        if (channel === 'harness:configure-composer-submit') {
          return Promise.resolve(undefined)
        }
        if (channel === 'project:switch') {
          if (arrivalOrder === 'event-first') {
            handlers.get('project:state')?.(switched)
          }
          return Promise.resolve({ ok: true, value: switched })
        }
        return Promise.reject(new Error(`Unexpected IPC channel: ${channel}`))
      })

      await act(async () => {
        reactRoot.render(<ProjectSessionHarness onProjectState={onProjectState} />)
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(session.projectState).toEqual(initial)
      onProjectState.mockClear()

      await act(async () => {
        await session.switchWorkspace('project-local', 'workspace-feature')
      })
      if (arrivalOrder === 'response-first') {
        act(() => handlers.get('project:state')?.(switched))
      }

      expect(session.projectState).toEqual(switched)
      expect(onProjectState).toHaveBeenCalledOnce()
      expect(onProjectState).toHaveBeenCalledWith(switched)
    },
  )

  it('rejects a queued state callback after the session lease closes', async () => {
    const initial = projectState(0, 'workspace-main')
    const onProjectState = vi.fn()
    invoke.mockImplementation((channel: string) => {
      if (channel === 'project:root') return Promise.resolve(initial)
      if (channel === 'harness:configure-composer-submit') {
        return Promise.resolve(undefined)
      }
      return Promise.reject(new Error(`Unexpected IPC channel: ${channel}`))
    })

    await act(async () => {
      reactRoot.render(<ProjectSessionHarness onProjectState={onProjectState} />)
      await Promise.resolve()
      await Promise.resolve()
    })
    const queuedStateHandler = handlers.get('project:state')
    expect(queuedStateHandler).toBeDefined()
    onProjectState.mockClear()

    act(() => reactRoot.unmount())
    mounted = false
    queuedStateHandler?.(projectState(1, 'workspace-feature'))

    expect(onProjectState).not.toHaveBeenCalled()
  })
})

function ProjectSessionHarness({
  onProjectState,
}: {
  readonly onProjectState: (state: ProjectState) => void
}): null {
  session = useProjectSession({
    composerSubmitMode: 'enter',
    onProjectState,
    onReloadFiles: vi.fn(),
    onWatchEvent: vi.fn(),
    isIgnoreRulePath: () => false,
  })
  return null
}

function createInvokeMock() {
  return vi.fn((_channel: string, _request?: unknown): Promise<unknown> =>
    Promise.resolve(undefined),
  )
}

function gitMetadataChange(path: HostPath) {
  return { type: 'change' as const, path }
}

function projectState(revision: number, activeWorkspaceId: string): ProjectState {
  const root = localPath(
    activeWorkspaceId === 'workspace-main' ? '/repo' : '/repo-feature',
  )
  return {
    revision,
    root,
    connectionState: 'connected',
    watchTier: 'native',
    activeProjectId: 'project-local',
    activeWorkspaceId,
    projects: [
      {
        id: 'project-local',
        registeredRoot: localPath('/repo'),
        displayName: 'repo',
        connectionState: 'connected',
        watchTier: 'native',
        activeWorkspaceId,
        workspaces: [
          {
            id: 'workspace-main',
            root: localPath('/repo'),
            name: 'main',
            main: true,
            closed: false,
            missing: false,
            repository: true,
            changedFiles: 0,
          },
          {
            id: 'workspace-feature',
            root: localPath('/repo-feature'),
            name: 'feature',
            main: false,
            closed: false,
            missing: false,
            repository: true,
            changedFiles: 0,
          },
        ],
      },
    ],
  }
}
