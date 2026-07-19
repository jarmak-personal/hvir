import { useCallback, useEffect, useRef, useState } from 'react'

import type { HostPath } from '../../../shared'
import {
  persistWorkspaceLayout,
  restoreWorkspaceLayout,
} from '../layout/workspace-layout-persistence'
import type { ViewerPaneId } from '../viewer/tab-state'
import { clamp, fitTerminalHeight } from './workbench-layout-policy'

const TREE_MIN_WIDTH = 160
const TREE_MAX_WIDTH = 520
const MAIN_MIN_WIDTH = 420
const DIVIDER_SIZE = 5

export type WorkbenchRailMode = 'files' | 'git' | 'harness'

export function useWorkbenchLayout({
  root,
  gitAvailable,
  workspaceMissing,
}: {
  readonly root?: HostPath
  readonly gitAvailable: boolean
  readonly workspaceMissing: boolean
}) {
  const workbenchRef = useRef<HTMLElement>(null)
  const viewerGroupsRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef(root)
  const [railMode, setRailMode] = useState<WorkbenchRailMode>('files')
  const [terminalFocused, setTerminalFocused] = useState(false)
  const [treeCollapsed, setTreeCollapsed] = useState(false)
  rootRef.current = root

  useEffect(() => {
    if (!root) return
    const layout = restoreWorkspaceLayout(root)
    const workbench = workbenchRef.current
    if (workbench) {
      setTrack(workbench, '--tree-track', layout.treeWidth)
      setTrack(
        workbench,
        '--terminal-track',
        layout.terminalHeight
          ? fitTerminalHeight(layout.terminalHeight, workbench.clientHeight)
          : undefined,
      )
    }
    const viewerGroups = viewerGroupsRef.current
    if (viewerGroups) {
      setTrack(viewerGroups, '--viewer-primary-track', layout.viewerPrimaryWidth)
    }
  }, [root])

  useEffect(() => {
    const workbench = workbenchRef.current
    if (!workbench) return
    const observer = new ResizeObserver(() => {
      const terminalTrack = Number.parseFloat(
        workbench.style.getPropertyValue('--terminal-track'),
      )
      if (!Number.isFinite(terminalTrack)) return
      const next = fitTerminalHeight(terminalTrack, workbench.clientHeight)
      if (Math.abs(next - terminalTrack) > 0.5) {
        workbench.style.setProperty('--terminal-track', `${next}px`)
      }
    })
    observer.observe(workbench)
    return () => observer.disconnect()
  }, [root])

  useEffect(() => {
    if ((!gitAvailable || workspaceMissing) && railMode === 'git') {
      setRailMode('files')
    }
  }, [gitAvailable, railMode, workspaceMissing])

  const resetWorkspaceView = useCallback((): void => {
    setTerminalFocused(false)
    setTreeCollapsed(false)
  }, [])

  const setTreeWidth = useCallback((width: number): void => {
    const workbench = workbenchRef.current
    if (!workbench) return
    const terminalRailWidth =
      workbench.querySelector<HTMLElement>('.terminal-rail')?.getBoundingClientRect()
        .width ?? 0
    const max = Math.max(
      TREE_MIN_WIDTH,
      Math.min(
        TREE_MAX_WIDTH,
        workbench.clientWidth - DIVIDER_SIZE - MAIN_MIN_WIDTH - terminalRailWidth,
      ),
    )
    const next = clamp(width, TREE_MIN_WIDTH, max)
    workbench.style.setProperty('--tree-track', `${next}px`)
    if (rootRef.current) persistWorkspaceLayout(rootRef.current, { treeWidth: next })
  }, [])

  const resetTreeWidth = useCallback((): void => {
    workbenchRef.current?.style.removeProperty('--tree-track')
    if (rootRef.current) persistWorkspaceLayout(rootRef.current, { treeWidth: 0 })
  }, [])

  const setTerminalHeight = useCallback((height: number): void => {
    const workbench = workbenchRef.current
    if (!workbench) return
    const next = fitTerminalHeight(height, workbench.clientHeight)
    workbench.style.setProperty('--terminal-track', `${next}px`)
    if (rootRef.current) {
      persistWorkspaceLayout(rootRef.current, { terminalHeight: next })
    }
  }, [])

  const resetTerminalHeight = useCallback((): void => {
    workbenchRef.current?.style.removeProperty('--terminal-track')
    if (rootRef.current) persistWorkspaceLayout(rootRef.current, { terminalHeight: 0 })
  }, [])

  const setViewerPrimaryWidth = useCallback((width: number): void => {
    const groups = viewerGroupsRef.current
    if (!groups) return
    const next = clamp(width, 240, Math.max(240, groups.clientWidth - 245))
    groups.style.setProperty('--viewer-primary-track', `${next}px`)
    if (rootRef.current) {
      persistWorkspaceLayout(rootRef.current, { viewerPrimaryWidth: next })
    }
  }, [])

  const resetViewerPrimaryWidth = useCallback((): void => {
    viewerGroupsRef.current?.style.removeProperty('--viewer-primary-track')
    if (rootRef.current) {
      persistWorkspaceLayout(rootRef.current, { viewerPrimaryWidth: 0 })
    }
  }, [])

  const toggleTerminalFocus = useCallback(
    () => setTerminalFocused((focused) => !focused),
    [],
  )
  const focusTerminal = useCallback((): void => {
    requestAnimationFrame(() =>
      document
        .querySelector<HTMLElement>(
          '.terminal-deck:not([hidden]) .terminal-surface.active textarea',
        )
        ?.focus(),
    )
  }, [])
  const focusViewer = useCallback((pane: ViewerPaneId): void => {
    setTerminalFocused(false)
    requestAnimationFrame(() =>
      document.querySelector<HTMLElement>(`[data-viewer-pane="${pane}"]`)?.focus(),
    )
  }, [])
  const focusTree = useCallback((): void => {
    setTerminalFocused(false)
    setTreeCollapsed(false)
    setRailMode('files')
    requestAnimationFrame(() =>
      document.querySelector<HTMLElement>('.tree-panel')?.focus(),
    )
  }, [])

  return {
    workbenchRef,
    viewerGroupsRef,
    railMode,
    setRailMode,
    terminalFocused,
    setTerminalFocused,
    toggleTerminalFocus,
    treeCollapsed,
    setTreeCollapsed,
    resetWorkspaceView,
    setTreeWidth,
    resetTreeWidth,
    setTerminalHeight,
    resetTerminalHeight,
    setViewerPrimaryWidth,
    resetViewerPrimaryWidth,
    focusTerminal,
    focusViewer,
    focusTree,
  }
}

function setTrack(
  element: HTMLElement,
  property: string,
  value: number | undefined,
): void {
  if (value) element.style.setProperty(property, `${value}px`)
  else element.style.removeProperty(property)
}
