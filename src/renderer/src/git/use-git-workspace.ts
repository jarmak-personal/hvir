import { useCallback, useRef, useState } from 'react'

import { unwrapOperation, type HostPath, type ProjectState } from '../../../shared'

export interface GitWorkspacePorts {
  readonly root: HostPath | undefined
  readonly hasDirtyViewerTabs: () => boolean
  readonly acceptProjectState: (state: ProjectState) => void
  readonly refreshContent: () => void
  readonly refreshGit: () => void
  readonly activateViewer: () => void
  readonly deactivateWebPane: () => void
}

export function useGitWorkspace(ports: GitWorkspacePorts) {
  const portsRef = useRef(ports)
  const [graphOpen, setGraphOpen] = useState(false)
  const [graphActive, setGraphActive] = useState(false)
  const [graphRequest, setGraphRequest] = useState<{
    readonly serial: number
    readonly hash?: string
  }>({ serial: 0 })
  const graphActiveRef = useRef(graphActive)
  portsRef.current = ports
  graphActiveRef.current = graphActive

  const openGraph = useCallback((hash?: string): void => {
    portsRef.current.activateViewer()
    setGraphOpen(true)
    setGraphActive(true)
    portsRef.current.deactivateWebPane()
    setGraphRequest((current) => ({
      serial: current.serial + 1,
      ...(hash ? { hash } : {}),
    }))
  }, [])

  const activateGraph = useCallback((): void => {
    portsRef.current.activateViewer()
    setGraphActive(true)
    portsRef.current.deactivateWebPane()
  }, [])
  const deactivateGraph = useCallback((): void => setGraphActive(false), [])
  const closeGraph = useCallback((): void => {
    setGraphOpen(false)
    setGraphActive(false)
  }, [])
  const resetGraph = useCallback((): void => {
    setGraphOpen(false)
    setGraphActive(false)
  }, [])

  const switchBranch = useCallback(async (branch: string): Promise<void> => {
    const current = portsRef.current
    if (!current.root) throw new Error('No active workspace')
    if (current.hasDirtyViewerTabs()) {
      throw new Error('Save or close unsaved viewer tabs before switching')
    }
    const state = unwrapOperation(
      await window.hvir.invoke('git:switch-branch', {
        root: current.root,
        branch,
      }),
    )
    current.acceptProjectState(state)
    current.refreshContent()
  }, [])

  const fetch = useCallback(async (): Promise<void> => {
    const current = portsRef.current
    if (!current.root) throw new Error('No active workspace')
    current.acceptProjectState(
      unwrapOperation(await window.hvir.invoke('git:fetch', { root: current.root })),
    )
    current.refreshGit()
  }, [])

  const pull = useCallback(async (): Promise<void> => {
    const current = portsRef.current
    if (!current.root) throw new Error('No active workspace')
    if (current.hasDirtyViewerTabs()) {
      throw new Error('Save or close unsaved viewer tabs before pulling')
    }
    current.acceptProjectState(
      unwrapOperation(await window.hvir.invoke('git:pull', { root: current.root })),
    )
    current.refreshContent()
  }, [])

  return {
    graphOpen,
    graphActive,
    graphActiveRef,
    graphRequest,
    openGraph,
    activateGraph,
    deactivateGraph,
    closeGraph,
    resetGraph,
    switchBranch,
    fetch,
    pull,
  }
}
