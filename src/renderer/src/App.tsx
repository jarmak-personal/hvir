import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type RefObject,
} from 'react'

import {
  asHostId,
  basenameHostPath,
  defaultViewMode,
  hostPath,
  hostPathEquals,
  unwrapOperation,
  type DiffBase,
  type FileOpenContext,
  type GitChanges,
  type HostPath,
  type HostConnectionState,
  type HostWatchTier,
  type ProjectHostOption,
  type ConnectedHost,
  type BrowseHostResponse,
  type ProjectState,
  type SshPromptRequest,
  type ViewMode,
  type WatchEvent,
} from '../../shared'
import { PaneResizer } from './layout/PaneResizer'
import { TerminalWorkspace } from './terminal/TerminalWorkspace'
import type { TerminalWorkspaceRollup } from './terminal/TerminalWorkspace'
import { ProjectsBar } from './workspaces/ProjectsBar'
import { RemoteConnectionBadge } from './workspaces/ConnectionStatus'
import { MissingWorkspaceNotice } from './workspaces/MissingWorkspaceNotice'
import { initialHostConnectionTarget } from './workspaces/initial-host-connection'
import { FileTree, SessionBar } from './tree/FileTree'
import { DirectoryTree } from './tree/DirectoryTree'
import { isGitIgnoreRulePath } from './tree/git-ignore-refresh'
import { GitPanel } from './git/GitPanel'
import { GitGraphView } from './git/GitGraphView'
import { FileViewer } from './viewer/FileViewer'
import { TabStrip } from './viewer/TabStrip'
import type {
  ViewerNavigationPosition,
  ViewerPaneId,
  ViewerTab,
} from './viewer/tab-state'
import { setAppTheme, useAppTheme } from './theme'
import { SettingsDialog } from './settings/SettingsDialog'
import { matchesKeybinding, type KeybindingAction } from './settings/keybindings'
import { setAppSettings, useAppSettings } from './settings/settings'

const TREE_MIN_WIDTH = 160
const TREE_MAX_WIDTH = 520
const MAIN_MIN_WIDTH = 420
const VIEWER_MIN_HEIGHT = 180
const TERMINAL_MIN_HEIGHT = 160
const DIVIDER_SIZE = 5
const TAB_STORAGE_VERSION = 1
const DRAFT_STORAGE_CHARACTER_LIMIT = 2 * 1024 * 1024

export function App(): ReactElement {
  const theme = useAppTheme()
  const settings = useAppSettings()
  const workbenchRef = useRef<HTMLElement>(null)
  const viewerGroupsRef = useRef<HTMLDivElement>(null)
  const tabsRef = useRef<readonly ViewerTab[]>([])
  const rootRef = useRef<HostPath | undefined>(undefined)
  const warmTabs = useRef(
    new Map<
      string,
      { readonly tabs: readonly ViewerTab[]; readonly activeId?: string }
    >(),
  )
  const activeIdRef = useRef<string | undefined>(undefined)
  const activePaneRef = useRef<ViewerPaneId>('primary')
  const activeByPaneRef = useRef<Record<ViewerPaneId, string | undefined>>({
    primary: undefined,
    secondary: undefined,
  })
  const gitGraphActiveRef = useRef(false)
  const workspaceSwitchRef = useRef<(direction: -1 | 1) => void>(() => undefined)
  const fileReadGenerations = useRef(new Map<string, number>())
  const nextViewerNavigation = useRef(0)
  const discardDirtyOnUnload = useRef(false)
  const watchHandler = useRef<(event: WatchEvent) => void>(() => undefined)
  const pendingScroll = useRef<
    { readonly id: string; readonly scrollTop: number } | undefined
  >(undefined)
  const scrollFrame = useRef<number | undefined>(undefined)
  const persistedState = useRef<
    | {
        readonly root: HostPath
        readonly tabs: readonly ViewerTab[]
        readonly activeId?: string
      }
    | undefined
  >(undefined)
  const [root, setRoot] = useState<HostPath>()
  const [projectState, setProjectState] = useState<ProjectState>()
  const [rootError, setRootError] = useState<string>()
  const [watchVersion, setWatchVersion] = useState(0)
  const [ignoredRefreshVersion, setIgnoredRefreshVersion] = useState(0)
  const [contentVersion, setContentVersion] = useState(0)
  const [gitVersion, setGitVersion] = useState(0)
  const [tabs, setTabs] = useState<readonly ViewerTab[]>([])
  const [activeId, setActiveId] = useState<string>()
  const [viewerSplit, setViewerSplit] = useState(false)
  const [gitGraphOpen, setGitGraphOpen] = useState(false)
  const [gitGraphActive, setGitGraphActive] = useState(false)
  const [gitGraphRequest, setGitGraphRequest] = useState<{
    readonly serial: number
    readonly hash?: string
  }>({ serial: 0 })
  const [restored, setRestored] = useState(false)
  const [railMode, setRailMode] = useState<'files' | 'git' | 'harness'>('files')
  const [gitChanges, setGitChanges] = useState<GitChanges>()
  const [connectionState, setConnectionState] = useState<HostConnectionState>('connected')
  const [watchTier, setWatchTier] = useState<HostWatchTier>('native')
  const [hosts, setHosts] = useState<readonly ProjectHostOption[]>([])
  const [showAddProject, setShowAddProject] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [sessionBusy, setSessionBusy] = useState(false)
  const [sessionError, setSessionError] = useState<string>()
  const [sshPrompts, setSshPrompts] = useState<readonly SshPromptRequest[]>([])
  const [terminalRollups, setTerminalRollups] = useState<
    Readonly<Record<string, TerminalWorkspaceRollup>>
  >({})
  const [terminalFocused, setTerminalFocused] = useState(false)
  const [treeCollapsed, setTreeCollapsed] = useState(false)
  tabsRef.current = tabs
  rootRef.current = root
  activeIdRef.current = activeId
  gitGraphActiveRef.current = gitGraphActive
  const changedCount = gitChanges?.workingTree.length ?? 0
  const activeProject = projectState?.projects.find(
    (project) => project.id === projectState.activeProjectId,
  )
  const activeWorkspace = activeProject?.workspaces.find(
    (workspace) => workspace.id === projectState?.activeWorkspaceId,
  )

  const applyProjectState = useCallback((state: ProjectState): void => {
    setProjectState(state)
    setConnectionState(state.connectionState)
    setWatchTier(state.watchTier)
    const currentRoot = rootRef.current
    if (currentRoot && hostPathEquals(currentRoot, state.root)) return
    if (currentRoot) {
      persistTabs(currentRoot, tabsRef.current, activeIdRef.current)
      warmTabs.current.set(storageKey(currentRoot), {
        tabs: tabsRef.current,
        activeId: activeIdRef.current,
      })
    }
    setRestored(false)
    setRoot(state.root)
    setTabs([])
    setActiveId(undefined)
    activePaneRef.current = 'primary'
    activeByPaneRef.current = { primary: undefined, secondary: undefined }
    setViewerSplit(false)
    setGitGraphOpen(false)
    setGitGraphActive(false)
    setGitChanges(undefined)
    setSessionError(undefined)
    setTerminalFocused(false)
    setTreeCollapsed(false)
  }, [])

  const updateTerminalRollup = useCallback(
    (workspaceId: string, rollup: TerminalWorkspaceRollup): void => {
      setTerminalRollups((current) => {
        const existing = current[workspaceId]
        if (
          existing?.unseen === rollup.unseen &&
          existing.actionable === rollup.actionable
        ) {
          return current
        }
        return { ...current, [workspaceId]: rollup }
      })
    },
    [],
  )

  const loadFile = useCallback((path: HostPath): void => {
    const id = tabId(path)
    const generation = (fileReadGenerations.current.get(id) ?? 0) + 1
    fileReadGenerations.current.set(id, generation)
    setTabs((current) =>
      current.map((tab) =>
        tab.id === id ? { ...tab, loading: !tab.file, error: undefined } : tab,
      ),
    )
    void window.hvir
      .invoke('fs:read', { path })
      .then(unwrapOperation)
      .then(
        (file) => {
          if (fileReadGenerations.current.get(id) !== generation) return
          setTabs((current) =>
            current.map((tab) =>
              tab.id === id
                ? tab.dirty
                  ? tab
                  : {
                      ...tab,
                      file,
                      loading: false,
                      error: undefined,
                      conflict: false,
                    }
                : tab,
            ),
          )
        },
        (reason: unknown) => {
          if (fileReadGenerations.current.get(id) !== generation) return
          const error = reason instanceof Error ? reason.message : String(reason)
          setTabs((current) =>
            current.map((tab) =>
              tab.id === id
                ? tab.dirty
                  ? tab
                  : tab.diffRevision
                    ? {
                        ...tab,
                        file: {
                          path: tab.path,
                          content: '',
                          size: 0,
                          mtimeMs: 0,
                          binary: false,
                        },
                        loading: false,
                        error: undefined,
                      }
                    : { ...tab, file: undefined, loading: false, error }
                : tab,
            ),
          )
        },
      )
  }, [])

  useEffect(() => {
    let cancelled = false
    let watchRefreshTimer: number | undefined
    let ignoredRefreshTimer: number | undefined
    let contentRefreshTimer: number | undefined
    let gitRefreshTimer: number | undefined
    const initializeProject = async (): Promise<void> => {
      let state: ProjectState
      try {
        state = await window.hvir.invoke('project:root', undefined)
      } catch (error) {
        if (!cancelled)
          setRootError(error instanceof Error ? error.message : String(error))
        return
      }
      if (cancelled) return
      applyProjectState(state)

      const hostId = initialHostConnectionTarget(state)
      if (!hostId) return
      setSessionBusy(true)
      setSessionError(undefined)
      try {
        const connected = unwrapOperation(
          await window.hvir.invoke('project:connect-host', { hostId }),
        )
        if (cancelled) return
        setConnectionState(connected.host.connectionState)
        setWatchTier(connected.host.watchTier)
        for (const tab of tabsRef.current) {
          if (!tab.dirty) loadFile(tab.path)
        }
      } catch (error) {
        if (!cancelled)
          setSessionError(error instanceof Error ? error.message : String(error))
      } finally {
        if (!cancelled) setSessionBusy(false)
      }
    }
    void initializeProject()
    const stopWatch = window.hvir.on('project:watch', (event) => {
      const gitMetadataEvent =
        event.synthetic !== 'refresh' && /(^|\/)\.git(?:\/|$)/.test(event.path.path)
      const ignoreRulesEvent =
        event.synthetic !== 'refresh' && isGitIgnoreRulePath(event.path.path)
      if (gitMetadataEvent && gitRefreshTimer === undefined) {
        gitRefreshTimer = window.setTimeout(() => {
          gitRefreshTimer = undefined
          setGitVersion((version) => version + 1)
        }, 250)
      }
      if (ignoreRulesEvent && ignoredRefreshTimer === undefined) {
        ignoredRefreshTimer = window.setTimeout(() => {
          ignoredRefreshTimer = undefined
          setIgnoredRefreshVersion((version) => version + 1)
        }, 250)
      }
      if (watchRefreshTimer === undefined) {
        watchRefreshTimer = window.setTimeout(() => {
          watchRefreshTimer = undefined
          setWatchVersion((version) => version + 1)
        }, 250)
      }
      if (event.synthetic !== 'refresh' && contentRefreshTimer === undefined) {
        contentRefreshTimer = window.setTimeout(() => {
          contentRefreshTimer = undefined
          setContentVersion((version) => version + 1)
        }, 250)
      }
      watchHandler.current(event)
    })
    const stopState = window.hvir.on('project:state', (state) => {
      applyProjectState(state)
      if (state.connectionState === 'connected') setSessionError(undefined)
      if (state.connectionState === 'disconnected') {
        setSshPrompts((current) =>
          current.filter((prompt) => prompt.hostId !== state.root.hostId),
        )
      }
    })
    const stopPrompt = window.hvir.on('ssh:prompt', (prompt) => {
      setSshPrompts((current) =>
        current.some((candidate) => candidate.id === prompt.id)
          ? current
          : [...current, prompt],
      )
    })
    const stopPromptCancel = window.hvir.on('ssh:prompt-cancel', ({ hostId }) => {
      setSshPrompts((current) => current.filter((prompt) => prompt.hostId !== hostId))
    })
    return () => {
      cancelled = true
      if (watchRefreshTimer !== undefined) window.clearTimeout(watchRefreshTimer)
      if (ignoredRefreshTimer !== undefined) window.clearTimeout(ignoredRefreshTimer)
      if (contentRefreshTimer !== undefined) window.clearTimeout(contentRefreshTimer)
      if (gitRefreshTimer !== undefined) window.clearTimeout(gitRefreshTimer)
      void stopWatch()
      void stopState()
      void stopPrompt()
      void stopPromptCancel()
    }
  }, [applyProjectState, loadFile])

  useEffect(() => {
    let cancelled = false
    void window.hvir.invoke('project:hosts', undefined).then(
      (nextHosts) => {
        if (!cancelled) setHosts(nextHosts)
      },
      () => undefined,
    )
    return () => {
      cancelled = true
    }
  }, [showAddProject])

  useEffect(() => {
    if (!root) return
    const restoredState = warmTabs.current.get(storageKey(root)) ?? restoreTabs(root)
    setTabs(restoredState.tabs)
    setActiveId(restoredState.activeId)
    const restoredActive = restoredState.tabs.find(
      (tab) => tab.id === restoredState.activeId,
    )
    activePaneRef.current = restoredActive?.pane ?? 'primary'
    activeByPaneRef.current = {
      primary:
        restoredState.tabs.find(
          (tab) => tab.pane === 'primary' && tab.id === restoredState.activeId,
        )?.id ?? restoredState.tabs.find((tab) => tab.pane === 'primary')?.id,
      secondary:
        restoredState.tabs.find(
          (tab) => tab.pane === 'secondary' && tab.id === restoredState.activeId,
        )?.id ?? restoredState.tabs.find((tab) => tab.pane === 'secondary')?.id,
    }
    setRestored(true)
    for (const tab of restoredState.tabs) if (!tab.dirty) loadFile(tab.path)
    const layout = restoreLayout(root)
    setViewerSplit(
      Boolean(layout.viewerSplit) ||
        restoredState.tabs.some((tab) => tab.pane === 'secondary'),
    )
    const workbench = workbenchRef.current
    if (workbench) {
      if (layout.treeWidth) {
        workbench.style.setProperty('--tree-track', `${layout.treeWidth}px`)
      } else {
        workbench.style.removeProperty('--tree-track')
      }
      if (layout.terminalHeight) {
        workbench.style.setProperty('--terminal-track', `${layout.terminalHeight}px`)
      } else {
        workbench.style.removeProperty('--terminal-track')
      }
    }
    const viewerGroups = viewerGroupsRef.current
    if (viewerGroups) {
      if (layout.viewerPrimaryWidth) {
        viewerGroups.style.setProperty(
          '--viewer-primary-track',
          `${layout.viewerPrimaryWidth}px`,
        )
      } else {
        viewerGroups.style.removeProperty('--viewer-primary-track')
      }
    }
  }, [loadFile, root])

  useEffect(() => {
    if (
      (activeWorkspace?.repository === false || activeWorkspace?.missing) &&
      railMode === 'git'
    ) {
      setRailMode('files')
    }
    if (activeWorkspace?.missing) {
      setGitGraphOpen(false)
      setGitGraphActive(false)
    }
  }, [activeWorkspace?.missing, activeWorkspace?.repository, railMode])

  useEffect(() => {
    const actionable = Object.values(terminalRollups).reduce(
      (total, rollup) => total + rollup.actionable,
      0,
    )
    window.hvir.send('app:attention', { count: actionable })
  }, [terminalRollups])
  useEffect(() => () => window.hvir.send('app:attention', { count: 0 }), [])

  useEffect(() => {
    if (!root || !restored) return
    persistedState.current = { root, tabs, activeId }
    const timer = window.setTimeout(() => persistTabs(root, tabs, activeId), 250)
    return () => window.clearTimeout(timer)
  }, [activeId, restored, root, tabs])

  useEffect(() => {
    const flushPersistence = (): void => {
      const state = persistedState.current
      if (state) {
        persistTabs(state.root, state.tabs, state.activeId, !discardDirtyOnUnload.current)
      }
    }
    const protectDirtyBuffers = (event: BeforeUnloadEvent): void => {
      const dirtyCount = tabsRef.current.filter((tab) => tab.dirty).length
      if (
        dirtyCount === 0 ||
        window.confirm(
          `${dirtyCount} tab${dirtyCount === 1 ? ' has' : 's have'} unsaved changes. Close hvir and discard them?`,
        )
      ) {
        discardDirtyOnUnload.current = dirtyCount > 0
        return
      }
      discardDirtyOnUnload.current = false
      event.preventDefault()
      // Electron silently cancels a close when beforeunload sets returnValue;
      // the explicit confirmation above supplies the UI it does not provide.
      event.returnValue = 'Unsaved changes'
    }
    window.addEventListener('pagehide', flushPersistence)
    window.addEventListener('beforeunload', protectDirtyBuffers)
    return () => {
      window.removeEventListener('pagehide', flushPersistence)
      window.removeEventListener('beforeunload', protectDirtyBuffers)
      if (scrollFrame.current !== undefined) {
        window.cancelAnimationFrame(scrollFrame.current)
      }
    }
  }, [])

  useEffect(() => {
    const keydown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return
      // Modal dialogs own the keyboard even when the browser reports body as
      // the target (for example after clicking their backdrop).
      if (document.querySelector('[aria-modal="true"]')) return
      const action = (
        Object.entries(settings.keybindings) as [KeybindingAction, string][]
      ).find(([, binding]) => matchesKeybinding(event, binding))?.[0]
      if (!action) return
      if (
        action === 'cycleViewMode' &&
        event.target instanceof Element &&
        event.target.closest('.terminal-panel')
      ) {
        return
      }
      event.preventDefault()
      if (action === 'cycleViewMode') {
        if (gitGraphActiveRef.current) return
        const id = activeIdRef.current
        if (!id) return
        setTabs((current) =>
          current.map((tab) =>
            tab.id === id ? { ...tab, mode: nextMode(tab.mode) } : tab,
          ),
        )
      } else if (action === 'toggleTerminalFocus') {
        setTerminalFocused((focused) => !focused)
      } else if (action === 'focusTerminal') {
        requestAnimationFrame(() =>
          document
            .querySelector<HTMLElement>(
              '.terminal-deck:not([hidden]) .terminal-surface.active textarea',
            )
            ?.focus(),
        )
      } else if (action === 'focusViewer') {
        setTerminalFocused(false)
        requestAnimationFrame(() =>
          document
            .querySelector<HTMLElement>(`[data-viewer-pane="${activePaneRef.current}"]`)
            ?.focus(),
        )
      } else if (action === 'focusTree') {
        setTerminalFocused(false)
        setTreeCollapsed(false)
        setRailMode('files')
        requestAnimationFrame(() =>
          document.querySelector<HTMLElement>('.tree-panel')?.focus(),
        )
      } else if (action === 'nextWorkspace') {
        workspaceSwitchRef.current(1)
      } else if (action === 'previousWorkspace') {
        workspaceSwitchRef.current(-1)
      }
    }
    window.addEventListener('keydown', keydown, true)
    return () => window.removeEventListener('keydown', keydown, true)
  }, [settings.keybindings])

  watchHandler.current = (event): void => {
    const tab = tabsRef.current.find((candidate) =>
      hostPathEquals(candidate.path, event.path),
    )
    if (!tab) return
    if (tab.dirty) {
      setTabs((current) =>
        current.map((candidate) =>
          candidate.id === tab.id ? { ...candidate, conflict: true } : candidate,
        ),
      )
    } else {
      loadFile(tab.path)
    }
  }

  const activateTab = (id: string, pane?: ViewerPaneId): void => {
    const targetPane = pane ?? tabsRef.current.find((tab) => tab.id === id)?.pane
    if (targetPane) {
      activePaneRef.current = targetPane
      activeByPaneRef.current[targetPane] = id
    }
    setActiveId(id)
    setGitGraphActive(false)
    setTerminalFocused(false)
  }

  const openFile = (
    path: HostPath,
    pinned: boolean,
    context: FileOpenContext = 'file-tree',
    diffBase: DiffBase = 'head',
    diffRevision?: string,
    position?: Omit<ViewerNavigationPosition, 'serial'>,
  ): void => {
    setTerminalFocused(false)
    setGitGraphActive(false)
    const id = tabId(path)
    const existing = tabsRef.current.find((tab) => tab.id === id)
    const targetPane = existing?.pane ?? (viewerSplit ? activePaneRef.current : 'primary')
    const navigation = position
      ? { ...position, serial: (nextViewerNavigation.current += 1) }
      : undefined
    setTabs((current) => {
      const existing = current.find((tab) => tab.id === id)
      if (existing) {
        return current.map((tab) =>
          tab.id === id
            ? {
                ...tab,
                pinned: pinned || tab.pinned,
                mode: position ? 'source' : context === 'git' ? 'diff' : tab.mode,
                diffBase: context === 'git' ? diffBase : tab.diffBase,
                diffRevision: context === 'git' ? diffRevision : undefined,
                navigation,
              }
            : tab,
        )
      }
      const created: ViewerTab = {
        id,
        path,
        pane: targetPane,
        pinned,
        mode: position ? 'source' : defaultViewMode(path, context),
        diffBase,
        diffRevision,
        scrollTop: 0,
        navigation,
        loading: true,
        dirty: false,
        conflict: false,
      }
      const previewIndex = current.findIndex(
        (tab) => tab.pane === targetPane && !tab.pinned && !tab.dirty,
      )
      if (previewIndex < 0) return [...current, created]
      const next = [...current]
      next[previewIndex] = created
      return next
    })
    activateTab(id, targetPane)
    // Reopening a dirty tab is navigation, not a reload. Its in-memory buffer
    // is authoritative until the user saves or explicitly chooses reload.
    if (!existing?.dirty) loadFile(path)
  }

  const closeTab = (id: string): void => {
    const closing = tabsRef.current.find((tab) => tab.id === id)
    if (
      closing?.dirty &&
      !window.confirm(`Close ${basenameHostPath(closing.path)} without saving?`)
    ) {
      return
    }
    const closesLastSecondary =
      closing?.pane === 'secondary' &&
      !tabsRef.current.some((tab) => tab.pane === 'secondary' && tab.id !== id)
    if (closesLastSecondary) {
      if (activePaneRef.current === 'secondary') activePaneRef.current = 'primary'
      activeByPaneRef.current.secondary = undefined
      setViewerSplit(false)
      if (rootRef.current) persistLayout(rootRef.current, { viewerSplit: false })
    }
    fileReadGenerations.current.set(id, (fileReadGenerations.current.get(id) ?? 0) + 1)
    setTabs((current) => {
      const index = current.findIndex((tab) => tab.id === id)
      if (index < 0) return current
      const pane = current[index]?.pane ?? 'primary'
      const next = current.filter((tab) => tab.id !== id)
      const nextInPane =
        next.slice(index).find((tab) => tab.pane === pane) ??
        [...next].reverse().find((tab) => tab.pane === pane)
      if (activeByPaneRef.current[pane] === id) {
        activeByPaneRef.current[pane] = nextInPane?.id
      }
      if (activeIdRef.current === id) {
        const nextActive = nextInPane ?? next[Math.min(index, next.length - 1)]
        if (nextActive) {
          activePaneRef.current = nextActive.pane
          activeByPaneRef.current[nextActive.pane] = nextActive.id
        }
        setActiveId(nextActive?.id)
      }
      return next
    })
  }

  const updateTab = (id: string, update: (tab: ViewerTab) => ViewerTab): void => {
    setTabs((current) => current.map((tab) => (tab.id === id ? update(tab) : tab)))
  }

  const scheduleScrollPersistence = (id: string, scrollTop: number): void => {
    pendingScroll.current = { id, scrollTop }
    if (scrollFrame.current !== undefined) return
    scrollFrame.current = window.requestAnimationFrame(() => {
      scrollFrame.current = undefined
      const pending = pendingScroll.current
      pendingScroll.current = undefined
      if (pending) {
        updateTab(pending.id, (tab) => ({ ...tab, scrollTop: pending.scrollTop }))
      }
    })
  }

  const saveTab = (id: string): void => {
    const tab = tabsRef.current.find((candidate) => candidate.id === id)
    if (!tab?.file || tab.file.binary || tab.conflict) return
    const savedContent = tab.file.content
    updateTab(tab.id, (candidate) => ({ ...candidate, error: undefined }))
    void window.hvir
      .invoke('fs:write', {
        path: tab.path,
        content: savedContent,
        ...(tab.file.mtimeMs > 0 ? { expectedMtimeMs: tab.file.mtimeMs } : {}),
      })
      .then(unwrapOperation)
      .then(
        (written) => {
          setTabs((current) =>
            current.map((candidate) => {
              if (candidate.id !== tab.id || !candidate.file) return candidate
              const unchangedSinceSave = candidate.file.content === savedContent
              return {
                ...candidate,
                error: undefined,
                dirty: unchangedSinceSave ? false : candidate.dirty,
                conflict: unchangedSinceSave ? false : candidate.conflict,
                file: {
                  ...candidate.file,
                  size: unchangedSinceSave ? written.size : candidate.file.size,
                  mtimeMs: written.mtimeMs,
                },
              }
            }),
          )
        },
        (reason: unknown) => {
          const error = reason instanceof Error ? reason.message : String(reason)
          setTabs((current) =>
            current.map((candidate) =>
              candidate.id === tab.id
                ? {
                    ...candidate,
                    error,
                    conflict: candidate.conflict || /file changed/i.test(error),
                  }
                : candidate,
            ),
          )
        },
      )
  }

  const activeTab = tabs.find((tab) => tab.id === activeId)
  const primaryTabs = tabs.filter((tab) => tab.pane === 'primary')
  const secondaryTabs = tabs.filter((tab) => tab.pane === 'secondary')
  const primaryActiveTab =
    primaryTabs.find((tab) => tab.id === activeByPaneRef.current.primary) ??
    primaryTabs[0]
  const secondaryActiveTab =
    secondaryTabs.find((tab) => tab.id === activeByPaneRef.current.secondary) ??
    secondaryTabs[0]

  const openViewerSplit = (): void => {
    setViewerSplit(true)
    if (rootRef.current) persistLayout(rootRef.current, { viewerSplit: true })
  }

  const closeViewerSplit = (): void => {
    setTabs((current) =>
      current.map((tab) =>
        tab.pane === 'secondary' ? { ...tab, pane: 'primary' } : tab,
      ),
    )
    if (activePaneRef.current === 'secondary') activePaneRef.current = 'primary'
    if (activeIdRef.current) activeByPaneRef.current.primary = activeIdRef.current
    activeByPaneRef.current.secondary = undefined
    setViewerSplit(false)
    if (rootRef.current) persistLayout(rootRef.current, { viewerSplit: false })
  }

  const moveTabToPane = (id: string, pane: ViewerPaneId): void => {
    const moving = tabsRef.current.find((tab) => tab.id === id)
    if (!moving || moving.pane === pane) return
    setTabs((current) => current.map((tab) => (tab.id === id ? { ...tab, pane } : tab)))
    if (activeByPaneRef.current[moving.pane] === id) {
      activeByPaneRef.current[moving.pane] = tabsRef.current.find(
        (tab) => tab.pane === moving.pane && tab.id !== id,
      )?.id
    }
    activeByPaneRef.current[pane] = id
    activePaneRef.current = pane
    setActiveId(id)
    setGitGraphActive(false)
    if (pane === 'secondary') openViewerSplit()
  }

  const openGitGraph = (hash?: string): void => {
    activePaneRef.current = 'primary'
    setGitGraphOpen(true)
    setGitGraphActive(true)
    setGitGraphRequest((current) => ({
      serial: current.serial + 1,
      ...(hash ? { hash } : {}),
    }))
  }

  const changeSession = (): void => {
    setShowAddProject(true)
  }

  const switchWorkspace = async (
    projectId: string,
    workspaceId: string,
  ): Promise<void> => {
    if (
      projectId === projectState?.activeProjectId &&
      workspaceId === projectState.activeWorkspaceId
    ) {
      return
    }
    setSessionBusy(true)
    setSessionError(undefined)
    try {
      const targetProject = projectState?.projects.find(
        (project) => project.id === projectId,
      )
      if (
        targetProject &&
        targetProject.registeredRoot.hostId !== 'local' &&
        targetProject.connectionState !== 'connected'
      ) {
        unwrapOperation(
          await window.hvir.invoke('project:connect-host', {
            hostId: targetProject.registeredRoot.hostId,
          }),
        )
      }
      const state = unwrapOperation(
        await window.hvir.invoke('project:switch', { projectId, workspaceId }),
      )
      applyProjectState(state)
    } catch (reason) {
      setSessionError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setSessionBusy(false)
    }
  }

  workspaceSwitchRef.current = (direction): void => {
    const project = projectState?.projects.find(
      (candidate) => candidate.id === projectState.activeProjectId,
    )
    const available = project?.workspaces.filter((workspace) => !workspace.missing) ?? []
    if (!project || available.length < 2) return
    const currentIndex = available.findIndex(
      (workspace) => workspace.id === projectState?.activeWorkspaceId,
    )
    const target =
      available[(currentIndex + direction + available.length) % available.length]
    if (target) void switchWorkspace(project.id, target.id)
  }

  const refreshProject = async (projectId: string): Promise<void> => {
    setSessionBusy(true)
    setSessionError(undefined)
    try {
      applyProjectState(
        unwrapOperation(await window.hvir.invoke('project:refresh', { projectId })),
      )
    } catch (reason) {
      setSessionError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setSessionBusy(false)
    }
  }

  const pruneWorktrees = async (projectId: string): Promise<void> => {
    setSessionBusy(true)
    setSessionError(undefined)
    try {
      applyProjectState(
        unwrapOperation(await window.hvir.invoke('workspace:prune', { projectId })),
      )
    } catch (reason) {
      setSessionError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setSessionBusy(false)
    }
  }

  const dismissWorkspace = async (
    projectId: string,
    workspaceId: string,
  ): Promise<void> => {
    setSessionBusy(true)
    setSessionError(undefined)
    try {
      applyProjectState(
        unwrapOperation(
          await window.hvir.invoke('workspace:dismiss', { projectId, workspaceId }),
        ),
      )
    } catch (reason) {
      setSessionError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setSessionBusy(false)
    }
  }

  const switchGitBranch = async (branch: string): Promise<void> => {
    const workspaceRoot = rootRef.current
    if (!workspaceRoot) throw new Error('No active workspace')
    if (tabsRef.current.some((tab) => tab.dirty)) {
      throw new Error('Save or close unsaved viewer tabs before switching')
    }
    const state = unwrapOperation(
      await window.hvir.invoke('git:switch-branch', {
        root: workspaceRoot,
        branch,
      }),
    )
    applyProjectState(state)
    setWatchVersion((version) => version + 1)
    setIgnoredRefreshVersion((version) => version + 1)
    setContentVersion((version) => version + 1)
    setGitVersion((version) => version + 1)
    for (const tab of tabsRef.current) {
      if (!tab.dirty) loadFile(tab.path)
    }
  }

  const disconnectSession = async (): Promise<void> => {
    if (!root || root.hostId === 'local') return
    setSessionBusy(true)
    setSessionError(undefined)
    try {
      const host = unwrapOperation(
        await window.hvir.invoke('project:disconnect-host', {
          hostId: root.hostId,
        }),
      )
      setSshPrompts((current) =>
        current.filter((prompt) => prompt.hostId !== root.hostId),
      )
      setConnectionState(host.connectionState)
    } catch (reason) {
      setSessionError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setSessionBusy(false)
    }
  }

  const reconnectSession = async (): Promise<void> => {
    if (!root || root.hostId === 'local') return
    setSessionBusy(true)
    setSessionError(undefined)
    try {
      const connected = unwrapOperation(
        await window.hvir.invoke('project:connect-host', {
          hostId: root.hostId,
        }),
      )
      setConnectionState(connected.host.connectionState)
      setWatchTier(connected.host.watchTier)
      for (const tab of tabsRef.current) {
        if (!tab.dirty) loadFile(tab.path)
      }
    } catch (reason) {
      setSessionError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setSessionBusy(false)
    }
  }

  const setTreeWidth = (width: number): void => {
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
    if (rootRef.current) persistLayout(rootRef.current, { treeWidth: next })
  }

  const setTerminalHeight = (height: number): void => {
    const workbench = workbenchRef.current
    if (!workbench) return
    const max = Math.max(
      TERMINAL_MIN_HEIGHT,
      workbench.clientHeight - DIVIDER_SIZE - VIEWER_MIN_HEIGHT,
    )
    const next = clamp(height, TERMINAL_MIN_HEIGHT, max)
    workbench.style.setProperty('--terminal-track', `${next}px`)
    if (rootRef.current) persistLayout(rootRef.current, { terminalHeight: next })
  }

  const setViewerPrimaryWidth = (width: number): void => {
    const groups = viewerGroupsRef.current
    if (!groups) return
    const next = clamp(width, 240, Math.max(240, groups.clientWidth - 245))
    groups.style.setProperty('--viewer-primary-track', `${next}px`)
    if (rootRef.current) {
      persistLayout(rootRef.current, { viewerPrimaryWidth: next })
    }
  }

  if (rootError) return <div className="startup-error">{rootError}</div>
  if (!root) return <div className="startup-loading">Starting hvir…</div>

  const renderViewerPane = (
    pane: ViewerPaneId,
    paneTabs: readonly ViewerTab[],
    paneTab: ViewerTab | undefined,
    graphPane: boolean,
  ): ReactElement => (
    <section
      className={`viewer-group viewer-group-${pane}`}
      aria-label={`${pane === 'primary' ? 'Primary' : 'Secondary'} file viewer`}
      data-viewer-pane={pane}
      tabIndex={-1}
      onPointerDownCapture={() => {
        activePaneRef.current = pane
        if (paneTab && !(graphPane && gitGraphActive)) {
          activeByPaneRef.current[pane] = paneTab.id
          setActiveId(paneTab.id)
        }
      }}
    >
      <TabStrip
        tabs={paneTabs}
        pane={pane}
        activeId={graphPane && gitGraphActive ? undefined : paneTab?.id}
        onActivate={(id) => activateTab(id, pane)}
        onClose={closeTab}
        onPin={(id) =>
          setTabs((current) =>
            current.map((tab) => (tab.id === id ? { ...tab, pinned: true } : tab)),
          )
        }
        onReorder={(draggedId, targetId) => {
          setTabs((current) => reorderTabs(current, draggedId, targetId))
        }}
        onMoveToPane={moveTabToPane}
        split={viewerSplit}
        onSplit={openViewerSplit}
        onClosePane={pane === 'secondary' ? closeViewerSplit : undefined}
        graphOpen={graphPane && gitGraphOpen}
        graphActive={graphPane && gitGraphActive}
        onActivateGraph={() => {
          activePaneRef.current = 'primary'
          setTerminalFocused(false)
          setGitGraphActive(true)
        }}
        onCloseGraph={() => {
          setGitGraphOpen(false)
          setGitGraphActive(false)
        }}
      />
      {graphPane && gitGraphOpen ? (
        <div className="workspace-view" hidden={!gitGraphActive}>
          <GitGraphView
            root={root}
            refreshVersion={gitVersion}
            connectionState={connectionState}
            requestedHash={gitGraphRequest.hash}
            requestSerial={gitGraphRequest.serial}
            onOpen={(path, base, revision) => openFile(path, true, 'git', base, revision)}
          />
        </div>
      ) : null}
      <div className="workspace-view" hidden={graphPane && gitGraphActive}>
        {activeWorkspace?.missing ? (
          <MissingWorkspaceNotice root={root} />
        ) : (
          <FileViewer
            key={`${pane}:${paneTab?.id ?? 'empty'}`}
            tab={paneTab}
            onMode={(mode) =>
              paneTab && updateTab(paneTab.id, (tab) => ({ ...tab, mode }))
            }
            onDiffBase={(diffBase) =>
              paneTab && updateTab(paneTab.id, (tab) => ({ ...tab, diffBase }))
            }
            onContent={(content) =>
              paneTab &&
              updateTab(paneTab.id, (tab) =>
                tab.file
                  ? {
                      ...tab,
                      pinned: true,
                      dirty: true,
                      file: {
                        ...tab.file,
                        content,
                        size: new TextEncoder().encode(content).byteLength,
                      },
                    }
                  : tab,
              )
            }
            onSave={() => paneTab && saveTab(paneTab.id)}
            onReload={() => {
              if (!paneTab) return
              updateTab(paneTab.id, (tab) => ({
                ...tab,
                dirty: false,
                conflict: false,
              }))
              loadFile(paneTab.path)
            }}
            onScroll={(scrollTop) =>
              paneTab && scheduleScrollPersistence(paneTab.id, scrollTop)
            }
            onNavigationHandled={(serial) =>
              paneTab &&
              updateTab(paneTab.id, (tab) =>
                tab.navigation?.serial === serial
                  ? { ...tab, navigation: undefined }
                  : tab,
              )
            }
            onOpenPath={(path) => {
              activePaneRef.current = pane
              if (paneTab) {
                updateTab(paneTab.id, (tab) => ({ ...tab, pinned: true }))
              }
              openFile(path, true)
            }}
            refreshVersion={contentVersion}
          />
        )}
      </div>
    </section>
  )

  return (
    <div className="app-shell">
      {projectState ? (
        <ProjectsBar
          state={projectState}
          rollups={terminalRollups}
          busy={sessionBusy}
          onAdd={changeSession}
          onSwitch={(projectId, workspaceId) =>
            void switchWorkspace(projectId, workspaceId)
          }
          onRefresh={(projectId) => void refreshProject(projectId)}
          onPrune={(projectId) => void pruneWorktrees(projectId)}
          onDismiss={(projectId, workspaceId) =>
            void dismissWorkspace(projectId, workspaceId)
          }
          theme={theme}
          onTheme={(nextTheme) => setAppTheme(nextTheme)}
          onSettings={() => setShowSettings(true)}
        />
      ) : null}
      <main
        className={`workbench${connectionState === 'connected' ? '' : ' project-stale'}${terminalFocused ? ' terminal-focused' : ''}${treeCollapsed ? ' tree-collapsed' : ''}`}
        ref={workbenchRef}
      >
        <aside className="tree-panel" aria-label="Project rail" tabIndex={-1}>
          <SessionBar
            label={root.hostId === 'local' ? 'Local' : `ssh:${root.hostId}`}
            remote={root.hostId !== 'local'}
            connectionState={connectionState}
            watchTier={watchTier}
            onChange={changeSession}
            onDisconnect={() => void disconnectSession()}
            onReconnect={() => void reconnectSession()}
            busy={sessionBusy}
            error={sessionError}
          />
          <nav className="rail-nav" aria-label="Project views">
            <button
              type="button"
              className={railMode === 'files' ? 'active' : ''}
              aria-current={railMode === 'files' ? 'page' : undefined}
              onClick={() => setRailMode('files')}
            >
              Files
            </button>
            {activeWorkspace?.repository !== false && !activeWorkspace?.missing ? (
              <button
                type="button"
                className={railMode === 'git' ? 'active' : ''}
                aria-current={railMode === 'git' ? 'page' : undefined}
                onClick={() => setRailMode('git')}
              >
                Git{changedCount > 0 ? ` ${changedCount}` : ''}
              </button>
            ) : null}
            <button
              type="button"
              className={railMode === 'harness' ? 'active' : ''}
              aria-current={railMode === 'harness' ? 'page' : undefined}
              onClick={() => setRailMode('harness')}
            >
              Harness
            </button>
          </nav>
          <div className="rail-content">
            <FileTree
              key={`files:${root.hostId}:${root.path}`}
              root={root}
              refreshVersion={watchVersion}
              ignoredRefreshVersion={ignoredRefreshVersion}
              changedFiles={gitChanges?.workingTree}
              selected={activeTab?.path}
              onOpen={openFile}
              connected={connectionState === 'connected'}
              missing={activeWorkspace?.missing}
              hidden={railMode !== 'files'}
            />
            {!activeWorkspace?.missing ? (
              <GitPanel
                key={`git:${root.hostId}:${root.path}`}
                root={root}
                refreshVersion={contentVersion}
                historyRefreshVersion={gitVersion}
                onChanges={setGitChanges}
                onOpenChange={(path, base, untracked) =>
                  openFile(path, true, untracked ? 'git-untracked' : 'git', base)
                }
                onOpenHistory={(path, revision) =>
                  openFile(path, true, 'git', 'head', revision)
                }
                onOpenGraph={openGitGraph}
                connectionState={connectionState}
                hidden={railMode !== 'git'}
                historyPaused={gitGraphActive}
                hasDirtyViewerTabs={tabs.some((tab) => tab.dirty)}
                onSwitchBranch={switchGitBranch}
              />
            ) : null}
            <section
              className="rail-section harness-placeholder"
              aria-label="Harness"
              hidden={railMode !== 'harness'}
            >
              <div className="harness-placeholder-copy">
                <strong>Harness view</strong>
                <span>Coming soon</span>
                <p>Agent activity and session context will live here.</p>
              </div>
            </section>
          </div>
        </aside>
        <PaneResizer
          orientation="vertical"
          className="tree-resizer"
          label="Resize file tree"
          onDrag={(clientX) => {
            const left = workbenchRef.current?.getBoundingClientRect().left ?? 0
            if (treeCollapsed) setTreeCollapsed(false)
            setTreeWidth(clientX - left)
          }}
          onNudge={(delta) => {
            if (treeCollapsed) {
              if (delta > 0) setTreeCollapsed(false)
              return
            }
            const current =
              workbenchRef.current?.querySelector<HTMLElement>('.tree-panel')
            if (current) setTreeWidth(current.getBoundingClientRect().width + delta)
          }}
          onReset={() => {
            workbenchRef.current?.style.removeProperty('--tree-track')
            if (rootRef.current) persistLayout(rootRef.current, { treeWidth: 0 })
          }}
          action={
            <button
              type="button"
              className="tree-collapse-toggle"
              data-resizer-action
              aria-label={
                treeCollapsed ? 'Restore file explorer' : 'Collapse file explorer'
              }
              aria-pressed={treeCollapsed}
              title={treeCollapsed ? 'Restore file explorer' : 'Collapse file explorer'}
              onDoubleClick={(event) => event.stopPropagation()}
              onClick={() => setTreeCollapsed((collapsed) => !collapsed)}
            >
              <svg aria-hidden="true" viewBox="0 0 16 16">
                <path
                  d={
                    treeCollapsed
                      ? 'M4 3 8.5 8 4 13M8 3l4.5 5L8 13'
                      : 'M12 3 7.5 8l4.5 5M8 3 3.5 8 8 13'
                  }
                />
              </svg>
            </button>
          }
        />
        <section className="viewer-panel" aria-label="File viewer">
          <div
            className={`viewer-groups${viewerSplit ? ' split' : ''}`}
            ref={viewerGroupsRef}
          >
            {renderViewerPane('primary', primaryTabs, primaryActiveTab, true)}
            {viewerSplit ? (
              <>
                <PaneResizer
                  orientation="vertical"
                  className="viewer-split-resizer"
                  label="Resize split viewers"
                  onDrag={(clientX) => {
                    const left =
                      viewerGroupsRef.current?.getBoundingClientRect().left ?? 0
                    setViewerPrimaryWidth(clientX - left)
                  }}
                  onNudge={(delta) => {
                    const current = viewerGroupsRef.current?.querySelector<HTMLElement>(
                      '.viewer-group-primary',
                    )
                    if (current) {
                      setViewerPrimaryWidth(current.getBoundingClientRect().width + delta)
                    }
                  }}
                  onReset={() => {
                    viewerGroupsRef.current?.style.removeProperty(
                      '--viewer-primary-track',
                    )
                    if (rootRef.current) {
                      persistLayout(rootRef.current, { viewerPrimaryWidth: 0 })
                    }
                  }}
                />
                {renderViewerPane('secondary', secondaryTabs, secondaryActiveTab, false)}
              </>
            ) : null}
          </div>
        </section>
        <PaneResizer
          orientation="horizontal"
          className="terminal-resizer"
          label="Resize terminal"
          onDrag={(clientY) => {
            const bottom = workbenchRef.current?.getBoundingClientRect().bottom ?? 0
            setTerminalHeight(bottom - clientY)
          }}
          onNudge={(delta) => {
            const current =
              workbenchRef.current?.querySelector<HTMLElement>('.terminal-panel')
            if (current) setTerminalHeight(current.getBoundingClientRect().height + delta)
          }}
          onReset={() => {
            workbenchRef.current?.style.removeProperty('--terminal-track')
            if (rootRef.current) persistLayout(rootRef.current, { terminalHeight: 0 })
          }}
          action={
            <button
              type="button"
              className="terminal-focus-toggle"
              data-resizer-action
              aria-label={terminalFocused ? 'Restore file viewer' : 'Expand terminal'}
              aria-pressed={terminalFocused}
              title={terminalFocused ? 'Restore file viewer' : 'Expand terminal'}
              onDoubleClick={(event) => event.stopPropagation()}
              onClick={() => setTerminalFocused((focused) => !focused)}
            >
              <svg aria-hidden="true" viewBox="0 0 16 16">
                <path
                  d={
                    terminalFocused
                      ? 'M3 4.5 8 9l5-4.5M3 8.5 8 13l5-4.5'
                      : 'M3 11.5 8 7l5 4.5M3 7.5 8 3l5 4.5'
                  }
                />
              </svg>
            </button>
          }
        />
        {projectState?.projects.flatMap((project) =>
          project.workspaces.map((workspace) => (
            <TerminalWorkspace
              key={workspace.id}
              workspaceId={workspace.id}
              cwd={workspace.root}
              label={workspace.name}
              available={!workspace.missing}
              visible={workspace.id === projectState.activeWorkspaceId}
              connectionState={project.connectionState}
              onRollup={updateTerminalRollup}
              onOpenPath={(target) =>
                openFile(
                  target.path,
                  true,
                  'file-tree',
                  'head',
                  undefined,
                  target.line === undefined
                    ? undefined
                    : { line: target.line, column: target.column },
                )
              }
              idleThresholdMs={settings.idleThresholdMs}
              recoveryMode={settings.terminalRecoveryMode}
              terminalTheme={settings.terminalTheme}
              onOpenSettings={() => setShowSettings(true)}
            />
          )),
        )}
      </main>
      {showAddProject ? (
        <SessionDialog
          hosts={hosts}
          currentRoot={root}
          suspended={sshPrompts.length > 0}
          onCancel={() => setShowAddProject(false)}
          onConnect={connectProjectHost}
          onBrowse={browseProjectHost}
          onDisconnect={disconnectProjectHost}
          onOpen={openProjectHost}
          onOpened={(state) => {
            applyProjectState(state)
            setShowAddProject(false)
          }}
        />
      ) : null}
      {showSettings ? (
        <SettingsDialog
          theme={theme}
          settings={settings}
          onClose={() => setShowSettings(false)}
          onSave={(nextTheme, nextSettings) => {
            setAppTheme(nextTheme)
            setAppSettings(nextSettings)
            setShowSettings(false)
          }}
        />
      ) : null}
      {sshPrompts[0] ? (
        <SshPromptDialog
          key={sshPrompts[0].id}
          prompt={sshPrompts[0]}
          onAnswer={(answers) => {
            const answered = sshPrompts[0]
            if (!answered) return
            void window.hvir.invoke('ssh:prompt-response', {
              id: answered.id,
              answers,
            })
            setSshPrompts((current) =>
              current.filter((candidate) => candidate.id !== answered.id),
            )
          }}
        />
      ) : null}
    </div>
  )
}

function SessionDialog({
  hosts,
  currentRoot,
  suspended,
  onCancel,
  onConnect,
  onBrowse,
  onDisconnect,
  onOpen,
  onOpened,
}: {
  readonly hosts: readonly ProjectHostOption[]
  readonly currentRoot: HostPath
  readonly suspended: boolean
  readonly onCancel: () => void
  readonly onConnect: (hostId: string) => Promise<ConnectedHost>
  readonly onBrowse: (hostId: string, path: string) => Promise<BrowseHostResponse>
  readonly onDisconnect: (hostId: string) => Promise<ProjectHostOption>
  readonly onOpen: (hostId: string, path: string) => Promise<ProjectState>
  readonly onOpened: (state: ProjectState) => void
}): ReactElement {
  const dialogRef = useRef<HTMLElement>(null)
  const [stage, setStage] = useState<'host' | 'folder'>('host')
  const [hostId, setHostId] = useState(
    hosts.some((host) => host.hostId === currentRoot.hostId)
      ? currentRoot.hostId
      : (hosts[0]?.hostId ?? 'local'),
  )
  const [connected, setConnected] = useState<ConnectedHost>()
  const [pathInput, setPathInput] = useState('')
  const [selectedPath, setSelectedPath] = useState<string>()
  const [revealedPath, setRevealedPath] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const selectedHost = hosts.find((host) => host.hostId === hostId)

  const releaseUnopenedHost = async (): Promise<void> => {
    if (connected?.host.kind === 'ssh' && connected.host.hostId !== currentRoot.hostId) {
      await onDisconnect(connected.host.hostId)
    }
  }

  const cancel = async (): Promise<void> => {
    setBusy(true)
    try {
      await releaseUnopenedHost()
    } finally {
      onCancel()
    }
  }

  const back = async (): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      await releaseUnopenedHost()
      setStage('host')
      setConnected(undefined)
      setPathInput('')
      setSelectedPath(undefined)
      setRevealedPath(undefined)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const selectPath = async (targetPath: string): Promise<void> => {
    if (!connected) return
    setBusy(true)
    setError(undefined)
    try {
      const result = await onBrowse(connected.host.hostId, targetPath)
      setPathInput(result.path.path)
      setSelectedPath(result.path.path)
      setRevealedPath(result.path.path)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const connect = async (): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      const result = await onConnect(hostId)
      setConnected(result)
      setStage('folder')
      const listing = await onBrowse(result.host.hostId, result.suggestedPath)
      setPathInput(listing.path.path)
      setSelectedPath(listing.path.path)
      setRevealedPath(listing.path.path)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const open = async (): Promise<void> => {
    if (!connected || !selectedPath) return
    setBusy(true)
    setError(undefined)
    try {
      const state = await onOpen(connected.host.hostId, selectedPath)
      rememberFolder(connected.host.hostId, state.root.path)
      onOpened(state)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      setBusy(false)
    }
  }

  const connectedHostId = connected?.host.hostId
  const loadPickerEntries = useCallback(
    async (directory: HostPath) => {
      if (!connectedHostId) return []
      return (await onBrowse(connectedHostId, directory.path)).directories
    },
    [connectedHostId, onBrowse],
  )

  useModalKeyboard(dialogRef, () => void cancel(), !busy, !suspended)

  return (
    <div className="modal-backdrop">
      <section
        className="project-dialog session-dialog"
        ref={dialogRef}
        role="dialog"
        aria-modal={suspended ? undefined : true}
        aria-hidden={suspended || undefined}
        inert={suspended || undefined}
        aria-labelledby="session-dialog-title"
        tabIndex={-1}
      >
        <h2 id="session-dialog-title">
          {stage === 'host'
            ? 'Connect to a host'
            : `Open folder on ${connected?.host.label ?? hostId}`}
        </h2>
        {error ? <p className="dialog-error">{error}</p> : null}
        {stage === 'host' ? (
          <div className="session-hosts" role="listbox" aria-label="Hosts">
            {hosts.map((host) => (
              <button
                type="button"
                role="option"
                aria-selected={hostId === host.hostId}
                className={`session-host-option${hostId === host.hostId ? ' selected' : ''}`}
                key={host.hostId}
                onClick={() => setHostId(host.hostId)}
              >
                <span className="session-host-copy">
                  {host.kind === 'ssh' ? (
                    <RemoteConnectionBadge
                      state={host.connectionState}
                      hostLabel={`ssh:${host.label}`}
                    />
                  ) : (
                    <strong>Local</strong>
                  )}
                  <small>
                    {host.kind === 'ssh' ? host.connectionState : 'this machine'}
                  </small>
                </span>
              </button>
            ))}
          </div>
        ) : (
          <>
            <form
              className="folder-path-form"
              onSubmit={(event) => {
                event.preventDefault()
                void selectPath(pathInput)
              }}
            >
              <input
                aria-label="Folder path"
                autoFocus
                value={pathInput}
                onChange={(event) => {
                  setPathInput(event.target.value)
                  setSelectedPath(undefined)
                }}
              />
              <button type="submit" disabled={busy}>
                Go
              </button>
            </form>
            {connected ? (
              <div className="recent-folders">
                {recentFolders(connected.host.hostId).map((folder) => (
                  <button
                    type="button"
                    key={folder}
                    onClick={() => void selectPath(folder)}
                  >
                    {folder}
                  </button>
                ))}
              </div>
            ) : null}
            <div className="folder-browser" aria-label="Folders">
              <div className="folder-selection">
                <small>Selected folder</small>
                <code>{selectedPath ?? 'Choose a folder from the tree'}</code>
              </div>
              {connectedHostId ? (
                <DirectoryTree
                  root={hostPath(asHostId(connectedHostId), '/')}
                  rootLabel="/"
                  loadEntries={loadPickerEntries}
                  selected={
                    selectedPath
                      ? hostPath(asHostId(connectedHostId), selectedPath)
                      : undefined
                  }
                  expandedPath={
                    revealedPath
                      ? hostPath(asHostId(connectedHostId), revealedPath)
                      : undefined
                  }
                  showFiles={false}
                  onSelectDirectory={(directory) => {
                    setPathInput(directory.path)
                    setSelectedPath(directory.path)
                    setRevealedPath(directory.path)
                  }}
                />
              ) : null}
            </div>
          </>
        )}
        <div className="dialog-actions">
          {stage === 'folder' ? (
            <button type="button" disabled={busy} onClick={() => void back()}>
              Back
            </button>
          ) : null}
          <button type="button" disabled={busy} onClick={() => void cancel()}>
            Cancel
          </button>
          <button
            type="button"
            disabled={busy || (stage === 'folder' && !selectedPath)}
            onClick={() => void (stage === 'host' ? connect() : open())}
          >
            {busy
              ? 'Working…'
              : stage === 'host'
                ? selectedHost?.kind === 'local' ||
                  selectedHost?.connectionState === 'connected'
                  ? 'Choose folder'
                  : 'Connect'
                : 'Open selected folder'}
          </button>
        </div>
      </section>
    </div>
  )
}

function SshPromptDialog({
  prompt,
  onAnswer,
}: {
  readonly prompt: SshPromptRequest
  readonly onAnswer: (answers?: readonly string[]) => void
}): ReactElement {
  const dialogRef = useRef<HTMLFormElement>(null)
  const [answers, setAnswers] = useState(() => prompt.prompts.map(() => ''))
  const [verifiedChangedKey, setVerifiedChangedKey] = useState(false)
  const changedKey = prompt.kind === 'host-key-changed'
  useModalKeyboard(dialogRef, () => onAnswer(undefined))
  return (
    <div className="modal-backdrop">
      <form
        className="project-dialog"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="ssh-prompt-title"
        tabIndex={-1}
        onSubmit={(event) => {
          event.preventDefault()
          onAnswer(prompt.kind === 'host-key' || changedKey ? ['yes'] : answers)
        }}
      >
        <h2 id="ssh-prompt-title">{prompt.title}</h2>
        {prompt.instructions ? <p>{prompt.instructions}</p> : null}
        {(prompt.kind === 'host-key' || changedKey) && prompt.fingerprint ? (
          <div className={changedKey ? 'ssh-host-key-changed' : undefined}>
            {changedKey && prompt.previousFingerprint ? (
              <label>
                Saved fingerprint
                <code className="ssh-host-fingerprint">{prompt.previousFingerprint}</code>
              </label>
            ) : null}
            <label>
              {changedKey ? 'Presented fingerprint' : 'Fingerprint'}
              <code className="ssh-host-fingerprint">{prompt.fingerprint}</code>
            </label>
            {changedKey ? (
              <label className="ssh-host-key-confirm">
                <input
                  type="checkbox"
                  checked={verifiedChangedKey}
                  onChange={(event) => setVerifiedChangedKey(event.target.checked)}
                />
                I verified this host key through a trusted channel.
              </label>
            ) : null}
          </div>
        ) : (
          prompt.prompts.map((item, index) => (
            <label key={`${item.text}:${index}`}>
              {item.text}
              <input
                autoFocus={index === 0}
                type={item.echo ? 'text' : 'password'}
                value={answers[index]}
                onChange={(event) =>
                  setAnswers((current) =>
                    current.map((answer, at) =>
                      at === index ? event.target.value : answer,
                    ),
                  )
                }
              />
            </label>
          ))
        )}
        <div className="dialog-actions">
          <button type="button" onClick={() => onAnswer(undefined)}>
            Cancel
          </button>
          <button
            type="submit"
            autoFocus={prompt.kind === 'host-key'}
            disabled={changedKey && !verifiedChangedKey}
          >
            {changedKey
              ? 'Replace Saved Key'
              : prompt.kind === 'host-key'
                ? 'Trust Host'
                : 'Continue'}
          </button>
        </div>
      </form>
    </div>
  )
}

function useModalKeyboard(
  dialogRef: RefObject<HTMLElement | null>,
  onDismiss: () => void,
  dismissEnabled = true,
  active = true,
): void {
  const dismissRef = useRef(onDismiss)
  const enabledRef = useRef(dismissEnabled)
  const activeRef = useRef(active)
  dismissRef.current = onDismiss
  enabledRef.current = dismissEnabled
  activeRef.current = active

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    const previousFocus = document.activeElement
    const focusableSelector =
      'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
    const focusFirst = window.requestAnimationFrame(() => {
      if (!activeRef.current) return
      const preferred = dialog.querySelector<HTMLElement>('[autofocus]')
      const first = dialog.querySelector<HTMLElement>(focusableSelector)
      ;(preferred ?? first ?? dialog).focus()
    })
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (!activeRef.current) return
      if (event.key === 'Escape' && enabledRef.current) {
        event.preventDefault()
        dismissRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = [
        ...dialog.querySelectorAll<HTMLElement>(focusableSelector),
      ].filter((element) => element.offsetParent !== null)
      if (focusable.length === 0) {
        event.preventDefault()
        dialog.focus()
        return
      }
      const current = focusable.indexOf(document.activeElement as HTMLElement)
      const next = event.shiftKey
        ? current <= 0
          ? focusable.at(-1)
          : focusable[current - 1]
        : current < 0 || current === focusable.length - 1
          ? focusable[0]
          : focusable[current + 1]
      event.preventDefault()
      next?.focus()
    }
    document.addEventListener('keydown', handleKeyDown, true)
    return () => {
      window.cancelAnimationFrame(focusFirst)
      document.removeEventListener('keydown', handleKeyDown, true)
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
        previousFocus.focus()
      }
    }
  }, [dialogRef])
}

function connectProjectHost(hostId: string): Promise<ConnectedHost> {
  return window.hvir.invoke('project:connect-host', { hostId }).then(unwrapOperation)
}

function browseProjectHost(hostId: string, path: string): Promise<BrowseHostResponse> {
  return window.hvir.invoke('project:browse-host', { hostId, path }).then(unwrapOperation)
}

function disconnectProjectHost(hostId: string): Promise<ProjectHostOption> {
  return window.hvir.invoke('project:disconnect-host', { hostId }).then(unwrapOperation)
}

function openProjectHost(hostId: string, path: string): Promise<ProjectState> {
  return window.hvir.invoke('project:open', { hostId, path }).then(unwrapOperation)
}

function recentFolders(hostId: string): readonly string[] {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(`hvir:recent-folders:${hostId}`) ?? '[]',
    )
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string').slice(0, 5)
      : []
  } catch {
    return []
  }
}

function rememberFolder(hostId: string, path: string): void {
  const next = [path, ...recentFolders(hostId).filter((folder) => folder !== path)].slice(
    0,
    5,
  )
  localStorage.setItem(`hvir:recent-folders:${hostId}`, JSON.stringify(next))
}

interface StoredTabs {
  readonly version: number
  readonly activeId?: string
  readonly tabs: readonly {
    readonly hostId: string
    readonly path: string
    readonly pane?: ViewerPaneId
    readonly pinned: boolean
    readonly mode: ViewMode
    readonly diffBase: DiffBase
    readonly diffRevision?: string
    readonly scrollTop: number
    readonly draft?: string
    readonly mtimeMs?: number
  }[]
}

function restoreTabs(root: HostPath): { tabs: readonly ViewerTab[]; activeId?: string } {
  try {
    const raw = localStorage.getItem(storageKey(root))
    if (!raw) return { tabs: [] }
    const parsed: unknown = JSON.parse(raw)
    if (!isStoredTabs(parsed)) return { tabs: [] }
    const stored = parsed
    const tabs = stored.tabs.flatMap((item): ViewerTab[] => {
      if (
        item.hostId !== root.hostId ||
        typeof item.path !== 'string' ||
        !insideRoot(item.path, root.path) ||
        !isViewMode(item.mode) ||
        !isDiffBase(item.diffBase)
      ) {
        return []
      }
      const path = hostPath(asHostId(item.hostId), item.path)
      const draft =
        typeof item.draft === 'string' &&
        item.draft.length <= DRAFT_STORAGE_CHARACTER_LIMIT
          ? item.draft
          : undefined
      return [
        {
          id: tabId(path),
          path,
          pane: item.pane === 'secondary' ? 'secondary' : 'primary',
          pinned: Boolean(item.pinned),
          mode: item.mode,
          diffBase: item.diffBase,
          diffRevision:
            typeof item.diffRevision === 'string' ? item.diffRevision : undefined,
          scrollTop: Number.isFinite(item.scrollTop) ? item.scrollTop : 0,
          file:
            draft === undefined
              ? undefined
              : {
                  path,
                  content: draft,
                  size: new TextEncoder().encode(draft).byteLength,
                  mtimeMs:
                    typeof item.mtimeMs === 'number' &&
                    Number.isFinite(item.mtimeMs) &&
                    item.mtimeMs > 0
                      ? item.mtimeMs
                      : 0,
                  binary: false,
                },
          loading: draft === undefined,
          dirty: draft !== undefined,
          conflict: false,
        },
      ]
    })
    const activeId = tabs.some((tab) => tab.id === stored.activeId)
      ? stored.activeId
      : tabs[0]?.id
    return { tabs, activeId }
  } catch {
    return { tabs: [] }
  }
}

function persistTabs(
  root: HostPath,
  tabs: readonly ViewerTab[],
  activeId?: string,
  includeDrafts = true,
): void {
  let remainingDraftCharacters = includeDrafts ? DRAFT_STORAGE_CHARACTER_LIMIT : 0
  const stored: StoredTabs = {
    version: TAB_STORAGE_VERSION,
    activeId,
    tabs: tabs.map((tab) => {
      const draft = tab.dirty ? tab.file?.content : undefined
      const draftCharacters = draft?.length ?? 0
      const storedDraft = draftCharacters <= remainingDraftCharacters ? draft : undefined
      remainingDraftCharacters -= storedDraft === undefined ? 0 : draftCharacters
      return {
        hostId: tab.path.hostId,
        path: tab.path.path,
        pane: tab.pane,
        pinned: tab.pinned,
        mode: tab.mode,
        diffBase: tab.diffBase,
        diffRevision: tab.diffRevision,
        scrollTop: tab.scrollTop,
        draft: storedDraft,
        mtimeMs: storedDraft === undefined ? undefined : tab.file?.mtimeMs,
      }
    }),
  }
  try {
    localStorage.setItem(storageKey(root), JSON.stringify(stored))
  } catch {
    // Storage is a recovery aid, never a reason to make the live viewer fail.
  }
}

function storageKey(root: HostPath): string {
  return `hvir:tabs:${root.hostId}:${root.path}`
}

interface StoredLayout {
  readonly version: 1
  readonly treeWidth?: number
  readonly terminalHeight?: number
  readonly viewerSplit?: boolean
  readonly viewerPrimaryWidth?: number
}

function restoreLayout(root: HostPath): StoredLayout {
  try {
    const parsed: unknown = JSON.parse(
      localStorage.getItem(`hvir:layout:${root.hostId}:${root.path}`) ?? 'null',
    )
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { version: 1 }
    }
    const layout = parsed as Record<string, unknown>
    return {
      version: 1,
      treeWidth:
        typeof layout['treeWidth'] === 'number' && Number.isFinite(layout['treeWidth'])
          ? layout['treeWidth']
          : undefined,
      terminalHeight:
        typeof layout['terminalHeight'] === 'number' &&
        Number.isFinite(layout['terminalHeight'])
          ? layout['terminalHeight']
          : undefined,
      viewerSplit:
        typeof layout['viewerSplit'] === 'boolean' ? layout['viewerSplit'] : undefined,
      viewerPrimaryWidth:
        typeof layout['viewerPrimaryWidth'] === 'number' &&
        Number.isFinite(layout['viewerPrimaryWidth'])
          ? layout['viewerPrimaryWidth']
          : undefined,
    }
  } catch {
    return { version: 1 }
  }
}

function persistLayout(
  root: HostPath,
  update: {
    readonly treeWidth?: number
    readonly terminalHeight?: number
    readonly viewerSplit?: boolean
    readonly viewerPrimaryWidth?: number
  },
): void {
  try {
    localStorage.setItem(
      `hvir:layout:${root.hostId}:${root.path}`,
      JSON.stringify({ ...restoreLayout(root), ...update }),
    )
  } catch {
    // Layout recovery is best effort and never blocks the live workbench.
  }
}

function tabId(path: HostPath): string {
  return `${path.hostId}:${path.path}`
}

function insideRoot(path: string, root: string): boolean {
  return path === root || path.startsWith(root === '/' ? '/' : `${root}/`)
}

function nextMode(mode: ViewMode): ViewMode {
  if (mode === 'rendered') return 'source'
  if (mode === 'source') return 'diff'
  return 'rendered'
}

function isViewMode(value: unknown): value is ViewMode {
  return value === 'rendered' || value === 'source' || value === 'diff'
}

function isDiffBase(value: unknown): value is DiffBase {
  return value === 'working-tree' || value === 'head' || value === 'branch-point'
}

function isStoredTabs(value: unknown): value is StoredTabs {
  if (!value || typeof value !== 'object') return false
  const candidate = value as { version?: unknown; tabs?: unknown }
  return candidate.version === TAB_STORAGE_VERSION && Array.isArray(candidate.tabs)
}

function reorderTabs(
  tabs: readonly ViewerTab[],
  draggedId: string,
  targetId: string,
): readonly ViewerTab[] {
  const from = tabs.findIndex((tab) => tab.id === draggedId)
  const to = tabs.findIndex((tab) => tab.id === targetId)
  if (from < 0 || to < 0 || from === to) return tabs
  const next = [...tabs]
  const [dragged] = next.splice(from, 1)
  if (!dragged) return tabs
  next.splice(to, 0, dragged)
  return next
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
