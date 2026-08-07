import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  hostPathEquals,
  renderedFileType,
  type DocumentReviewRevalidation,
  type DocumentReviewWorkspaceSnapshot,
  type HostPath,
} from '../../../shared'
import { createDocumentReviewCapture } from './document-review-capture'
import { selectDocumentReviewComments } from './document-review-selectors'
import type {
  DocumentReviewAction,
  DocumentReviewActionResult,
  DocumentReviewComment,
  ReviewAnchorCapture,
  ReviewSourceRange,
} from './document-review-types'
import type { DocumentReviewWorkspaceState } from './document-review-workspace-controller'
import {
  useDocumentReviewDelivery,
  type DocumentReviewDeliveryInteraction,
} from './use-document-review-delivery'

const ACTIVE_BATCH_ID = 'active-review'

export interface DocumentReviewWorkspaceBinding {
  readonly state: DocumentReviewWorkspaceState
  readonly apply: (action: DocumentReviewAction) => DocumentReviewActionResult
  readonly readDocument: (document: HostPath) => Promise<DocumentReviewRevalidation>
  readonly flush: () => Promise<void>
  readonly adoptAuthoritative: (snapshot: DocumentReviewWorkspaceSnapshot) => boolean
}

interface DocumentReviewDocumentInput {
  readonly path: HostPath
  readonly content: string
  readonly dirty: boolean
  readonly mode: 'rendered' | 'source' | 'diff'
}

export interface DocumentReviewDocumentProjection {
  readonly active: boolean
  readonly dirty: boolean
  readonly comments: readonly DocumentReviewComment[]
  readonly onCapture: (range: ReviewSourceRange) => void
  readonly onOpenComment: (comment: DocumentReviewComment) => void
  readonly onSourceRange: (range?: ReviewSourceRange) => void
  readonly onExit: () => void
}

export interface DocumentReviewInteraction {
  readonly available: boolean
  readonly active: boolean
  readonly dirty: boolean
  readonly comments: readonly DocumentReviewComment[]
  readonly sourceRange?: ReviewSourceRange
  readonly pendingRange?: ReviewSourceRange
  readonly reanchorCommentId?: string
  readonly error?: string
  readonly commentNavigation?: { readonly id: string; readonly request: number }
  readonly inBatch: ReadonlySet<string>
  readonly activeBatchId?: string
  readonly activeBatchCount: number
  readonly historyCount: number
  readonly delivery: DocumentReviewDeliveryInteraction
  readonly projection?: DocumentReviewDocumentProjection
  readonly toggle: () => void
  readonly exit: () => void
  readonly captureSource: () => void
  readonly submit: (body: string) => Promise<void>
  readonly cancelCapture: () => void
  readonly edit: (commentId: string, body: string) => void
  readonly remove: (commentId: string) => void
  readonly beginReanchor: (commentId: string) => void
  readonly resolve: (commentId: string) => void
  readonly clearHistory: () => void
  readonly reviewStale: (commentId: string) => void
  readonly toggleBatch: (commentId: string) => void
  readonly navigate: (comment: DocumentReviewComment) => void
}

export function useDocumentReviewInteraction(
  document: DocumentReviewDocumentInput | undefined,
  binding: DocumentReviewWorkspaceBinding | undefined,
  onNavigate: (line: number) => void,
): DocumentReviewInteraction {
  const [active, setActive] = useState(false)
  const [sourceRange, setSourceRange] = useState<ReviewSourceRange>()
  const [pendingRange, setPendingRange] = useState<ReviewSourceRange>()
  const [reanchorCommentId, setReanchorCommentId] = useState<string>()
  const [error, setError] = useState<string>()
  const [commentNavigation, setCommentNavigation] = useState<{
    readonly id: string
    readonly request: number
  }>()
  const current = useRef({ document, binding })
  const captureGeneration = useRef(0)
  const commentNavigationRequest = useRef(0)
  const delivery = useDocumentReviewDelivery(binding)
  current.current = { document, binding }

  const model = binding?.state.status === 'ready' ? binding.state.model : undefined
  const available = Boolean(
    document &&
    document.mode !== 'diff' &&
    renderedFileType(document.path) === 'markdown' &&
    model,
  )
  const comments = useMemo(() => {
    if (!available || !document || !model) return []
    const selected = selectDocumentReviewComments(model, document.path)
    return selected.ok ? selected.value : []
    // Host and path are the stable document identity; the loaded content does not
    // change which durable records are projected.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [available, document?.path.hostId, document?.path.path, model])
  const activeBatch = model?.batches.find((batch) => batch.id === ACTIVE_BATCH_ID)
  const historyCount =
    model?.comments.filter((comment) => comment.lifecycle !== 'draft').length ?? 0
  const inBatch = useMemo(
    () => new Set(activeBatch?.commentIds ?? []),
    [activeBatch?.commentIds],
  )

  const exit = useCallback((): void => {
    captureGeneration.current += 1
    setActive(false)
    setSourceRange(undefined)
    setPendingRange(undefined)
    setReanchorCommentId(undefined)
    setCommentNavigation(undefined)
    setError(undefined)
  }, [])
  useEffect(() => {
    if (!available) exit()
  }, [available, exit])
  useEffect(() => {
    captureGeneration.current += 1
    setPendingRange(undefined)
    setReanchorCommentId(undefined)
    setCommentNavigation(undefined)
    setError(undefined)
  }, [
    binding?.state.workspace?.id,
    binding?.state.workspace?.root.hostId,
    binding?.state.workspace?.root.path,
    binding?.state.workspaceGeneration,
    document?.content,
    document?.path.hostId,
    document?.path.path,
  ])
  useEffect(
    () => () => {
      captureGeneration.current += 1
    },
    [],
  )

  const apply = useCallback((action: DocumentReviewAction): boolean => {
    const result = current.current.binding?.apply(action)
    if (!result) {
      setError('Document review is still restoring this workspace')
      return false
    }
    if (!result.ok) {
      setError(result.error.message)
      return false
    }
    setError(undefined)
    return true
  }, [])

  const capture = useCallback(
    async (
      range: ReviewSourceRange,
      commentId?: string,
      body?: string,
    ): Promise<void> => {
      const snapshot = current.current
      const target = snapshot.document
      const workspace = snapshot.binding?.state.model?.workspace
      if (!target || !workspace || target.dirty) {
        setError('Save or reload this Markdown document before capturing a location')
        return
      }
      const content = target.content
      const path = target.path
      const generation = (captureGeneration.current += 1)
      let read: DocumentReviewRevalidation
      try {
        read = await snapshot.binding!.readDocument(path)
      } catch (reason) {
        if (captureGeneration.current === generation) {
          setError(
            reason instanceof Error
              ? reason.message
              : 'The on-disk review snapshot could not be prepared',
          )
        }
        return
      }
      if (captureGeneration.current !== generation) return
      if (read.status === 'stale') {
        setError(captureReadError(read.reason))
        return
      }
      const latest = current.current.document
      if (
        !latest ||
        latest.dirty ||
        latest.content !== content ||
        !hostPathEquals(latest.path, path)
      ) {
        setError('The document changed while its review location was being captured')
        return
      }
      if (!hostPathEquals(read.document, path) || read.content !== content) {
        setError(
          'The on-disk Markdown changed before capture. Reload it and choose the location again.',
        )
        return
      }
      const captured: ReviewAnchorCapture = createDocumentReviewCapture(read, range)
      if (
        apply(
          commentId
            ? {
                type: 'reanchor-comment',
                workspace,
                commentId,
                capture: captured,
              }
            : {
                type: 'add-comment',
                workspace,
                commentId: crypto.randomUUID(),
                body: body ?? '',
                capture: captured,
              },
        )
      ) {
        setPendingRange(undefined)
        setReanchorCommentId(undefined)
      }
    },
    [apply],
  )

  const requestCapture = useCallback(
    (range: ReviewSourceRange): void => {
      if (current.current.document?.dirty) {
        setError('Save or reload this Markdown document before capturing a location')
        return
      }
      if (reanchorCommentId) void capture(range, reanchorCommentId)
      else {
        setPendingRange(range)
        setError(undefined)
      }
    },
    [capture, reanchorCommentId],
  )
  const acceptSourceRange = useCallback((range?: ReviewSourceRange): void => {
    setSourceRange((currentRange) =>
      currentRange?.startLine === range?.startLine &&
      currentRange?.endLine === range?.endLine
        ? currentRange
        : range,
    )
  }, [])
  const openComment = useCallback((comment: DocumentReviewComment): void => {
    setActive(true)
    setPendingRange(undefined)
    setReanchorCommentId(undefined)
    setError(undefined)
    setCommentNavigation({
      id: comment.id,
      request: (commentNavigationRequest.current += 1),
    })
  }, [])
  const submit = useCallback(
    async (body: string): Promise<void> => {
      if (!pendingRange) return
      await capture(pendingRange, undefined, body)
    },
    [capture, pendingRange],
  )
  const workspaceAction = useCallback(
    (
      build: (workspace: NonNullable<typeof model>['workspace']) => DocumentReviewAction,
    ): void => {
      const workspace = current.current.binding?.state.model?.workspace
      if (workspace) apply(build(workspace))
    },
    [apply],
  )

  const projection = useMemo<DocumentReviewDocumentProjection | undefined>(
    () =>
      available
        ? {
            active,
            dirty: Boolean(document?.dirty),
            comments,
            onCapture: requestCapture,
            onOpenComment: openComment,
            onSourceRange: acceptSourceRange,
            onExit: exit,
          }
        : undefined,
    [
      acceptSourceRange,
      active,
      available,
      comments,
      document?.dirty,
      exit,
      openComment,
      requestCapture,
    ],
  )

  return {
    available,
    active,
    dirty: Boolean(document?.dirty),
    comments,
    sourceRange,
    pendingRange,
    reanchorCommentId,
    error,
    commentNavigation,
    inBatch,
    activeBatchId: activeBatch?.id,
    activeBatchCount: activeBatch?.commentIds.length ?? 0,
    historyCount,
    delivery,
    projection,
    toggle: () => {
      if (!available) return
      if (active) exit()
      else {
        setActive(true)
        setError(undefined)
      }
    },
    exit,
    captureSource: () => {
      if (sourceRange) requestCapture(sourceRange)
    },
    submit,
    cancelCapture: () => {
      captureGeneration.current += 1
      setPendingRange(undefined)
      setReanchorCommentId(undefined)
      setError(undefined)
    },
    edit: (commentId, body) =>
      workspaceAction((workspace) => ({
        type: 'edit-comment',
        workspace,
        commentId,
        body,
      })),
    remove: (commentId) =>
      workspaceAction((workspace) => ({
        type: 'remove-comment',
        workspace,
        commentId,
      })),
    beginReanchor: (commentId) => {
      if (document?.dirty) {
        setError('Save or reload this Markdown document before re-anchoring a comment')
        return
      }
      setActive(true)
      setPendingRange(undefined)
      setReanchorCommentId(commentId)
      setError(undefined)
    },
    resolve: (commentId) =>
      workspaceAction((workspace) => ({
        type: 'resolve-comment',
        workspace,
        commentId,
      })),
    clearHistory: () =>
      workspaceAction((workspace) => ({
        type: 'clear-history',
        workspace,
        history: 'all',
      })),
    reviewStale: (commentId) =>
      workspaceAction((workspace) => ({
        type: 'review-stale',
        workspace,
        commentId,
      })),
    toggleBatch: (commentId) =>
      workspaceAction((workspace) =>
        inBatch.has(commentId)
          ? {
              type: 'remove-from-batch',
              workspace,
              batchId: ACTIVE_BATCH_ID,
              commentId,
            }
          : activeBatch
            ? {
                type: 'add-to-batch',
                workspace,
                batchId: ACTIVE_BATCH_ID,
                commentId,
              }
            : {
                type: 'create-batch',
                workspace,
                batchId: ACTIVE_BATCH_ID,
                commentIds: [commentId],
              },
      ),
    navigate: (comment) => onNavigate(comment.anchor.range.startLine),
  }
}

function captureReadError(
  reason: Extract<DocumentReviewRevalidation, { status: 'stale' }>['reason'],
): string {
  switch (reason) {
    case 'deleted':
      return 'The on-disk Markdown document no longer exists'
    case 'host-unavailable':
      return 'The document host is unavailable for review capture'
    case 'incomplete-read':
      return 'The on-disk Markdown document exceeds the review read limit'
    case 'invalid-text':
      return 'The on-disk document is not valid reviewable Markdown text'
  }
}
