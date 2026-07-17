const MIN_COLS = 2
const MIN_ROWS = 1

export interface TerminalFitBox {
  readonly clientWidth: number
  readonly clientHeight: number
  readonly paddingTop: number
  readonly paddingRight: number
  readonly paddingBottom: number
  readonly paddingLeft: number
  readonly cellWidth: number
  readonly cellHeight: number
}

export interface TerminalFitDimensions {
  readonly cols: number
  readonly rows: number
}

/** Fit the VT grid to the real content box without reserving a DOM scrollbar. */
export function calculateTerminalFit(
  box: TerminalFitBox,
): TerminalFitDimensions | undefined {
  const values = [
    box.clientWidth,
    box.clientHeight,
    box.paddingTop,
    box.paddingRight,
    box.paddingBottom,
    box.paddingLeft,
    box.cellWidth,
    box.cellHeight,
  ]
  if (
    values.some((value) => !Number.isFinite(value)) ||
    box.cellWidth <= 0 ||
    box.cellHeight <= 0
  ) {
    return undefined
  }

  const width = box.clientWidth - box.paddingLeft - box.paddingRight
  const height = box.clientHeight - box.paddingTop - box.paddingBottom
  if (width <= 0 || height <= 0) return undefined

  return {
    cols: Math.max(MIN_COLS, Math.floor(width / box.cellWidth)),
    rows: Math.max(MIN_ROWS, Math.floor(height / box.cellHeight)),
  }
}
