import { TemporaryDocumentWorkspace } from './temporary-document-context'
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import {
  basenameHostPath,
  canRender,
  renderedFileType,
  type DiffBase,
  type ViewMode,
  type GitBlameRun,
  type HostPath,
} from '../../../shared'
import { DiffView } from './DiffView'
import { FindControl } from './FindControl'
import { GoToLineControl } from './GoToLineControl'
import { RenderedView } from './RenderedView'
import { SourceView } from './SourceView'
import { LargeFileView } from './LargeFileView'
import { useSourceBlame } from './use-source-blame'
import { formatViewerBytes } from './viewer-byte-format'
import type { SourceCoordinate } from './source-coordinate'
import type {
  ViewerDocumentPosition,
  ViewerNavigationPosition,
  ViewerTab,
} from './tab-state'
import type { RegisterViewerCommandTarget } from './viewer-command-targets'
import {
  viewerFindUnavailable,
  type RegisterViewerFindTarget,
  type ViewerFindTarget,
} from './viewer-find'
import type { ViewerPositionCapture } from './viewer-position'
import {
  canUseInteractiveSource,
  sourcePreview,
  SOURCE_INTERACTIVE_BYTE_LIMIT,
} from './viewer-workload-policy'
import {
  DocumentReviewChrome,
  DocumentReviewToolbar,
} from '../document-review/DocumentReviewControls'
import { DocumentReviewInlineProvider } from '../document-review/DocumentReviewInlineSurface'
import {
  useDocumentReviewInteraction,
  type DocumentReviewDocumentProjection,
  type DocumentReviewWorkspaceBinding,
} from '../document-review/use-document-review-interaction'

interface FileViewerProps {
  readonly tab?: ViewerTab
  readonly gitRefreshVersion: number
  readonly onMode: (mode: ViewMode, position?: ViewerDocumentPosition) => void
  readonly onDiffBase: (base: DiffBase) => void
  readonly onContent: (content: string) => void
  readonly onSave: () => void
  readonly onReload: () => void
  readonly onPosition: (position: ViewerDocumentPosition) => void
  readonly onNavigationHandled: (serial: number) => void
  readonly registerCommands: RegisterViewerCommandTarget
  readonly onOpenPath: (path: HostPath) => void
  readonly onRenderedDependencies: (tabId: string, paths: readonly HostPath[]) => void
  readonly documentReview?: DocumentReviewWorkspaceBinding
}

export function FileViewer({
  tab,
  gitRefreshVersion,
  onMode,
  onDiffBase,
  onContent,
  onSave,
  onReload,
  onPosition,
  onNavigationHandled,
  registerCommands,
  onOpenPath,
  onRenderedDependencies,
  documentReview,
}: FileViewerProps): ReactElement {
  const [showBlame, setShowBlame] = useState(false)
  const [modeControlExpanded, setModeControlExpanded] = useState(false)
  const [manualNavigation, setManualNavigation] = useState<ViewerNavigationPosition>()
  const [findTarget, setFindTarget] = useState<ViewerFindTarget>()
  const [findRequest, setFindRequest] = useState<number>()
  const [goToLineRequest, setGoToLineRequest] = useState<number>()
  const manualNavigationSerial = useRef(0)
  const commandSerial = useRef(0)
  const modeControlRef = useRef<HTMLDivElement>(null)
  const tabId = tab?.id
  const currentPath = tab?.path
  const blameMode = tab?.temporaryWorkspaceRoot ? undefined : tab?.mode
  const positionCapture = useRef<(() => ViewerDocumentPosition) | undefined>(undefined)
  const binaryImage = Boolean(tab?.file?.binary && renderedFileType(tab.path) === 'image')
  const boundedPreview = Boolean(
    tab?.file && tab.file.size > SOURCE_INTERACTIVE_BYTE_LIMIT,
  )
  const navigationContent =
    tab?.file && !tab.file.binary
      ? boundedPreview
        ? sourcePreview(tab.file.content)
        : tab.file.content
      : undefined
  const documentRefreshVersion = tab?.refresh?.version ?? 0
  const { blame, blameStatus } = useSourceBlame(
    currentPath,
    blameMode,
    showBlame,
    documentRefreshVersion,
    gitRefreshVersion,
  )

  const registerFindTarget: RegisterViewerFindTarget = useCallback((target) => {
    setFindTarget(target)
    let active = true
    return () => {
      if (!active) return
      active = false
      setFindTarget((current) => (current === target ? undefined : current))
    }
  }, [])

  const reportRenderedDependencies = useCallback(
    (paths: readonly HostPath[]): void => {
      if (tabId) onRenderedDependencies(tabId, paths)
    },
    [onRenderedDependencies, tabId],
  )

  const navigate = useCallback(
    (coordinate: SourceCoordinate): void => {
      setManualNavigation({
        ...coordinate,
        serial: (manualNavigationSerial.current -= 1),
        focus: true,
      })
      onMode('source', positionCapture.current?.())
    },
    [onMode],
  )
  const navigateReviewLine = useCallback(
    (line: number): void => navigate({ line }),
    [navigate],
  )
  const reviewInteraction = useDocumentReviewInteraction(
    tab?.file && !tab.file.binary && !tab.temporaryWorkspaceRoot
      ? {
          path: tab.path,
          content: tab.file.content,
          dirty: tab.dirty,
          mode: tab.mode,
        }
      : undefined,
    documentReview,
    navigateReviewLine,
  )

  const handleNavigation = (serial: number): void => {
    if (manualNavigation?.serial === serial) setManualNavigation(undefined)
    else onNavigationHandled(serial)
  }

  useEffect(() => {
    if (!tabId) return
    return registerCommands(tabId, {
      findInFile: () => setFindRequest((commandSerial.current += 1)),
      goToLine: () => setGoToLineRequest((commandSerial.current += 1)),
    })
  }, [registerCommands, tabId])

  useEffect(() => {
    if (!modeControlExpanded) return
    const collapseOutside = (event: PointerEvent): void => {
      if (
        event.target instanceof Node &&
        !modeControlRef.current?.contains(event.target)
      ) {
        setModeControlExpanded(false)
      }
    }
    document.addEventListener('pointerdown', collapseOutside, true)
    return () => document.removeEventListener('pointerdown', collapseOutside, true)
  }, [modeControlExpanded])

  return (
    <div className="viewer-body">
      {tab ? (
        <div className="viewer-floating-controls" role="toolbar" aria-label="Viewer">
          {tab.conflict ? (
            <button className="conflict-badge" type="button" onClick={onReload}>
              Changed on disk · reload
            </button>
          ) : null}
          {tab.error && tab.file ? (
            <span className="viewer-operation-error" role="status" title={tab.error}>
              Save failed
            </span>
          ) : null}
          <div className="view-controls">
            {tab.temporaryWorkspaceRoot ? (
              <span>Read-only · temporary document</span>
            ) : null}
            <DocumentReviewToolbar interaction={reviewInteraction} mode={tab.mode} />
            <FindControl
              key={`${tab.id}:${tab.pane}:${tab.mode}`}
              requestSerial={findRequest}
              target={findTarget}
              unavailable={viewerFindUnavailable(tab)}
              boundedPreview={boundedPreview && tab.mode !== 'rendered'}
              onRequestHandled={(serial) =>
                setFindRequest((current) => (current === serial ? undefined : current))
              }
            />
            <GoToLineControl
              requestSerial={goToLineRequest}
              content={navigationContent}
              boundedPreview={boundedPreview}
              onRequestHandled={(serial) =>
                setGoToLineRequest((current) =>
                  current === serial ? undefined : current,
                )
              }
              onNavigate={navigate}
            />
            {tab.mode === 'diff' && !tab.diffRevision ? (
              <select
                className="diff-base-select"
                aria-label="Diff base"
                value={tab.diffBase}
                onChange={(event) => onDiffBase(event.currentTarget.value as DiffBase)}
              >
                <option value="working-tree">Index</option>
                <option value="head">HEAD</option>
                <option value="branch-point">Branch point</option>
              </select>
            ) : null}
            {tab.mode === 'source' && !tab.temporaryWorkspaceRoot ? (
              <button
                type="button"
                className={`blame-toggle${showBlame ? ' active' : ''}`}
                aria-pressed={showBlame}
                onClick={() => setShowBlame((shown) => !shown)}
              >
                Blame
              </button>
            ) : null}
            <div
              ref={modeControlRef}
              className={`mode-control${modeControlExpanded ? ' expanded' : ''}`}
              role="group"
              aria-label="View mode"
              onFocus={(event) => {
                if (
                  event.target instanceof HTMLElement &&
                  event.target.matches(':focus-visible')
                ) {
                  setModeControlExpanded(true)
                }
              }}
              onBlur={(event) => {
                if (
                  !(event.relatedTarget instanceof Node) ||
                  !event.currentTarget.contains(event.relatedTarget)
                ) {
                  setModeControlExpanded(false)
                }
              }}
            >
              {(['rendered', 'source', 'diff'] as const).map((mode) => (
                <button
                  type="button"
                  className={tab.mode === mode ? 'active' : ''}
                  aria-pressed={tab.mode === mode}
                  aria-expanded={tab.mode === mode ? modeControlExpanded : undefined}
                  title={
                    tab.file?.binary && mode !== 'rendered'
                      ? 'Binary repository assets are available in rendered view only'
                      : mode === 'rendered' && !canRender(tab.path)
                        ? 'No renderer registered for this file type'
                        : tab.mode === mode && !modeControlExpanded
                          ? 'Choose view mode · Ctrl/Cmd+Shift+M cycles modes'
                          : `${mode} view · Ctrl/Cmd+Shift+M cycles modes`
                  }
                  disabled={Boolean(
                    (tab.file?.binary && mode !== 'rendered') ||
                    (tab.temporaryWorkspaceRoot && mode === 'diff'),
                  )}
                  key={mode}
                  onClick={() => {
                    if (tab.mode === mode && !modeControlExpanded) {
                      setModeControlExpanded(true)
                      return
                    }
                    setModeControlExpanded(false)
                    onMode(mode, positionCapture.current?.())
                  }}
                >
                  {mode}
                </button>
              ))}
            </div>
            <select
              className="mode-select"
              aria-label="View mode"
              value={tab.mode}
              onChange={(event) => {
                onMode(event.currentTarget.value as ViewMode, positionCapture.current?.())
              }}
            >
              {(['rendered', 'source', 'diff'] as const).map((mode) => (
                <option
                  value={mode}
                  disabled={Boolean(
                    (tab.file?.binary && mode !== 'rendered') ||
                    (tab.temporaryWorkspaceRoot && mode === 'diff'),
                  )}
                  key={mode}
                >
                  {mode[0]?.toUpperCase()}
                  {mode.slice(1)}
                </option>
              ))}
            </select>
          </div>
        </div>
      ) : null}
      {!tab ? <EmptyViewer text="Choose a file from the tree" /> : null}
      {tab?.loading ? <EmptyViewer text="Opening…" /> : null}
      {tab?.error && !tab.file ? <EmptyViewer text={tab.error} error /> : null}
      {tab && !tab.loading && tab.file?.binary && !binaryImage ? (
        <BinaryFileView path={tab.path} size={tab.file.size} />
      ) : null}
      {tab && !tab.loading && tab.file && (!tab.file.binary || binaryImage) ? (
        <DocumentReviewInlineProvider interaction={reviewInteraction}>
          <ActiveView
            tab={tab}
            file={tab.file}
            onContent={onContent}
            onSave={onSave}
            onPosition={onPosition}
            blame={showBlame ? blame : []}
            blameStatus={showBlame ? blameStatus : ''}
            onOpenPath={onOpenPath}
            refresh={tab.refresh}
            gitRefreshVersion={gitRefreshVersion}
            onRenderedDependencies={reportRenderedDependencies}
            positionCapture={positionCapture}
            navigation={manualNavigation ?? tab.navigation}
            onNavigationHandled={handleNavigation}
            registerFindTarget={registerFindTarget}
            documentReview={reviewInteraction.projection}
          />
        </DocumentReviewInlineProvider>
      ) : null}
      <DocumentReviewChrome interaction={reviewInteraction} />
    </div>
  )
}

function BinaryFileView({
  path,
  size,
}: {
  readonly path: HostPath
  readonly size: number
}): ReactElement {
  const extension = basenameHostPath(path).split('.').at(-1)?.toUpperCase()
  return (
    <div className="viewer-empty binary-file-summary">
      <strong>{extension ? `${extension} binary file` : 'Binary file'}</strong>
      <span>{formatViewerBytes(size)}</span>
      <span>Source, diff, and review capture are unavailable.</span>
    </div>
  )
}

function ActiveView({
  tab,
  file,
  onContent,
  onSave,
  onPosition,
  blame,
  blameStatus,
  onOpenPath,
  refresh,
  gitRefreshVersion,
  onRenderedDependencies,
  positionCapture,
  navigation,
  onNavigationHandled,
  registerFindTarget,
  documentReview,
}: {
  readonly tab: ViewerTab
  readonly file: NonNullable<ViewerTab['file']>
  readonly onContent: (content: string) => void
  readonly onSave: () => void
  readonly onPosition: (position: ViewerDocumentPosition) => void
  readonly blame: readonly GitBlameRun[]
  readonly blameStatus: string
  readonly onOpenPath: (path: HostPath) => void
  readonly refresh?: ViewerTab['refresh']
  readonly gitRefreshVersion: number
  readonly onRenderedDependencies: (paths: readonly HostPath[]) => void
  readonly positionCapture: ViewerPositionCapture
  readonly navigation?: ViewerNavigationPosition
  readonly onNavigationHandled: (serial: number) => void
  readonly registerFindTarget: RegisterViewerFindTarget
  readonly documentReview?: DocumentReviewDocumentProjection
}): ReactElement {
  if (tab.mode === 'rendered') {
    return (
      <TemporaryDocumentWorkspace.Provider value={tab.temporaryWorkspaceRoot}>
        <RenderedView
          path={tab.path}
          content={file.content}
          position={tab.position}
          onPosition={onPosition}
          positionCapture={positionCapture}
          onOpenPath={onOpenPath}
          refresh={refresh}
          onDependencies={onRenderedDependencies}
          registerFindTarget={registerFindTarget}
          documentReview={documentReview}
        />
      </TemporaryDocumentWorkspace.Provider>
    )
  }
  if (tab.mode === 'diff') {
    return (
      <DiffView
        path={tab.path}
        base={tab.diffBase}
        currentContent={file.content}
        currentSize={file.size}
        dirty={tab.dirty}
        revision={tab.diffRevision}
        documentRefreshVersion={refresh?.version ?? 0}
        gitRefreshVersion={gitRefreshVersion}
        position={tab.position}
        onPosition={onPosition}
        positionCapture={positionCapture}
        registerFindTarget={registerFindTarget}
      />
    )
  }
  if (!canUseInteractiveSource(file.size)) {
    return (
      <LargeFileView
        content={file.content}
        size={file.size}
        mode={tab.mode}
        position={tab.position}
        onPosition={onPosition}
        positionCapture={positionCapture}
        navigation={navigation}
        onNavigationHandled={onNavigationHandled}
        registerFindTarget={registerFindTarget}
      />
    )
  }
  return (
    <SourceView
      readOnly={Boolean(tab.temporaryWorkspaceRoot)}
      path={tab.path}
      content={file.content}
      size={file.size}
      position={tab.position}
      onContent={onContent}
      onSave={onSave}
      onPosition={onPosition}
      blame={blame}
      blameStatus={blameStatus}
      positionCapture={positionCapture}
      navigation={navigation}
      onNavigationHandled={onNavigationHandled}
      registerFindTarget={registerFindTarget}
      documentReview={documentReview}
    />
  )
}

function EmptyViewer({
  text,
  error = false,
}: {
  readonly text: string
  readonly error?: boolean
}): ReactElement {
  return <div className={`viewer-empty${error ? ' error' : ''}`}>{text}</div>
}
