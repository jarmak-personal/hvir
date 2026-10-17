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
      if (!activeRef.current || topmostModal() !== dialog) return
      const preferred = dialog.querySelector<HTMLElement>(
        '[data-modal-initial], [autofocus]',
      )
      const first = dialog.querySelector<HTMLElement>(focusableSelector)
      ;(preferred ?? first ?? dialog).focus()
    })
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (!activeRef.current || topmostModal() !== dialog) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopImmediatePropagation()
        if (enabledRef.current) dismissRef.current()
        return
      }
      if (event.key !== 'Tab') return
      event.stopImmediatePropagation()
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
      const remaining = topmostModal()
      if (
        previousFocus instanceof HTMLElement &&
        previousFocus.isConnected &&
        (!remaining || remaining.contains(previousFocus))
      ) {
        previousFocus.focus()
      }
    }
  }, [dialogRef])
}

/** Shared backdrop siblings paint in DOM order; nested dialogs remain within that stack. */
function topmostModal(): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]')]
    .filter((dialog) => !dialog.hidden)
    .at(-1)
}
