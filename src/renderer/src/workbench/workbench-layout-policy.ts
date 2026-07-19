import { PANE_DIVIDER_SIZE } from '../layout/split-layout-policy'

const VIEWER_MIN_HEIGHT = 180
const TERMINAL_MIN_HEIGHT = 160

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function fitTerminalHeight(height: number, workbenchHeight: number): number {
  const max = Math.max(
    TERMINAL_MIN_HEIGHT,
    workbenchHeight - PANE_DIVIDER_SIZE - VIEWER_MIN_HEIGHT,
  )
  return clamp(height, TERMINAL_MIN_HEIGHT, max)
}
