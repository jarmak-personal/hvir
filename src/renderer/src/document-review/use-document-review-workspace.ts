import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from 'react'

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

function useDocumentReviewWorkspaceState(workspace?: ReviewWorkspaceIdentity) {
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
  const adoptAuthoritative = useCallback(
    (snapshot: import('../../../shared').DocumentReviewWorkspaceSnapshot) =>
      controller.current!.adoptAuthoritative(snapshot),
    [],
  )
  const watchPaths = useMemo(() => documentReviewPaths(state.model), [state.model])

  return {
    state,
    apply,
    flush: () => controller.current!.flush(),
    adoptAuthoritative,
    handleWatchEvent,
    watchPaths,
  }
}

export function useReviewWorkspace(
  workspace: ReviewWorkspaceIdentity | undefined,
  fanout: DocumentReviewWatchFanout,
) {
  const review = useDocumentReviewWorkspaceState(workspace)
  useReviewWatchTarget(fanout, review.handleWatchEvent)
  return review
}

export interface DocumentReviewWatchFanout {
  readonly handle: (event: WatchEvent) => void
  readonly target: MutableRefObject<(event: WatchEvent) => void>
}

export function useWatchFanout(
  viewer: (event: WatchEvent) => void,
): DocumentReviewWatchFanout {
  const viewerRef = useRef(viewer)
  const target = useRef<(event: WatchEvent) => void>(() => undefined)
  useEffect(() => {
    viewerRef.current = viewer
  }, [viewer])
  const handle = useCallback((event: WatchEvent): void => {
    viewerRef.current(event)
    target.current(event)
  }, [])
  return useMemo(() => ({ handle, target }), [handle])
}

function useReviewWatchTarget(
  fanout: DocumentReviewWatchFanout,
  target: (event: WatchEvent) => void,
): void {
  useEffect(() => {
    fanout.target.current = target
    return () => {
      fanout.target.current = () => undefined
    }
  }, [fanout, target])
}

function rendererApi(): HvirApi {
  return (globalThis as unknown as { readonly window: { readonly hvir: HvirApi } }).window
    .hvir
}
