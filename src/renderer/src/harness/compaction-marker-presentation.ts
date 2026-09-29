export const DEFAULT_COMPACTION_MARKER_PITCH = 10

export function compactionMarkerPresentation(
  count: number,
  availableWidth: number,
  markerPitch = DEFAULT_COMPACTION_MARKER_PITCH,
): { readonly kind: 'empty' | 'circles' | 'summary'; readonly count: number } {
  if (!Number.isSafeInteger(count) || count <= 0) return { kind: 'empty', count: 0 }
  return count * Math.max(0, markerPitch) <= Math.max(0, availableWidth)
    ? { kind: 'circles', count }
    : { kind: 'summary', count }
}
