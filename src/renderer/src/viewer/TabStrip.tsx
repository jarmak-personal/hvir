import { useState, type DragEvent, type ReactElement } from 'react'

import { basenameHostPath } from '../../../shared'
import type { ViewerTab } from './tab-state'

interface TabStripProps {
  readonly tabs: readonly ViewerTab[]
  readonly activeId?: string
  readonly onActivate: (id: string) => void
  readonly onClose: (id: string) => void
  readonly onPin: (id: string) => void
  readonly onReorder: (draggedId: string, targetId: string) => void
}

export function TabStrip({
  tabs,
  activeId,
  onActivate,
  onClose,
  onPin,
  onReorder,
}: TabStripProps): ReactElement {
  const [dragged, setDragged] = useState<string>()
  return (
    <div className="tab-strip" role="tablist" aria-label="Open files">
      {tabs.map((tab) => (
        <div
          className={`viewer-tab${tab.id === activeId ? ' active' : ''}${tab.pinned ? '' : ' preview'}`}
          key={tab.id}
          role="tab"
          aria-selected={tab.id === activeId}
          draggable
          onDragStart={(event: DragEvent) => {
            setDragged(tab.id)
            event.dataTransfer.effectAllowed = 'move'
          }}
          onDragOver={(event) => {
            event.preventDefault()
            event.dataTransfer.dropEffect = 'move'
          }}
          onDrop={(event) => {
            event.preventDefault()
            if (dragged && dragged !== tab.id) onReorder(dragged, tab.id)
            setDragged(undefined)
          }}
          onDragEnd={() => setDragged(undefined)}
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
            onClick={() => onClose(tab.id)}
          >
            ×
          </button>
        </div>
      ))}
      {tabs.length === 0 ? <span className="tab-strip-empty">Viewer</span> : null}
    </div>
  )
}
