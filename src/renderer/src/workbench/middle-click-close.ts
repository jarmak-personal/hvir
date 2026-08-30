interface MiddleButtonEvent {
  readonly button: number
  preventDefault(): void
}

export function guardMiddleClickClosePointerDown(event: MiddleButtonEvent): void {
  if (event.button !== 1) return
  event.preventDefault()
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
}

export function closeOnMiddleClick(event: MiddleButtonEvent, close: () => void): void {
  if (event.button !== 1) return
  event.preventDefault()
  close()
}
