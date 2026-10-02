import {
  ExtensionContextOwner,
  type ExtensionContextSources,
} from '../../src/main/extensions/context-owner'
import { localPath, type ProjectState } from '../../src/shared'
import type { ObservedManagedPty } from '../../src/main/pty/pty-supervisor'

export function contextFixture() {
  const root = localPath('/project')
  let closed = false
  let disconnected = false
  let live = true
  let moved = false
  let title = 'Ordinary shell'
  const listeners: (() => void)[][] = [[], [], []]
  const subscribe = (index: number) => (callback: () => void) => {
    listeners[index]!.push(callback)
    return () => {
      listeners[index] = listeners[index]!.filter((value) => value !== callback)
    }
  }
  const sources: ExtensionContextSources = {
    projectState: () =>
      ({
        revision: 1, root, connectionState: disconnected ? 'disconnected' : 'connected', watchTier: 'native', activeProjectId: 'project', activeWorkspaceId: 'workspace',
        projects: [
          {
            id: 'project', registeredRoot: root, displayName: 'Project', watchTier: 'native', activeWorkspaceId: 'workspace',
            connectionState: disconnected ? 'disconnected' : 'connected',
            workspaces: [
              { id: 'workspace', root, name: 'Workspace', main: true, closed, missing: false, repository: false, changedFiles: 0 },
            ],
          },
        ],
      }) satisfies ProjectState,
    observeProjects: subscribe(0),
    sessions: {
      get: () => ({ title }) as ReturnType<ExtensionContextSources['sessions']['get']>,
      observationSnapshot: () => [],
      observe: subscribe(1),
    },
    ptys: {
      observationSnapshot: () =>
        live
          ? [1, 2].map(
              (id) =>
                ({
                  info: {
                    id: `terminal-${id}`,
                    instanceId: `spawn-${id}`,
                    ownerId: id,
                    ownerGeneration: 1,
                    workspaceRoot: moved ? localPath('/other') : root,
                  },
                }) as ObservedManagedPty,
            )
          : [],
      observe: subscribe(2),
    },
  }
  const contexts = new ExtensionContextOwner(sources)
  return {
    sources,
    root,
    contexts,
    id: (owner: number) => contexts.sessions({ id: owner, generation: 1 })[0]!.id,
    change: (kind: 'close' | 'disconnect' | 'exit' | 'move' | 'title') => {
      if (kind === 'close') closed = true
      if (kind === 'disconnect') disconnected = true
      if (kind === 'exit') live = false
      if (kind === 'move') moved = true
      if (kind === 'title') title = 'Updated'
      for (const listener of listeners[
        kind === 'close' || kind === 'disconnect' ? 0 : kind === 'title' ? 1 : 2
      ]!)
        listener()
    },
    listeners,
  }
}
