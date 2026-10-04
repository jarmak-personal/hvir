import { useCallback, useEffect, useRef, useState } from 'react'
import {
  containsHostPath,
  hostPathEquals,
  type HostPath,
  type HvirApi,
} from '../../../shared'
import type { DirectoryTreeRevealRequest } from '../tree/directory-tree-reveal'

/** Files navigation shares one workspace-scoped selection lifetime across admitted origins. */
export function useWorkspaceDirectoryReveal(
  root: HostPath | undefined,
  selectedFile: HostPath | undefined,
  workspaceId: string | undefined,
  focusFiles: () => void,
): {
  readonly reveal: (path: HostPath) => void
  readonly clear: () => void
  readonly request?: DirectoryTreeRevealRequest
} {
  const mounted = useRef(false),
    token = useRef(0),
    latest = useRef({ root, selectedFile, workspaceId, focusFiles })
  latest.current = { root, selectedFile, workspaceId, focusFiles }
  const ownerKey = JSON.stringify([root, workspaceId]),
    generation = useRef({ key: ownerKey, serial: 0 })
  if (generation.current.key !== ownerKey)
    generation.current = { key: ownerKey, serial: generation.current.serial + 1 }
  const [state, setState] = useState<{
    readonly root: HostPath
    readonly generation: number
    readonly selectedFile?: HostPath
    readonly request: DirectoryTreeRevealRequest
  }>()
  const reveal = useCallback((path: HostPath) => {
    const current = latest.current
    if (!mounted.current || !current.root || !containsHostPath(current.root, path)) return
    setState({
      root: current.root,
      generation: generation.current.serial,
      selectedFile: current.selectedFile,
      request: { path, token: ++token.current },
    })
    current.focusFiles()
  }, [])
  const clear = useCallback(() => setState(undefined), [])
  useEffect(() => {
    mounted.current = true
    const api = (globalThis as unknown as { readonly window: { readonly hvir: HvirApi } })
      .window.hvir
    const stop = api.on('extensions:files-reveal', (request) => {
      const current = latest.current
      if (
        !current.root ||
        request.workspaceId !== current.workspaceId ||
        !hostPathEquals(request.root, current.root)
      )
        return
      reveal(request.path)
    })
    return () => {
      mounted.current = false
      void stop()
    }
  }, [reveal])
  const sameSelected =
    !state?.selectedFile || !selectedFile
      ? state?.selectedFile === selectedFile
      : hostPathEquals(state.selectedFile, selectedFile)
  return {
    reveal,
    clear,
    request:
      state &&
      state.generation === generation.current.serial &&
      root &&
      hostPathEquals(state.root, root) &&
      sameSelected
        ? state.request
        : undefined,
  }
}
