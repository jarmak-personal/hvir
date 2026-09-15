import { ProjectFolderPickerCoordinator } from '../project-folder-picker'
import type { RendererResourceScopes } from '../renderer-resource-scopes'
import {
  MAX_PROJECT_WATCH_INTERESTS,
  hostPathEquals,
  localPath,
  type HostPath,
} from '../../shared'
import type { IpcDeps, EmitRendererEvent } from '../ipc/deps'
import type { ProjectHost } from '../project-host'
import type { createSmokeProjectState } from './project-state-fixture'
import type { workspaceCloseSmokeCommands } from './workspace-close'

/** Project/host command fixture behind the production IPC authority router. */
export function createProjectFixtureCommands(options: {
  host: ProjectHost
  rendererResources: RendererResourceScopes
  smokeRemoteHost: ProjectHost
  smokeRoot: HostPath
  smokeRemoteRoot: HostPath
  smokeCloseableRoot: HostPath
  smokeWebSwitchRoot: HostPath
  projectFixture: ReturnType<typeof createSmokeProjectState>
  workspaceCloseCommands: ReturnType<typeof workspaceCloseSmokeCommands>
  smokeHostOptions: IpcDeps['listHosts']
  emit: EmitRendererEvent
  preserveSelection: boolean
  projectReturn: boolean
}) {
  const {
    host,
    smokeRemoteHost,
    smokeRoot,
    smokeRemoteRoot,
    smokeCloseableRoot,
    smokeWebSwitchRoot,
    projectFixture,
    workspaceCloseCommands,
    smokeHostOptions,
    emit,
    preserveSelection,
    projectReturn,
  } = options
  const {
    base: smokeProjectState,
    set: setSmokeProjectState,
    projectReturn: smokeProjectReturnState,
  } = projectFixture
  const openedFolderSelections: Array<{ hostId: string; path: string }> = []
  const revealedEntries: HostPath[] = []
  const browseSmokeHost = async (_hostId: string, path: string) => {
    if (path.endsWith('.missing')) throw new Error(`Folder not found: ${path}`)
    const canonical = await host.realpath(localPath(path))
    const directories = (await host.readdir(canonical)).filter(
      (entry) => entry.type === 'dir',
    )
    return { path: canonical, directories }
  }
  const ports: Pick<
    IpcDeps,
    | 'getProject'
    | 'getHost'
    | 'connectedHosts'
    | 'getRegisteredWorkspaceRoot'
    | 'revealLocalEntry'
    | 'getProjectState'
    | 'listHosts'
    | 'connectHost'
    | 'disconnectHost'
    | 'browseHost'
    | 'openProject'
    | 'switchWorkspace'
    | 'refreshProject'
    | 'updateWatchInterests'
    | 'closeProject'
    | 'pruneWorktrees'
    | 'dismissWorkspace'
    | 'planWorkspaceClose'
    | 'closeWorkspace'
    | 'reopenWorkspace'
    | 'acknowledgeWorkspace'
    | 'switchGitBranch'
    | 'fetchGit'
    | 'pullGit'
    | 'respondSshPrompt'
  > = {
    getProject: () =>
      projectFixture.get().root.hostId === smokeRemoteHost.hostId
        ? { host: smokeRemoteHost, root: smokeRemoteRoot }
        : { host, root: smokeRoot },
    getHost: (hostId) => (hostId === smokeRemoteHost.hostId ? smokeRemoteHost : host),
    connectedHosts: () => [host],
    getRegisteredWorkspaceRoot: (root) =>
      hostPathEquals(root, smokeRoot) ||
      hostPathEquals(root, smokeCloseableRoot) ||
      hostPathEquals(root, smokeWebSwitchRoot) ||
      hostPathEquals(root, smokeRemoteRoot)
        ? root
        : undefined,
    revealLocalEntry: (path) => revealedEntries.push(path),
    getProjectState: () => projectFixture.get(),
    listHosts: smokeHostOptions,
    connectHost: () =>
      Promise.resolve({
        host: {
          hostId: host.hostId,
          label: 'Local',
          kind: 'local',
          connectionState: host.connectionState,
          watchTier: host.watchTier,
        },
        suggestedPath: smokeRoot.path,
      }),
    disconnectHost: () =>
      Promise.resolve({
        hostId: host.hostId,
        label: 'Local',
        kind: 'local',
        connectionState: host.connectionState,
        watchTier: host.watchTier,
      }),
    browseHost: browseSmokeHost,
    openProject: (hostId, path) => {
      openedFolderSelections.push({ hostId, path })
      return Promise.resolve(setSmokeProjectState(smokeProjectState()))
    },
    switchWorkspace: (projectId) => {
      const state = setSmokeProjectState(
        preserveSelection
          ? projectFixture.get()
          : projectReturn
            ? smokeProjectReturnState(projectId)
            : smokeProjectState(),
      )
      if (projectReturn) {
        emit('project:state', state)
      }
      return Promise.resolve(state)
    },
    refreshProject: () => Promise.resolve(setSmokeProjectState(smokeProjectState())),
    updateWatchInterests: (paths) =>
      Promise.resolve({
        accepted: Math.min(paths.length, MAX_PROJECT_WATCH_INTERESTS),
        limited: paths.length > MAX_PROJECT_WATCH_INTERESTS,
      }),
    closeProject: () => {
      return Promise.resolve(setSmokeProjectState(smokeProjectState()))
    },
    pruneWorktrees: () => Promise.resolve(setSmokeProjectState(smokeProjectState())),
    dismissWorkspace: () => Promise.resolve(setSmokeProjectState(smokeProjectState())),
    planWorkspaceClose: workspaceCloseCommands.planWorkspaceClose,
    closeWorkspace: workspaceCloseCommands.closeWorkspace,
    reopenWorkspace: workspaceCloseCommands.reopenWorkspace,
    acknowledgeWorkspace: () =>
      Promise.resolve(setSmokeProjectState(smokeProjectState())),
    switchGitBranch: async (_root, branch) => {
      const result = await host.exec('git', [
        '-C',
        smokeRoot.path,
        'switch',
        '--no-guess',
        branch,
      ])
      if (result.code !== 0) throw new Error(result.stderr)
      return setSmokeProjectState(smokeProjectState())
    },
    fetchGit: () => Promise.resolve(setSmokeProjectState(smokeProjectState())),
    pullGit: () => Promise.resolve(setSmokeProjectState(smokeProjectState())),
    respondSshPrompt: () => undefined,
  }
  const projectFolderPicker = new ProjectFolderPickerCoordinator(
    {
      hostById: (hostId) => (hostId === smokeRemoteHost.hostId ? smokeRemoteHost : host),
    },
    { browseHost: browseSmokeHost },
    options.rendererResources,
  )
  return { ports, projectFolderPicker, openedFolderSelections, revealedEntries }
}
