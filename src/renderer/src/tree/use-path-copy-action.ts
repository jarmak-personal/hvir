import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from 'react'

import type { HostPath } from '../../../shared'
import {
  copyHostPath,
  PATH_COPY_LABELS,
  writeApplicationClipboard,
  type PathCopyKind,
} from '../path-copy/path-copy'
import type { FileActionFeedback } from './file-operation-feedback'
import { projectFileOwnerKey } from './project-file-owner-key'
import type { FileActionMenuRequest } from './use-file-create-actions'

/** Own path-copy completion and focus restoration across workspace changes. */
export function usePathCopyAction(
  root: HostPath,
  request: FileActionMenuRequest | undefined,
  pending: boolean,
  setPending: Dispatch<SetStateAction<boolean>>,
  setMenu: Dispatch<SetStateAction<FileActionMenuRequest | undefined>>,
  setFeedback: Dispatch<SetStateAction<FileActionFeedback | undefined>>,
): (kind: PathCopyKind) => void {
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

  return useCallback(
    (kind: PathCopyKind) => {
      if (!request || pending) return
      const requestOwnerKey = ownerKey
      const returnFocus = request.focusMenu ? request.returnFocus : undefined
      setPending(true)
      void copyHostPath(root, request.target, kind, writeApplicationClipboard).then(
        () => {
          if (!alive.current || latestOwnerKey.current !== requestOwnerKey) return
          setFeedback({
            kind: 'success',
            message: `${PATH_COPY_LABELS[kind].replace('Copy ', '')} copied.`,
          })
          setMenu(undefined)
          setPending(false)
          returnFocus?.focus({ preventScroll: true })
        },
        () => {
          if (!alive.current || latestOwnerKey.current !== requestOwnerKey) return
          setFeedback({
            kind: 'error',
            message: 'Could not copy the path to the clipboard.',
          })
          setMenu(undefined)
          setPending(false)
          returnFocus?.focus({ preventScroll: true })
        },
      )
    },
    [ownerKey, pending, request, root, setFeedback, setMenu, setPending],
  )
}
