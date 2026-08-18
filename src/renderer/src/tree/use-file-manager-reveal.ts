import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from 'react'

import { unwrapOperation, type FileType, type HostPath } from '../../../shared'
import { canRevealInFileManager } from './file-manager-reveal'
import type { FileActionFeedback } from './file-operation-feedback'
import { projectFileOwnerKey } from './project-file-owner-key'
import type { FileActionMenuRequest } from './use-file-create-actions'

interface RevealRequest {
  readonly target: HostPath
  readonly targetType: FileType
}

interface FileManagerRevealController {
  readonly available: boolean
  readonly run: () => void
}

/** Own the one-shot native reveal effect and reject completion after workspace change. */
export function useFileManagerReveal(
  root: HostPath,
  request: RevealRequest | undefined,
  pending: boolean,
  setPending: Dispatch<SetStateAction<boolean>>,
  setMenu: Dispatch<SetStateAction<FileActionMenuRequest | undefined>>,
  setFeedback: Dispatch<SetStateAction<FileActionFeedback | undefined>>,
): FileManagerRevealController {
  const alive = useRef(true)
  const ownerKey = projectFileOwnerKey(root)
  const latestOwnerKey = useRef(ownerKey)
  latestOwnerKey.current = ownerKey

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const run = useCallback(() => {
    if (!request || pending || !canRevealInFileManager(root, request.targetType)) return
    const actionOwnerKey = ownerKey
    setPending(true)
    setFeedback(undefined)
    setMenu(undefined)
    void window.hvir
      .invoke('fs:reveal-entry', { workspaceRoot: root, path: request.target })
      .then(unwrapOperation)
      .then(
        () => {
          if (!alive.current || latestOwnerKey.current !== actionOwnerKey) return
          setPending(false)
        },
        () => {
          if (!alive.current || latestOwnerKey.current !== actionOwnerKey) return
          setPending(false)
          setFeedback({
            kind: 'error',
            message: 'Could not reveal the entry in the file manager.',
          })
        },
      )
  }, [ownerKey, pending, request, root, setFeedback, setMenu, setPending])

  return {
    available: Boolean(request && canRevealInFileManager(root, request.targetType)),
    run,
  }
}
