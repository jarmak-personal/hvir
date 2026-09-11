import type { ReactElement } from 'react'
import { hostPathEquals, type HostPath, type HostConnectionState } from '../../../shared'
import type { WebViewState } from '../dashboards/WebPane'
import { WebPaneStack } from '../dashboards/WebPaneStack'
import type { useWebPaneWorkspace } from '../dashboards/use-web-pane-workspace'
import { GitGraphView } from '../git/GitGraphView'
import type { useGitWorkspace } from '../git/use-git-workspace'
import { FileViewer } from '../viewer/FileViewer'
import { TabStrip } from '../viewer/TabStrip'
import type { useViewerWorkspace } from '../viewer/use-viewer-workspace'
import { MissingWorkspaceNotice } from '../workspaces/MissingWorkspaceNotice'
import type { useReviewWorkspace } from '../document-review/use-document-review-workspace'
import type { SkillagerController } from '../skillager/use-skillager-workspace'
import { SkillagerDetails } from '../skillager/SkillagerDetails'
import { SkillagerTabs } from '../skillager/SkillagerTabs'

interface Props {
  readonly pane: 'primary' | 'secondary'
  readonly root: HostPath
  readonly viewer: ReturnType<typeof useViewerWorkspace>
  readonly git: ReturnType<typeof useGitWorkspace>
  readonly web: ReturnType<typeof useWebPaneWorkspace>
  readonly documentReview: ReturnType<typeof useReviewWorkspace>
  readonly skillager: SkillagerController
  readonly workspaceMissing: boolean
  readonly connectionState: HostConnectionState
  readonly gitVersion: number
  readonly revealSourceTerminal: (view: WebViewState) => Promise<void>
}

/** Existing viewer surface composition, including feature-owned auxiliary tabs. */
export function WorkbenchViewerPane({
  pane,
  root,
  viewer,
  git,
  web,
  documentReview,
  skillager,
  workspaceMissing,
  connectionState,
  gitVersion,
  revealSourceTerminal,
}: Props): ReactElement {
  const graphPane = pane === 'primary'
  const skillsActive = graphPane && Boolean(skillager.activeId)
  const paneTabs = graphPane ? viewer.primaryTabs : viewer.secondaryTabs
  const paneTab = graphPane ? viewer.primaryActiveTab : viewer.secondaryActiveTab
  const {
    focusPane: focusViewerPane,
    activateTab,
    closeTab,
    pinTab,
    reorderTabs: reorderViewerTabs,
    moveTab: moveTabToPane,
    split: viewerSplit,
    openSplit: openViewerSplit,
    closeSplit: closeViewerSplit,
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
    graphActive: gitGraphActive,
    graphOpen: gitGraphOpen,
    graphRequest: gitGraphRequest,
    activateGraph: activateGitGraph,
    closeGraph: closeGitGraph,
  } = git
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
  const rootWebViews = webViews.filter((view) => hostPathEquals(view.workspaceRoot, root))
  return (
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
          !(graphPane && (gitGraphActive || skillager.activeId)) &&
          !(pane === 'primary' && webViewActive)
        ) {
          focusViewerPane(pane, paneTab.id)
        } else {
          focusViewerPane(pane)
        }
      }}
    >
      <TabStrip
        additionalTabs={graphPane ? <SkillagerTabs controller={skillager} /> : undefined}
        hasAdditionalTabs={graphPane && skillager.tabs.length > 0}
        tabs={paneTabs}
        pathCopyRoot={root}
        pane={pane}
        activeId={
          (graphPane && (gitGraphActive || skillager.activeId)) ||
          (pane === 'primary' && webViewActive)
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
        graphActive={graphPane && gitGraphActive && !skillsActive}
        onActivateGraph={activateGitGraph}
        onCloseGraph={closeGitGraph}
        webTabs={
          pane === 'primary'
            ? rootWebViews.map((view) => ({ id: view.id, title: view.title }))
            : undefined
        }
        activeWebId={
          pane === 'primary' && webViewActive && !skillsActive
            ? activeWebViewId
            : undefined
        }
        onActivateWeb={activateWebView}
        onCloseWeb={closeWebView}
      />
      {graphPane && skillager.active ? (
        <div className="workspace-view">
          <SkillagerDetails
            metadata={skillager.active.metadata}
            tab={skillager.active}
            reviews={skillager.reviews}
            exposures={skillager.exposures}
          />
        </div>
      ) : null}
      {graphPane && gitGraphOpen ? (
        <div className="workspace-view" hidden={!gitGraphActive || skillsActive}>
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
          active={webViewActive && !skillsActive}
          activeId={activeWebViewId}
          focused={webViewFocused && !skillsActive}
          onToggleFocus={() => setWebViewFocused((focused) => !focused)}
          onTitle={setWebViewTitle}
          onBlockedNavigation={followBlockedNavigation}
          onOpenBrowser={openWebViewInBrowser}
          onRevealTerminal={(view) => void revealSourceTerminal(view)}
        />
      ) : null}
      <div
        className="workspace-view"
        hidden={
          (graphPane && (gitGraphActive || Boolean(skillager.activeId))) ||
          (pane === 'primary' && webViewActive)
        }
      >
        {workspaceMissing ? (
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
}
