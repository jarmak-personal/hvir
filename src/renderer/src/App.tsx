import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import {
  GIT_CHANGE_DISPLAY_LIMIT,
  hostPathEquals,
  type GitChanges,
  type HostPath,
  type ProjectState,
} from '../../shared'
import { PaneResizer } from './layout/PaneResizer'
import type { WebViewState } from './dashboards/WebPane'
import { WebPaneStack } from './dashboards/WebPaneStack'
import { useWebPaneWorkspace } from './dashboards/use-web-pane-workspace'
import { TerminalWorkspaceCollection } from './terminal/TerminalWorkspaceCollection'
import { useTerminalWorkspaceRuntime } from './terminal/use-terminal-workspace-runtime'
import { useTerminalAttention } from './terminal/use-terminal-attention'
import { ProjectsBar } from './workspaces/ProjectsBar'
import { MissingWorkspaceNotice } from './workspaces/MissingWorkspaceNotice'
import { useProjectSession } from './workspaces/project-session'
import { useProjectWatchInterests } from './workspaces/project-watch-interests'
import { SessionDialog } from './workspaces/SessionDialog'
import { SshPromptDialog } from './workspaces/SshPromptDialog'
import { FileTree } from './tree/FileTree'
import { isGitIgnoreRulePath } from './tree/git-ignore-refresh'
import { GitPanel } from './git/GitPanel'
import { workspaceGitEnabled } from './git/git-capability'
import { GitGraphView } from './git/GitGraphView'
import { useGitWorkspace } from './git/use-git-workspace'
import { FileViewer } from './viewer/FileViewer'
import { TabStrip } from './viewer/TabStrip'
import { useViewerWorkspace } from './viewer/use-viewer-workspace'
import { setAppTheme, useAppTheme } from './theme'
import { SettingsDialog } from './settings/SettingsDialog'
import { setAppSettings, terminalPreferences, useAppSettings } from './settings/settings'
import { useWorkbenchCommands } from './workbench/use-workbench-commands'
import { focusVisibleActiveTerminalAfterLayout } from './workbench/active-terminal-focus'
import { useWorkbenchLayout } from './workbench/use-workbench-layout'
import { useWorkbenchOverlays } from './workbench/use-workbench-overlays'
import { TerminalLayoutControls } from './workbench/TerminalLayoutControls'
import { useRendererReady } from './workbench/use-renderer-ready'
import { useTerminalPathActivation } from './workbench/use-terminal-path-activation'
import * as review from './document-review/use-document-review-workspace'
export function App(): ReactElement {
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
  const viewer = useViewerWorkspace({
    onActivateFile: () => {
      deactivateGitGraphRef.current()
      deactivateWebPaneRef.current()
      restoreViewerRef.current()
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
    viewerCommands,
    setDiffBase: setViewerDiffBase,
    setContent: setViewerContent,
    navigationHandled,
    schedulePosition,
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
  const reviewWatch = review.useWatchFanout(handleWatchEvent)
  const web = useWebPaneWorkspace({
    onActivate: () => {
      focusViewerPane('primary')
      deactivateGitGraphRef.current()
      restoreViewerRef.current()
    },
    onError: (message) => sessionErrorRef.current(message),
  })
  const {
    views: webViews,
    activeId: activeWebViewId,
    active: webViewActive,
    activeRef: webViewActiveRef,
    focused: webViewFocused,
    setFocused: setWebViewFocused,
    setActive: setWebViewActive,
    applyProjectState: applyWebProjectState,
    setWorkspaceRoot: setWebWorkspaceRoot,
    openLink: openWebLink,
    activateView: activateWebView,
    closeView: closeWebView,
    forgetTerminalViews,
    followBlockedNavigation,
    setTitle: setWebViewTitle,
    openBrowser: openWebViewInBrowser,
  } = web
  const changedCount = gitChanges?.workingTree.length ?? 0
  const changedCountLabel = gitChanges?.workingTreeLimited
    ? `${GIT_CHANGE_DISPLAY_LIMIT.toLocaleString()}+`
    : changedCount.toLocaleString()
  const applyProjectViewState = useCallback(
    (state: ProjectState): void => {
      if (!applyWebProjectState(state, rootRef.current)) return
      switchViewerWorkspace(state.root)
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
  const {
    projectState,
    root,
    activeWorkspace,
    connectionState,
    rootError,
    refreshHosts,
  } = session
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
    viewerGroupsRef,
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
    setViewerPrimaryWidth,
    resetViewerPrimaryWidth,
    focusTree,
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
    deactivateWebPane: () => setWebViewActive(false),
  })
  const {
    graphOpen: gitGraphOpen,
    graphActive: gitGraphActive,
    graphActiveRef: gitGraphActiveRef,
    graphRequest: gitGraphRequest,
    openGraph: openGitGraph,
    activateGraph: activateGitGraph,
    closeGraph: closeGitGraph,
    resetGraph: resetGitGraph,
    deactivateGraph: deactivateGitGraph,
    switchBranch: switchGitBranch,
    fetch: fetchGit,
    pull: pullGit,
  } = git
  const terminalPathActivation = useTerminalPathActivation({
    root,
    selectedFile: activeTab?.path,
    openFile: (path, position) =>
      openFile(path, true, 'file-tree', 'head', undefined, position),
    revealDirectory: focusTree,
  })
  rootRef.current = root
  sessionErrorRef.current = session.reportError
  workspaceSwitchRef.current = session.switchRelativeWorkspace
  restoreViewerRef.current = restoreViewer
  resetGitGraphRef.current = resetGitGraph
  deactivateGitGraphRef.current = deactivateGitGraph
  deactivateWebPaneRef.current = () => setWebViewActive(false)
  useEffect(() => {
    if (overlays.projectPickerOpen) void refreshHosts()
  }, [overlays.projectPickerOpen, refreshHosts])
  useEffect(() => {
    if (root) setWebWorkspaceRoot(root)
  }, [root, setWebWorkspaceRoot])
  useEffect(() => {
    if (activeWorkspace?.missing) resetGitGraph()
  }, [activeWorkspace?.missing, resetGitGraph])
  useWorkbenchCommands(settings.keybindings, {
    closeWebPane: closeWebView,
    escapeWebPaneFocus: () => setWebViewFocused(false),
    canUseViewerCommands: () => !gitGraphActiveRef.current && !webViewActiveRef.current,
    cycleViewMode: cycleActiveMode,
    findFile: layout.focusFilenameSearch,
    findInFile: viewerCommands.findInFile,
    findInTerminal: terminalWorkspaces.openTerminalSearch,
    goToLine: viewerCommands.goToLine,
    toggleTerminalFocus,
    focusTerminal: layout.focusTerminal,
    focusViewer: () => layout.focusViewer(getActivePane()),
    focusTree,
    switchWorkspace: (direction) => workspaceSwitchRef.current(direction),
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
  const rootWebViews = webViews.filter((view) => hostPathEquals(view.workspaceRoot, root))
  const renderViewerPane = (
    pane: 'primary' | 'secondary',
    paneTabs: typeof primaryTabs,
    paneTab: typeof primaryActiveTab,
    graphPane: boolean,
  ): ReactElement => (
    <section
      className={`viewer-group viewer-group-${pane}`}
      aria-label={`${pane === 'primary' ? 'Primary' : 'Secondary'} file viewer`}
      data-diagnostic-capture="viewer"
      data-viewer-pane={pane}
      tabIndex={-1}
      onPointerDownCapture={(event) => {
        if (event.button !== 0) return
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
        pathCopyRoot={root}
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
        onActivateGraph={activateGitGraph}
        onCloseGraph={closeGitGraph}
        webTabs={
          pane === 'primary'
            ? rootWebViews.map((view) => ({ id: view.id, title: view.title }))
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
      {pane === 'primary' ? (
        <WebPaneStack
          views={webViews}
          root={root}
          active={webViewActive}
          activeId={activeWebViewId}
          focused={webViewFocused}
          onToggleFocus={() => setWebViewFocused((focused) => !focused)}
          onTitle={setWebViewTitle}
          onBlockedNavigation={followBlockedNavigation}
          onOpenBrowser={openWebViewInBrowser}
          onRevealTerminal={(view) => void revealSourceTerminal(view)}
        />
      ) : null}
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
            gitRefreshVersion={gitVersion}
            onMode={(mode, at) => paneTab && setViewerMode(paneTab.id, mode, at)}
            onDiffBase={(diffBase) => paneTab && setViewerDiffBase(paneTab.id, diffBase)}
            onContent={(content) => paneTab && setViewerContent(paneTab.id, content)}
            onSave={() => paneTab && saveTab(paneTab.id)}
            onReload={() => paneTab && reloadTab(paneTab.id)}
            onPosition={(position) => paneTab && schedulePosition(paneTab.id, position)}
            onNavigationHandled={(serial) =>
              paneTab && navigationHandled(paneTab.id, serial)
            }
            registerCommands={viewerCommands.register}
            onOpenPath={(path) => {
              focusViewerPane(pane)
              if (paneTab) pinTab(paneTab.id)
              openFile(path, true)
            }}
            onRenderedDependencies={viewer.setRenderedDependencies}
            documentReview={documentReview}
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
          rollups={terminalAttention.rollups}
          busy={session.busy}
          onAdd={overlays.openProjectPicker}
          onSwitch={(projectId, workspaceId) =>
            void session.switchWorkspace(projectId, workspaceId)
          }
          onRefresh={(projectId) => void session.refreshProject(projectId)}
          onCloseProject={(projectId) => void session.closeProject(projectId)}
          onPrune={(projectId) => void session.pruneWorktrees(projectId)}
          onDismiss={(projectId, workspaceId) =>
            void session.dismissWorkspace(projectId, workspaceId)
          }
          onPlanCloseWorkspace={session.planWorkspaceClose}
          onCloseWorkspace={(projectId, workspaceId, plan, terminateTerminals) =>
            void session.closeWorkspace(projectId, workspaceId, plan, terminateTerminals)
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
        />
      ) : null}
      <main
        className={`workbench${connectionState === 'connected' ? '' : ' project-stale'}${terminalMode === 'maximized' ? ' terminal-focused' : ''}${terminalMode === 'collapsed' ? ' terminal-collapsed' : ''}${treeCollapsed ? ' tree-collapsed' : ''}${layout.terminalRailCompact ? ' terminal-rail-compact' : ''}${webViewFocused && webViewActive ? ' web-focused' : ''}`}
        ref={workbenchRef}
      >
        <aside
          className="tree-panel"
          aria-label="Project rail"
          data-diagnostic-capture="project-navigation"
          tabIndex={-1}
        >
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
              searchRefreshVersion={contentVersion}
              ignoredRefreshVersion={ignoredRefreshVersion}
              changedFiles={gitChanges?.workingTree}
              gitChangesLimited={gitChanges?.workingTreeLimited}
              selected={terminalPathActivation.revealRequest?.path ?? activeTab?.path}
              revealRequest={terminalPathActivation.revealRequest}
              onOpen={openFile}
              onPointerActivate={focusVisibleActiveTerminalAfterLayout}
              viewerPathRebind={viewer}
              onWorkspaceContentChanged={session.refreshWorkspaceContent}
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
                  onReset={resetViewerPrimaryWidth}
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
            if (current) setTerminalHeight(current.getBoundingClientRect().height + delta)
          }}
          onReset={layout.resetTerminalHeight}
          action={<TerminalLayoutControls mode={terminalMode} onMode={setTerminalMode} />}
        />
        <TerminalWorkspaceCollection
          state={projectState}
          runtime={terminalWorkspaces}
          terminalPresented={
            terminalMode !== 'collapsed' && !(webViewFocused && webViewActive)
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
      {overlays.projectPickerOpen ? (
        <SessionDialog
          hosts={session.hosts}
          currentRoot={root}
          suspended={session.prompts.length > 0}
          onCancel={overlays.closeProjectPicker}
          onConnect={session.connectHost}
          onBrowse={session.browseHost}
          onDisconnect={session.disconnectHost}
          onOpen={session.openHost}
          onOpened={overlays.closeProjectPicker}
        />
      ) : null}
      {overlays.settingsOpen ? (
        <SettingsDialog
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
