import { useCallback, useEffect, useRef, useState } from 'react'

import {
  hostPath,
  unwrapOperation,
  type ExternalFileGrantDescriptor,
  type ExternalMovePickerSelection,
  type HostPath,
  type ProjectFileExternalMoveDisclosure,
  type ProjectFileOperationProgress,
  type ProjectFileOperationResult,
} from '../../../shared'
import { projectFileOwnerKey } from './project-file-owner-key'
import { useProjectFileOperation } from './use-project-file-operation'

interface ExternalMoveDialogBase {
  readonly id: number
  readonly workspaceRoot: HostPath
  readonly destinationDirectory: HostPath
  readonly disclosure: Extract<
    ProjectFileExternalMoveDisclosure,
    { readonly outcome: 'available' }
  >
}

export type ExternalMoveDialogRequest =
  | (ExternalMoveDialogBase & { readonly stage: 'selection' })
  | (ExternalMoveDialogBase & {
      readonly stage: 'confirmation'
      readonly grant: ExternalFileGrantDescriptor
    })

export interface ExternalFileMoveController {
  readonly dialog?: ExternalMoveDialogRequest
  readonly pending: boolean
  readonly progress?: ProjectFileOperationProgress
  begin(destinationDirectory: HostPath): void
  choose(selection: ExternalMovePickerSelection): void
  confirm(): void
  dismiss(): void
  cancel(): void
}

export function useExternalFileMove(options: {
  readonly root: HostPath
  readonly onOpen: () => void
  readonly onStart: () => void
  readonly onComplete: (result: ProjectFileOperationResult | undefined) => void
  readonly onError: (message: string) => void
}): ExternalFileMoveController {
  const callbacks = useRef({
    onOpen: options.onOpen,
    onStart: options.onStart,
    onComplete: options.onComplete,
    onError: options.onError,
  })
  callbacks.current = {
    onOpen: options.onOpen,
    onStart: options.onStart,
    onComplete: options.onComplete,
    onError: options.onError,
  }
  const [dialog, setDialog] = useState<ExternalMoveDialogRequest>()
  const [acquiring, setAcquiring] = useState(false)
  const nextId = useRef(0)
  const activeDialogId = useRef<number | undefined>(undefined)
  const pendingGrant = useRef<ExternalFileGrantDescriptor | undefined>(undefined)
  const alive = useRef(true)
  const ownerKey = projectFileOwnerKey(options.root)
  const latestOwnerKey = useRef(ownerKey)
  latestOwnerKey.current = ownerKey
  const handleStart = useCallback(() => callbacks.current.onStart(), [])
  const handleComplete = useCallback(
    (result: ProjectFileOperationResult | undefined) =>
      callbacks.current.onComplete(result),
    [],
  )
  const handleError = useCallback(
    (message: string) => callbacks.current.onError(message),
    [],
  )
  const operation = useProjectFileOperation({
    root: options.root,
    onStart: handleStart,
    onComplete: handleComplete,
    onError: handleError,
  })
  const releaseGrant = useCallback((grant: ExternalFileGrantDescriptor) => {
    if (
      pendingGrant.current?.grantId === grant.grantId &&
      pendingGrant.current.generation === grant.generation
    ) {
      pendingGrant.current = undefined
    }
    void window.hvir
      .invoke('fs:release-external-move-grant', {
        grantId: grant.grantId,
        grantGeneration: grant.generation,
      })
      .catch(() => undefined)
  }, [])
  const releasePendingGrant = useCallback(() => {
    const grant = pendingGrant.current
    if (grant) releaseGrant(grant)
  }, [releaseGrant])

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  useEffect(() => () => releasePendingGrant(), [ownerKey, releasePendingGrant])
  useEffect(() => {
    activeDialogId.current = undefined
    setDialog(undefined)
    setAcquiring(false)
  }, [ownerKey])

  const begin = useCallback(
    (destinationDirectory: HostPath) => {
      if (acquiring || operation.pending) return
      const id = (nextId.current += 1)
      activeDialogId.current = id
      const requestOwnerKey = ownerKey
      const workspaceRoot = hostPath(options.root.hostId, options.root.path)
      const destination = hostPath(destinationDirectory.hostId, destinationDirectory.path)
      callbacks.current.onOpen()
      setAcquiring(true)
      void window.hvir
        .invoke('fs:external-move-disclosure', undefined)
        .then(unwrapOperation)
        .then((disclosure) => {
          if (!alive.current || latestOwnerKey.current !== requestOwnerKey) return
          if (disclosure.outcome === 'unavailable') {
            callbacks.current.onError(disclosure.reason)
            return
          }
          setDialog({
            id,
            stage: 'selection',
            workspaceRoot,
            destinationDirectory: destination,
            disclosure,
          })
        })
        .catch((reason: unknown) => {
          if (alive.current && latestOwnerKey.current === requestOwnerKey) {
            callbacks.current.onError(
              reason instanceof Error ? reason.message : 'External move is unavailable',
            )
          }
        })
        .finally(() => {
          if (alive.current && latestOwnerKey.current === requestOwnerKey) {
            setAcquiring(false)
          }
        })
    },
    [acquiring, operation.pending, options.root, ownerKey],
  )

  const choose = useCallback(
    (selection: ExternalMovePickerSelection) => {
      if (!dialog || dialog.stage !== 'selection' || acquiring || operation.pending) {
        return
      }
      const request = dialog
      const requestOwnerKey = projectFileOwnerKey(request.workspaceRoot)
      setAcquiring(true)
      void window.hvir
        .invoke('fs:acquire-external-move-files', { selection })
        .then(unwrapOperation)
        .then((result) => {
          if (
            !alive.current ||
            latestOwnerKey.current !== requestOwnerKey ||
            activeDialogId.current !== request.id
          ) {
            if (result.outcome === 'available') releaseGrant(result.grant)
            return
          }
          if (result.outcome === 'cancelled') return
          if (result.outcome === 'unsupported') {
            callbacks.current.onError(result.reason)
            return
          }
          pendingGrant.current = result.grant
          setDialog({ ...request, stage: 'confirmation', grant: result.grant })
        })
        .catch((reason: unknown) => {
          if (alive.current && latestOwnerKey.current === requestOwnerKey) {
            callbacks.current.onError(
              reason instanceof Error ? reason.message : 'The native picker failed',
            )
          }
        })
        .finally(() => {
          if (alive.current && latestOwnerKey.current === requestOwnerKey) {
            setAcquiring(false)
          }
        })
    },
    [acquiring, dialog, operation.pending, releaseGrant],
  )

  const confirm = useCallback(() => {
    if (!dialog || dialog.stage !== 'confirmation' || acquiring) return
    const request = dialog
    if (
      operation.start(
        () =>
          window.hvir
            .invoke('fs:move-external', {
              workspaceRoot: request.workspaceRoot,
              destinationDirectory: request.destinationDirectory,
              grantId: request.grant.grantId,
              grantGeneration: request.grant.generation,
            })
            .finally(() => releaseGrant(request.grant)),
        'moving-external',
        'The external move could not start',
      )
    ) {
      activeDialogId.current = undefined
      setDialog(undefined)
    }
  }, [acquiring, dialog, operation, releaseGrant])

  return {
    dialog,
    pending: acquiring || operation.pending,
    progress: operation.progress,
    begin,
    choose,
    confirm,
    dismiss() {
      if (!acquiring && !operation.pending) {
        if (dialog?.stage === 'confirmation') releaseGrant(dialog.grant)
        activeDialogId.current = undefined
        setDialog(undefined)
      }
    },
    cancel: () => operation.cancel(),
  }
}
