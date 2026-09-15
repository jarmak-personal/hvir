import { useCallback, useRef, useState } from 'react'
import {
  containsHostPath,
  hostPathEquals,
  type HostPath,
} from '../../../shared/host-path'

/** Completed directory navigation belongs to Files, independent of its initiating surface. */
export function useWorkspaceDirectoryReveal(
  root: HostPath | undefined,
  selectedFile: HostPath | undefined,
  focusTree: () => void,
) {
  const current = useRef({ root, selectedFile, focusTree })
  current.current = { root, selectedFile, focusTree }
  const serial = useRef(0)
  const [state, setState] = useState<{
    root: HostPath
    selectedFile?: HostPath
    request: { readonly path: HostPath; readonly token: number; readonly focusRow: true }
  }>()
  const reveal = useCallback((path: HostPath) => {
    const { root, selectedFile, focusTree } = current.current
    if (!root || !containsHostPath(root, path) || hostPathEquals(root, path)) return
    setState({
      root,
      selectedFile,
      request: { path, token: ++serial.current, focusRow: true },
    })
    focusTree()
  }, [])
  const sameFile =
    state?.selectedFile && selectedFile
      ? hostPathEquals(state.selectedFile, selectedFile)
      : state?.selectedFile === selectedFile
  return {
    reveal,
    clear: () => setState(undefined),
    request:
      state && root && hostPathEquals(state.root, root) && sameFile
        ? state.request
        : undefined,
  }
}
