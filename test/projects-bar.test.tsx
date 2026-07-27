// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ProjectsBar } from '../src/renderer/src/workspaces/ProjectsBar'
import {
  asHostId,
  hostPath,
  localPath,
  type HostConnectionState,
  type ProjectState,
} from '../src/shared'

vi.mock('../src/renderer/src/health/WorkbenchHealthControl', () => ({
  WorkbenchHealthControl: () => null,
}))

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
})

describe('ProjectsBar status presentation', () => {
  it('omits Git change counts while keeping actionable attention', () => {
    renderProjectsBar(projectState(2, 3), {
      'workspace:local:/repo': { actionable: 1 },
      'workspace:local:/repo/feature': { actionable: 1 },
    })

    const projectTab = host.querySelector('.project-tab')
    const projectAttention = projectTab?.querySelector('.terminal-attention-count')
    expect(projectTab?.querySelector('.project-change-count')).toBeNull()
    expect(projectTab?.querySelector('.remote-connection-badge')).toBeNull()
    expect(projectAttention?.textContent).toBe('!2')
    expect(projectAttention?.getAttribute('aria-label')).toBe(
      '2 terminals needing attention',
    )

    const workspaceTabs = [...host.querySelectorAll('.workspace-tab')]
    expect(workspaceTabs).toHaveLength(2)
    expect(
      workspaceTabs.every((tab) => !tab.querySelector('.workspace-change-count')),
    ).toBe(true)
    expect(
      workspaceTabs.map(
        (tab) => tab.querySelector('.terminal-attention-count')?.textContent,
      ),
    ).toEqual(['!1', '!1'])
    expect(host.textContent).not.toContain('Δ')
  })

  it('keeps SSH project badges compact while preserving connection details and controls', () => {
    renderProjectsBar(
      remoteProjectState([
        'connected',
        'connecting',
        'reconnecting',
        'failed',
        'disconnected',
      ]),
      {},
    )

    const badges = [...host.querySelectorAll('.remote-connection-badge')]
    expect(
      badges.map((badge) => badge.querySelector('.remote-connection-host')?.textContent),
    ).toEqual(['ssh', 'ssh', 'ssh', 'ssh', 'ssh'])
    expect(
      badges.map((badge) => badge.querySelector('.remote-connection-mark')?.textContent),
    ).toEqual(['✓', '…', '↻', '×', '×'])
    expect(badges.map((badge) => badge.getAttribute('title'))).toEqual([
      'ssh:remote-connected · Connected',
      'ssh:remote-connecting · Connecting',
      'ssh:remote-reconnecting · Reconnecting',
      'ssh:remote-failed · Connection failed',
      'ssh:remote-disconnected · Disconnected',
    ])
    expect(badges.map((badge) => badge.getAttribute('aria-label'))).toEqual([
      'ssh:remote-connected · Connected',
      'ssh:remote-connecting · Connecting',
      'ssh:remote-reconnecting · Reconnecting',
      'ssh:remote-failed · Connection failed',
      'ssh:remote-disconnected · Disconnected',
    ])

    const trigger = host.querySelector<HTMLButtonElement>(
      '.project-tab.active .project-connection-trigger',
    )
    expect(trigger?.getAttribute('aria-label')).toBe(
      'Connection controls for ssh:remote-connected · Connected',
    )

    act(() => trigger?.click())

    const menu = host.querySelector('.project-connection-menu')
    expect(menu?.textContent).toContain('ssh:remote-connected')
    expect(menu?.textContent).toContain('Connected')
  })

  it('disables active close and confirms the exact inactive terminal count', async () => {
    const callbacks = renderProjectsBar(projectState(0, 0), {})
    const closeButtons = [...host.querySelectorAll<HTMLButtonElement>('.workspace-close')]
    expect(closeButtons).toHaveLength(2)
    expect(closeButtons[0]?.disabled).toBe(true)
    expect(closeButtons[0]?.title).toBe(
      'Select another workspace before closing this one',
    )
    expect(closeButtons[1]?.getAttribute('aria-label')).toBe('Close workspace feature')
    callbacks.plan.mockResolvedValueOnce({ terminalCount: 2 })

    await act(async () => {
      closeButtons[1]?.click()
      await Promise.resolve()
    })

    expect(host.querySelector('.close-workspace-dialog')?.textContent).toContain(
      '2 hvir terminals will be terminated',
    )
    const confirm = [
      ...host.querySelectorAll<HTMLButtonElement>('.confirmation-action'),
    ].find((button) => button.textContent === 'Close workspace')
    act(() => confirm?.click())
    expect(callbacks.close).toHaveBeenCalledWith(
      'project:local:/repo',
      'workspace:local:/repo/feature',
      { terminalCount: 2 },
      true,
    )
  })

  it('keeps closed worktrees out of the bar and exposes present, missing, and prunable catalog actions', () => {
    const state = projectState(0, 0)
    const project = state.projects[0]!
    const feature = project.workspaces[1]!
    const closedState: ProjectState = {
      ...state,
      projects: [
        {
          ...project,
          workspaces: [
            project.workspaces[0]!,
            { ...feature, closed: true },
            {
              ...feature,
              id: 'workspace:local:/repo/missing',
              root: localPath('/repo/missing'),
              name: 'missing',
              closed: true,
              missing: true,
            },
            {
              ...feature,
              id: 'workspace:local:/repo/prunable',
              root: localPath('/repo/prunable'),
              name: 'prunable',
              closed: true,
              missing: true,
              prunableReason: 'gitdir is stale',
            },
          ],
        },
      ],
    }
    const callbacks = renderProjectsBar(closedState, {})

    expect(host.querySelectorAll('.workspace-tab')).toHaveLength(1)
    const catalog = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Worktrees 3',
    )
    act(() => catalog?.click())
    const dialog = host.querySelector('.closed-worktrees-dialog')
    expect(dialog?.textContent).toContain('Present')
    expect(dialog?.textContent).toContain(
      'Missing from the last successful Git discovery',
    )
    expect(dialog?.textContent).toContain('Prunable · gitdir is stale')
    expect(host.textContent).toContain('Prune 1')
    const reopen = dialog?.querySelector<HTMLButtonElement>(
      '[aria-label="Reopen workspace feature"]',
    )
    act(() => reopen?.click())
    expect(callbacks.reopen).toHaveBeenCalledWith(
      'project:local:/repo',
      'workspace:local:/repo/feature',
    )
    act(() => catalog?.click())
    const dismiss = host.querySelector<HTMLButtonElement>(
      '[aria-label="Dismiss removed workspace missing"]',
    )
    act(() => dismiss?.click())
    expect(callbacks.dismiss).toHaveBeenCalledWith(
      'project:local:/repo',
      'workspace:local:/repo/missing',
    )
  })
})

function renderProjectsBar(
  state: ProjectState,
  rollups: Readonly<Record<string, { readonly actionable: number }>>,
) {
  const callbacks = {
    plan: vi.fn(() => Promise.resolve({ terminalCount: 0 })),
    close: vi.fn(),
    reopen: vi.fn(),
    dismiss: vi.fn(),
  }
  act(() => {
    root.render(
      <ProjectsBar
        state={state}
        rollups={rollups}
        busy={false}
        onAdd={vi.fn()}
        onSwitch={vi.fn()}
        onRefresh={vi.fn()}
        onCloseProject={vi.fn()}
        onPrune={vi.fn()}
        onDismiss={callbacks.dismiss}
        onPlanCloseWorkspace={callbacks.plan}
        onCloseWorkspace={callbacks.close}
        onReopenWorkspace={callbacks.reopen}
        watchTier="native"
        onChangeConnection={vi.fn()}
        onDisconnect={vi.fn()}
        onReconnect={vi.fn()}
        theme="dark"
        onTheme={vi.fn()}
        onSettings={vi.fn()}
      />,
    )
  })
  return callbacks
}

function projectState(mainChanged: number, featureChanged: number): ProjectState {
  const main = {
    id: 'workspace:local:/repo',
    root: localPath('/repo'),
    name: 'main',
    branch: 'main',
    main: true,
    closed: false,
    missing: false,
    repository: true,
    changedFiles: mainChanged,
  }
  const feature = {
    id: 'workspace:local:/repo/feature',
    root: localPath('/repo/feature'),
    name: 'feature',
    branch: 'feature',
    main: false,
    closed: false,
    missing: false,
    repository: true,
    changedFiles: featureChanged,
  }
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
        workspaces: [main, feature],
      },
    ],
  }
}

function remoteProjectState(states: readonly HostConnectionState[]): ProjectState {
  const projects = states.map((connectionState) => {
    const hostId = asHostId(`remote-${connectionState}`)
    const root = hostPath(hostId, `/srv/${connectionState}`)
    const workspace = {
      id: `workspace:${hostId}:${root.path}`,
      root,
      name: connectionState,
      branch: 'main',
      main: true,
      closed: false,
      missing: false,
      repository: true,
      changedFiles: 0,
    }
    return {
      id: `project:${hostId}:${root.path}`,
      displayName: `repo-${connectionState}`,
      registeredRoot: root,
      connectionState,
      watchTier: 'polling' as const,
      activeWorkspaceId: workspace.id,
      workspaces: [workspace],
    }
  })
  const activeProject = projects[0]
  if (!activeProject) throw new Error('Expected at least one remote project')
  return {
    root: activeProject.registeredRoot,
    activeProjectId: activeProject.id,
    activeWorkspaceId: activeProject.activeWorkspaceId,
    connectionState: activeProject.connectionState,
    watchTier: activeProject.watchTier,
    projects,
  }
}
