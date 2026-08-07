export interface TerminalMenuPoint {
  readonly x: number
  readonly y: number
}

export interface TerminalMenuSize {
  readonly width: number
  readonly height: number
}

const VIEWPORT_MARGIN = 8

export function boundTerminalContextMenuPosition(
  anchor: TerminalMenuPoint,
  viewport: TerminalMenuSize,
  menu: TerminalMenuSize,
): TerminalMenuPoint {
  return {
    x: Math.max(
      VIEWPORT_MARGIN,
      Math.min(anchor.x, viewport.width - menu.width - VIEWPORT_MARGIN),
    ),
    y: Math.max(
      VIEWPORT_MARGIN,
      Math.min(anchor.y, viewport.height - menu.height - VIEWPORT_MARGIN),
    ),
  }
}
