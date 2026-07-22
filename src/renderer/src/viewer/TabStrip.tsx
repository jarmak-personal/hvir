import { useEffect, useState, type DragEvent, type ReactElement } from 'react'

import { basenameHostPath } from '../../../shared'
import { ConfirmationDialog } from '../workbench/ConfirmationDialog'
import type { ViewerPaneId, ViewerTab } from './tab-state'

const VIEWER_TAB_DRAG_TYPE = 'application/x-hvir-viewer-tab'

interface TabStripProps {
  readonly tabs: readonly ViewerTab[]
  readonly pane: ViewerPaneId
  readonly activeId?: string
  readonly onActivate: (id: string) => void
  readonly onClose: (id: string) => void
  readonly onPin: (id: string) => void
  readonly onReorder: (draggedId: string, targetId: string) => void
  readonly onMoveToPane: (id: string, pane: ViewerPaneId) => void
  readonly split: boolean
  readonly onSplit: () => void
  readonly onClosePane?: () => void
  readonly graphOpen: boolean
  readonly graphActive: boolean
  readonly onActivateGraph: () => void
  readonly onCloseGraph: () => void
  readonly webTabs?: readonly { readonly id: string; readonly title: string }[]
  readonly activeWebId?: string
  readonly onActivateWeb?: (id: string) => void
  readonly onCloseWeb?: (id: string) => void
}

export function TabStrip({
  tabs,
  pane,
  activeId,
  onActivate,
  onClose,
  onPin,
  onReorder,
  onMoveToPane,
  split,
  onSplit,
  onClosePane,
  graphOpen,
  graphActive,
  onActivateGraph,
  onCloseGraph,
  webTabs = [],
  activeWebId,
  onActivateWeb,
  onCloseWeb,
}: TabStripProps): ReactElement {
  const [pendingCloseId, setPendingCloseId] = useState<string>()
  const pendingClose = tabs.find((tab) => tab.id === pendingCloseId)

  useEffect(() => {
    if (pendingCloseId && !pendingClose) setPendingCloseId(undefined)
  }, [pendingClose, pendingCloseId])

  const requestClose = (tab: ViewerTab): void => {
    if (tab.dirty) setPendingCloseId(tab.id)
    else onClose(tab.id)
  }

  return (
    <>
      <div
        className="tab-strip"
        role="tablist"
        aria-label={`${pane === 'primary' ? 'Primary' : 'Secondary'} open views`}
        onDragOver={(event) => acceptTabDrag(event)}
        onDrop={(event) => {
          const id = draggedTabId(event)
          if (!id) return
          event.preventDefault()
          onMoveToPane(id, pane)
        }}
      >
        {tabs.map((tab) => (
          <div
            className={`viewer-tab${tab.id === activeId ? ' active' : ''}${tab.pinned ? '' : ' preview'}`}
            key={tab.id}
            role="tab"
            aria-selected={tab.id === activeId}
            draggable
            onDragStart={(event: DragEvent) => {
              event.dataTransfer.setData(VIEWER_TAB_DRAG_TYPE, tab.id)
              event.dataTransfer.setData('text/plain', tab.id)
              event.dataTransfer.effectAllowed = 'move'
            }}
            onDragOver={acceptTabDrag}
            onDrop={(event) => {
              event.stopPropagation()
              const dragged = draggedTabId(event)
              if (!dragged) return
              event.preventDefault()
              onMoveToPane(dragged, pane)
              if (dragged !== tab.id) onReorder(dragged, tab.id)
            }}
            onDoubleClick={() => onPin(tab.id)}
          >
            <button
              className="tab-main"
              type="button"
              onClick={() => onActivate(tab.id)}
              title={tab.path.path}
            >
              <span className={`tab-status${tab.conflict ? ' conflict' : ''}`}>
                {tab.conflict ? '!' : tab.dirty ? '●' : ''}
              </span>
              <span className="tab-name">{basenameHostPath(tab.path)}</span>
            </button>
            <button
              className="tab-close"
              type="button"
              aria-label={`Close ${basenameHostPath(tab.path)}`}
              onClick={() => requestClose(tab)}
            >
              ×
            </button>
          </div>
        ))}
        {graphOpen ? (
          <div
            className={`viewer-tab git-graph-tab${graphActive ? ' active' : ''}`}
            role="tab"
            aria-selected={graphActive}
          >
            <button
              className="tab-main"
              type="button"
              onClick={onActivateGraph}
              title="Repository history graph"
            >
              <span className="tab-status" aria-hidden="true">
                ⎇
              </span>
              <span className="tab-name">Git history</span>
            </button>
            <button
              className="tab-close"
              type="button"
              aria-label="Close Git history"
              onClick={onCloseGraph}
            >
              ×
            </button>
          </div>
        ) : null}
        {webTabs.map((webTab) => (
          <div
            className={`viewer-tab web-pane-tab${webTab.id === activeWebId ? ' active' : ''}`}
            key={webTab.id}
            role="tab"
            aria-selected={webTab.id === activeWebId}
          >
            <button
              className="tab-main"
              type="button"
              onClick={() => onActivateWeb?.(webTab.id)}
              title={webTab.title}
            >
              <span className="tab-status" aria-hidden="true">
                ◍
              </span>
              <span className="tab-name">{webTab.title}</span>
            </button>
            <button
              className="tab-close"
              type="button"
              aria-label={`Close ${webTab.title}`}
              onClick={() => onCloseWeb?.(webTab.id)}
            >
              ×
            </button>
          </div>
        ))}
        {tabs.length === 0 && !graphOpen && webTabs.length === 0 ? (
          <span className="tab-strip-empty">{split ? 'Drop a tab here' : 'Viewer'}</span>
        ) : null}
        <span className="tab-strip-spacer" />
        {pane === 'primary' && !split ? (
          <button
            className="viewer-pane-action"
            type="button"
            aria-label="Split viewer right"
            title="Split viewer right"
            onClick={onSplit}
          >
            ◫
          </button>
        ) : null}
        {pane === 'secondary' && onClosePane ? (
          <button
            className="viewer-pane-action"
            type="button"
            aria-label="Close secondary viewer"
            title="Close secondary viewer"
            onClick={onClosePane}
          >
            ×
          </button>
        ) : null}
      </div>
      {pendingClose ? (
        <ConfirmationDialog
          labelledBy={`dirty-tab-close-${pane}`}
          actions={[
            {
              label: 'Cancel',
              kind: 'cancel',
              onSelect: () => setPendingCloseId(undefined),
            },
            {
              label: 'Close without saving',
              kind: 'destructive',
              onSelect: () => {
                setPendingCloseId(undefined)
                onClose(pendingClose.id)
              },
            },
          ]}
          className="dirty-tab-close-dialog"
        >
          <h2 id={`dirty-tab-close-${pane}`}>
            Close {basenameHostPath(pendingClose.path)} without saving?
          </h2>
          <p>Unsaved changes in this tab will be discarded.</p>
        </ConfirmationDialog>
      ) : null}
    </>
  )
}

function acceptTabDrag(event: DragEvent): void {
  if (!event.dataTransfer.types.includes(VIEWER_TAB_DRAG_TYPE)) return
  event.preventDefault()
  event.dataTransfer.dropEffect = 'move'
}

function draggedTabId(event: DragEvent): string | undefined {
  const id = event.dataTransfer.getData(VIEWER_TAB_DRAG_TYPE)
  return id || undefined
}
