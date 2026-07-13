export interface VirtualRange {
  readonly start: number
  readonly end: number
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
