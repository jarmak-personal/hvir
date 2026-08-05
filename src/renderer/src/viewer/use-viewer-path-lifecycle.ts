import { useCallback, type RefObject } from 'react'

import { hostPathEquals, type HostPath } from '../../../shared'
import type { ViewerDocumentPosition } from './tab-state'
import { canRebindViewerPath, reboundHostPath } from './viewer-path-rebind'
import { closeCleanViewerPath, reviewViewerPathRemoval } from './viewer-path-removal'
import type {
  ViewerWorkspaceAction,
  ViewerWorkspaceModel,
} from './viewer-workspace-model'
import { viewerTabId } from './viewer-workspace-persistence'

interface UseViewerPathLifecycleOptions {
  readonly modelRef: RefObject<ViewerWorkspaceModel>
  readonly pendingPositions: RefObject<Map<string, ViewerDocumentPosition>>
  readonly readGenerations: RefObject<Map<string, number>>
  readonly send: (action: ViewerWorkspaceAction) => void
  readonly closeTab: (id: string) => void
}

/** Owns open-view path identity and removal lifecycle for project entry operations. */
export function useViewerPathLifecycle({
  modelRef,
  pendingPositions,
  readGenerations,
  send,
  closeTab,
}: UseViewerPathLifecycleOptions) {
  const canRebindPath = useCallback(
    (source: HostPath, destination: HostPath): boolean =>
      canRebindViewerPath(modelRef.current, source, destination),
    [modelRef],
  )

  const rebindPath = useCallback(
    (source: HostPath, destination: HostPath): boolean => {
      const current = modelRef.current
      if (!canRebindViewerPath(current, source, destination)) return false
      for (const tab of current.tabs) {
        const path = reboundHostPath(tab.path, source, destination)
        if (hostPathEquals(path, tab.path)) continue
        const nextId = viewerTabId(path)
        const pending = pendingPositions.current.get(tab.id)
        pendingPositions.current.delete(tab.id)
        pendingPositions.current.delete(nextId)
        if (pending) pendingPositions.current.set(nextId, pending)
        const generation =
          Math.max(
            readGenerations.current.get(tab.id) ?? 0,
            readGenerations.current.get(nextId) ?? 0,
          ) + 1
        readGenerations.current.delete(tab.id)
        readGenerations.current.set(nextId, generation)
      }
      send({ type: 'rebind-path', source, destination })
      return true
    },
    [modelRef, pendingPositions, readGenerations, send],
  )

  const reviewPathRemoval = useCallback(
    (target: HostPath) => reviewViewerPathRemoval(modelRef.current, target),
    [modelRef],
  )

  const closeCleanPath = useCallback(
    (target: HostPath) => closeCleanViewerPath(modelRef.current, target, closeTab),
    [closeTab, modelRef],
  )

  return { canRebindPath, rebindPath, reviewPathRemoval, closeCleanPath }
}
