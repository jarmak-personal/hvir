import { useEffect, useRef, type RefObject } from 'react'

import { nextModalFocusIndex } from './modal-keyboard-model'

export function useModalKeyboard(
  dialogRef: RefObject<HTMLElement | null>,
  onDismiss: () => void,
  dismissEnabled = true,
  active = true,
): void {
  const dismissRef = useRef(onDismiss)
  const enabledRef = useRef(dismissEnabled)
  const activeRef = useRef(active)
  dismissRef.current = onDismiss
  enabledRef.current = dismissEnabled
  activeRef.current = active

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    const previousFocus = document.activeElement
    const focusableSelector =
      'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
    const focusFirst = window.requestAnimationFrame(() => {
      if (!activeRef.current) return
      const preferred = dialog.querySelector<HTMLElement>('[autofocus]')
      const first = dialog.querySelector<HTMLElement>(focusableSelector)
      ;(preferred ?? first ?? dialog).focus()
    })
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (!activeRef.current) return
      if (event.key === 'Escape' && enabledRef.current) {
        event.preventDefault()
        dismissRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = [
        ...dialog.querySelectorAll<HTMLElement>(focusableSelector),
      ].filter((element) => element.offsetParent !== null)
      if (focusable.length === 0) {
        event.preventDefault()
        dialog.focus()
        return
      }
      const current = focusable.indexOf(document.activeElement as HTMLElement)
      const nextIndex = nextModalFocusIndex(current, focusable.length, event.shiftKey)
      event.preventDefault()
      if (nextIndex !== undefined) focusable[nextIndex]?.focus()
    }
    document.addEventListener('keydown', handleKeyDown, true)
    return () => {
      window.cancelAnimationFrame(focusFirst)
      document.removeEventListener('keydown', handleKeyDown, true)
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
        previousFocus.focus()
      }
    }
  }, [dialogRef])
}
