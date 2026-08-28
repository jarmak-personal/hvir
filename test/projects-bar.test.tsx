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
  it('keeps Sessions as the fixed application destination and leaves it through project navigation', () => {
    const callbacks = renderProjectsBar(projectState(0, 0), {}, { sessionsActive: true })
    const sessions = host.querySelector<HTMLButtonElement>('.sessions-destination')
    expect(sessions?.getAttribute('aria-current')).toBe('page')
    expect(host.querySelector('.project-tab.active')).toBeNull()
    expect(host.querySelector('.workspaces-bar')).toBeNull()

    act(() => host.querySelector<HTMLButtonElement>('.project-tab-main')?.click())
    expect(callbacks.switchWorkspace).toHaveBeenCalledWith(
      'project:local:/repo',
      'workspace:local:/repo',
    )
    act(() => sessions?.click())
    expect(callbacks.sessions).toHaveBeenCalledOnce()
  })

  it('omits Git change counts while keeping actionable attention', () => {
    renderProjectsBar(projectState(2, 3), {
      'workspace:local:/repo': { actionable: 1, working: 0 },
      'workspace:local:/repo/feature': { actionable: 1, working: 0 },
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

  it('animates a Working project name without adding a badge and lets actionable attention win', () => {
    const state = projectState(0, 0)
    renderProjectsBar(state, {
      'workspace:local:/repo': { actionable: 0, working: 1 },
      'workspace:local:/repo/feature': { actionable: 0, working: 2 },
    })

    const projectMain = host.querySelector<HTMLButtonElement>('.project-tab-main')
    const projectName = projectMain?.querySelector('strong')
    expect(projectName?.textContent).toBe('repo')
    expect(projectName?.classList.contains('project-name-working')).toBe(true)
    expect(projectMain?.querySelector('.terminal-attention-count')).toBeNull()
    expect(projectMain?.getAttribute('aria-label')).toBe('repo · 3 terminals working')
    expect(projectMain?.title).toBe('/repo · connected · 3 terminals working')

    renderProjectsBar(state, {
      'workspace:local:/repo': { actionable: 1, working: 1 },
      'workspace:local:/repo/feature': { actionable: 0, working: 2 },
    })

    const actionableMain = host.querySelector<HTMLButtonElement>('.project-tab-main')
    expect(
      actionableMain?.querySelector('strong')?.classList.contains('project-name-working'),
    ).toBe(false)
    expect(actionableMain?.querySelector('.terminal-attention-count')?.textContent).toBe(
      '!1',
    )
    expect(actionableMain?.getAttribute('aria-label')).toBe(
      'repo · 1 terminal needing attention · 3 terminals working',
    )
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
      {
        'workspace:remote-connected:/srv/connected': {
          actionable: 0,
          working: 1,
        },
        'workspace:remote-reconnecting:/srv/reconnecting': {
          actionable: 0,
          working: 2,
        },
      },
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
    expect(host.querySelectorAll('.project-name-working')).toHaveLength(2)

    const trigger = host.querySelector<HTMLButtonElement>(
      '.project-tab.active .project-connection-trigger',
    )
    const activeProjectMain = host.querySelector<HTMLButtonElement>(
      '.project-tab.active .project-tab-main',
    )
    expect(activeProjectMain?.getAttribute('aria-label')).toBe(
      'repo-connected · ssh:remote-connected · Connected · 1 terminal working',
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

describe('ProjectsBar middle-click close', () => {
  it.each([
    ['local', projectState(0, 0)],
    ['SSH', remoteWorkspaceState()],
  ])(
    'runs the existing close plan for an inactive present %s worktree without switching',
    async (_hostKind, state) => {
      const callbacks = renderProjectsBar(state, {})
      callbacks.plan.mockResolvedValueOnce({ terminalCount: 0 })
      const workspace = requiredElement('.workspace-tab:not(.active)')

      const events = await middleClick(workspace)

      expect(events.mouseDown.defaultPrevented).toBe(true)
      expect(events.auxClick.defaultPrevented).toBe(true)
      const project = state.projects[0]!
      const inactive = project.workspaces.find(
        (candidate) => candidate.id !== state.activeWorkspaceId,
      )!
      expect(callbacks.plan).toHaveBeenCalledWith(project.id, inactive.id)
      expect(callbacks.close).toHaveBeenCalledWith(
        project.id,
        inactive.id,
        { terminalCount: 0 },
        false,
      )
      expect(callbacks.switchWorkspace).not.toHaveBeenCalled()
    },
  )

  it('opens the existing destructive confirmation for retained terminals', async () => {
    const callbacks = renderProjectsBar(projectState(0, 0), {})
    callbacks.plan.mockResolvedValueOnce({ terminalCount: 2 })

    await middleClick(requiredElement('.workspace-tab:not(.active)'))

    expect(callbacks.close).not.toHaveBeenCalled()
    expect(host.querySelector('.close-workspace-dialog')?.textContent).toContain(
      '2 hvir terminals will be terminated',
    )
  })

  it('leaves active, missing, busy, and already-planning workspaces open', async () => {
    const state = projectState(0, 0)
    const project = state.projects[0]!
    const feature = project.workspaces[1]!
    const missingState: ProjectState = {
      ...state,
      projects: [
        {
          ...project,
          workspaces: [project.workspaces[0]!, { ...feature, missing: true }],
        },
      ],
    }
    const activeCallbacks = renderProjectsBar(state, {})
    const activeEvents = await middleClick(requiredElement('.workspace-tab.active'))
    expect(activeEvents.auxClick.defaultPrevented).toBe(false)
    expect(activeCallbacks.plan).not.toHaveBeenCalled()

    const missingCallbacks = renderProjectsBar(missingState, {})
    const missingEvents = await middleClick(requiredElement('.workspace-tab.missing'))
    expect(missingEvents.auxClick.defaultPrevented).toBe(false)
    expect(missingCallbacks.plan).not.toHaveBeenCalled()

    const busyCallbacks = renderProjectsBar(state, {}, { busy: true })
    const busyEvents = await middleClick(requiredElement('.workspace-tab:not(.active)'))
    expect(busyEvents.auxClick.defaultPrevented).toBe(false)
    expect(busyCallbacks.plan).not.toHaveBeenCalled()

    let resolvePlan: ((plan: { terminalCount: number }) => void) | undefined
    const planningCallbacks = renderProjectsBar(state, {})
    planningCallbacks.plan.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePlan = resolve
        }),
    )
    const planningTab = requiredElement('.workspace-tab:not(.active)')
    await middleClick(planningTab, false)
    const repeatedEvents = await middleClick(planningTab, false)
    expect(repeatedEvents.auxClick.defaultPrevented).toBe(false)
    expect(planningCallbacks.plan).toHaveBeenCalledOnce()
    await act(async () => {
      resolvePlan?.({ terminalCount: 0 })
      await Promise.resolve()
    })
  })

  it('does not close project tabs or open the project-close dialog', async () => {
    const callbacks = renderProjectsBar(projectState(0, 0), {})

    const events = await middleClick(requiredElement('.project-tab'))

    expect(events.auxClick.defaultPrevented).toBe(false)
    expect(callbacks.closeProject).not.toHaveBeenCalled()
    expect(host.querySelector('.close-project-dialog')).toBeNull()
  })
})

function renderProjectsBar(
  state: ProjectState,
  rollups: Readonly<
    Record<string, { readonly actionable: number; readonly working: number }>
  >,
  options: { readonly busy?: boolean; readonly sessionsActive?: boolean } = {},
) {
  const callbacks = {
    plan: vi.fn(() => Promise.resolve({ terminalCount: 0 })),
    close: vi.fn(),
    reopen: vi.fn(),
    dismiss: vi.fn(),
    switchWorkspace: vi.fn(),
    closeProject: vi.fn(),
    sessions: vi.fn(),
  }
  act(() => {
    root.render(
      <ProjectsBar
        state={state}
        rollups={rollups}
        busy={options.busy ?? false}
        onAdd={vi.fn()}
        onSwitch={callbacks.switchWorkspace}
        onRefresh={vi.fn()}
        onCloseProject={callbacks.closeProject}
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
        sessionsActive={options.sessionsActive ?? false}
        onSessions={callbacks.sessions}
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
    revision: 0,
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
    revision: 0,
    root: activeProject.registeredRoot,
    activeProjectId: activeProject.id,
    activeWorkspaceId: activeProject.activeWorkspaceId,
    connectionState: activeProject.connectionState,
    watchTier: activeProject.watchTier,
    projects,
  }
}

function remoteWorkspaceState(): ProjectState {
  const hostId = asHostId('remote-workspaces')
  const mainRoot = hostPath(hostId, '/srv/repo')
  const featureRoot = hostPath(hostId, '/srv/repo-feature')
  const mainId = `workspace:${hostId}:${mainRoot.path}`
  const featureId = `workspace:${hostId}:${featureRoot.path}`
  const projectId = `project:${hostId}:${mainRoot.path}`
  return {
    revision: 0,
    root: mainRoot,
    activeProjectId: projectId,
    activeWorkspaceId: mainId,
    connectionState: 'connected',
    watchTier: 'polling',
    projects: [
      {
        id: projectId,
        displayName: 'remote-repo',
        registeredRoot: mainRoot,
        connectionState: 'connected',
        watchTier: 'polling',
        activeWorkspaceId: mainId,
        workspaces: [
          {
            id: mainId,
            root: mainRoot,
            name: 'main',
            branch: 'main',
            main: true,
            closed: false,
            missing: false,
            repository: true,
            changedFiles: 0,
          },
          {
            id: featureId,
            root: featureRoot,
            name: 'feature',
            branch: 'feature',
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

function requiredElement<T extends Element = HTMLDivElement>(selector: string): T {
  const match = host.querySelector<T>(selector)
  if (!match) throw new Error(`Missing element '${selector}'`)
  return match
}

async function middleClick(
  target: Element,
  settle = true,
): Promise<{ readonly mouseDown: MouseEvent; readonly auxClick: MouseEvent }> {
  const mouseDown = new MouseEvent('mousedown', {
    button: 1,
    bubbles: true,
    cancelable: true,
  })
  const auxClick = new MouseEvent('auxclick', {
    button: 1,
    bubbles: true,
    cancelable: true,
  })
  await act(async () => {
    target.dispatchEvent(mouseDown)
    target.dispatchEvent(auxClick)
    if (settle) await Promise.resolve()
  })
  return { mouseDown, auxClick }
}
