import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react'

import type {
  GitChanges,
  HostConnectionState,
  HostPath,
} from '../../../shared'
import {
  gitAutoFetchDelay,
  gitChangeCountLabel,
  gitRailReducer,
  gitRailSyncState,
  initialGitRailModel,
  type GitRailAction,
  type GitRailView,
  type GitSyncOperation,
} from './git-rail-model'
import { errorMessage, GitSyncCoordinator } from './git-sync-coordinator'

export interface GitRailControllerOptions {
  readonly root: HostPath
  readonly refreshVersion: number
  readonly historyRefreshVersion: number
  readonly onChanges: (changes: GitChanges | undefined) => void
  readonly connectionState: HostConnectionState
  readonly hidden: boolean
  readonly historyPaused: boolean
  readonly hasDirtyViewerTabs: boolean
  readonly onSwitchBranch: (branch: string) => Promise<void>
  readonly onFetch: () => Promise<void>
  readonly onPull: () => Promise<void>
  readonly autoFetchIntervalMs: number
}

export function useGitRailController(options: GitRailControllerOptions) {
  const {
    root,
    refreshVersion,
    historyRefreshVersion,
    onChanges,
    connectionState,
    hidden,
    historyPaused,
    hasDirtyViewerTabs,
    autoFetchIntervalMs,
  } = options
  const [model, dispatch] = useReducer(gitRailReducer, initialGitRailModel)
  const modelRef = useRef(model)
  const optionsRef = useRef(options)
  const syncCoordinator = useRef(new GitSyncCoordinator())
  const changesControl = useRef({ running: false, queued: false })
  const historyLoading = useRef(false)
  const branchRequestId = useRef(0)
  const historyRequestId = useRef(0)
  modelRef.current = model
  optionsRef.current = options

  const send = useCallback((action: GitRailAction): void => {
    modelRef.current = gitRailReducer(modelRef.current, action)
    dispatch(action)
  }, [])

  const requestChanges = useCallback((): void => {
    const control = changesControl.current
    control.queued = true
    if (control.running) return
    control.running = true
    void (async () => {
      while (control.queued) {
        control.queued = false
        const current = optionsRef.current
        if (current.connectionState !== 'connected') continue
        const generation = syncCoordinator.current.generation()
        const requestRoot = current.root
        const requestKey = hostPathKey(requestRoot)
        send({ type: 'changes-requested', generation })
        try {
          const changes = await window.hvir.invoke('git:changes', { root: requestRoot })
          const latest = optionsRef.current
          if (
            syncCoordinator.current.generation() !== generation ||
            hostPathKey(latest.root) !== requestKey ||
            latest.connectionState !== 'connected'
          ) {
            continue
          }
          send({ type: 'changes-loaded', generation, changes })
          latest.onChanges(changes)
        } catch (reason) {
          const latest = optionsRef.current
          if (
            syncCoordinator.current.generation() !== generation ||
            hostPathKey(latest.root) !== requestKey
          ) {
            continue
          }
          if (!modelRef.current.changes) latest.onChanges(undefined)
          send({ type: 'changes-failed', generation, error: errorMessage(reason) })
        }
      }
      control.running = false
    })()
  }, [send])

  useEffect(() => {
    const changesOwner = changesControl.current
    const syncOwner = syncCoordinator.current
    changesOwner.queued = false
    historyLoading.current = false
    const generation = syncOwner.reset()
    send({ type: 'context-reset', generation })
    onChanges(undefined)
    return () => {
      changesOwner.queued = false
      historyLoading.current = false
      syncOwner.reset()
    }
  }, [connectionState, onChanges, root.hostId, root.path, send])

  useEffect(() => {
    if (connectionState !== 'connected') return
    requestChanges()
  }, [
    connectionState,
    historyRefreshVersion,
    refreshVersion,
    requestChanges,
    root.hostId,
    root.path,
  ])

  useEffect(() => {
    if (connectionState !== 'connected') return
    const generation = syncCoordinator.current.generation()
    const requestId = ++branchRequestId.current
    send({ type: 'branch-requested', generation, requestId })
    void window.hvir.invoke('git:branches', { root }).then(
      (branchModel) => {
        if (syncCoordinator.current.generation() !== generation) return
        send({ type: 'branch-loaded', generation, requestId, model: branchModel })
      },
      (reason: unknown) => {
        if (syncCoordinator.current.generation() !== generation) return
        send({
          type: 'branch-failed',
          generation,
          requestId,
          error: errorMessage(reason),
        })
      },
    )
  }, [
    connectionState,
    historyRefreshVersion,
    model.branchRefreshVersion,
    root,
    send,
  ])

  useEffect(() => {
    if (model.view !== 'history' || connectionState !== 'connected' || historyPaused) {
      return
    }
    const generation = syncCoordinator.current.generation()
    const requestId = ++historyRequestId.current
    historyLoading.current = true
    send({ type: 'history-requested', generation, requestId, append: false })
    void window.hvir.invoke('git:history', { root, limit: 50 }).then(
      (page) => {
        if (syncCoordinator.current.generation() !== generation) return
        send({
          type: 'history-loaded',
          generation,
          requestId,
          append: false,
          page,
        })
      },
      (reason: unknown) => {
        if (syncCoordinator.current.generation() !== generation) return
        send({
          type: 'history-failed',
          generation,
          requestId,
          append: false,
          error: errorMessage(reason),
        })
      },
    ).finally(() => {
      if (
        syncCoordinator.current.generation() === generation &&
        modelRef.current.historyRequestId === requestId
      ) {
        historyLoading.current = false
      }
    })
  }, [
    connectionState,
    historyPaused,
    historyRefreshVersion,
    model.view,
    root,
    send,
  ])

  const loadMoreHistory = useCallback((): void => {
    const currentOptions = optionsRef.current
    const current = modelRef.current
    if (
      currentOptions.connectionState !== 'connected' ||
      currentOptions.historyPaused ||
      historyLoading.current ||
      !current.hasMore ||
      !current.historyCursor
    ) {
      return
    }
    const generation = syncCoordinator.current.generation()
    const requestId = ++historyRequestId.current
    const cursor = current.historyCursor
    historyLoading.current = true
    send({ type: 'history-requested', generation, requestId, append: true })
    void window.hvir
      .invoke('git:history', { root: currentOptions.root, cursor, limit: 50 })
      .then(
        (page) => {
          if (syncCoordinator.current.generation() !== generation) return
          send({
            type: 'history-loaded',
            generation,
            requestId,
            append: true,
            page,
          })
        },
        (reason: unknown) => {
          if (syncCoordinator.current.generation() !== generation) return
          send({
            type: 'history-failed',
            generation,
            requestId,
            append: true,
            error: errorMessage(reason),
          })
        },
      )
      .finally(() => {
        if (
          syncCoordinator.current.generation() === generation &&
          modelRef.current.historyRequestId === requestId
        ) {
          historyLoading.current = false
        }
      })
  }, [send])

  const switchBranch = useCallback(
    async (branch: string): Promise<void> => {
      const current = modelRef.current
      if (current.branchSwitching || current.syncBusy) return
      const generation = current.generation
      send({ type: 'branch-switch-requested', generation })
      try {
        await optionsRef.current.onSwitchBranch(branch)
        if (syncCoordinator.current.generation() !== generation) return
        send({ type: 'branch-switch-succeeded', generation })
      } catch (reason) {
        if (syncCoordinator.current.generation() !== generation) return
        send({ type: 'branch-switch-failed', generation, error: errorMessage(reason) })
      }
    },
    [send],
  )

  const runSync = useCallback(
    (operation: GitSyncOperation, manual: boolean): void => {
      const current = modelRef.current
      const generation = current.generation
      if (manual && operation === 'fetch') {
        send({ type: 'sync-retry-enabled', generation })
      }
      const request =
        operation === 'fetch' ? optionsRef.current.onFetch : optionsRef.current.onPull
      syncCoordinator.current.run(operation, request, {
        started: (startedOperation, requestId) =>
          send({
            type: 'sync-requested',
            generation,
            requestId,
            operation: startedOperation,
          }),
        succeeded: (succeededOperation, requestId, fetchedAt) =>
          send({
            type: 'sync-succeeded',
            generation,
            requestId,
            operation: succeededOperation,
            fetchedAt,
          }),
        failed: (failedOperation, requestId, error) =>
          send({
            type: 'sync-failed',
            generation,
            requestId,
            operation: failedOperation,
            error,
          }),
      })
    },
    [send],
  )

  const fetch = useCallback((): void => runSync('fetch', true), [runSync])
  const pull = useCallback((): void => runSync('pull', true), [runSync])

  useEffect(() => {
    const delay = gitAutoFetchDelay({
      hidden,
      connectionState,
      intervalMs: autoFetchIntervalMs,
      remoteAvailable: Boolean(model.branchModel?.remoteAvailable),
      blocked: model.autoFetchBlocked,
      syncBusy: Boolean(model.syncBusy),
      lastFetchedAt: model.lastFetchedAt,
      now: Date.now(),
    })
    if (delay === undefined) return
    const timer = window.setTimeout(() => runSync('fetch', false), delay)
    return () => window.clearTimeout(timer)
  }, [
    autoFetchIntervalMs,
    connectionState,
    hidden,
    model.autoFetchBlocked,
    model.branchModel?.remoteAvailable,
    model.lastFetchedAt,
    model.syncBusy,
    runSync,
  ])

  const selectView = useCallback(
    (view: GitRailView): void => send({ type: 'view-selected', view }),
    [send],
  )
  const syncState = useMemo(
    () => gitRailSyncState({ model, connectionState, hasDirtyViewerTabs }),
    [connectionState, hasDirtyViewerTabs, model],
  )

  return {
    model,
    changeCountLabel: gitChangeCountLabel(model.changes),
    syncState,
    selectView,
    requestChanges,
    loadMoreHistory,
    switchBranch,
    fetch,
    pull,
  }
}

function hostPathKey(path: HostPath): string {
  return `${path.hostId}\0${path.path}`
}
