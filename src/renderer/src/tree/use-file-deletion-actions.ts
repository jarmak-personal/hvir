import { useCallback, useEffect, useRef, useState } from 'react'

import {
  basenameHostPath,
  hostPath,
  hostPathEquals,
  unwrapOperation,
  type HostPath,
  type ProjectFileDeletionDisclosure,
  type ProjectFileOperationProgress,
  type ProjectFileOperationResult,
} from '../../../shared'
import type {
  ViewerPathRemovalReview,
  ViewerPathRemovalResult,
} from '../viewer/viewer-path-removal'
import { projectFileOwnerKey } from './project-file-owner-key'
import { useProjectFileOperation } from './use-project-file-operation'

export type FileDeletionMenuState =
  | { readonly state: 'idle' }
  | { readonly state: 'loading'; readonly source: HostPath }
  | {
      readonly state: 'available'
      readonly disclosure: Extract<
        ProjectFileDeletionDisclosure,
        { outcome: 'available' }
      >
    }
  | {
      readonly state: 'unavailable'
      readonly source: HostPath
      readonly reason: string
    }

export interface FileDeletionDialogRequest {
  readonly id: number
  readonly workspaceRoot: HostPath
  readonly source: HostPath
  readonly recovery: 'recoverable' | 'permanent'
}

export interface FileDeletionActionsController {
  readonly menu: FileDeletionMenuState
  readonly dialog?: FileDeletionDialogRequest
  readonly dialogError?: string
  readonly pending: boolean
  readonly progress?: ProjectFileOperationProgress
  inspect(source?: HostPath): void
  begin(): void
  confirm(permanentEntryName: string): void
  dismiss(): void
  cancel(): void
}

export function useFileDeletionActions(options: {
  readonly root: HostPath
  readonly reviewPathRemoval: (target: HostPath) => ViewerPathRemovalReview
  readonly closeCleanPath: (target: HostPath) => ViewerPathRemovalResult
  readonly onStart: () => void
  readonly onComplete: (
    result: ProjectFileOperationResult | undefined,
    viewerCleanup?: ViewerPathRemovalResult,
  ) => void
  readonly onError: (message: string) => void
}): FileDeletionActionsController {
  const { root, onStart } = options
  const latest = useRef(options)
  latest.current = options
  const [menu, setMenu] = useState<FileDeletionMenuState>({ state: 'idle' })
  const [dialog, setDialog] = useState<FileDeletionDialogRequest>()
  const [dialogError, setDialogError] = useState<string>()
  const nextId = useRef(0)
  const inspectionId = useRef(0)
  const activeSource = useRef<HostPath | undefined>(undefined)
  const ownerKey = projectFileOwnerKey(root)
  const finish = useCallback((result: ProjectFileOperationResult | undefined) => {
    const source = activeSource.current
    activeSource.current = undefined
    const item = result?.outcome === 'completed' ? result.items[0] : undefined
    const cleanup =
      source &&
      item?.status === 'completed' &&
      (item.effect === 'trashed-entry' || item.effect === 'permanently-deleted-entry')
        ? latest.current.closeCleanPath(source)
        : undefined
    setDialog(undefined)
    setDialogError(undefined)
    latest.current.onComplete(result, cleanup)
  }, [])
  const fail = useCallback((message: string) => {
    activeSource.current = undefined
    setDialogError(message)
    latest.current.onError(message)
  }, [])
  const operation = useProjectFileOperation({
    root,
    onStart,
    onComplete: finish,
    onError: fail,
  })

  useEffect(() => {
    inspectionId.current += 1
    activeSource.current = undefined
    setMenu({ state: 'idle' })
    setDialog(undefined)
    setDialogError(undefined)
  }, [ownerKey])

  return {
    menu,
    dialog,
    dialogError,
    pending: operation.pending,
    progress: operation.progress,
    inspect(source) {
      const id = (inspectionId.current += 1)
      if (!source || hostPathEquals(source, root)) {
        setMenu({ state: 'idle' })
        return
      }
      const snapshot = hostPath(source.hostId, source.path)
      setMenu({ state: 'loading', source: snapshot })
      void Promise.resolve()
        .then(() =>
          window.hvir.invoke('fs:deletion-disclosure', {
            workspaceRoot: root,
            source: snapshot,
          }),
        )
        .then(unwrapOperation)
        .then(
          (disclosure) => {
            if (inspectionId.current !== id) return
            setMenu(
              disclosure.outcome === 'available'
                ? { state: 'available', disclosure }
                : {
                    state: 'unavailable',
                    source: disclosure.source,
                    reason: disclosure.reason,
                  },
            )
          },
          (reason: unknown) => {
            if (inspectionId.current !== id) return
            setMenu({
              state: 'unavailable',
              source: snapshot,
              reason:
                reason instanceof Error
                  ? reason.message
                  : 'Deletion capability could not be inspected',
            })
          },
        )
    },
    begin() {
      if (operation.pending || menu.state !== 'available') return
      const review = latest.current.reviewPathRemoval(menu.disclosure.source)
      if (review.dirtyPaths.length > 0) {
        latest.current.onError(dirtyBufferMessage(review.dirtyPaths.length))
        return
      }
      setDialog({
        id: (nextId.current += 1),
        workspaceRoot: menu.disclosure.workspaceRoot,
        source: menu.disclosure.source,
        recovery: menu.disclosure.recovery,
      })
      setDialogError(undefined)
    },
    confirm(permanentEntryName) {
      if (!dialog || operation.pending) return
      const review = latest.current.reviewPathRemoval(dialog.source)
      if (review.dirtyPaths.length > 0) {
        setDialogError(dirtyBufferMessage(review.dirtyPaths.length))
        return
      }
      if (
        dialog.recovery === 'permanent' &&
        permanentEntryName !== basenameHostPath(dialog.source)
      ) {
        setDialogError('Type the exact entry name to confirm permanent deletion.')
        return
      }
      const accepted = operation.start(
        () =>
          window.hvir.invoke('fs:delete-entry', {
            workspaceRoot: dialog.workspaceRoot,
            source: dialog.source,
            confirmedRecovery: dialog.recovery,
          }),
        'deleting',
        'The deletion could not start',
      )
      if (accepted) activeSource.current = dialog.source
    },
    dismiss() {
      if (operation.pending) return
      activeSource.current = undefined
      setDialog(undefined)
      setDialogError(undefined)
    },
    cancel: () => operation.cancel(),
  }
}

function dirtyBufferMessage(count: number): string {
  return `${count} open ${count === 1 ? 'buffer has' : 'buffers have'} unsaved changes at or beneath this entry. Save or close ${count === 1 ? 'it' : 'them'} before deleting.`
}
