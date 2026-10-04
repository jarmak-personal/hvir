import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { hostPathEquals } from '../../shared'
import type { GitChanges, HostPath, ProjectState } from '../../shared'
import { PaneResizer } from './layout/PaneResizer'
import type { WebViewState } from './dashboards/WebPane'
import { useWebPaneWorkspace } from './dashboards/use-web-pane-workspace'
import { TerminalWorkspaceCollection } from './terminal/TerminalWorkspaceCollection'
import { useTerminalWorkspaceRuntime } from './terminal/use-terminal-workspace-runtime'
import { useTerminalAttention } from './terminal/use-terminal-attention'
import { ProjectsBar } from './workspaces/ProjectsBar'
import { useProjectSession } from './workspaces/project-session'
import { useProjectWatchInterests } from './workspaces/project-watch-interests'
import { SessionDialog } from './workspaces/SessionDialog'
import { SshPromptDialog } from './workspaces/SshPromptDialog'
import { WorkbenchProjectRail } from './workbench/WorkbenchProjectRail'
import {
  ExtensionContributionsProvider,
  ExtensionTopDestination,
} from './extensions/ExtensionContributions'
import { isGitIgnoreRulePath } from './tree/git-ignore-refresh'
import { workspaceGitEnabled } from './git/git-capability'
import { useGitWorkspace } from './git/use-git-workspace'
import { WorkbenchViewer } from './viewer/WorkbenchViewer'
import { useExtensionViews } from './extensions/use-extension-views'
import { useViewerWorkspace } from './viewer/use-viewer-workspace'
import { setAppTheme, useAppTheme } from './theme'
import { WorkbenchAccessDialogs } from './workbench/WorkbenchAccessDialogs'
import { setAppSettings, terminalPreferences, useAppSettings } from './settings/settings'
import { useWorkbenchCommands } from './workbench/use-workbench-commands'
import { focusVisibleActiveTerminalAfterLayout } from './workbench/active-terminal-focus'
import { useWorkbenchLayout } from './workbench/use-workbench-layout'
import { useWorkbenchOverlays } from './workbench/use-workbench-overlays'
import { TerminalLayoutControls } from './workbench/TerminalLayoutControls'
import { useRendererReady } from './workbench/use-renderer-ready'
import { useTerminalPathActivation } from './workbench/use-terminal-path-activation'
import * as review from './document-review/use-document-review-workspace'
import { SessionsApplicationDestination } from './sessions/SessionsApplicationDestination'
export function App(): ReactElement {
  const [destination, setDestination] = useState<'workspace' | 'sessions' | 'extension'>(
    'workspace',
  )
  const theme = useAppTheme()
  const settings = useAppSettings()
  const rootRef = useRef<HostPath | undefined>(undefined)
  const workspaceSwitchRef = useRef<(direction: -1 | 1) => void>(() => undefined)
  const sessionErrorRef = useRef<(message: string) => void>(() => undefined)
  const restoreViewerRef = useRef<() => void>(() => undefined)
  const resetGitGraphRef = useRef<() => void>(() => undefined)
  const deactivateGitGraphRef = useRef<() => void>(() => undefined)
  const deactivateWebPaneRef = useRef<() => void>(() => undefined)
  const [gitChanges, setGitChanges] = useState<GitChanges>()
  const overlays = useWorkbenchOverlays()
  const terminalAttention = useTerminalAttention()
  const extensions = useExtensionViews({
    onActivate: (focus = true) => {
      deactivateGitGraphRef.current()
      deactivateWebPaneRef.current()
      restoreViewerRef.current()
      setDestination('workspace')
      if (focus) overlays.closeSettings()
    },
    onError: (message) => sessionErrorRef.current(message),
  })
  const viewer = useViewerWorkspace({
    onActivateFile: () => {
      extensions.deactivate()
      deactivateGitGraphRef.current()
      deactivateWebPaneRef.current()
      restoreViewerRef.current()
    },
  })
  const {
    tabs,
    activeTab,
    switchWorkspace: switchViewerWorkspace,
    openFile,
    cycleActiveMode,
    viewerCommands,
    handleWatchEvent,
    reloadCleanFiles,
    focusPane: focusViewerPane,
    getActivePane,
  } = viewer
  const reviewWatch = review.useWatchFanout(handleWatchEvent)
  const web = useWebPaneWorkspace({
    onActivate: () => {
      extensions.deactivate()
      focusViewerPane('primary')
      deactivateGitGraphRef.current()
      restoreViewerRef.current()
    },
    onError: (message) => sessionErrorRef.current(message),
  })
  const {
    active: webViewActive,
    activeRef: webViewActiveRef,
    focused: webViewFocused,
    setFocused: setWebViewFocused,
    setActive: setWebViewActive,
    applyProjectState: applyWebProjectState,
    setWorkspaceRoot: setWebWorkspaceRoot,
    openLink: openWebLink,
    closeView: closeWebView,
    forgetTerminalViews,
  } = web
  const applyProjectViewState = useCallback(
    (state: ProjectState): void => {
      switchViewerWorkspace(state.root, state.connectionState === 'connected')
      if (!applyWebProjectState(state, rootRef.current)) return
      resetGitGraphRef.current()
      setGitChanges(undefined)
    },
    [applyWebProjectState, switchViewerWorkspace],
  )
  const session = useProjectSession({
    composerSubmitMode: settings.composerSubmitMode,
    onProjectState: applyProjectViewState,
    onReloadFiles: reloadCleanFiles,
    onWatchEvent: reviewWatch.handle,
    isIgnoreRulePath: isGitIgnoreRulePath,
  })
  const accept = session.acceptProjectState
  const { projectState, root, activeWorkspace, connectionState, rootError } = session
  const documentReview = review.useReviewWorkspace(activeWorkspace, reviewWatch)
  const { watch: watchVersion, ignored: ignoredRefreshVersion } = session.versions
  const { content: contentVersion, git: gitVersion } = session.versions
  useRendererReady(Boolean(root))
  const watchInterests = useProjectWatchInterests({
    root,
    connected: connectionState === 'connected',
    missing: activeWorkspace?.missing,
    openPaths: viewer.openWatchPaths,
    reviewPaths: documentReview.watchPaths,
    dependencyPaths: viewer.renderedWatchPaths,
  })
  const gitEnabled = workspaceGitEnabled(activeWorkspace)
  const terminalWorkspaces = useTerminalWorkspaceRuntime({
    projectState,
    acceptProjectState: session.acceptProjectState,
    forgetWebViews: forgetTerminalViews,
    acknowledgeWorkspaces: session.acknowledgeWorkspaces,
    onError: session.reportError,
  })
  const layout = useWorkbenchLayout({
    root,
    gitAvailable: gitEnabled,
    workspaceMissing: Boolean(activeWorkspace?.missing),
  })
  const {
    workbenchRef,
    railMode,
    setRailMode,
    terminalMode,
    setTerminalMode,
    toggleTerminalFocus,
    restoreViewer,
    treeCollapsed,
    setTreeCollapsed,
    setTreeWidth,
    setTerminalHeight,
    focusTerminal: showTerminal,
  } = layout
  const git = useGitWorkspace({
    root,
    hasDirtyViewerTabs: () => tabs.some((tab) => tab.dirty),
    acceptProjectState: session.acceptProjectState,
    refreshContent: session.refreshWorkspaceContent,
    refreshGit: session.refreshGit,
    activateViewer: () => {
      focusViewerPane('primary')
      restoreViewer()
    },
    deactivateWebPane: () => {
      setWebViewActive(false)
      extensions.deactivate()
    },
  })
  const {
    graphActive: gitGraphActive,
    graphActiveRef: gitGraphActiveRef,
    openGraph: openGitGraph,
    resetGraph: resetGitGraph,
    deactivateGraph: deactivateGitGraph,
    switchBranch: switchGitBranch,
    fetch: fetchGit,
    pull: pullGit,
  } = git
  const terminalPathActivation = useTerminalPathActivation({
    root,
    workspaceId: activeWorkspace?.id,
    selectedFile: activeTab?.path,
    openFile: (path, position) =>
      openFile(path, true, 'file-tree', 'head', undefined, position),
    revealDirectory: layout.focusTree,
  })
  rootRef.current = root
  sessionErrorRef.current = session.reportError
  workspaceSwitchRef.current = session.switchRelativeWorkspace
  restoreViewerRef.current = restoreViewer
  resetGitGraphRef.current = resetGitGraph
  deactivateGitGraphRef.current = deactivateGitGraph
  deactivateWebPaneRef.current = () => setWebViewActive(false)
  useEffect(() => {
    if (root) setWebWorkspaceRoot(root)
  }, [root, setWebWorkspaceRoot])
  useEffect(() => {
    if (activeWorkspace?.missing) resetGitGraph()
  }, [activeWorkspace?.missing, resetGitGraph])
  useWorkbenchCommands(settings.keybindings, {
    enabled: destination === 'workspace',
    closeWebPane: closeWebView,
    escapeWebPaneFocus: () => setWebViewFocused(false),
    canUseViewerCommands: () =>
      !gitGraphActiveRef.current &&
      !webViewActiveRef.current &&
      !extensions.activeRef.current,
    cycleViewMode: cycleActiveMode,
    findFile: layout.focusFilenameSearch,
    findInFile: viewerCommands.findInFile,
    findInTerminal: terminalWorkspaces.openTerminalSearch,
    goToLine: viewerCommands.goToLine,
    toggleTerminalFocus,
    focusTerminal: layout.focusTerminal,
    focusViewer: () => layout.focusViewer(getActivePane()),
    focusTree: layout.focusTree,
    switchWorkspace: (direction) => {
      setDestination('workspace')
      workspaceSwitchRef.current(direction)
    },
  })
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
  if (rootError) return <div className="startup-error">{rootError}</div>
  if (!root) return <div className="startup-loading">Starting hvir…</div>
  return (
    <ExtensionContributionsProvider
      topActive={destination === 'extension'}
      obscured={overlays.settingsOpen}
      onTop={() => setDestination('extension')}
      onWorkspace={() => setDestination('workspace')}
      workspaceId={activeWorkspace?.id}
      views={extensions.guests}
      onError={session.reportError}
    >
      <div className="app-shell">
        {projectState ? (
          <ProjectsBar
            state={projectState}
            rollups={terminalAttention.rollups}
            busy={session.busy}
            onAdd={overlays.openProjectPicker}
            onSwitch={(projectId, workspaceId) => {
              setDestination('workspace')
              void session.switchWorkspace(projectId, workspaceId)
            }}
            onRefresh={(projectId) => void session.refreshProject(projectId)}
            onCloseProject={(projectId) => void session.closeProject(projectId)}
            onPrune={(projectId) => void session.pruneWorktrees(projectId)}
            onDismiss={(projectId, workspaceId) =>
              void session.dismissWorkspace(projectId, workspaceId)
            }
            onPlanCloseWorkspace={session.planWorkspaceClose}
            onCloseWorkspace={(projectId, workspaceId, plan, terminateTerminals) =>
              void session.closeWorkspace(
                projectId,
                workspaceId,
                plan,
                terminateTerminals,
              )
            }
            onReopenWorkspace={(projectId, workspaceId) =>
              void session.reopenWorkspace(projectId, workspaceId)
            }
            watchTier={session.watchTier}
            statusError={session.error}
            onChangeConnection={overlays.openProjectPicker}
            onDisconnect={() => void session.disconnect()}
            onReconnect={() => void session.reconnect()}
            theme={theme}
            onTheme={(nextTheme) => setAppTheme(nextTheme)}
            onSettings={() => overlays.openSettings()}
            sessionsActive={destination === 'sessions'}
            onSessions={() => setDestination('sessions')}
          />
        ) : null}
        <main
          className={`workbench hvir-panel${connectionState === 'connected' ? '' : ' project-stale'}${terminalMode === 'maximized' ? ' terminal-focused' : ''}${terminalMode === 'collapsed' ? ' terminal-collapsed' : ''}${treeCollapsed ? ' tree-collapsed' : ''}${layout.terminalRailCompact ? ' terminal-rail-compact' : ''}${webViewFocused && webViewActive ? ' web-focused' : ''}`}
          ref={workbenchRef}
          hidden={destination !== 'workspace'}
        >
          <WorkbenchProjectRail
            mode={railMode}
            onMode={setRailMode}
            gitEnabled={gitEnabled}
            changedCount={gitChanges?.workingTree.length ?? 0}
            changesLimited={gitChanges?.workingTreeLimited}
            visible={destination === 'workspace' && !treeCollapsed}
            files={{
              root,
              refreshVersion: watchVersion,
              searchRefreshVersion: contentVersion,
              ignoredRefreshVersion,
              changedFiles: gitChanges?.workingTree,
              gitChangesLimited: gitChanges?.workingTreeLimited,
              selected: terminalPathActivation.revealRequest?.path ?? activeTab?.path,
              revealRequest: terminalPathActivation.revealRequest,
              onOpen: openFile,
              onPointerActivate: focusVisibleActiveTerminalAfterLayout,
              viewerPathRebind: viewer,
              onWorkspaceContentChanged: session.refreshWorkspaceContent,
              connected: connectionState === 'connected',
              missing: activeWorkspace?.missing,
              hidden: railMode !== 'files',
              gitEnabled,
              watchInterestsLimited: watchInterests.limited,
              onExpandedChange: watchInterests.updateExpandedPath,
            }}
            git={
              gitEnabled
                ? {
                    root,
                    refreshVersion: contentVersion,
                    historyRefreshVersion: gitVersion,
                    onChanges: setGitChanges,
                    onOpenChange: (path, base, untracked) =>
                      openFile(path, true, untracked ? 'git-untracked' : 'git', base),
                    onOpenHistory: (path, revision) =>
                      openFile(path, true, 'git', 'head', revision),
                    onOpenGraph: openGitGraph,
                    connectionState,
                    hidden: railMode !== 'git',
                    historyPaused: gitGraphActive,
                    hasDirtyViewerTabs: tabs.some((tab) => tab.dirty),
                    onSwitchBranch: switchGitBranch,
                    onFetch: fetchGit,
                    onPull: pullGit,
                    autoFetchIntervalMs: settings.gitAutoFetchIntervalMs,
                  }
                : undefined
            }
          />
          <PaneResizer
            orientation="vertical"
            className="tree-resizer"
            label="Resize file tree"
            onDragStart={() => {
              if (treeCollapsed) setTreeCollapsed(false)
            }}
            onDrag={(clientX) => {
              const left = workbenchRef.current?.getBoundingClientRect().left ?? 0
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
            onReset={layout.resetTreeWidth}
            action={
              <button
                type="button"
                className="tree-collapse-toggle hvir-button"
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
          <WorkbenchViewer
            root={root}
            missing={Boolean(activeWorkspace?.missing)}
            viewer={viewer}
            web={web}
            git={git}
            layout={layout}
            gitVersion={gitVersion}
            connectionState={connectionState}
            documentReview={documentReview}
            revealSourceTerminal={revealSourceTerminal}
            extensions={extensions}
            visible={destination === 'workspace' && terminalMode !== 'maximized'}
          />
          <PaneResizer
            orientation="horizontal"
            className="terminal-resizer"
            label="Resize terminal"
            onDragStart={() => {
              if (terminalMode !== 'restored') setTerminalMode('restored')
            }}
            onDrag={(clientY) => {
              const bottom = workbenchRef.current?.getBoundingClientRect().bottom ?? 0
              setTerminalHeight(bottom - clientY)
            }}
            onNudge={(delta) => {
              if (terminalMode !== 'restored') {
                if (
                  (terminalMode === 'maximized' && delta < 0) ||
                  (terminalMode === 'collapsed' && delta > 0)
                ) {
                  setTerminalMode('restored')
                }
                return
              }
              const current =
                workbenchRef.current?.querySelector<HTMLElement>('.terminal-panel')
              if (current)
                setTerminalHeight(current.getBoundingClientRect().height + delta)
            }}
            onReset={layout.resetTerminalHeight}
            action={
              <TerminalLayoutControls mode={terminalMode} onMode={setTerminalMode} />
            }
          />
          <TerminalWorkspaceCollection
            state={projectState}
            runtime={terminalWorkspaces}
            terminalPresented={
              destination === 'workspace' &&
              terminalMode !== 'collapsed' &&
              !(webViewFocused && webViewActive)
            }
            railCompact={layout.terminalRailCompact}
            onRailCompact={layout.setTerminalRailCompact}
            onRollup={terminalAttention.updateRollup}
            onOpenPath={terminalPathActivation.activate}
            onOpenWebLink={openWebLink}
            preferences={terminalPreferences(settings)}
            onOpenSettings={() => overlays.openSettings()}
            onOpenTerminalSettings={() => overlays.openSettings('terminal')}
            onOpenHarnessSettings={() => overlays.openSettings('harnesses')}
            onAddHarness={overlays.openAddHarnessSettings}
          />
        </main>
        <ExtensionTopDestination />
        <SessionsApplicationDestination
          active={destination === 'sessions'}
          runtime={terminalWorkspaces}
          onOpened={(state) => (
            showTerminal(),
            accept(state),
            setDestination('workspace')
          )}
          onError={session.reportError}
        />
        {overlays.projectPickerOpen ? (
          <SessionDialog
            currentRoot={root}
            suspended={session.prompts.length > 0}
            onCancel={overlays.closeProjectPicker}
            onConnect={session.connectHost}
            onBrowse={session.browseHost}
            folderPicker={session.folderPicker}
            onDisconnect={session.disconnectHost}
            onOpen={session.openHost}
            onOpened={() => (setDestination('workspace'), overlays.closeProjectPicker())}
          />
        ) : null}
        <WorkbenchAccessDialogs
          open={overlays.settingsOpen}
          theme={theme}
          settings={settings}
          workspaceRoot={root}
          projectRoot={session.activeProject?.registeredRoot}
          initialDestination={overlays.settingsDestination}
          onClose={overlays.closeSettings}
          onSave={(nextTheme, nextSettings) => {
            setAppTheme(nextTheme)
            setAppSettings(nextSettings)
            overlays.closeSettings()
          }}
        />
        {session.prompts[0] ? (
          <SshPromptDialog
            key={session.prompts[0].id}
            prompt={session.prompts[0]}
            onAnswer={session.answerPrompt}
          />
        ) : null}
      </div>
    </ExtensionContributionsProvider>
  )
}
