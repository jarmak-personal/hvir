export interface SessionsTerminalOverlayOrigin {
  readonly top: number
  readonly right: number
  readonly bottom: number
  readonly left: number
}

export function sessionsTerminalOverlayOrigin(
  element: HTMLElement | undefined,
): SessionsTerminalOverlayOrigin | undefined {
  if (!element) return undefined
  const bounds = element.getBoundingClientRect()
  return {
    top: bounds.top,
    right: bounds.right,
    bottom: bounds.bottom,
    left: bounds.left,
  }
}
