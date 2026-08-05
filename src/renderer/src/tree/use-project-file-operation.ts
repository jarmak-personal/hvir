import { useCallback, useEffect, useRef, useState } from 'react'

import {
  unwrapOperation,
  type HostPath,
  type OperationResult,
  type ProjectFileOperationProgress,
  type ProjectFileOperationResult,
  type ProjectFileOperationStartResult,
} from '../../../shared'

export interface StartedProjectFileOperationController {
  readonly pending: boolean
  readonly progress?: ProjectFileOperationProgress
  start(
    launch: () => Promise<OperationResult<ProjectFileOperationStartResult>>,
    phase: ProjectFileOperationProgress['phase'],
    errorFallback: string,
  ): boolean
  cancel(): void
}

export function useProjectFileOperation(options: {
  readonly root: HostPath
  readonly onStart: () => void
  readonly onComplete: (result: ProjectFileOperationResult | undefined) => void
  readonly onError: (message: string) => void
}): StartedProjectFileOperationController {
  const { root, onStart, onComplete, onError } = options
  const [pending, setPending] = useState(false)
  const [progress, setProgress] = useState<ProjectFileOperationProgress>()
  const active = useRef<
    { readonly operationId: string; readonly generation: number } | undefined
  >(undefined)
  const launching = useRef(false)
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
    launching.current = false
    earlyEvent.current = undefined
    setPending(false)
    setProgress(undefined)
  }, [ownerKey])
  const acceptEvent = useCallback(
    (event: ProjectFileOperationProgress) => {
      const operation = active.current
      if (pathKey(event.workspaceRoot) !== latestOwnerKey.current) return
      if (!operation) {
        if (launching.current) earlyEvent.current = event
        return
      }
      if (
        operation.operationId !== event.operationId ||
        operation.generation !== event.generation
      ) {
        return
      }
      if (event.phase === 'completed') {
        active.current = undefined
        launching.current = false
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
      launch: () => Promise<OperationResult<ProjectFileOperationStartResult>>,
      phase: ProjectFileOperationProgress['phase'],
      errorFallback: string,
    ) => {
      if (launching.current || active.current) return false
      launching.current = true
      const requestOwnerKey = ownerKey
      onStart()
      setPending(true)
      void Promise.resolve()
        .then(launch)
        .then(unwrapOperation)
        .then((started) => {
          if (!alive.current || latestOwnerKey.current !== requestOwnerKey) return
          if (started.outcome === 'busy') throw new Error(started.reason)
          active.current = {
            operationId: started.operationId,
            generation: started.generation,
          }
          launching.current = false
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
            phase,
            completedItems: 0,
            totalItems: started.itemCount,
          })
        })
        .catch((reason: unknown) => {
          if (!alive.current || latestOwnerKey.current !== requestOwnerKey) return
          active.current = undefined
          launching.current = false
          earlyEvent.current = undefined
          setProgress(undefined)
          setPending(false)
          onError(reason instanceof Error ? reason.message : errorFallback)
        })
      return true
    },
    [acceptEvent, onError, onStart, ownerKey, root],
  )

  return {
    pending,
    progress,
    start,
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
