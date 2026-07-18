import { describe, expect, it, vi } from 'vitest'

import { subscribeProjectSessionEvents } from '../src/renderer/src/workspaces/project-session-events'
import {
  initialProjectSessionModel,
  projectSessionReducer,
  selectActiveProject,
  selectActiveWorkspace,
  selectRelativeWorkspace,
} from '../src/renderer/src/workspaces/project-session-model'
import {
  asHostId,
  hostPath,
  type HvirApi,
  type ProjectState,
  type SshPromptRequest,
} from '../src/shared'

describe('project session model', () => {
  it('ignores stale transition completions and failures', () => {
    const first = projectSessionReducer(initialProjectSessionModel, {
      type: 'transition-started',
      generation: 1,
    })
    const second = projectSessionReducer(first, {
      type: 'transition-started',
      generation: 2,
    })

    expect(
      projectSessionReducer(second, {
        type: 'transition-project',
        generation: 1,
        state: projectState('stale'),
      }),
    ).toBe(second)
    expect(
      projectSessionReducer(second, {
        type: 'transition-connection',
        generation: 1,
        connectionState: 'failed',
      }),
    ).toBe(second)
    expect(
      projectSessionReducer(second, {
        type: 'transition-failed',
        generation: 1,
        error: 'stale error',
      }),
    ).toBe(second)

    const applied = projectSessionReducer(second, {
      type: 'transition-project',
      generation: 2,
      state: projectState('current'),
    })
    expect(applied.projectState?.activeWorkspaceId).toBe('current')
    expect(
      projectSessionReducer(applied, {
        type: 'transition-finished',
        generation: 2,
      }).busy,
    ).toBe(false)
  })

  it('selects host-qualified active identity and skips missing workspaces', () => {
    const state = projectSessionReducer(initialProjectSessionModel, {
      type: 'project-state',
      state: projectState(workspaceId('remote')),
    })

    expect(selectActiveProject(state)?.registeredRoot).toEqual(
      hostPath(asHostId('ssh:ship'), '/repo'),
    )
    expect(selectActiveWorkspace(state)?.root).toEqual(
      hostPath(asHostId('ssh:ship'), '/repo/remote'),
    )
    expect(selectRelativeWorkspace(state, 1)).toEqual({
      projectId: projectId(),
      workspaceId: workspaceId('local'),
    })
    expect(selectRelativeWorkspace(state, -1)).toEqual({
      projectId: projectId(),
      workspaceId: workspaceId('local'),
    })
  })

  it('preserves the active root identity across same-workspace metadata updates', () => {
    const first = projectSessionReducer(initialProjectSessionModel, {
      type: 'project-state',
      state: projectState(workspaceId('local')),
    })
    const second = projectSessionReducer(first, {
      type: 'project-state',
      state: projectState(workspaceId('local')),
    })

    expect(second.projectState?.root).toBe(first.projectState?.root)
  })

  it('deduplicates prompt leases and clears the disconnected host only', () => {
    const first = prompt(1, 'ssh:ship')
    const second = prompt(2, 'ssh:other')
    let state = projectSessionReducer(initialProjectSessionModel, {
      type: 'prompt-received',
      prompt: first,
    })
    state = projectSessionReducer(state, { type: 'prompt-received', prompt: first })
    state = projectSessionReducer(state, { type: 'prompt-received', prompt: second })
    expect(state.prompts).toHaveLength(2)

    state = projectSessionReducer(state, {
      type: 'prompts-cancelled',
      hostId: 'ssh:ship',
    })
    expect(state.prompts).toEqual([second])
  })

  it('owns all renderer subscriptions as one idempotent lease', () => {
    const disposed: string[] = []
    const on = vi.fn((channel: string) => () => disposed.push(channel))
    const stop = subscribeProjectSessionEvents({ on } as unknown as Pick<HvirApi, 'on'>, {
      onWatch: vi.fn(),
      onState: vi.fn(),
      onPrompt: vi.fn(),
      onPromptCancel: vi.fn(),
    })

    expect(on.mock.calls.map(([channel]) => channel)).toEqual([
      'project:watch',
      'project:state',
      'ssh:prompt',
      'ssh:prompt-cancel',
    ])
    stop()
    stop()
    expect(disposed).toEqual([
      'project:watch',
      'project:state',
      'ssh:prompt',
      'ssh:prompt-cancel',
    ])
  })
})

function projectState(activeWorkspaceId: string): ProjectState {
  const hostId = asHostId('ssh:ship')
  const registeredRoot = hostPath(hostId, '/repo')
  return {
    root: hostPath(hostId, `/repo/${activeWorkspaceId}`),
    activeProjectId: projectId(),
    activeWorkspaceId,
    connectionState: 'connected',
    watchTier: 'polling',
    projects: [
      {
        id: projectId(),
        displayName: 'repo',
        registeredRoot,
        connectionState: 'connected',
        watchTier: 'polling',
        activeWorkspaceId,
        workspaces: [
          {
            id: workspaceId('local'),
            name: 'local',
            root: hostPath(hostId, '/repo/local'),
            main: true,
            repository: true,
            missing: false,
            changedFiles: 0,
          },
          {
            id: workspaceId('missing'),
            name: 'missing',
            root: hostPath(hostId, '/repo/missing'),
            main: false,
            repository: true,
            missing: true,
            prunableReason: 'administrative record is stale',
            changedFiles: 0,
          },
          {
            id: workspaceId('remote'),
            name: 'remote',
            root: hostPath(hostId, '/repo/remote'),
            main: false,
            repository: true,
            missing: false,
            changedFiles: 0,
          },
        ],
      },
    ],
  }
}

function projectId(): string {
  return 'project:ssh:ship:/repo'
}

function workspaceId(name: string): string {
  return `workspace:ssh:ship:/repo/${name}`
}

function prompt(id: number, hostId: string): SshPromptRequest {
  return {
    id,
    hostId,
    kind: 'password',
    title: 'Authenticate',
    prompts: [{ text: 'Password', echo: false }],
  }
}
