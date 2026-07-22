import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from 'react'

import { hostPathEquals, type HostPath } from '../../../shared'
import { editorErrorMessage } from './harness-profile-editor-policy'

export type HarnessProfileLoadState = 'idle' | 'loading' | 'ready' | 'error'

export function useHarnessProfileLoad(
  workspaceRoot: HostPath | undefined,
  setError: Dispatch<SetStateAction<string | undefined>>,
) {
  const [loadState, setLoadState] = useState<HarnessProfileLoadState>(
    workspaceRoot ? 'loading' : 'idle',
  )
  const rootRef = useRef(workspaceRoot)
  rootRef.current = workspaceRoot

  const reset = useCallback((): void => {
    setLoadState(rootRef.current ? 'loading' : 'idle')
  }, [])

  const reload = useCallback(
    (load: () => Promise<void>): void => {
      const requestRoot = rootRef.current
      if (!requestRoot) {
        setLoadState('idle')
        return
      }
      setLoadState('loading')
      setError(undefined)
      void load().then(
        () => {
          if (rootRef.current && hostPathEquals(rootRef.current, requestRoot)) {
            setLoadState('ready')
          }
        },
        (reason: unknown) => {
          if (rootRef.current && hostPathEquals(rootRef.current, requestRoot)) {
            setError(editorErrorMessage(reason))
            setLoadState('error')
          }
        },
      )
    },
    [setError],
  )

  return { loadState, reset, reload }
}
