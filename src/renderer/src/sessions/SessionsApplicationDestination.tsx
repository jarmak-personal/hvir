import type { ReactElement } from 'react'

import type {
  ProjectState,
  SessionsLivePtyQualifier,
  SessionsTerminalHandle,
  SessionsWorkspaceQualifier,
} from '../../../shared'
import type { SessionsRendererObservationPort } from './sessions-renderer-observation'
import { SessionsOverview } from './SessionsOverview'

interface SessionsDestinationRuntime {
  readonly sessionsObservation: SessionsRendererObservationPort
  readonly focusProjectedSession: (
    handle: SessionsTerminalHandle,
    workspaceQualifier: SessionsWorkspaceQualifier,
    livePty: SessionsLivePtyQualifier,
  ) => Promise<boolean>
}

export function SessionsApplicationDestination({
  active,
  runtime,
  onOpened,
  onReturn,
  onError,
}: {
  readonly active: boolean
  readonly runtime: SessionsDestinationRuntime
  readonly onOpened: (state: ProjectState) => void
  readonly onReturn: () => void
  readonly onError: (message: string) => void
}): ReactElement | null {
  if (!active) return null
  return (
    <SessionsOverview
      observation={runtime.sessionsObservation}
      onReturn={onReturn}
      onOpened={(state) => {
        onOpened(state)
        onReturn()
      }}
      onFocusOpened={runtime.focusProjectedSession}
      onOpenFailed={onError}
    />
  )
}
