import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from 'react'

import type { TerminalContextMenuTarget } from './terminal-context-menu-target'

export interface TerminalContextMenuRequest {
  readonly id: number
  readonly target: TerminalContextMenuTarget
  readonly x: number
  readonly y: number
  readonly focusMenu: boolean
  readonly copyAvailable: boolean
}

export interface TerminalContextMenuController {
  readonly request?: TerminalContextMenuRequest
  readonly openFromPointer: (event: MouseEvent<HTMLElement>) => void
  readonly openFromKeyboard: (event: KeyboardEvent<HTMLElement>) => boolean
  readonly dismiss: (restoreTerminalFocus?: boolean) => void
}

export function useTerminalContextMenu(
  getTarget: () => TerminalContextMenuTarget | undefined,
  enabled = true,
): TerminalContextMenuController {
  const [request, setRequest] = useState<TerminalContextMenuRequest>()
  const nextRequestId = useRef(0)

  useEffect(() => {
    if (!enabled) setRequest(undefined)
  }, [enabled])

  useEffect(() => {
    if (!request) return
    const dispose = request.target.onRevoked(() => {
      setRequest((current) => (current?.id === request.id ? undefined : current))
    })
    return () => void dispose()
  }, [request])

  const open = useCallback(
    (x: number, y: number, focusMenu: boolean): void => {
      const target = getTarget()
      if (!target) {
        setRequest(undefined)
        return
      }
      setRequest({
        id: (nextRequestId.current += 1),
        target,
        x,
        y,
        focusMenu,
        copyAvailable: target.hasSelection(),
      })
    },
    [getTarget],
  )

  const openFromPointer = useCallback(
    (event: MouseEvent<HTMLElement>): void => {
      event.preventDefault()
      event.stopPropagation()
      open(event.clientX, event.clientY, false)
    },
    [open],
  )

  const openFromKeyboard = useCallback(
    (event: KeyboardEvent<HTMLElement>): boolean => {
      if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) {
        return false
      }
      event.preventDefault()
      event.stopPropagation()
      const bounds = event.currentTarget.getBoundingClientRect()
      open(bounds.left + Math.min(bounds.width, 24), bounds.top + 24, true)
      return true
    },
    [open],
  )

  const dismiss = useCallback(
    (restoreTerminalFocus = false): void => {
      setRequest(undefined)
      if (restoreTerminalFocus) request?.target.focus()
    },
    [request],
  )

  return { request, openFromPointer, openFromKeyboard, dismiss }
}
