import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from 'react'

import type { HostPath } from '../../../shared'

export interface PathCopyMenuRequest {
  readonly id: number
  readonly target: HostPath
  readonly label: string
  readonly x: number
  readonly y: number
  readonly returnFocus?: HTMLElement
  readonly focusMenu: boolean
}

export interface PathCopyMenuController {
  readonly request?: PathCopyMenuRequest
  readonly openFromPointer: (
    event: MouseEvent<HTMLElement>,
    target: HostPath,
    label: string,
  ) => void
  readonly openFromKeyboard: (
    event: KeyboardEvent<HTMLElement>,
    target: HostPath,
    label: string,
  ) => boolean
  readonly dismiss: (restoreFocus?: boolean) => void
}

export function usePathCopyMenu(owner?: HostPath): PathCopyMenuController {
  const [request, setRequest] = useState<PathCopyMenuRequest>()
  const nextRequestId = useRef(0)
  const ownerKey = owner ? `${owner.hostId}\0${owner.path}` : undefined

  useEffect(() => {
    setRequest(undefined)
  }, [ownerKey])

  const openFromPointer = useCallback(
    (event: MouseEvent<HTMLElement>, target: HostPath, label: string): void => {
      event.preventDefault()
      event.stopPropagation()
      setRequest({
        id: (nextRequestId.current += 1),
        target,
        label,
        x: event.clientX,
        y: event.clientY,
        returnFocus: focusedElement(),
        focusMenu: false,
      })
    },
    [],
  )

  const openFromKeyboard = useCallback(
    (event: KeyboardEvent<HTMLElement>, target: HostPath, label: string): boolean => {
      if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) {
        return false
      }
      event.preventDefault()
      event.stopPropagation()
      const bounds = event.currentTarget.getBoundingClientRect()
      setRequest({
        id: (nextRequestId.current += 1),
        target,
        label,
        x: bounds.left + Math.min(bounds.width, 24),
        y: bounds.bottom,
        returnFocus: event.currentTarget,
        focusMenu: true,
      })
      return true
    },
    [],
  )

  const dismiss = useCallback(
    (restoreFocus = false): void => {
      setRequest(undefined)
      if (restoreFocus) request?.returnFocus?.focus({ preventScroll: true })
    },
    [request],
  )

  return { request, openFromPointer, openFromKeyboard, dismiss }
}

function focusedElement(): HTMLElement | undefined {
  return document.activeElement instanceof HTMLElement
    ? document.activeElement
    : undefined
}
