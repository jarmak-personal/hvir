export function sessionsProjectionNonNegativeInteger(
  value: number | undefined,
): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined
}

export function sessionsProjectionPercent(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : undefined
}

export function sessionsProjectionTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}
