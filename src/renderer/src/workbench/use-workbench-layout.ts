import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type SetStateAction,
} from 'react'

import type { HostPath } from '../../../shared'
import {
  persistWorkspaceLayout,
  restoreWorkspaceLayout,
} from '../layout/workspace-layout-persistence'
import { fitSplitPrimaryWidth, PANE_DIVIDER_SIZE } from '../layout/split-layout-policy'
import type { ViewerPaneId } from '../viewer/tab-state'
import { focusActiveTerminalAfterLayout } from './active-terminal-focus'
import { clamp, fitTerminalHeight } from './workbench-layout-policy'
import {
  DEFAULT_WORKSPACE_PANE_STATE,
  WorkspacePaneStateSession,
  type TerminalLayoutMode,
} from './workspace-pane-state'

const TREE_MIN_WIDTH = 160
const TREE_MAX_WIDTH = 520
const MAIN_MIN_WIDTH = 420
const VIEWER_PANE_MIN_WIDTH = 240

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
  const paneStateSessionRef = useRef<WorkspacePaneStateSession | undefined>(undefined)
  if (!paneStateSessionRef.current) {
    paneStateSessionRef.current = new WorkspacePaneStateSession()
  }
  const [railMode, setRailMode] = useState<WorkbenchRailMode>('files')
  const [terminalModeState, setTerminalModeState] =
    useState<TerminalLayoutMode>('restored')
  const [terminalRailCompactState, setTerminalRailCompactState] = useState(false)
  const [treeCollapsedState, setTreeCollapsedState] = useState(false)
  const terminalModeRef = useRef<TerminalLayoutMode>('restored')
  const terminalRailCompactRef = useRef(false)
  const treeCollapsedRef = useRef(false)
  rootRef.current = root

  useLayoutEffect(() => {
    const state = root
      ? paneStateSessionRef.current?.read(root)
      : DEFAULT_WORKSPACE_PANE_STATE
    const next = state ?? DEFAULT_WORKSPACE_PANE_STATE
    terminalModeRef.current = next.terminalMode
    terminalRailCompactRef.current = next.terminalRailCompact
    treeCollapsedRef.current = next.treeCollapsed
    setTerminalModeState(next.terminalMode)
    setTerminalRailCompactState(next.terminalRailCompact)
    setTreeCollapsedState(next.treeCollapsed)
  }, [root])

  const setTerminalMode = useCallback(
    (update: SetStateAction<TerminalLayoutMode>): void => {
      const next = resolveStateUpdate(update, terminalModeRef.current)
      terminalModeRef.current = next
      setTerminalModeState(next)
      const activeRoot = rootRef.current
      if (activeRoot) {
        paneStateSessionRef.current?.write(activeRoot, {
          terminalMode: next,
          terminalRailCompact: terminalRailCompactRef.current,
          treeCollapsed: treeCollapsedRef.current,
        })
      }
    },
    [],
  )

  const setTreeCollapsed = useCallback((update: SetStateAction<boolean>): void => {
    const next = resolveStateUpdate(update, treeCollapsedRef.current)
    treeCollapsedRef.current = next
    setTreeCollapsedState(next)
    const activeRoot = rootRef.current
    if (activeRoot) {
      paneStateSessionRef.current?.write(activeRoot, {
        terminalMode: terminalModeRef.current,
        terminalRailCompact: terminalRailCompactRef.current,
        treeCollapsed: next,
      })
    }
  }, [])

  const setTerminalRailCompact = useCallback((compact: boolean): void => {
    terminalRailCompactRef.current = compact
    setTerminalRailCompactState(compact)
    const activeRoot = rootRef.current
    if (activeRoot) {
      paneStateSessionRef.current?.write(activeRoot, {
        terminalMode: terminalModeRef.current,
        terminalRailCompact: compact,
        treeCollapsed: treeCollapsedRef.current,
      })
    }
    focusActiveTerminalAfterLayout()
  }, [])

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

  const setTreeWidth = useCallback((width: number): void => {
    const workbench = workbenchRef.current
    if (!workbench) return
    const terminalRailWidth =
      workbench
        .querySelector<HTMLElement>('.terminal-rail:not([hidden])')
        ?.getBoundingClientRect().width ?? 0
    const max = Math.max(
      TREE_MIN_WIDTH,
      Math.min(
        TREE_MAX_WIDTH,
        workbench.clientWidth - PANE_DIVIDER_SIZE - MAIN_MIN_WIDTH - terminalRailWidth,
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
    const next = fitSplitPrimaryWidth(width, groups.clientWidth, VIEWER_PANE_MIN_WIDTH)
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
    () => setTerminalMode((mode) => (mode === 'maximized' ? 'restored' : 'maximized')),
    [setTerminalMode],
  )
  const focusTerminal = useCallback((): void => {
    setTerminalMode((mode) => (mode === 'collapsed' ? 'restored' : mode))
    focusActiveTerminalAfterLayout()
  }, [setTerminalMode])
  const focusViewer = useCallback(
    (pane: ViewerPaneId): void => {
      setTerminalMode((mode) => (mode === 'maximized' ? 'restored' : mode))
      requestAnimationFrame(() =>
        document.querySelector<HTMLElement>(`[data-viewer-pane="${pane}"]`)?.focus(),
      )
    },
    [setTerminalMode],
  )
  const focusTree = useCallback((): void => {
    setTerminalMode((mode) => (mode === 'maximized' ? 'restored' : mode))
    setTreeCollapsed(false)
    setRailMode('files')
    requestAnimationFrame(() =>
      document.querySelector<HTMLElement>('.tree-panel')?.focus(),
    )
  }, [setTerminalMode, setTreeCollapsed])

  const restoreViewer = useCallback((): void => {
    setTerminalMode((mode) => (mode === 'maximized' ? 'restored' : mode))
  }, [setTerminalMode])

  return {
    workbenchRef,
    viewerGroupsRef,
    railMode,
    setRailMode,
    terminalMode: terminalModeState,
    setTerminalMode,
    terminalRailCompact: terminalRailCompactState,
    setTerminalRailCompact,
    toggleTerminalFocus,
    restoreViewer,
    treeCollapsed: treeCollapsedState,
    setTreeCollapsed,
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

function resolveStateUpdate<T>(update: SetStateAction<T>, current: T): T {
  return typeof update === 'function' ? (update as (value: T) => T)(current) : update
}

function setTrack(
  element: HTMLElement,
  property: string,
  value: number | undefined,
): void {
  if (value) element.style.setProperty(property, `${value}px`)
  else element.style.removeProperty(property)
}
