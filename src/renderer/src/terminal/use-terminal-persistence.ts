import { useEffect, useRef } from 'react'

import { hostPathEquals, type HostPath } from '../../../shared'
import {
  readTerminalSplitLayout,
  writeTerminalSplitLayout,
} from './terminal-split-persistence'
import {
  settledTerminalSessions,
  type TerminalWorkspaceModel,
  type TerminalSession,
} from './terminal-workspace-model'

export function useTerminalPersistence(
  root: HostPath,
  model: TerminalWorkspaceModel,
  ready: boolean,
  updateSession: (
    id: string,
    update: (session: TerminalSession) => TerminalSession,
  ) => void,
): void {
  useEffect(() => {
    const dispose = window.hvir.on('terminal:name-changed', (name) => {
      if (!hostPathEquals(name.root, root)) return
      updateSession(name.id, (current) =>
        (name.nameRevision ?? 0) > (current.nameRevision ?? 0)
          ? { ...current, customName: name.customName, nameRevision: name.nameRevision }
          : current,
      )
    })
    return () => {
      void dispose()
    }
  }, [root, updateSession])
  const modelRef = useRef(model)
  modelRef.current = model
  const layoutKey = JSON.stringify(
    settledTerminalSessions(model.sessions).map((session, position) => ({
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
    const sessions = settledTerminalSessions(current.sessions).map(
      (session, position) => ({
        id: session.id,
        title: session.title,
        position,
        active: session.id === current.activeId,
        attention: session.attention,
      }),
    )
    void window.hvir
      .invoke('terminal:update-layout', { root, sessions })
      .catch(() => undefined)
  }, [layoutKey, ready, root])

  useEffect(() => {
    if (!ready) return
    writeTerminalSplitLayout(root, {
      ...readTerminalSplitLayout(root),
      secondaryIds: settledTerminalSessions(modelRef.current.sessions)
        .filter((session) => session.pane === 'secondary')
        .map((session) => session.id),
      activeByPane: modelRef.current.activeByPane,
    })
  }, [layoutKey, ready, root])
}
