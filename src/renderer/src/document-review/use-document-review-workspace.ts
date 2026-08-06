import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  unwrapOperation,
  type HvirApi,
  type ReviewWorkspaceIdentity,
  type WatchEvent,
} from '../../../shared'
import type { DocumentReviewAction } from './document-review-types'
import {
  DocumentReviewWorkspaceController,
  documentReviewPaths,
  type DocumentReviewWorkspaceState,
} from './document-review-workspace-controller'

const IDLE_STATE: DocumentReviewWorkspaceState = {
  status: 'idle',
  localGeneration: 0,
  revision: 0,
}

export function useDocumentReviewWorkspace(workspace?: ReviewWorkspaceIdentity) {
  const [state, setState] = useState(IDLE_STATE)
  const controller = useRef<DocumentReviewWorkspaceController | undefined>(undefined)
  const workspaceRef = useRef(workspace)
  workspaceRef.current = workspace
  const hvir = rendererApi()
  controller.current ??= new DocumentReviewWorkspaceController(
    {
      restore: async (target) =>
        unwrapOperation(
          await hvir.invoke('document-review:restore', { workspace: target }),
        ),
      save: async (request) =>
        unwrapOperation(await hvir.invoke('document-review:save', request)),
      revalidate: async (request) =>
        unwrapOperation(await hvir.invoke('document-review:revalidate', request)),
    },
    setState,
  )

  const key = workspace
    ? `${workspace.id}\0${workspace.root.hostId}\0${workspace.root.path}`
    : undefined
  useEffect(() => {
    const target = workspaceRef.current
    if (target) controller.current?.activate(target)
    else controller.current?.deactivate()
  }, [key])
  useEffect(() => () => controller.current?.dispose(), [])

  const apply = useCallback(
    (action: DocumentReviewAction) => controller.current!.apply(action),
    [],
  )
  const handleWatchEvent = useCallback(
    (event: WatchEvent): void => controller.current?.handleWatch(event),
    [],
  )
  const watchPaths = useMemo(() => documentReviewPaths(state.model), [state.model])

  return { state, apply, handleWatchEvent, watchPaths }
}

function rendererApi(): HvirApi {
  return (globalThis as unknown as { readonly window: { readonly hvir: HvirApi } }).window
    .hvir
}

export function createDocumentReviewWatchBridge() {
  let viewer: (event: WatchEvent) => void = () => undefined
  let review: (event: WatchEvent) => void = () => undefined
  const combined = (event: WatchEvent): void => {
    viewer(event)
    review(event)
  }
  return {
    combine: (handle: (event: WatchEvent) => void) => {
      viewer = handle
      return combined
    },
    connect: (handle: (event: WatchEvent) => void): void => {
      review = handle
    },
  }
}
