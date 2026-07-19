import { useCallback, useEffect, useReducer, useRef, useState } from 'react'

import {
  unwrapOperation,
  type BrowseHostResponse,
  type ConnectedHost,
  type ProjectHostOption,
  type ProjectState,
  type WatchEvent,
} from '../../../shared'
import { initialHostConnectionTarget } from './initial-host-connection'
import { subscribeProjectSessionEvents } from './project-session-events'
import {
  initialProjectSessionModel,
  projectSessionReducer,
  selectActiveProject,
  selectActiveWorkspace,
  selectRelativeWorkspace,
} from './project-session-model'

const WATCH_REFRESH_DELAY_MS = 250

interface ProjectSessionVersions {
  readonly watch: number
  readonly ignored: number
  readonly content: number
  readonly git: number
}

interface UseProjectSessionOptions {
  readonly onProjectState: (state: ProjectState) => void
  readonly onReloadFiles: () => void
  readonly onWatchEvent: (event: WatchEvent) => void
  readonly isIgnoreRulePath: (path: string) => boolean
}

export function useProjectSession(options: UseProjectSessionOptions) {
  const [model, dispatch] = useReducer(projectSessionReducer, initialProjectSessionModel)
  const [hosts, setHosts] = useState<readonly ProjectHostOption[]>([])
  const [rootError, setRootError] = useState<string>()
  const [versions, setVersions] = useState<ProjectSessionVersions>({
    watch: 0,
    ignored: 0,
    content: 0,
    git: 0,
  })
  const callbacks = useRef(options)
  const modelRef = useRef(model)
  const generation = useRef(0)
  callbacks.current = options
  modelRef.current = model

  const acceptProjectState = useCallback((state: ProjectState): void => {
    dispatch({ type: 'project-state', state })
    callbacks.current.onProjectState(state)
  }, [])

  const bumpVersions = useCallback((keys: readonly (keyof ProjectSessionVersions)[]) => {
    setVersions((current) => {
      const next = { ...current }
      for (const key of keys) next[key] += 1
      return next
    })
  }, [])

  const refreshWorkspaceContent = useCallback((): void => {
    bumpVersions(['watch', 'ignored', 'content', 'git'])
    callbacks.current.onReloadFiles()
  }, [bumpVersions])

  const refreshGit = useCallback((): void => {
    bumpVersions(['git'])
  }, [bumpVersions])

  const runTransition = useCallback(
    async (operation: () => Promise<ProjectState>): Promise<ProjectState | undefined> => {
      const currentGeneration = (generation.current += 1)
      dispatch({ type: 'transition-started', generation: currentGeneration })
      try {
        const state = await operation()
        if (generation.current !== currentGeneration) return undefined
        dispatch({
          type: 'transition-project',
          generation: currentGeneration,
          state,
        })
        callbacks.current.onProjectState(state)
        return state
      } catch (reason) {
        if (generation.current === currentGeneration) {
          dispatch({
            type: 'transition-failed',
            generation: currentGeneration,
            error: errorMessage(reason),
          })
        }
        return undefined
      } finally {
        dispatch({ type: 'transition-finished', generation: currentGeneration })
      }
    },
    [],
  )

  const connectHost = useCallback(async (hostId: string): Promise<ConnectedHost> => {
    return unwrapOperation(await window.hvir.invoke('project:connect-host', { hostId }))
  }, [])

  const browseHost = useCallback(
    async (hostId: string, path: string): Promise<BrowseHostResponse> => {
      return unwrapOperation(
        await window.hvir.invoke('project:browse-host', { hostId, path }),
      )
    },
    [],
  )

  const disconnectHost = useCallback(
    async (hostId: string): Promise<ProjectHostOption> => {
      return unwrapOperation(
        await window.hvir.invoke('project:disconnect-host', { hostId }),
      )
    },
    [],
  )

  const openHost = useCallback(
    async (hostId: string, path: string): Promise<ProjectState> => {
      const state = unwrapOperation(
        await window.hvir.invoke('project:open', { hostId, path }),
      )
      acceptProjectState(state)
      return state
    },
    [acceptProjectState],
  )

  const switchWorkspace = useCallback(
    async (projectId: string, workspaceId: string): Promise<void> => {
      const current = modelRef.current.projectState
      if (
        current?.activeProjectId === projectId &&
        current.activeWorkspaceId === workspaceId
      ) {
        return
      }
      await runTransition(async () => {
        const targetProject = modelRef.current.projectState?.projects.find(
          (project) => project.id === projectId,
        )
        if (
          targetProject &&
          targetProject.registeredRoot.hostId !== 'local' &&
          targetProject.connectionState !== 'connected'
        ) {
          await connectHost(targetProject.registeredRoot.hostId)
        }
        return unwrapOperation(
          await window.hvir.invoke('project:switch', { projectId, workspaceId }),
        )
      })
    },
    [connectHost, runTransition],
  )

  const switchRelativeWorkspace = useCallback(
    (direction: -1 | 1): void => {
      const target = selectRelativeWorkspace(modelRef.current, direction)
      if (target) void switchWorkspace(target.projectId, target.workspaceId)
    },
    [switchWorkspace],
  )

  const refreshProject = useCallback(
    async (projectId: string): Promise<void> => {
      await runTransition(async () =>
        unwrapOperation(await window.hvir.invoke('project:refresh', { projectId })),
      )
    },
    [runTransition],
  )

  const closeProject = useCallback(
    async (projectId: string): Promise<void> => {
      await runTransition(async () =>
        unwrapOperation(await window.hvir.invoke('project:close', { projectId })),
      )
    },
    [runTransition],
  )

  const pruneWorktrees = useCallback(
    async (projectId: string): Promise<void> => {
      await runTransition(async () =>
        unwrapOperation(await window.hvir.invoke('workspace:prune', { projectId })),
      )
    },
    [runTransition],
  )

  const dismissWorkspace = useCallback(
    async (projectId: string, workspaceId: string): Promise<void> => {
      await runTransition(async () =>
        unwrapOperation(
          await window.hvir.invoke('workspace:dismiss', { projectId, workspaceId }),
        ),
      )
    },
    [runTransition],
  )

  const disconnect = useCallback(async (): Promise<void> => {
    const root = modelRef.current.projectState?.root
    if (!root || root.hostId === 'local') return
    const currentGeneration = (generation.current += 1)
    dispatch({ type: 'transition-started', generation: currentGeneration })
    try {
      const host = await disconnectHost(root.hostId)
      if (generation.current !== currentGeneration) return
      dispatch({ type: 'prompts-cancelled', hostId: root.hostId })
      dispatch({
        type: 'transition-connection',
        generation: currentGeneration,
        connectionState: host.connectionState,
        watchTier: host.watchTier,
      })
    } catch (reason) {
      dispatch({
        type: 'transition-failed',
        generation: currentGeneration,
        error: errorMessage(reason),
      })
    } finally {
      dispatch({ type: 'transition-finished', generation: currentGeneration })
    }
  }, [disconnectHost])

  const reconnect = useCallback(async (): Promise<void> => {
    const root = modelRef.current.projectState?.root
    if (!root || root.hostId === 'local') return
    const currentGeneration = (generation.current += 1)
    dispatch({ type: 'transition-started', generation: currentGeneration })
    try {
      const connected = await connectHost(root.hostId)
      if (generation.current !== currentGeneration) return
      dispatch({
        type: 'transition-connection',
        generation: currentGeneration,
        connectionState: connected.host.connectionState,
        watchTier: connected.host.watchTier,
      })
      callbacks.current.onReloadFiles()
    } catch (reason) {
      dispatch({
        type: 'transition-failed',
        generation: currentGeneration,
        error: errorMessage(reason),
      })
    } finally {
      dispatch({ type: 'transition-finished', generation: currentGeneration })
    }
  }, [connectHost])

  const answerPrompt = useCallback((answers?: readonly string[]): void => {
    const prompt = modelRef.current.prompts[0]
    if (!prompt) return
    void window.hvir.invoke('ssh:prompt-response', { id: prompt.id, answers })
    dispatch({ type: 'prompt-answered', id: prompt.id })
  }, [])

  const reportError = useCallback((error?: string): void => {
    dispatch({ type: 'reported-error', error })
  }, [])

  const refreshHosts = useCallback(async (): Promise<void> => {
    try {
      setHosts(await window.hvir.invoke('project:hosts', undefined))
    } catch {
      // The current project remains usable if host discovery fails.
    }
  }, [])

  useEffect(() => {
    let disposed = false
    const timers: Partial<Record<keyof ProjectSessionVersions, number>> = {}
    const scheduleVersion = (key: keyof ProjectSessionVersions): void => {
      if (timers[key] !== undefined) return
      timers[key] = window.setTimeout(() => {
        timers[key] = undefined
        bumpVersions([key])
      }, WATCH_REFRESH_DELAY_MS)
    }
    const currentGeneration = (generation.current += 1)
    dispatch({ type: 'transition-started', generation: currentGeneration })
    void window.hvir.invoke('project:root', undefined).then(
      async (state) => {
        if (disposed || generation.current !== currentGeneration) return
        dispatch({ type: 'transition-project', generation: currentGeneration, state })
        callbacks.current.onProjectState(state)
        const hostId = initialHostConnectionTarget(state)
        if (!hostId) {
          dispatch({ type: 'transition-finished', generation: currentGeneration })
          return
        }
        try {
          const connected = await connectHost(hostId)
          if (disposed || generation.current !== currentGeneration) return
          dispatch({
            type: 'transition-connection',
            generation: currentGeneration,
            connectionState: connected.host.connectionState,
            watchTier: connected.host.watchTier,
          })
          callbacks.current.onReloadFiles()
        } catch (reason) {
          if (!disposed && generation.current === currentGeneration) {
            dispatch({
              type: 'transition-failed',
              generation: currentGeneration,
              error: errorMessage(reason),
            })
          }
        } finally {
          if (!disposed) {
            dispatch({ type: 'transition-finished', generation: currentGeneration })
          }
        }
      },
      (reason: unknown) => {
        if (disposed || generation.current !== currentGeneration) return
        setRootError(errorMessage(reason))
        dispatch({ type: 'transition-finished', generation: currentGeneration })
      },
    )
    const stopEvents = subscribeProjectSessionEvents(window.hvir, {
      onWatch: (event) => {
        const gitMetadataEvent =
          event.synthetic !== 'refresh' && /(^|\/)\.git(?:\/|$)/.test(event.path.path)
        const ignoreRulesEvent =
          event.synthetic !== 'refresh' &&
          callbacks.current.isIgnoreRulePath(event.path.path)
        if (gitMetadataEvent) scheduleVersion('git')
        if (ignoreRulesEvent) scheduleVersion('ignored')
        scheduleVersion('watch')
        if (event.synthetic !== 'refresh') scheduleVersion('content')
        callbacks.current.onWatchEvent(event)
      },
      onState: acceptProjectState,
      onPrompt: (prompt) => dispatch({ type: 'prompt-received', prompt }),
      onPromptCancel: (hostId) => dispatch({ type: 'prompts-cancelled', hostId }),
    })
    return () => {
      disposed = true
      generation.current += 1
      for (const timer of Object.values(timers)) {
        if (timer !== undefined) window.clearTimeout(timer)
      }
      stopEvents()
    }
  }, [acceptProjectState, bumpVersions, connectHost])

  const projectState = model.projectState
  return {
    projectState,
    root: projectState?.root,
    activeProject: selectActiveProject(model),
    activeWorkspace: selectActiveWorkspace(model),
    connectionState: model.connectionState,
    watchTier: model.watchTier,
    busy: model.busy,
    error: model.error,
    rootError,
    prompts: model.prompts,
    hosts,
    versions,
    acceptProjectState,
    refreshWorkspaceContent,
    refreshGit,
    reportError,
    refreshHosts,
    switchWorkspace,
    switchRelativeWorkspace,
    refreshProject,
    closeProject,
    pruneWorktrees,
    dismissWorkspace,
    disconnect,
    reconnect,
    connectHost,
    browseHost,
    disconnectHost,
    openHost,
    answerPrompt,
  }
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}
