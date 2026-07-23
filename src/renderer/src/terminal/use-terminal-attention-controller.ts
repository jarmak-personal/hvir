import { useCallback, useEffect, useRef } from 'react'

import {
  nextTerminalAttention,
  terminalActionableAttentionCount,
  terminalIdleAttentionAfterInput,
  terminalOutputAttentionDecision,
  type TerminalAttention,
  type TerminalIdleAttentionState,
} from './terminal-attention'
import type { TerminalSession } from './terminal-workspace-model'

export function useTerminalAttentionController({
  idleThresholdMs,
  onUpdateSession,
}: {
  readonly idleThresholdMs: number
  readonly onUpdateSession: (
    id: string,
    update: (session: TerminalSession) => TerminalSession,
  ) => void
}) {
  const updateRef = useRef(onUpdateSession)
  const idleThresholdRef = useRef(idleThresholdMs)
  const appFocused = useRef(document.hasFocus())
  const focusedTerminal = useRef<string | undefined>(undefined)
  const idleTimers = useRef(new Map<string, number>())
  const idleStates = useRef(new Map<string, TerminalIdleAttentionState>())
  updateRef.current = onUpdateSession
  idleThresholdRef.current = idleThresholdMs

  const clearTimer = useCallback((id: string): void => {
    const timer = idleTimers.current.get(id)
    if (timer !== undefined) window.clearTimeout(timer)
    idleTimers.current.delete(id)
  }, [])

  const reset = useCallback((): void => {
    for (const timer of idleTimers.current.values()) window.clearTimeout(timer)
    idleTimers.current.clear()
    idleStates.current.clear()
    focusedTerminal.current = undefined
  }, [])

  useEffect(() => {
    const focused = (): void => {
      appFocused.current = true
      focusedTerminal.current =
        document.activeElement instanceof Element
          ? document.activeElement.closest<HTMLElement>('[data-terminal-session]')
              ?.dataset['terminalSession']
          : undefined
    }
    const blurred = (): void => {
      appFocused.current = false
      focusedTerminal.current = undefined
    }
    const trackFocus = (event: FocusEvent): void => {
      const terminal =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>('[data-terminal-session]')
          : null
      focusedTerminal.current = terminal?.dataset['terminalSession']
    }
    const trackPointer = (event: PointerEvent): void => {
      if (
        event.target instanceof Element &&
        !event.target.closest('[data-terminal-session]')
      ) {
        focusedTerminal.current = undefined
      }
    }
    window.addEventListener('focus', focused)
    window.addEventListener('blur', blurred)
    window.addEventListener('focusin', trackFocus)
    window.addEventListener('pointerdown', trackPointer, true)
    return () => {
      window.removeEventListener('focus', focused)
      window.removeEventListener('blur', blurred)
      window.removeEventListener('focusin', trackFocus)
      window.removeEventListener('pointerdown', trackPointer, true)
      reset()
    }
  }, [reset])

  const focusSession = useCallback(
    (id: string): void => {
      clearTimer(id)
      focusedTerminal.current = id
    },
    [clearTimer],
  )

  const forgetSession = useCallback(
    (id: string): void => {
      clearTimer(id)
      idleStates.current.delete(id)
      if (focusedTerminal.current === id) focusedTerminal.current = undefined
    },
    [clearTimer],
  )

  const raiseAttention = useCallback((id: string, attention: TerminalAttention): void => {
    const focused = focusedTerminal.current === id && appFocused.current
    updateRef.current(id, (session) => {
      const nextAttention = nextTerminalAttention(session.attention, attention, focused)
      return nextAttention === session.attention
        ? session
        : { ...session, attention: nextAttention }
    })
  }, [])

  const recordInput = useCallback((id: string, data: string): void => {
    const current = idleStates.current.get(id) ?? 'initial'
    idleStates.current.set(id, terminalIdleAttentionAfterInput(current, data))
  }, [])

  const recordOutput = useCallback(
    (id: string): void => {
      const focused = focusedTerminal.current === id && appFocused.current
      clearTimer(id)
      const decision = terminalOutputAttentionDecision(
        idleStates.current.get(id) ?? 'initial',
      )
      if (!decision.notify || focused) return
      raiseAttention(id, 'working')
      if (!decision.scheduleIdle) return
      idleTimers.current.set(
        id,
        window.setTimeout(() => {
          idleTimers.current.delete(id)
          idleStates.current.set(id, 'settled')
          if (focusedTerminal.current !== id || !appFocused.current) {
            raiseAttention(id, 'idle')
          }
        }, idleThresholdRef.current),
      )
    },
    [clearTimer, raiseAttention],
  )

  return {
    reset,
    focusSession,
    forgetSession,
    raiseAttention,
    recordInput,
    recordOutput,
  }
}

export function useTerminalAttentionRollup({
  workspaceId,
  sessions,
  onRollup,
}: {
  readonly workspaceId: string
  readonly sessions: readonly TerminalSession[]
  readonly onRollup: (
    workspaceId: string,
    rollup: { readonly actionable: number },
  ) => void
}): void {
  const actionable = terminalActionableAttentionCount(
    sessions.map((session) => session.attention),
  )
  useEffect(() => {
    onRollup(workspaceId, { actionable })
  }, [actionable, onRollup, workspaceId])
  useEffect(() => () => onRollup(workspaceId, { actionable: 0 }), [onRollup, workspaceId])
}
