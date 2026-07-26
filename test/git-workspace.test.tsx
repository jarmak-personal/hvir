// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  useGitWorkspace,
  type GitWorkspacePorts,
} from '../src/renderer/src/git/use-git-workspace'
import { localPath, type ProjectState } from '../src/shared'

let host: HTMLDivElement
let reactRoot: Root
let workspace: ReturnType<typeof useGitWorkspace>
let invoke: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div')
  document.body.append(host)
  reactRoot = createRoot(host)
  invoke = vi.fn()
  Object.defineProperty(window, 'hvir', {
    configurable: true,
    value: { invoke },
  })
})

afterEach(() => {
  act(() => reactRoot.unmount())
  host.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('Git workspace mutations', () => {
  it('refreshes workspace content after Git refuses branch switching and pull', async () => {
    const ports = renderWorkspace()
    invoke.mockResolvedValue({
      ok: false,
      error: 'local changes would be overwritten',
    })

    await expect(workspace.switchBranch('main')).rejects.toThrow(
      'local changes would be overwritten',
    )
    await expect(workspace.pull()).rejects.toThrow('local changes would be overwritten')

    expect(invoke).toHaveBeenNthCalledWith(1, 'git:switch-branch', {
      root: localPath('/repo'),
      branch: 'main',
    })
    expect(invoke).toHaveBeenNthCalledWith(2, 'git:pull', {
      root: localPath('/repo'),
    })
    expect(ports.refreshContent).toHaveBeenCalledTimes(2)
    expect(ports.acceptProjectState).not.toHaveBeenCalled()
  })

  it('accepts successful state before refreshing workspace content', async () => {
    const state = projectState()
    const ports = renderWorkspace()
    invoke.mockResolvedValue({ ok: true, value: state })

    await workspace.pull()

    expect(ports.acceptProjectState).toHaveBeenCalledWith(state)
    expect(ports.refreshContent).toHaveBeenCalledOnce()
  })

  it('keeps unsaved viewer tabs ahead of any Git mutation', async () => {
    const ports = renderWorkspace(true)

    await expect(workspace.switchBranch('main')).rejects.toThrow(
      'Save or close unsaved viewer tabs',
    )
    await expect(workspace.pull()).rejects.toThrow('Save or close unsaved viewer tabs')

    expect(invoke).not.toHaveBeenCalled()
    expect(ports.refreshContent).not.toHaveBeenCalled()
  })
})

function renderWorkspace(hasDirtyViewerTabs = false): GitWorkspacePorts {
  const ports: GitWorkspacePorts = {
    root: localPath('/repo'),
    hasDirtyViewerTabs: () => hasDirtyViewerTabs,
    acceptProjectState: vi.fn(),
    refreshContent: vi.fn(),
    refreshGit: vi.fn(),
    activateViewer: vi.fn(),
    deactivateWebPane: vi.fn(),
  }
  act(() => {
    reactRoot.render(<GitWorkspaceHarness ports={ports} />)
  })
  return ports
}

function GitWorkspaceHarness({ ports }: { readonly ports: GitWorkspacePorts }): null {
  workspace = useGitWorkspace(ports)
  return null
}

function projectState(): ProjectState {
  const root = localPath('/repo')
  return {
    root,
    connectionState: 'connected',
    watchTier: 'native',
    activeProjectId: 'project-1',
    activeWorkspaceId: 'workspace-1',
    projects: [
      {
        id: 'project-1',
        registeredRoot: root,
        displayName: 'repo',
        connectionState: 'connected',
        watchTier: 'native',
        activeWorkspaceId: 'workspace-1',
        workspaces: [
          {
            id: 'workspace-1',
            root,
            name: 'repo',
            main: true,
            closed: false,
            missing: false,
            repository: true,
            changedFiles: 1,
          },
        ],
      },
    ],
  }
}
