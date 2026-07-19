import { useEffect, useRef, useState } from 'react'

import { hostPath, unwrapOperation, type HostPath } from '../../../shared'
import { editorErrorMessage } from './harness-profile-editor-policy'
import { HarnessProfileRequestPolicy } from './harness-profile-request-policy'

export function useHarnessFolderPicker(root: HostPath, open: boolean) {
  const [current, setCurrent] = useState(root)
  const [directories, setDirectories] = useState<readonly { readonly name: string }[]>([])
  const [error, setError] = useState<string>()
  const policy = useRef(new HarnessProfileRequestPolicy())

  useEffect(() => {
    if (!open) {
      policy.current.switchWorkspace()
      return
    }
    policy.current.switchWorkspace()
    setCurrent(root)
    setDirectories([])
    setError(undefined)
  }, [open, root])

  useEffect(() => {
    if (!open) return
    const policyOwner = policy.current
    const channel = `browse:${current.path}` as const
    const token = policyOwner.start(channel)
    void window.hvir
      .invoke('project:browse-host', { hostId: root.hostId, path: current.path })
      .then((response) => {
        if (!policyOwner.isCurrent(token)) return
        try {
          const listing = unwrapOperation(response)
          setCurrent(listing.path)
          setDirectories(listing.directories)
          setError(undefined)
        } catch (reason) {
          setError(editorErrorMessage(reason))
        }
      })
      .catch((reason: unknown) => {
        if (policyOwner.isCurrent(token)) setError(editorErrorMessage(reason))
      })
    return () => policyOwner.invalidate(channel)
  }, [current.path, open, root.hostId])

  const parent =
    current.path === '/' ? '/' : current.path.replace(/\/+[^/]+\/?$/, '') || '/'
  return {
    current,
    directories,
    error,
    parent: hostPath(root.hostId, parent),
    navigate: setCurrent,
  }
}
