interface MiddleButtonEvent {
  readonly button: number
  preventDefault(): void
}

export function suppressMiddleClickDefault(event: MiddleButtonEvent): void {
  if (event.button === 1) event.preventDefault()
}

export function closeOnMiddleClick(event: MiddleButtonEvent, close: () => void): void {
  if (event.button !== 1) return
  event.preventDefault()
  close()
}
