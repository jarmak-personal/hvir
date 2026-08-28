export interface SessionsTerminalOverlayOrigin {
  readonly x: number
  readonly y: number
}

export function sessionsTerminalOverlayOrigin(
  element: HTMLElement | undefined,
): SessionsTerminalOverlayOrigin | undefined {
  if (!element) return undefined
  const bounds = element.getBoundingClientRect()
  return {
    x: bounds.left + bounds.width / 2,
    y: bounds.top + bounds.height / 2,
  }
}
