export function nextModalFocusIndex(
  current: number,
  count: number,
  backwards: boolean,
): number | undefined {
  if (count === 0) return undefined
  if (backwards) return current <= 0 ? count - 1 : current - 1
  return current < 0 || current === count - 1 ? 0 : current + 1
}
