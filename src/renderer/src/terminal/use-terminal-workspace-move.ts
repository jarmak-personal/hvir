import { useCallback, useEffect, useState, type RefObject } from 'react'

import {
  unwrapOperation,
  type MoveTerminalResponse,
  type TerminalMovePlan,
  type WorkspaceState,
} from '../../../shared'
import type {
  TerminalSession,
  TerminalWorkspaceAction,
  TerminalWorkspaceModel,
} from './terminal-workspace-model'

export interface TerminalWorkspaceController {
  readonly hasSession: (id: string) => boolean
  readonly transferOut: (id: string) => TerminalSession | undefined
  readonly transferIn: (session: TerminalSession) => void
}

export function useTerminalWorkspaceMove({
  workspaceId,
  modelRef,
  send,
  forgetAttention,
  moveTargets,
  registerController,
  onMoved,
  acknowledgeTargets,
  onError,
}: {
  readonly workspaceId: string
  readonly modelRef: RefObject<TerminalWorkspaceModel>
  readonly send: (action: TerminalWorkspaceAction) => void
  readonly forgetAttention: (id: string) => void
  readonly moveTargets: readonly WorkspaceState[]
  readonly registerController: (
    workspaceId: string,
    controller: TerminalWorkspaceController | undefined,
  ) => void
  readonly onMoved: (
    sessionId: string,
    sourceWorkspaceId: string,
    targetWorkspaceId: string,
    response: MoveTerminalResponse,
  ) => void
  readonly acknowledgeTargets: (workspaceIds: readonly string[]) => Promise<void>
  readonly onError: (message: string) => void
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [pending, setPending] = useState<TerminalMovePlan>()

  useEffect(() => {
    const controller: TerminalWorkspaceController = {
      hasSession: (id) => modelRef.current.sessions.some((session) => session.id === id),
      transferOut: (id) => {
        const session = modelRef.current.sessions.find((candidate) => candidate.id === id)
        if (!session) return undefined
        forgetAttention(id)
        send({ type: 'session-closed', id })
        return session
      },
      transferIn: (session) => {
        if (!modelRef.current.sessions.some((candidate) => candidate.id === session.id)) {
          send({ type: 'session-added', session })
        }
      },
    }
    registerController(workspaceId, controller)
    return () => registerController(workspaceId, undefined)
  }, [forgetAttention, modelRef, registerController, send, workspaceId])

  useEffect(() => {
    if (!menuOpen) return
    const close = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMenuOpen(false)
    }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [menuOpen])

  const plan = useCallback(
    (target: WorkspaceState): void => {
      const terminalId = modelRef.current.activeId
      if (!terminalId) return
      setMenuOpen(false)
      void window.hvir
        .invoke('terminal:plan-move', {
          terminalId,
          sourceWorkspaceId: workspaceId,
          targetWorkspaceId: target.id,
        })
        .then((result) => setPending(unwrapOperation(result)))
        .catch((reason) => onError(errorMessage(reason)))
    },
    [modelRef, onError, workspaceId],
  )

  const confirm = useCallback(async (): Promise<void> => {
    if (!pending) return
    const response = unwrapOperation(
      await window.hvir.invoke('terminal:move', {
        terminalId: pending.terminalId,
        sourceWorkspaceId: pending.sourceWorkspaceId,
        targetWorkspaceId: pending.targetWorkspaceId,
        expectedWebPaneIds: pending.webPaneIds,
      }),
    )
    onMoved(
      pending.terminalId,
      pending.sourceWorkspaceId,
      pending.targetWorkspaceId,
      response,
    )
    setPending(undefined)
  }, [onMoved, pending])

  return {
    menuOpen,
    pending,
    toggleMenu: () => setMenuOpen((open) => !open),
    closeMenu: () => setMenuOpen(false),
    plan,
    cancel: () => setPending(undefined),
    confirm,
    dismissNewTargets: () => {
      setMenuOpen(false)
      void acknowledgeTargets(
        moveTargets.filter((target) => target.newlyDiscovered).map((target) => target.id),
      ).catch((reason) => onError(errorMessage(reason)))
    },
  }
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}
