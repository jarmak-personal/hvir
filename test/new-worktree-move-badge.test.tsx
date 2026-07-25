// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  NEW_WORKTREE_MOVE_BADGE_DURATION_MS,
  useNewWorktreeMoveBadge,
} from '../src/renderer/src/terminal/use-new-worktree-move-badge'
import { localPath, type ProjectState } from '../src/shared'

let host: HTMLDivElement
let root: Root
let mounted: boolean

beforeEach(() => {
  vi.useFakeTimers()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  mounted = true
})

afterEach(() => {
  if (mounted) act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('new-worktree move badge', () => {
  it('acknowledges each target 20 seconds after it becomes newly discovered', async () => {
    const acknowledgeWorkspaces = vi.fn(() => Promise.resolve())
    renderBadgeLease(projectState(['feature']), acknowledgeWorkspaces)

    act(() => {
      vi.advanceTimersByTime(NEW_WORKTREE_MOVE_BADGE_DURATION_MS - 1)
    })
    expect(acknowledgeWorkspaces).not.toHaveBeenCalled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(acknowledgeWorkspaces).toHaveBeenCalledWith('project:local:/repo', [
      'workspace:local:/repo/feature',
    ])
  })

  it('gives later targets their own full badge lifetime', async () => {
    const acknowledgeWorkspaces = vi.fn(() => Promise.resolve())
    renderBadgeLease(projectState(['feature']), acknowledgeWorkspaces)

    act(() => {
      vi.advanceTimersByTime(10_000)
    })
    renderBadgeLease(projectState(['feature', 'later']), acknowledgeWorkspaces)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(acknowledgeWorkspaces).toHaveBeenCalledTimes(1)
    expect(acknowledgeWorkspaces).toHaveBeenLastCalledWith('project:local:/repo', [
      'workspace:local:/repo/feature',
    ])

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(acknowledgeWorkspaces).toHaveBeenCalledTimes(2)
    expect(acknowledgeWorkspaces).toHaveBeenLastCalledWith('project:local:/repo', [
      'workspace:local:/repo/later',
    ])
  })

  it('revokes pending dismissal when a target clears or the owner unmounts', () => {
    const acknowledgeWorkspaces = vi.fn(() => Promise.resolve())
    renderBadgeLease(projectState(['feature']), acknowledgeWorkspaces)
    renderBadgeLease(projectState([]), acknowledgeWorkspaces)

    act(() => {
      vi.advanceTimersByTime(NEW_WORKTREE_MOVE_BADGE_DURATION_MS)
    })
    expect(acknowledgeWorkspaces).not.toHaveBeenCalled()

    renderBadgeLease(projectState(['later']), acknowledgeWorkspaces)
    act(() => {
      root.unmount()
      mounted = false
      vi.advanceTimersByTime(NEW_WORKTREE_MOVE_BADGE_DURATION_MS)
    })
    expect(acknowledgeWorkspaces).not.toHaveBeenCalled()
  })
})

function renderBadgeLease(
  state: ProjectState,
  acknowledgeWorkspaces: (
    projectId: string,
    workspaceIds: readonly string[],
  ) => Promise<void>,
): void {
  act(() => {
    root.render(
      <BadgeLeaseProbe state={state} acknowledgeWorkspaces={acknowledgeWorkspaces} />,
    )
  })
}

function BadgeLeaseProbe({
  state,
  acknowledgeWorkspaces,
}: {
  readonly state: ProjectState
  readonly acknowledgeWorkspaces: (
    projectId: string,
    workspaceIds: readonly string[],
  ) => Promise<void>
}) {
  useNewWorktreeMoveBadge({
    projectState: state,
    acknowledgeWorkspaces,
    onError: (message) => {
      throw new Error(message)
    },
  })
  return null
}

function projectState(newWorkspaceNames: readonly string[]): ProjectState {
  const main = {
    id: 'workspace:local:/repo',
    root: localPath('/repo'),
    name: 'main',
    branch: 'main',
    main: true,
    missing: false,
    repository: true,
    changedFiles: 0,
  }
  const workspaces = newWorkspaceNames.map((name) => ({
    id: `workspace:local:/repo/${name}`,
    root: localPath(`/repo/${name}`),
    name,
    branch: name,
    main: false,
    missing: false,
    repository: true,
    changedFiles: 0,
    newlyDiscovered: true,
  }))
  return {
    root: main.root,
    activeProjectId: 'project:local:/repo',
    activeWorkspaceId: main.id,
    connectionState: 'connected',
    watchTier: 'native',
    projects: [
      {
        id: 'project:local:/repo',
        displayName: 'repo',
        registeredRoot: main.root,
        connectionState: 'connected',
        watchTier: 'native',
        activeWorkspaceId: main.id,
        workspaces: [main, ...workspaces],
      },
    ],
  }
}
