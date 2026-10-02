export function compactionMarkerPresentation(count: number): {
  readonly kind: 'empty' | 'summary'
  readonly count: number
} {
  return Number.isSafeInteger(count) && count > 0
    ? { kind: 'summary', count }
    : { kind: 'empty', count: 0 }
}
