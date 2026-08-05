import { useCallback, useEffect, useRef, useState } from 'react'

import {
  unwrapOperation,
  type ExternalFileGrantResult,
  type HostPath,
  type OperationResult,
  type ProjectFileOperationProgress,
  type ProjectFileOperationResult,
} from '../../../shared'

export interface ExternalFileCopyController {
  readonly pending: boolean
  readonly progress?: ProjectFileOperationProgress
  copyClipboard(destinationDirectory: HostPath): void
  copyDropped(files: readonly File[], destinationDirectory: HostPath): void
  cancel(): void
}

export function useExternalFileCopy(options: {
  readonly root: HostPath
  readonly onStart: () => void
  readonly onComplete: (result: ProjectFileOperationResult | undefined) => void
  readonly onError: (message: string) => void
}): ExternalFileCopyController {
  const { root, onStart, onComplete, onError } = options
  const [pending, setPending] = useState(false)
  const [progress, setProgress] = useState<ProjectFileOperationProgress>()
  const active = useRef<
    { readonly operationId: string; readonly generation: number } | undefined
  >(undefined)
  const acquiring = useRef(false)
  const earlyEvent = useRef<ProjectFileOperationProgress | undefined>(undefined)
  const alive = useRef(true)
  const ownerKey = pathKey(root)
  const latestOwnerKey = useRef(ownerKey)
  latestOwnerKey.current = ownerKey

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  useEffect(() => {
    active.current = undefined
    acquiring.current = false
    earlyEvent.current = undefined
    setPending(false)
    setProgress(undefined)
  }, [ownerKey])
  const acceptEvent = useCallback(
    (event: ProjectFileOperationProgress) => {
      const operation = active.current
      if (pathKey(event.workspaceRoot) !== latestOwnerKey.current) return
      if (!operation) {
        if (acquiring.current) earlyEvent.current = event
        return
      }
      if (
        operation.operationId !== event.operationId ||
        operation.generation !== event.generation
      )
        return
      if (event.phase === 'completed') {
        active.current = undefined
        acquiring.current = false
        setProgress(undefined)
        setPending(false)
        onComplete(event.result)
      } else {
        setProgress(event)
      }
    },
    [onComplete],
  )
  useEffect(() => {
    const dispose = window.hvir.on('fs:project-file-operation', acceptEvent)
    return () => void dispose()
  }, [acceptEvent])

  const start = useCallback(
    (
      destinationDirectory: HostPath,
      acquire: () => Promise<OperationResult<ExternalFileGrantResult>>,
    ) => {
      if (pending || acquiring.current || active.current) return
      acquiring.current = true
      const requestOwnerKey = ownerKey
      onStart()
      setPending(true)
      void Promise.resolve()
        .then(acquire)
        .then(unwrapOperation)
        .then(async (grantResult) => {
          if (!alive.current || latestOwnerKey.current !== requestOwnerKey) return
          if (grantResult.outcome === 'unsupported') {
            throw new Error(grantResult.reason)
          }
          return unwrapOperation(
            await window.hvir.invoke('fs:copy-external', {
              workspaceRoot: root,
              destinationDirectory,
              grantId: grantResult.grant.grantId,
              grantGeneration: grantResult.grant.generation,
            }),
          )
        })
        .then((started) => {
          if (!started || !alive.current || latestOwnerKey.current !== requestOwnerKey) {
            return
          }
          if (started.outcome === 'busy') throw new Error(started.reason)
          active.current = {
            operationId: started.operationId,
            generation: started.generation,
          }
          acquiring.current = false
          const early = earlyEvent.current
          earlyEvent.current = undefined
          if (
            early?.operationId === started.operationId &&
            early.generation === started.generation
          ) {
            acceptEvent(early)
            return
          }
          setProgress({
            workspaceRoot: root,
            operationId: started.operationId,
            generation: started.generation,
            phase: 'copying',
            completedItems: 0,
            totalItems: started.itemCount,
          })
        })
        .catch((reason: unknown) => {
          if (!alive.current || latestOwnerKey.current !== requestOwnerKey) return
          active.current = undefined
          acquiring.current = false
          earlyEvent.current = undefined
          setProgress(undefined)
          setPending(false)
          onError(reason instanceof Error ? reason.message : 'The copy could not start')
        })
    },
    [acceptEvent, onError, onStart, ownerKey, pending, root],
  )

  return {
    pending,
    progress,
    copyClipboard: (destinationDirectory) =>
      start(destinationDirectory, () =>
        window.hvir.invoke('fs:acquire-clipboard-files', undefined),
      ),
    copyDropped: (files, destinationDirectory) =>
      start(destinationDirectory, () => window.hvir.externalFiles.acquireDropped(files)),
    cancel() {
      if (!active.current) return
      void window.hvir
        .invoke('fs:cancel-file-operation', active.current)
        .catch(() => undefined)
    },
  }
}

function pathKey(path: HostPath): string {
  return `${path.hostId}\0${path.path}`
}
