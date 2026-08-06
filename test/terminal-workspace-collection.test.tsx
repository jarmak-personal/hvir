// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'

import { TerminalWorkspaceCollection } from '../src/renderer/src/terminal/TerminalWorkspaceCollection'
import { localPath, type ProjectState } from '../src/shared'

const workspaceRender = vi.hoisted(() => vi.fn())

vi.mock('../src/renderer/src/terminal/TerminalWorkspace', () => ({
  TerminalWorkspace: ({
    workspaceId,
    visible,
  }: {
    readonly workspaceId: string
    readonly visible: boolean
  }) => {
    workspaceRender(workspaceId)
    return <div data-mounted-workspace={workspaceId} data-visible={String(visible)} />
  },
}))

describe('terminal workspace collection', () => {
  it('mounts no renderer terminal runtime for 20 closed worktrees', () => {
    const host = document.createElement('div')
    const root = createRoot(host)
    const state = projectStateWithClosedWorktrees(20)

    act(() => {
      root.render(
        <TerminalWorkspaceCollection
          state={state}
          runtime={{ moveProps: vi.fn(() => ({})) } as never}
          railCompact={false}
          onRailCompact={vi.fn()}
          onRollup={vi.fn()}
          onOpenPath={vi.fn()}
          onOpenWebLink={vi.fn()}
          preferences={{
            terminalTheme: 'app',
            terminalLightThemeId: 'hvir-default-light',
            terminalDarkThemeId: 'hvir-default-dark',
            terminalTypography: { fontFamily: 'monospace', fontSize: 13 },
            terminalCursorDefaults: { shape: 'block', blink: 'terminal' },
            terminalLigatures: true,
            composerSubmitMode: 'enter',
            idleThresholdMs: 10_000,
            terminalRecoveryMode: 'prompt',
          }}
          onOpenSettings={vi.fn()}
          onOpenTerminalSettings={vi.fn()}
          onOpenHarnessSettings={vi.fn()}
          onAddHarness={vi.fn()}
        />,
      )
    })

    expect(host.querySelectorAll('[data-mounted-workspace]')).toHaveLength(1)
    expect(host.querySelector('[data-mounted-workspace="workspace-open"]')).not.toBeNull()
    act(() => root.unmount())
  })

  it('materializes only the selected workspace as an open catalog grows', () => {
    const host = document.createElement('div')
    const root = createRoot(host)
    const state = projectStateWithOpenWorktrees(100)

    act(() => {
      root.render(collection({ state, materializedWorkspaceIds: [] }))
    })

    expect(host.querySelectorAll('[data-mounted-workspace]')).toHaveLength(1)
    expect(host.querySelector('[data-mounted-workspace="workspace-open"]')).not.toBeNull()
    act(() => root.unmount())
  })

  it('bounds unrelated catalog refresh renders by materialized ownership', () => {
    const host = document.createElement('div')
    const root = createRoot(host)
    const state = projectStateWithOpenWorktrees(100)
    workspaceRender.mockClear()

    act(() => {
      root.render(collection({ state, materializedWorkspaceIds: [] }))
    })
    const refreshed: ProjectState = {
      ...state,
      projects: state.projects.map((project) => ({
        ...project,
        workspaces: project.workspaces.map((workspace) => ({
          ...workspace,
          changedFiles: workspace.changedFiles + 1,
        })),
      })),
    }
    act(() => {
      root.render(collection({ state: refreshed, materializedWorkspaceIds: [] }))
    })

    expect(workspaceRender).toHaveBeenCalledTimes(2)
    expect(workspaceRender).toHaveBeenNthCalledWith(1, 'workspace-open')
    expect(workspaceRender).toHaveBeenNthCalledWith(2, 'workspace-open')
    act(() => root.unmount())
  })

  it('revokes an obsolete empty owner while retaining a live background owner', () => {
    const host = document.createElement('div')
    const root = createRoot(host)
    const initial = projectStateWithOpenWorktrees(2)
    const nextActiveId = 'workspace-open-0'
    const switched: ProjectState = {
      ...initial,
      activeWorkspaceId: nextActiveId,
      projects: initial.projects.map((project) => ({
        ...project,
        activeWorkspaceId: nextActiveId,
      })),
    }

    act(() => {
      root.render(collection({ state: initial, materializedWorkspaceIds: [] }))
    })
    expect(host.querySelectorAll('[data-mounted-workspace]')).toHaveLength(1)

    act(() => {
      root.render(collection({ state: switched, materializedWorkspaceIds: [] }))
    })
    expect(host.querySelectorAll('[data-mounted-workspace]')).toHaveLength(1)
    expect(host.querySelector('[data-mounted-workspace="workspace-open"]')).toBeNull()

    act(() => {
      root.render(
        collection({
          state: switched,
          materializedWorkspaceIds: ['workspace-open'],
        }),
      )
    })
    expect(host.querySelectorAll('[data-mounted-workspace]')).toHaveLength(2)
    expect(
      host
        .querySelector('[data-mounted-workspace="workspace-open"]')
        ?.getAttribute('data-visible'),
    ).toBe('false')
    expect(
      host
        .querySelector(`[data-mounted-workspace="${nextActiveId}"]`)
        ?.getAttribute('data-visible'),
    ).toBe('true')
    act(() => root.unmount())
  })
})

function collection({
  state,
  materializedWorkspaceIds,
}: {
  readonly state: ProjectState
  readonly materializedWorkspaceIds: readonly string[]
}) {
  return (
    <TerminalWorkspaceCollection
      state={state}
      runtime={{ materializedWorkspaceIds, moveProps: vi.fn(() => ({})) } as never}
      railCompact={false}
      onRailCompact={vi.fn()}
      onRollup={vi.fn()}
      onOpenPath={vi.fn()}
      onOpenWebLink={vi.fn()}
      preferences={{
        terminalTheme: 'app',
        terminalLightThemeId: 'hvir-default-light',
        terminalDarkThemeId: 'hvir-default-dark',
        terminalTypography: { fontFamily: 'monospace', fontSize: 13 },
        terminalCursorDefaults: { shape: 'block', blink: 'terminal' },
        terminalLigatures: true,
        composerSubmitMode: 'enter',
        idleThresholdMs: 10_000,
        terminalRecoveryMode: 'prompt',
      }}
      onOpenSettings={vi.fn()}
      onOpenTerminalSettings={vi.fn()}
      onOpenHarnessSettings={vi.fn()}
      onAddHarness={vi.fn()}
    />
  )
}

function projectStateWithClosedWorktrees(count: number): ProjectState {
  const root = localPath('/repo')
  const open = {
    id: 'workspace-open',
    root,
    name: 'main',
    main: true,
    closed: false,
    missing: false,
    repository: true,
    changedFiles: 0,
  }
  return {
    revision: 0,
    root,
    activeProjectId: 'project',
    activeWorkspaceId: open.id,
    connectionState: 'connected',
    watchTier: 'native',
    projects: [
      {
        id: 'project',
        registeredRoot: root,
        displayName: 'repo',
        connectionState: 'connected',
        watchTier: 'native',
        activeWorkspaceId: open.id,
        workspaces: [
          open,
          ...Array.from({ length: count }, (_, index) => ({
            ...open,
            id: `workspace-closed-${index}`,
            root: localPath(`/repo/closed-${index}`),
            name: `closed-${index}`,
            main: false,
            closed: true,
          })),
        ],
      },
    ],
  }
}

function projectStateWithOpenWorktrees(count: number): ProjectState {
  const state = projectStateWithClosedWorktrees(0)
  const open = state.projects[0]!.workspaces[0]!
  return {
    ...state,
    projects: [
      {
        ...state.projects[0]!,
        workspaces: [
          open,
          ...Array.from({ length: count }, (_, index) => ({
            ...open,
            id: `workspace-open-${index}`,
            root: localPath(`/repo/open-${index}`),
            name: `open-${index}`,
            main: false,
          })),
        ],
      },
    ],
  }
}
