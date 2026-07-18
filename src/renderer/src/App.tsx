import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type RefObject,
} from 'react'

import {
  asHostId,
  GIT_CHANGE_DISPLAY_LIMIT,
  hostPath,
  hostPathEquals,
  unwrapOperation,
  type GitChanges,
  type HostPath,
  type ProjectHostOption,
  type ConnectedHost,
  type BrowseHostResponse,
  type ProjectState,
  type SshPromptRequest,
  type WebPaneCommandAction,
} from '../../shared'
import { PaneResizer } from './layout/PaneResizer'
import { WebPane, type WebViewState } from './dashboards/WebPane'
import { TerminalWorkspace } from './terminal/TerminalWorkspace'
import { ProjectsBar } from './workspaces/ProjectsBar'
import { RemoteConnectionBadge } from './workspaces/ConnectionStatus'
import { MissingWorkspaceNotice } from './workspaces/MissingWorkspaceNotice'
import { useProjectSession } from './workspaces/project-session'
import type {
  WorkspaceAttentionRollup,
  WorkspaceAttentionRollups,
} from './workspaces/project-session-model'
import { useProjectWatchInterests } from './workspaces/project-watch-interests'
import { FileTree } from './tree/FileTree'
import { DirectoryTree } from './tree/DirectoryTree'
import { isGitIgnoreRulePath } from './tree/git-ignore-refresh'
import { GitPanel } from './git/GitPanel'
import { workspaceGitEnabled } from './git/git-capability'
import { GitGraphView } from './git/GitGraphView'
import { FileViewer } from './viewer/FileViewer'
import { TabStrip } from './viewer/TabStrip'
import type { ViewerPaneId, ViewerTab } from './viewer/tab-state'
import { useViewerWorkspace } from './viewer/use-viewer-workspace'
import {
  persistWorkspaceLayout,
  restoreWorkspaceLayout,
  viewerStorageKey,
} from './viewer/viewer-workspace-persistence'
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

export function App(): ReactElement {
  const theme = useAppTheme()
  const settings = useAppSettings()
  const workbenchRef = useRef<HTMLElement>(null)
  const viewerGroupsRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<HostPath | undefined>(undefined)
  const gitGraphActiveRef = useRef(false)
  const workspaceSwitchRef = useRef<(direction: -1 | 1) => void>(() => undefined)
  const [gitGraphOpen, setGitGraphOpen] = useState(false)
  const [gitGraphActive, setGitGraphActive] = useState(false)
  const [gitGraphRequest, setGitGraphRequest] = useState<{
    readonly serial: number
    readonly hash?: string
  }>({ serial: 0 })
  const [railMode, setRailMode] = useState<'files' | 'git' | 'harness'>('files')
  const [webViews, setWebViews] = useState<readonly WebViewState[]>([])
  const [activeWebViewId, setActiveWebViewId] = useState<string>()
  const [webViewActive, setWebViewActive] = useState(false)
  const [webViewFocused, setWebViewFocused] = useState(false)
  const webViewsRef = useRef<readonly WebViewState[]>([])
  const activeWebViewIdRef = useRef<string | undefined>(undefined)
  const webViewSelection = useRef(
    new Map<string, { readonly id?: string; readonly active: boolean }>(),
  )
  const webViewActiveRef = useRef(false)
  const [gitChanges, setGitChanges] = useState<GitChanges>()
  const [showAddProject, setShowAddProject] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [settingsInitialSection, setSettingsInitialSection] = useState<
    'general' | 'harnesses' | 'harnesses-add'
  >('general')
  const [terminalRollups, setTerminalRollups] = useState<WorkspaceAttentionRollups>({})
  const [terminalFocused, setTerminalFocused] = useState(false)
  const [treeCollapsed, setTreeCollapsed] = useState(false)
  const viewer = useViewerWorkspace({
    onActivateFile: () => {
      setGitGraphActive(false)
      setWebViewActive(false)
      setTerminalFocused(false)
    },
  })
  const {
    tabs,
    activeTab,
    primaryTabs,
    secondaryTabs,
    primaryActiveTab,
    secondaryActiveTab,
    split: viewerSplit,
    switchWorkspace: switchViewerWorkspace,
    openFile,
    activateTab,
    closeTab,
    pinTab,
    setMode: setViewerMode,
    cycleActiveMode,
    setDiffBase: setViewerDiffBase,
    setContent: setViewerContent,
    navigationHandled,
    scheduleScroll,
    reloadTab,
    saveTab,
    handleWatchEvent,
    reloadCleanFiles,
    focusPane: focusViewerPane,
    getActivePane,
    openSplit: openViewerSplit,
    closeSplit: closeViewerSplit,
    moveTab: moveTabToPane,
    reorderTabs: reorderViewerTabs,
  } = viewer
  gitGraphActiveRef.current = gitGraphActive
  webViewsRef.current = webViews
  activeWebViewIdRef.current = activeWebViewId
  webViewActiveRef.current = webViewActive
  const changedCount = gitChanges?.workingTree.length ?? 0
  const changedCountLabel = gitChanges?.workingTreeLimited
    ? `${GIT_CHANGE_DISPLAY_LIMIT.toLocaleString()}+`
    : changedCount.toLocaleString()

  useEffect(() => {
    const disposeNavigation = window.hvir.on(
      'web-pane:navigation-blocked',
      (navigation) => {
        setWebViews((current) =>
          current.map((view) =>
            view.id === navigation.paneId
              ? { ...view, blockedNavigation: navigation }
              : view,
          ),
        )
      },
    )
    const disposeDiagnostic = window.hvir.on(
      'web-pane:diagnostic',
      ({ paneId, event }) => {
        setWebViews((current) =>
          current.map((view) =>
            view.id === paneId
              ? {
                  ...view,
                  routeDiagnostic: {
                    revision: (view.routeDiagnostic?.revision ?? 0) + 1,
                    event,
                  },
                }
              : view,
          ),
        )
      },
    )
    return () => {
      void disposeNavigation()
      void disposeDiagnostic()
    }
  }, [])

  useEffect(() => {
    window.hvir.send('web-pane:full-page', {
      paneId: webViewFocused && webViewActive ? activeWebViewId : undefined,
    })
  }, [activeWebViewId, webViewActive, webViewFocused])

  const applyProjectViewState = useCallback(
    (state: ProjectState): void => {
      const liveWorkspaceKeys = new Set(
        state.projects.flatMap((project) =>
          project.workspaces.map((workspace) => viewerStorageKey(workspace.root)),
        ),
      )
      setWebViews((current) =>
        current.filter((view) =>
          liveWorkspaceKeys.has(viewerStorageKey(view.workspaceRoot)),
        ),
      )
      const currentRoot = rootRef.current
      if (currentRoot && hostPathEquals(currentRoot, state.root)) return
      if (currentRoot) {
        webViewSelection.current.set(viewerStorageKey(currentRoot), {
          id: activeWebViewIdRef.current,
          active: webViewActiveRef.current,
        })
      }
      const nextWebSelection = webViewSelection.current.get(viewerStorageKey(state.root))
      const selectedWebView = webViewsRef.current.find(
        (view) =>
          view.id === nextWebSelection?.id &&
          hostPathEquals(view.workspaceRoot, state.root),
      )
      switchViewerWorkspace(state.root)
      setGitGraphOpen(false)
      setGitGraphActive(false)
      setActiveWebViewId(selectedWebView?.id)
      setWebViewActive(Boolean(selectedWebView && nextWebSelection?.active))
      setWebViewFocused(false)
      setGitChanges(undefined)
      setTerminalFocused(false)
      setTreeCollapsed(false)
    },
    [switchViewerWorkspace],
  )

  const updateTerminalRollup = useCallback(
    (workspaceId: string, rollup: WorkspaceAttentionRollup): void => {
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

  const session = useProjectSession({
    onProjectState: applyProjectViewState,
    onReloadFiles: reloadCleanFiles,
    onWatchEvent: handleWatchEvent,
    isIgnoreRulePath: isGitIgnoreRulePath,
  })
  const {
    projectState,
    root,
    activeProject,
    activeWorkspace,
    connectionState,
    watchTier,
    rootError,
    refreshHosts,
  } = session
  const { watch: watchVersion, ignored: ignoredRefreshVersion } = session.versions
  const { content: contentVersion, git: gitVersion } = session.versions
  const openWatchPaths = useMemo(() => tabs.map((tab) => tab.path), [tabs])
  const watchInterests = useProjectWatchInterests({
    root,
    connected: connectionState === 'connected',
    missing: activeWorkspace?.missing,
    openPaths: openWatchPaths,
  })
  rootRef.current = root
  const gitEnabled = workspaceGitEnabled(activeWorkspace)

  useEffect(() => {
    if (showAddProject) void refreshHosts()
  }, [refreshHosts, showAddProject])

  useEffect(() => {
    if (!root) return
    const layout = restoreWorkspaceLayout(root)
    const workbench = workbenchRef.current
    if (workbench) {
      if (layout.treeWidth) {
        workbench.style.setProperty('--tree-track', `${layout.treeWidth}px`)
      } else {
        workbench.style.removeProperty('--tree-track')
      }
      if (layout.terminalHeight) {
        workbench.style.setProperty(
          '--terminal-track',
          `${fitTerminalHeight(layout.terminalHeight, workbench.clientHeight)}px`,
        )
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
    const perform = (action: WebPaneCommandAction, paneId?: string): void => {
      if (document.querySelector('[aria-modal="true"]')) return
      if (action === 'closeWebPane') {
        if (paneId) closeWebView(paneId)
      } else if (action === 'escapeWebPaneFocus') {
        setWebViewFocused(false)
      } else if (action === 'cycleViewMode') {
        if (gitGraphActiveRef.current || webViewActiveRef.current) return
        cycleActiveMode()
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
            .querySelector<HTMLElement>(`[data-viewer-pane="${getActivePane()}"]`)
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
      perform(action)
    }
    window.hvir.send('web-pane:reserved-bindings', settings.keybindings)
    const disposeCommand = window.hvir.on('web-pane:command', ({ action, paneId }) =>
      perform(action, paneId),
    )
    window.addEventListener('keydown', keydown, true)
    return () => {
      window.removeEventListener('keydown', keydown, true)
      void disposeCommand()
    }
  }, [cycleActiveMode, getActivePane, settings.keybindings])

  const openWebView = (view: WebViewState): void => {
    setTerminalFocused(false)
    setGitGraphActive(false)
    const existing = webViewsRef.current.find((candidate) => candidate.id === view.id)
    if (existing) {
      setWebViews((current) =>
        current.map((candidate) =>
          candidate.id === existing.id
            ? {
                ...candidate,
                url: view.url,
                blockedNavigation: undefined,
              }
            : candidate,
        ),
      )
      setActiveWebViewId(existing.id)
    } else {
      setWebViews((current) => [...current, view])
      setActiveWebViewId(view.id)
    }
    focusViewerPane('primary')
    setWebViewActive(true)
  }

  const openWebLink = (activation: {
    readonly terminalId: string
    readonly workspaceRoot: HostPath
    readonly url: string
  }): void => {
    void (async () => {
      try {
        const opened = unwrapOperation(
          await window.hvir.invoke('web-pane:open', {
            source: 'terminal',
            root: activation.workspaceRoot,
            terminalId: activation.terminalId,
            url: activation.url,
          }),
        )
        openWebView({
          id: opened.paneId,
          title: new URL(opened.origin).host,
          url: opened.url,
          origin: opened.origin,
          partition: opened.partition,
          workspaceRoot: activation.workspaceRoot,
          sourceTerminalId: activation.terminalId,
        })
      } catch (reason) {
        session.reportError(reason instanceof Error ? reason.message : String(reason))
      }
    })()
  }

  const followBlockedNavigation = (id: string): void => {
    const view = webViewsRef.current.find((candidate) => candidate.id === id)
    const navigation = view?.blockedNavigation
    if (!view || !navigation) return
    setWebViews((current) =>
      current.map((candidate) =>
        candidate.id === id ? { ...candidate, blockedNavigation: undefined } : candidate,
      ),
    )
    if (navigation.kind === 'external') {
      void window.hvir
        .invoke('web-pane:open-external', { paneId: id, url: navigation.url })
        .catch((reason) =>
          session.reportError(reason instanceof Error ? reason.message : String(reason)),
        )
      return
    }
    void (async () => {
      try {
        const opened = unwrapOperation(
          await window.hvir.invoke('web-pane:open', {
            source: 'pane',
            paneId: id,
            url: navigation.url,
          }),
        )
        openWebView({
          id: opened.paneId,
          title: new URL(opened.origin).host,
          url: opened.url,
          origin: opened.origin,
          partition: opened.partition,
          workspaceRoot: view.workspaceRoot,
          sourceTerminalId: view.sourceTerminalId,
        })
      } catch (reason) {
        session.reportError(reason instanceof Error ? reason.message : String(reason))
      }
    })()
  }

  const activateWebView = (id: string): void => {
    focusViewerPane('primary')
    setActiveWebViewId(id)
    setWebViewActive(true)
    setGitGraphActive(false)
    setTerminalFocused(false)
  }

  const closeWebView = (id: string): void => {
    void window.hvir.invoke('web-pane:close', { paneId: id }).catch(() => undefined)
    const remaining = webViewsRef.current.filter((candidate) => candidate.id !== id)
    setWebViews(remaining)
    if (activeWebViewIdRef.current === id) {
      const fallback = remaining
        .filter(
          (view) =>
            rootRef.current && hostPathEquals(view.workspaceRoot, rootRef.current),
        )
        .at(-1)
      setActiveWebViewId(fallback?.id)
      if (!fallback) setWebViewActive(false)
    }
  }

  const openGitGraph = (hash?: string): void => {
    focusViewerPane('primary')
    setGitGraphOpen(true)
    setGitGraphActive(true)
    setWebViewActive(false)
    setGitGraphRequest((current) => ({
      serial: current.serial + 1,
      ...(hash ? { hash } : {}),
    }))
  }

  const changeSession = (): void => {
    setShowAddProject(true)
  }

  workspaceSwitchRef.current = session.switchRelativeWorkspace

  const switchGitBranch = async (branch: string): Promise<void> => {
    const workspaceRoot = rootRef.current
    if (!workspaceRoot) throw new Error('No active workspace')
    if (tabs.some((tab) => tab.dirty)) {
      throw new Error('Save or close unsaved viewer tabs before switching')
    }
    const state = unwrapOperation(
      await window.hvir.invoke('git:switch-branch', {
        root: workspaceRoot,
        branch,
      }),
    )
    session.acceptProjectState(state)
    session.refreshWorkspaceContent()
  }

  const fetchGit = async (): Promise<void> => {
    const workspaceRoot = rootRef.current
    if (!workspaceRoot) throw new Error('No active workspace')
    session.acceptProjectState(
      unwrapOperation(
        await window.hvir.invoke('git:fetch', {
          root: workspaceRoot,
        }),
      ),
    )
    session.refreshGit()
  }

  const pullGit = async (): Promise<void> => {
    const workspaceRoot = rootRef.current
    if (!workspaceRoot) throw new Error('No active workspace')
    if (tabs.some((tab) => tab.dirty)) {
      throw new Error('Save or close unsaved viewer tabs before pulling')
    }
    session.acceptProjectState(
      unwrapOperation(
        await window.hvir.invoke('git:pull', {
          root: workspaceRoot,
        }),
      ),
    )
    session.refreshWorkspaceContent()
  }

  const revealSourceTerminal = async (view: WebViewState): Promise<void> => {
    const target = projectState?.projects
      .flatMap((project) =>
        project.workspaces.map((workspace) => ({ project, workspace })),
      )
      .find(({ workspace }) => hostPathEquals(workspace.root, view.workspaceRoot))
    if (!target) {
      session.reportError('The source workspace is no longer registered')
      return
    }
    if (!rootRef.current || !hostPathEquals(rootRef.current, view.workspaceRoot)) {
      await session.switchWorkspace(target.project.id, target.workspace.id)
    }
    window.requestAnimationFrame(() => {
      const source = [
        ...document.querySelectorAll<HTMLElement>('[data-terminal-session]'),
      ].find((element) => element.dataset['terminalSession'] === view.sourceTerminalId)
      source?.click()
      source?.focus()
      if (!source) session.reportError('The source terminal has closed')
    })
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
    if (rootRef.current) persistWorkspaceLayout(rootRef.current, { treeWidth: next })
  }

  const setTerminalHeight = (height: number): void => {
    const workbench = workbenchRef.current
    if (!workbench) return
    const next = fitTerminalHeight(height, workbench.clientHeight)
    workbench.style.setProperty('--terminal-track', `${next}px`)
    if (rootRef.current) {
      persistWorkspaceLayout(rootRef.current, { terminalHeight: next })
    }
  }

  const setViewerPrimaryWidth = (width: number): void => {
    const groups = viewerGroupsRef.current
    if (!groups) return
    const next = clamp(width, 240, Math.max(240, groups.clientWidth - 245))
    groups.style.setProperty('--viewer-primary-track', `${next}px`)
    if (rootRef.current) {
      persistWorkspaceLayout(rootRef.current, { viewerPrimaryWidth: next })
    }
  }

  if (rootError) return <div className="startup-error">{rootError}</div>
  if (!root) return <div className="startup-loading">Starting hvir…</div>

  const workspaceWebViews = webViews.filter((view) =>
    hostPathEquals(view.workspaceRoot, root),
  )

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
        if (
          paneTab &&
          !(graphPane && gitGraphActive) &&
          !(pane === 'primary' && webViewActive)
        ) {
          focusViewerPane(pane, paneTab.id)
        } else {
          focusViewerPane(pane)
        }
      }}
    >
      <TabStrip
        tabs={paneTabs}
        pane={pane}
        activeId={
          (graphPane && gitGraphActive) || (pane === 'primary' && webViewActive)
            ? undefined
            : paneTab?.id
        }
        onActivate={(id) => activateTab(id, pane)}
        onClose={closeTab}
        onPin={pinTab}
        onReorder={reorderViewerTabs}
        onMoveToPane={moveTabToPane}
        split={viewerSplit}
        onSplit={openViewerSplit}
        onClosePane={pane === 'secondary' ? closeViewerSplit : undefined}
        graphOpen={graphPane && gitGraphOpen}
        graphActive={graphPane && gitGraphActive}
        onActivateGraph={() => {
          focusViewerPane('primary')
          setTerminalFocused(false)
          setGitGraphActive(true)
          setWebViewActive(false)
        }}
        onCloseGraph={() => {
          setGitGraphOpen(false)
          setGitGraphActive(false)
        }}
        webTabs={
          pane === 'primary'
            ? workspaceWebViews.map((view) => ({ id: view.id, title: view.title }))
            : undefined
        }
        activeWebId={pane === 'primary' && webViewActive ? activeWebViewId : undefined}
        onActivateWeb={activateWebView}
        onCloseWeb={closeWebView}
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
      {pane === 'primary'
        ? webViews.map((view) => (
            // Visibility-based hiding: display:none breaks <webview> guests,
            // so inactive panes collapse to zero height instead.
            <div
              className={`workspace-view${
                hostPathEquals(view.workspaceRoot, root) &&
                webViewActive &&
                activeWebViewId === view.id
                  ? ''
                  : ' web-view-hidden'
              }`}
              key={view.id}
            >
              <WebPane
                view={view}
                focused={hostPathEquals(view.workspaceRoot, root) && webViewFocused}
                onToggleFocus={() => setWebViewFocused((focused) => !focused)}
                onTitle={(title) => {
                  const sanitized = sanitizedWebPaneTitle(title)
                  setWebViews((current) =>
                    current.map((candidate) =>
                      candidate.id === view.id && candidate.title !== sanitized
                        ? { ...candidate, title: sanitized }
                        : candidate,
                    ),
                  )
                }}
                onBlockedNavigation={() => followBlockedNavigation(view.id)}
                onOpenBrowser={(url) => {
                  void window.hvir
                    .invoke('web-pane:open-browser', { paneId: view.id, url })
                    .catch((reason) =>
                      session.reportError(
                        reason instanceof Error ? reason.message : String(reason),
                      ),
                    )
                }}
                onRevealTerminal={() => void revealSourceTerminal(view)}
              />
            </div>
          ))
        : null}
      <div
        className="workspace-view"
        hidden={(graphPane && gitGraphActive) || (pane === 'primary' && webViewActive)}
      >
        {activeWorkspace?.missing ? (
          <MissingWorkspaceNotice root={root} />
        ) : (
          <FileViewer
            key={`${pane}:${paneTab?.id ?? 'empty'}`}
            tab={paneTab}
            onMode={(mode) => paneTab && setViewerMode(paneTab.id, mode)}
            onDiffBase={(diffBase) => paneTab && setViewerDiffBase(paneTab.id, diffBase)}
            onContent={(content) => paneTab && setViewerContent(paneTab.id, content)}
            onSave={() => paneTab && saveTab(paneTab.id)}
            onReload={() => paneTab && reloadTab(paneTab.id)}
            onScroll={(scrollTop) => paneTab && scheduleScroll(paneTab.id, scrollTop)}
            onNavigationHandled={(serial) =>
              paneTab && navigationHandled(paneTab.id, serial)
            }
            onOpenPath={(path) => {
              focusViewerPane(pane)
              if (paneTab) pinTab(paneTab.id)
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
          busy={session.busy}
          onAdd={changeSession}
          onSwitch={(projectId, workspaceId) =>
            void session.switchWorkspace(projectId, workspaceId)
          }
          onRefresh={(projectId) => void session.refreshProject(projectId)}
          onCloseProject={(projectId) => void session.closeProject(projectId)}
          onPrune={(projectId) => void session.pruneWorktrees(projectId)}
          onDismiss={(projectId, workspaceId) =>
            void session.dismissWorkspace(projectId, workspaceId)
          }
          watchTier={watchTier}
          statusError={session.error}
          onChangeConnection={changeSession}
          onDisconnect={() => void session.disconnect()}
          onReconnect={() => void session.reconnect()}
          theme={theme}
          onTheme={(nextTheme) => setAppTheme(nextTheme)}
          onSettings={() => {
            setSettingsInitialSection('general')
            setShowSettings(true)
          }}
        />
      ) : null}
      <main
        className={`workbench${connectionState === 'connected' ? '' : ' project-stale'}${terminalFocused ? ' terminal-focused' : ''}${treeCollapsed ? ' tree-collapsed' : ''}${webViewFocused && webViewActive ? ' web-focused' : ''}`}
        ref={workbenchRef}
      >
        <aside className="tree-panel" aria-label="Project rail" tabIndex={-1}>
          <nav className="rail-nav" aria-label="Project views">
            <button
              type="button"
              className={railMode === 'files' ? 'active' : ''}
              aria-current={railMode === 'files' ? 'page' : undefined}
              onClick={() => setRailMode('files')}
            >
              Files
            </button>
            {gitEnabled ? (
              <button
                type="button"
                className={railMode === 'git' ? 'active' : ''}
                aria-current={railMode === 'git' ? 'page' : undefined}
                onClick={() => setRailMode('git')}
              >
                Git{changedCount > 0 ? ` ${changedCountLabel}` : ''}
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
              gitChangesLimited={gitChanges?.workingTreeLimited}
              selected={activeTab?.path}
              onOpen={openFile}
              connected={connectionState === 'connected'}
              missing={activeWorkspace?.missing}
              hidden={railMode !== 'files'}
              gitEnabled={gitEnabled}
              watchInterestsLimited={watchInterests.limited}
              onExpandedChange={watchInterests.updateExpandedPath}
            />
            {gitEnabled ? (
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
                onFetch={fetchGit}
                onPull={pullGit}
                autoFetchIntervalMs={settings.gitAutoFetchIntervalMs}
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
            if (rootRef.current) {
              persistWorkspaceLayout(rootRef.current, { treeWidth: 0 })
            }
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
                      persistWorkspaceLayout(rootRef.current, {
                        viewerPrimaryWidth: 0,
                      })
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
            if (rootRef.current) {
              persistWorkspaceLayout(rootRef.current, { terminalHeight: 0 })
            }
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
              onOpenWebLink={openWebLink}
              idleThresholdMs={settings.idleThresholdMs}
              recoveryMode={settings.terminalRecoveryMode}
              terminalTheme={settings.terminalTheme}
              onOpenSettings={() => {
                setSettingsInitialSection('general')
                setShowSettings(true)
              }}
              onOpenHarnessSettings={() => {
                setSettingsInitialSection('harnesses')
                setShowSettings(true)
              }}
              onAddHarness={() => {
                setSettingsInitialSection('harnesses-add')
                setShowSettings(true)
              }}
            />
          )),
        )}
      </main>
      {showAddProject ? (
        <SessionDialog
          hosts={session.hosts}
          currentRoot={root}
          suspended={session.prompts.length > 0}
          onCancel={() => setShowAddProject(false)}
          onConnect={session.connectHost}
          onBrowse={session.browseHost}
          onDisconnect={session.disconnectHost}
          onOpen={session.openHost}
          onOpened={() => setShowAddProject(false)}
        />
      ) : null}
      {showSettings ? (
        <SettingsDialog
          theme={theme}
          settings={settings}
          workspaceRoot={root}
          projectRoot={activeProject?.registeredRoot}
          initialSection={settingsInitialSection}
          onClose={() => setShowSettings(false)}
          onSave={(nextTheme, nextSettings) => {
            setAppTheme(nextTheme)
            setAppSettings(nextSettings)
            setShowSettings(false)
          }}
        />
      ) : null}
      {session.prompts[0] ? (
        <SshPromptDialog
          key={session.prompts[0].id}
          prompt={session.prompts[0]}
          onAnswer={session.answerPrompt}
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function sanitizedWebPaneTitle(title: string): string {
  const normalized = [...title]
    .map((character) => {
      const codepoint = character.codePointAt(0) ?? 0
      return codepoint < 32 || codepoint === 127 ? ' ' : character
    })
    .join('')
    .trim()
  return normalized.slice(0, 120) || 'Web pane'
}

function fitTerminalHeight(height: number, workbenchHeight: number): number {
  const max = Math.max(
    TERMINAL_MIN_HEIGHT,
    workbenchHeight - DIVIDER_SIZE - VIEWER_MIN_HEIGHT,
  )
  return clamp(height, TERMINAL_MIN_HEIGHT, max)
}
