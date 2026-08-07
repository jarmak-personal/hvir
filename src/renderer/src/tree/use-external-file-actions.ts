import { useCallback, useRef } from 'react'

import type {
  FileType,
  HostPath,
  ProjectFileOperationProgress,
  ProjectFileOperationResult,
} from '../../../shared'
import { fileActionDestination } from './file-action-destination'
import {
  copyFeedback,
  externalMoveFeedback,
  projectFileResultHasEffect,
  type FileActionFeedback,
} from './file-operation-feedback'
import { useExternalFileCopy } from './use-external-file-copy'
import {
  useExternalFileMove,
  type ExternalFileMoveController,
} from './use-external-file-move'

export interface ExternalFileActionsController {
  readonly pending: boolean
  readonly progress?: ProjectFileOperationProgress
  readonly move: ExternalFileMoveController
  copyClipboard(target: HostPath, targetType: FileType): void
  copyDropped(files: readonly File[], target: HostPath, targetType: FileType): void
  beginMove(target: HostPath, targetType: FileType): void
  cancel(): void
}

/** Files-owned composition for external copy and explicit verified move workflows. */
export function useExternalFileActions(options: {
  readonly root: HostPath
  readonly onStart: () => void
  readonly onRefresh: () => void
  readonly onFeedback: (feedback: FileActionFeedback) => void
  readonly onWorkspaceContentChanged: () => void
}): ExternalFileActionsController {
  const callbacks = useRef(options)
  callbacks.current = options
  const onStart = useCallback(() => callbacks.current.onStart(), [])
  const onError = useCallback(
    (message: string) => callbacks.current.onFeedback({ kind: 'error', message }),
    [],
  )
  const complete = useCallback(
    (
      result: ProjectFileOperationResult | undefined,
      feedback: (value: ProjectFileOperationResult | undefined) => FileActionFeedback,
    ) => {
      callbacks.current.onRefresh()
      callbacks.current.onFeedback(feedback(result))
      if (projectFileResultHasEffect(result)) {
        callbacks.current.onWorkspaceContentChanged()
      }
    },
    [],
  )
  const onCopyComplete = useCallback(
    (result: ProjectFileOperationResult | undefined) => complete(result, copyFeedback),
    [complete],
  )
  const onMoveComplete = useCallback(
    (result: ProjectFileOperationResult | undefined) =>
      complete(result, externalMoveFeedback),
    [complete],
  )
  const copy = useExternalFileCopy({
    root: options.root,
    onStart,
    onComplete: onCopyComplete,
    onError,
  })
  const move = useExternalFileMove({
    root: options.root,
    onOpen: onStart,
    onStart,
    onComplete: onMoveComplete,
    onError,
  })
  return {
    pending: copy.pending || move.pending,
    progress: copy.progress ?? move.progress,
    move,
    copyClipboard: (target, targetType) =>
      copy.copyClipboard(fileActionDestination(options.root, target, targetType)),
    copyDropped: (files, target, targetType) =>
      copy.copyDropped(files, fileActionDestination(options.root, target, targetType)),
    beginMove: (target, targetType) =>
      move.begin(fileActionDestination(options.root, target, targetType)),
    cancel() {
      if (copy.pending) copy.cancel()
      else move.cancel()
    },
  }
}
