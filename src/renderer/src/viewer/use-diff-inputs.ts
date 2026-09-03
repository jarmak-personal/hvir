import { useEffect, useRef, useState } from 'react'

import type { DiffBase, GitDiffResponse, HostPath } from '../../../shared'

interface DiffInputsRequest {
  readonly contextKey: string
  readonly path: HostPath
  readonly base: DiffBase
  readonly revision?: string
  readonly documentRefreshVersion: number
  readonly gitRefreshVersion: number
}

interface DiffInputsState {
  readonly contextKey: string
  readonly inputs?: GitDiffResponse
  readonly error?: string
}

/** Owns one host-qualified diff-input request generation and its settled presentation. */
export function useDiffInputs(request: DiffInputsRequest): DiffInputsState {
  const requestRef = useRef(request)
  const control = useRef({
    contextKey: request.contextKey,
    generation: 0,
    running: false,
    queued: false,
    disposed: false,
  })
  const [state, setState] = useState<DiffInputsState>({
    contextKey: request.contextKey,
  })
  requestRef.current = request

  useEffect(() => {
    const owner = control.current
    owner.disposed = false
    return () => {
      owner.disposed = true
      owner.generation += 1
      owner.queued = false
    }
  }, [])

  useEffect(() => {
    const owner = control.current
    if (owner.contextKey !== request.contextKey) {
      owner.contextKey = request.contextKey
      owner.generation += 1
      owner.queued = false
    }
    owner.queued = true
    if (owner.running) return
    owner.running = true
    void (async () => {
      try {
        while (owner.queued && !owner.disposed) {
          owner.queued = false
          const current = requestRef.current
          const generation = owner.generation
          const requestKey = current.contextKey
          setState((settled) =>
            settled.contextKey === requestKey && settled.error
              ? { ...settled, error: undefined }
              : settled,
          )
          try {
            const inputs = await window.hvir.invoke('git:diff-inputs', {
              path: current.path,
              base: current.base,
              revision: current.revision,
            })
            if (
              owner.disposed ||
              owner.generation !== generation ||
              requestRef.current.contextKey !== requestKey
            ) {
              continue
            }
            setState({ contextKey: requestKey, inputs })
          } catch (reason) {
            if (
              owner.disposed ||
              owner.queued ||
              owner.generation !== generation ||
              requestRef.current.contextKey !== requestKey
            ) {
              continue
            }
            const error = reason instanceof Error ? reason.message : String(reason)
            setState((settled) =>
              settled.contextKey === requestKey
                ? { ...settled, error }
                : { contextKey: requestKey, error },
            )
          }
        }
      } finally {
        owner.running = false
      }
    })()
  }, [request.contextKey, request.documentRefreshVersion, request.gitRefreshVersion])

  return state.contextKey === request.contextKey
    ? state
    : { contextKey: request.contextKey }
}

export function diffInputContextKey(
  path: HostPath,
  base: DiffBase,
  revision?: string,
): string {
  return `${path.hostId}\0${path.path}\0${base}\0${revision ?? ''}`
}
