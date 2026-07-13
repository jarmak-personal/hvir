export interface VirtualRange {
  readonly start: number
  readonly end: number
}

export interface VariableVirtualMeasurements {
  /** Top offset for every row plus the total height as the final entry. */
  readonly offsets: readonly number[]
  readonly totalHeight: number
}

/** Pure fixed-row windowing math shared by History, Changes, and detail lists. */
export function virtualRange(
  itemCount: number,
  rowHeight: number,
  scrollTop: number,
  viewportHeight: number,
  overscan: number,
): VirtualRange {
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan)
  const end = Math.min(
    itemCount,
    Math.ceil((scrollTop + viewportHeight) / rowHeight) + overscan,
  )
  return { start, end }
}

/** Windowing for lists whose row types have different, but stable, heights. */
export function measureVariableRows(
  rowHeights: readonly number[],
): VariableVirtualMeasurements {
  const offsets = [0]
  for (const height of rowHeights) {
    offsets.push((offsets.at(-1) ?? 0) + height)
  }
  return {
    offsets,
    totalHeight: offsets[rowHeights.length] ?? 0,
  }
}

export function variableVirtualRange(
  measurements: VariableVirtualMeasurements,
  scrollTop: number,
  viewportHeight: number,
  overscan: number,
): VirtualRange {
  const { offsets } = measurements
  const itemCount = Math.max(0, offsets.length - 1)
  const visibleStart = firstIndex(
    itemCount,
    (index) => (offsets[index + 1] ?? 0) > scrollTop,
  )
  const viewportBottom = scrollTop + viewportHeight
  const visibleEnd = firstIndex(
    itemCount,
    (index) => (offsets[index] ?? 0) >= viewportBottom,
  )
  return {
    start: Math.max(0, visibleStart - overscan),
    end: Math.min(itemCount, visibleEnd + overscan),
  }
}

function firstIndex(itemCount: number, predicate: (index: number) => boolean): number {
  let low = 0
  let high = itemCount
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (predicate(middle)) high = middle
    else low = middle + 1
  }
  return low
}
