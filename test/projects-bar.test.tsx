// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ProjectsBar } from '../src/renderer/src/workspaces/ProjectsBar'
import { localPath, type ProjectState } from '../src/shared'

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
})

function renderProjectsBar(
  state: ProjectState,
  rollups: Readonly<Record<string, { readonly actionable: number }>>,
): void {
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
        onDismiss={vi.fn()}
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
}

function projectState(mainChanged: number, featureChanged: number): ProjectState {
  const main = {
    id: 'workspace:local:/repo',
    root: localPath('/repo'),
    name: 'main',
    branch: 'main',
    main: true,
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
