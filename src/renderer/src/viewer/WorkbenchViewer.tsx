import type { ReactElement } from 'react'
import { hostPathEquals, type HostPath } from '../../../shared'
import { PaneResizer } from '../layout/PaneResizer'
import { GitGraphView } from '../git/GitGraphView'
import { MissingWorkspaceNotice } from '../workspaces/MissingWorkspaceNotice'
import { WebPaneStack } from '../dashboards/WebPaneStack'
import { ExtensionViewStack } from '../extensions/ExtensionViewStack'
import { FileViewer } from './FileViewer'
import { TabStrip } from './TabStrip'
import type { useViewerWorkspace } from './use-viewer-workspace'
import type { useWebPaneWorkspace } from '../dashboards/use-web-pane-workspace'
import type { useGitWorkspace } from '../git/use-git-workspace'
import type { useWorkbenchLayout } from '../workbench/use-workbench-layout'
import type { useReviewWorkspace } from '../document-review/use-document-review-workspace'
import type { useExtensionViews } from '../extensions/use-extension-views'
import type { WebViewState } from '../dashboards/WebPane'

/** Viewer-owned composition of document, graph, loopback and application contribution surfaces. */
export function WorkbenchViewer({
  root,
  missing,
  viewer,
  web,
  git,
  layout,
  gitVersion,
  connectionState,
  documentReview,
  revealSourceTerminal,
  extensions,
  visible,
}: {
  readonly root: HostPath
  readonly missing: boolean
  readonly viewer: ReturnType<typeof useViewerWorkspace>
  readonly web: ReturnType<typeof useWebPaneWorkspace>
  readonly git: ReturnType<typeof useGitWorkspace>
  readonly layout: ReturnType<typeof useWorkbenchLayout>
  readonly gitVersion: number
  readonly connectionState:
    'connected' | 'disconnected' | 'connecting' | 'reconnecting' | 'failed'
  readonly documentReview: ReturnType<typeof useReviewWorkspace>
  readonly revealSourceTerminal: (view: WebViewState) => Promise<void>
  readonly extensions: ReturnType<typeof useExtensionViews>
  readonly visible: boolean
}): ReactElement {
  const {
    primaryTabs,
    secondaryTabs,
    primaryActiveTab,
    secondaryActiveTab,
    split: viewerSplit,
    activateTab,
    closeTab,
    pinTab,
    reorderTabs: reorderViewerTabs,
    moveTab: moveTabToPane,
    openSplit: openViewerSplit,
    closeSplit: closeViewerSplit,
    focusPane: focusViewerPane,
    openFile,
    setMode: setViewerMode,
    setDiffBase: setViewerDiffBase,
    setContent: setViewerContent,
    saveTab,
    reloadTab,
    schedulePosition,
    navigationHandled,
    viewerCommands,
  } = viewer
  const {
    views: webViews,
    active: webViewActive,
    activeId: activeWebViewId,
    focused: webViewFocused,
    setFocused: setWebViewFocused,
    activateView: activateWebView,
    closeView: closeWebView,
    setTitle: setWebViewTitle,
    followBlockedNavigation,
    openBrowser: openWebViewInBrowser,
  } = web
  const {
    graphOpen: gitGraphOpen,
    graphActive: gitGraphActive,
    graphRequest: gitGraphRequest,
    activateGraph: activateGitGraph,
    closeGraph: closeGitGraph,
  } = git
  const { viewerGroupsRef, setViewerPrimaryWidth, resetViewerPrimaryWidth } = layout
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
          !(pane === 'primary' && (webViewActive || extensions.active))
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
          (graphPane && gitGraphActive) ||
          (pane === 'primary' && (webViewActive || extensions.active))
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
        contributedTabs={pane === 'primary' ? extensions.views : undefined}
        activeContributionId={
          pane === 'primary' && extensions.active ? extensions.activeId : undefined
        }
        onActivateContribution={extensions.activate}
        onCloseContribution={extensions.close}
      />
      {graphPane && gitGraphOpen ? (
        <div className="workspace-view hvir-panel" hidden={!gitGraphActive}>
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
      {pane === 'primary' ? (
        <ExtensionViewStack
          views={extensions.views}
          activeId={extensions.activeId}
          active={extensions.active && visible}
          onClose={extensions.close}
        />
      ) : null}
      <div
        className="workspace-view hvir-panel"
        hidden={
          (graphPane && gitGraphActive) ||
          (pane === 'primary' && (webViewActive || extensions.active))
        }
      >
        {missing ? (
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
    <section className="viewer-panel hvir-panel" aria-label="File viewer">
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
                const left = viewerGroupsRef.current?.getBoundingClientRect().left ?? 0
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
  )
}
