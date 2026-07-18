import { useCallback, useEffect, useReducer, useRef } from 'react'

import {
  basenameHostPath,
  hostPathEquals,
  unwrapOperation,
  type DiffBase,
  type FileOpenContext,
  type HostPath,
  type ViewMode,
  type WatchEvent,
} from '../../../shared'
import type { ViewerNavigationPosition, ViewerPaneId } from './tab-state'
import {
  initialViewerWorkspaceModel,
  viewerWorkspaceReducer,
  type ViewerWorkspaceAction,
  type ViewerWorkspaceModel,
} from './viewer-workspace-model'
import {
  sameViewerWorkspace,
  selectActiveTab,
  selectPaneActiveTab,
  selectPaneTabs,
} from './viewer-workspace-selectors'
import {
  persistViewerTabs,
  persistWorkspaceLayout,
  restoreViewerTabs,
  restoreWorkspaceLayout,
  viewerStorageKey,
  viewerTabId,
  type RestoredViewerTabs,
} from './viewer-workspace-persistence'

interface UseViewerWorkspaceOptions {
  readonly onActivateFile: () => void
}

type WarmViewerWorkspace = RestoredViewerTabs

export function useViewerWorkspace(options: UseViewerWorkspaceOptions) {
  const [model, dispatch] = useReducer(
    viewerWorkspaceReducer,
    initialViewerWorkspaceModel,
  )
  const modelRef = useRef(model)
  const optionsRef = useRef(options)
  const warmWorkspaces = useRef(new Map<string, WarmViewerWorkspace>())
  const workspaceGeneration = useRef(0)
  const readGenerations = useRef(new Map<string, number>())
  const navigationSerial = useRef(0)
  const pendingScroll = useRef<
    { readonly id: string; readonly scrollTop: number } | undefined
  >(undefined)
  const scrollFrame = useRef<number | undefined>(undefined)
  const persistedState = useRef<
    | {
        readonly root: HostPath
        readonly tabs: ViewerWorkspaceModel['tabs']
        readonly activeId?: string
      }
    | undefined
  >(undefined)
  const discardDirtyOnUnload = useRef(false)
  modelRef.current = model
  optionsRef.current = options

  const send = useCallback((action: ViewerWorkspaceAction): void => {
    modelRef.current = viewerWorkspaceReducer(modelRef.current, action)
    dispatch(action)
  }, [])

  const loadFileAt = useCallback(
    (path: HostPath, generation = modelRef.current.generation): void => {
      const id = viewerTabId(path)
      const readGeneration = (readGenerations.current.get(id) ?? 0) + 1
      readGenerations.current.set(id, readGeneration)
      send({
        type: 'read-started',
        id,
        workspaceGeneration: generation,
        readGeneration,
      })
      void window.hvir
        .invoke('fs:read', { path })
        .then(unwrapOperation)
        .then(
          (file) =>
            send({
              type: 'read-succeeded',
              id,
              workspaceGeneration: generation,
              readGeneration,
              file,
            }),
          (reason: unknown) =>
            send({
              type: 'read-failed',
              id,
              workspaceGeneration: generation,
              readGeneration,
              error: errorMessage(reason),
            }),
        )
    },
    [send],
  )

  const switchWorkspace = useCallback(
    (root: HostPath): void => {
      const current = modelRef.current
      if (sameViewerWorkspace(current, root)) return
      if (current.root) {
        persistViewerTabs(current.root, current.tabs, current.activeId)
        warmWorkspaces.current.set(viewerStorageKey(current.root), {
          tabs: current.tabs,
          activeId: current.activeId,
        })
      }
      const restored =
        warmWorkspaces.current.get(viewerStorageKey(root)) ?? restoreViewerTabs(root)
      const generation = (workspaceGeneration.current += 1)
      send({
        type: 'workspace-activated',
        root,
        generation,
        tabs: restored.tabs,
        activeId: restored.activeId,
        split: Boolean(restoreWorkspaceLayout(root).viewerSplit),
      })
      for (const tab of restored.tabs) {
        if (!tab.dirty) loadFileAt(tab.path, generation)
      }
    },
    [loadFileAt, send],
  )

  const activateTab = useCallback(
    (id: string, pane?: ViewerPaneId): void => {
      send({ type: 'activate', id, pane })
      optionsRef.current.onActivateFile()
    },
    [send],
  )

  const openFile = useCallback(
    (
      path: HostPath,
      pinned: boolean,
      context: FileOpenContext = 'file-tree',
      diffBase: DiffBase = 'head',
      diffRevision?: string,
      position?: Omit<ViewerNavigationPosition, 'serial'>,
    ): void => {
      const existing = modelRef.current.tabs.find((tab) => tab.id === viewerTabId(path))
      send({
        type: 'open',
        request: {
          path,
          pinned,
          context,
          diffBase,
          diffRevision,
          position: position
            ? { ...position, serial: (navigationSerial.current += 1) }
            : undefined,
        },
      })
      optionsRef.current.onActivateFile()
      // Reopening a dirty tab is navigation, not a reload. Its in-memory buffer
      // is authoritative until the user saves or explicitly chooses reload.
      if (!existing?.dirty) loadFileAt(path)
    },
    [loadFileAt, send],
  )

  const closeTab = useCallback(
    (id: string): void => {
      const current = modelRef.current
      const closing = current.tabs.find((tab) => tab.id === id)
      if (
        closing?.dirty &&
        !window.confirm(`Close ${basenameHostPath(closing.path)} without saving?`)
      ) {
        return
      }
      readGenerations.current.set(id, (readGenerations.current.get(id) ?? 0) + 1)
      const closesLastSecondary =
        closing?.pane === 'secondary' &&
        !current.tabs.some((tab) => tab.pane === 'secondary' && tab.id !== id)
      send({ type: 'close', id })
      if (closesLastSecondary && current.root) {
        persistWorkspaceLayout(current.root, { viewerSplit: false })
      }
    },
    [send],
  )

  const setMode = useCallback(
    (id: string, mode: ViewMode): void => send({ type: 'set-mode', id, mode }),
    [send],
  )

  const setDiffBase = useCallback(
    (id: string, diffBase: DiffBase): void =>
      send({ type: 'set-diff-base', id, diffBase }),
    [send],
  )

  const setContent = useCallback(
    (id: string, content: string): void => send({ type: 'set-content', id, content }),
    [send],
  )

  const pinTab = useCallback((id: string): void => send({ type: 'pin', id }), [send])

  const cycleActiveMode = useCallback((): void => {
    send({ type: 'cycle-active-mode' })
  }, [send])

  const navigationHandled = useCallback(
    (id: string, serial: number): void =>
      send({ type: 'navigation-handled', id, serial }),
    [send],
  )

  const scheduleScroll = useCallback(
    (id: string, scrollTop: number): void => {
      pendingScroll.current = { id, scrollTop }
      if (scrollFrame.current !== undefined) return
      scrollFrame.current = window.requestAnimationFrame(() => {
        scrollFrame.current = undefined
        const pending = pendingScroll.current
        pendingScroll.current = undefined
        if (pending) send({ type: 'set-scroll', ...pending })
      })
    },
    [send],
  )

  const reloadTab = useCallback(
    (id: string): void => {
      const tab = modelRef.current.tabs.find((candidate) => candidate.id === id)
      if (!tab) return
      send({ type: 'reload-requested', id })
      loadFileAt(tab.path)
    },
    [loadFileAt, send],
  )

  const saveTab = useCallback(
    (id: string): void => {
      const tab = modelRef.current.tabs.find((candidate) => candidate.id === id)
      if (!tab?.file || tab.file.binary || tab.conflict) return
      const savedContent = tab.file.content
      send({ type: 'save-started', id })
      void window.hvir
        .invoke('fs:write', {
          path: tab.path,
          content: savedContent,
          ...(tab.file.mtimeMs > 0 ? { expectedMtimeMs: tab.file.mtimeMs } : {}),
        })
        .then(unwrapOperation)
        .then(
          (written) => send({ type: 'save-succeeded', id, savedContent, written }),
          (reason: unknown) =>
            send({ type: 'save-failed', id, error: errorMessage(reason) }),
        )
    },
    [send],
  )

  const handleWatchEvent = useCallback(
    (event: WatchEvent): void => {
      const tab = modelRef.current.tabs.find((candidate) =>
        hostPathEquals(candidate.path, event.path),
      )
      if (!tab) return
      if (tab.dirty) send({ type: 'watch-conflict', id: tab.id })
      else loadFileAt(tab.path)
    },
    [loadFileAt, send],
  )

  const reloadCleanFiles = useCallback((): void => {
    for (const tab of modelRef.current.tabs) {
      if (!tab.dirty) loadFileAt(tab.path)
    }
  }, [loadFileAt])

  const focusPane = useCallback(
    (pane: ViewerPaneId, id?: string): void => {
      send({ type: 'focus-pane', pane, id })
    },
    [send],
  )

  const getActivePane = useCallback((): ViewerPaneId => modelRef.current.activePane, [])

  const openSplit = useCallback((): void => {
    const root = modelRef.current.root
    send({ type: 'split-opened' })
    if (root) persistWorkspaceLayout(root, { viewerSplit: true })
  }, [send])

  const closeSplit = useCallback((): void => {
    const root = modelRef.current.root
    send({ type: 'split-closed' })
    if (root) persistWorkspaceLayout(root, { viewerSplit: false })
  }, [send])

  const moveTab = useCallback(
    (id: string, pane: ViewerPaneId): void => {
      const current = modelRef.current
      const moving = current.tabs.find((tab) => tab.id === id)
      if (!moving || moving.pane === pane) return
      send({ type: 'move', id, pane })
      if (pane === 'secondary' && current.root) {
        persistWorkspaceLayout(current.root, { viewerSplit: true })
      }
      optionsRef.current.onActivateFile()
    },
    [send],
  )

  const reorderTabs = useCallback(
    (draggedId: string, targetId: string): void => {
      send({ type: 'reorder', draggedId, targetId })
    },
    [send],
  )

  useEffect(() => {
    if (!model.root || !model.restored) return
    persistedState.current = {
      root: model.root,
      tabs: model.tabs,
      activeId: model.activeId,
    }
    const timer = window.setTimeout(
      () => persistViewerTabs(model.root!, model.tabs, model.activeId),
      250,
    )
    return () => window.clearTimeout(timer)
  }, [model.activeId, model.restored, model.root, model.tabs])

  useEffect(() => {
    const flushPersistence = (): void => {
      const state = persistedState.current
      if (state) {
        persistViewerTabs(
          state.root,
          state.tabs,
          state.activeId,
          !discardDirtyOnUnload.current,
        )
      }
    }
    const protectDirtyBuffers = (event: BeforeUnloadEvent): void => {
      const dirtyCount = modelRef.current.tabs.filter((tab) => tab.dirty).length
      if (
        dirtyCount === 0 ||
        window.confirm(
          `${dirtyCount} tab${dirtyCount === 1 ? ' has' : 's have'} unsaved changes. Close hvir and discard them?`,
        )
      ) {
        discardDirtyOnUnload.current = dirtyCount > 0
        return
      }
      discardDirtyOnUnload.current = false
      event.preventDefault()
      event.returnValue = 'Unsaved changes'
    }
    window.addEventListener('pagehide', flushPersistence)
    window.addEventListener('beforeunload', protectDirtyBuffers)
    return () => {
      window.removeEventListener('pagehide', flushPersistence)
      window.removeEventListener('beforeunload', protectDirtyBuffers)
      if (scrollFrame.current !== undefined) {
        window.cancelAnimationFrame(scrollFrame.current)
      }
    }
  }, [])

  return {
    model,
    tabs: model.tabs,
    activeId: model.activeId,
    activeTab: selectActiveTab(model),
    primaryTabs: selectPaneTabs(model, 'primary'),
    secondaryTabs: selectPaneTabs(model, 'secondary'),
    primaryActiveTab: selectPaneActiveTab(model, 'primary'),
    secondaryActiveTab: selectPaneActiveTab(model, 'secondary'),
    split: model.split,
    switchWorkspace,
    openFile,
    activateTab,
    closeTab,
    pinTab,
    setMode,
    cycleActiveMode,
    setDiffBase,
    setContent,
    navigationHandled,
    scheduleScroll,
    reloadTab,
    saveTab,
    handleWatchEvent,
    reloadCleanFiles,
    focusPane,
    getActivePane,
    openSplit,
    closeSplit,
    moveTab,
    reorderTabs,
  }
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}
