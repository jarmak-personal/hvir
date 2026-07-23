import { useEffect, useRef } from 'react'

import type { HostPath } from '../../../shared'
import {
  readTerminalSplitLayout,
  writeTerminalSplitLayout,
} from './terminal-split-persistence'
import type { TerminalWorkspaceModel } from './terminal-workspace-model'

export function useTerminalPersistence({
  root,
  model,
  ready,
}: {
  readonly root: HostPath
  readonly model: TerminalWorkspaceModel
  readonly ready: boolean
}): void {
  const modelRef = useRef(model)
  modelRef.current = model
  const layoutKey = JSON.stringify(
    model.sessions.map((session, position) => ({
      id: session.id,
      title: session.title,
      position,
      active: session.id === model.activeId,
      pane: session.pane,
      attention: session.attention,
    })),
  )

  useEffect(() => {
    if (!ready) return
    const current = modelRef.current
    const sessions = current.sessions.map((session, position) => ({
      id: session.id,
      title: session.title,
      position,
      active: session.id === current.activeId,
      attention: session.attention,
    }))
    void window.hvir
      .invoke('terminal:update-layout', { root, sessions })
      .catch(() => undefined)
  }, [layoutKey, ready, root])

  useEffect(() => {
    if (!ready) return
    writeTerminalSplitLayout(root, {
      ...readTerminalSplitLayout(root),
      secondaryIds: modelRef.current.sessions
        .filter((session) => session.pane === 'secondary')
        .map((session) => session.id),
      activeByPane: modelRef.current.activeByPane,
    })
  }, [layoutKey, ready, root])
}
