import { useCallback, useRef } from 'react'

import type { MoveTerminalResponse } from '../../../shared'
import type { TerminalWorkspaceRuntimeOwner } from './terminal-workspace-runtime-owner'
import type { TerminalWorkspaceController } from './use-terminal-workspace-move'

export function useTerminalWorkspaceTransfer({
  owner,
  canMaterialize,
  acceptProjectState,
  forgetWebViews,
  onError,
}: {
  readonly owner: TerminalWorkspaceRuntimeOwner
  readonly canMaterialize: (workspaceId: string) => boolean
  readonly acceptProjectState: (state: MoveTerminalResponse['state']) => void
  readonly forgetWebViews: (terminalId: string) => void
  readonly onError: (message: string) => void
}) {
  const callbacks = useRef({ acceptProjectState, canMaterialize, forgetWebViews, onError })
  callbacks.current = { acceptProjectState, canMaterialize, forgetWebViews, onError }

  const register = useCallback(
    (workspaceId: string, controller: TerminalWorkspaceController | undefined) => {
      owner.registerController(workspaceId, controller)
    },
    [owner],
  )

  const prepare = useCallback(
    (workspaceId: string): Promise<void> => {
      if (!callbacks.current.canMaterialize(workspaceId)) {
        return Promise.reject(
          new Error(`Terminal move target '${workspaceId}' is no longer available`),
        )
      }
      return owner.prepareTransferTarget(workspaceId)
    },
    [owner],
  )

  const release = useCallback(
    (workspaceId: string): void => owner.releaseTransferTarget(workspaceId),
    [owner],
  )

  const complete = useCallback(
    (
      terminalId: string,
      sourceWorkspaceId: string,
      targetWorkspaceId: string,
      response: MoveTerminalResponse,
    ): void => {
      const source = owner.controller(sourceWorkspaceId)
      const target = owner.controller(targetWorkspaceId)
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
      owner.retainWorkspace(targetWorkspaceId, true)
      callbacks.current.forgetWebViews(terminalId)
      callbacks.current.acceptProjectState(response.state)
    },
    [owner],
  )

  return { register, prepare, release, complete }
}
