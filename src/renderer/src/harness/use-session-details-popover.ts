import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from 'react'

export interface SessionDetailsRequest {
  readonly id: number
  readonly target: string
  readonly x: number
  readonly y: number
  readonly focusPopover: boolean
  readonly returnFocus?: HTMLElement
}

export interface SessionDetailsPopoverController {
  readonly request?: SessionDetailsRequest
  readonly openFromPointer: (event: MouseEvent<HTMLElement>, target: string) => void
  readonly openFromKeyboard: (
    event: KeyboardEvent<HTMLElement>,
    target: string,
  ) => boolean
  readonly dismiss: (restoreFocus?: boolean) => void
}

export function useSessionDetailsPopover(
  ownerKey: string,
  focusFallback?: () => void,
): SessionDetailsPopoverController {
  const [request, setRequest] = useState<SessionDetailsRequest>()
  const requestRef = useRef(request)
  const focusFallbackRef = useRef(focusFallback)
  const nextId = useRef(0)
  requestRef.current = request
  focusFallbackRef.current = focusFallback
  useEffect(() => setRequest(undefined), [ownerKey])

  const openFromPointer = useCallback(
    (event: MouseEvent<HTMLElement>, target: string): void => {
      event.preventDefault()
      event.stopPropagation()
      setRequest({
        id: (nextId.current += 1),
        target,
        x: event.clientX,
        y: event.clientY,
        focusPopover: false,
        returnFocus:
          document.activeElement instanceof HTMLElement
            ? document.activeElement
            : event.currentTarget,
      })
    },
    [],
  )
  const openFromKeyboard = useCallback(
    (event: KeyboardEvent<HTMLElement>, target: string): boolean => {
      if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) {
        return false
      }
      event.preventDefault()
      event.stopPropagation()
      const bounds = event.currentTarget.getBoundingClientRect()
      setRequest({
        id: (nextId.current += 1),
        target,
        x: bounds.left + Math.min(bounds.width, 24),
        y: bounds.bottom,
        focusPopover: true,
        returnFocus: event.currentTarget,
      })
      return true
    },
    [],
  )
  const dismiss = useCallback((restoreFocus = false): void => {
    setRequest(undefined)
    if (!restoreFocus) return
    const returnFocus = requestRef.current?.returnFocus
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true })
    else focusFallbackRef.current?.()
  }, [])
  return { request, openFromPointer, openFromKeyboard, dismiss }
}
