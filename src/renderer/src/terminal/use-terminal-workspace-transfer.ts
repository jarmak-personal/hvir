import { useCallback, useRef } from 'react'

import type { MoveTerminalResponse } from '../../../shared'
import type { TerminalWorkspaceController } from './use-terminal-workspace-move'

export function useTerminalWorkspaceTransfer({
  acceptProjectState,
  forgetWebViews,
  onError,
}: {
  readonly acceptProjectState: (state: MoveTerminalResponse['state']) => void
  readonly forgetWebViews: (terminalId: string) => void
  readonly onError: (message: string) => void
}) {
  const controllers = useRef(new Map<string, TerminalWorkspaceController>())
  const callbacks = useRef({ acceptProjectState, forgetWebViews, onError })
  callbacks.current = { acceptProjectState, forgetWebViews, onError }

  const register = useCallback(
    (workspaceId: string, controller: TerminalWorkspaceController | undefined) => {
      if (controller) controllers.current.set(workspaceId, controller)
      else controllers.current.delete(workspaceId)
    },
    [],
  )

  const complete = useCallback(
    (
      terminalId: string,
      sourceWorkspaceId: string,
      targetWorkspaceId: string,
      response: MoveTerminalResponse,
    ): void => {
      const source = controllers.current.get(sourceWorkspaceId)
      const target = controllers.current.get(targetWorkspaceId)
      if (!source || !target || !source.hasSession(terminalId)) {
        callbacks.current.acceptProjectState(response.state)
        callbacks.current.onError(
          'The terminal moved, but its workspace view was not ready. Reload hvir to recover it.',
        )
        return
      }
      const session = source.transferOut(terminalId)
      if (!session) {
        callbacks.current.acceptProjectState(response.state)
        callbacks.current.onError('The moved terminal disappeared from its source view')
        return
      }
      target.transferIn(session)
      callbacks.current.forgetWebViews(terminalId)
      callbacks.current.acceptProjectState(response.state)
    },
    [],
  )

  return { register, complete }
}
