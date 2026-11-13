/** M7 preview housekeeping on the designated engine caller, never effect policy.
 * ABI4 owns 128 FIFO records and two latest-value slots; no payload leaves here. */
export function discardNativeTerminalEffects(next: () => { result: number }): {
  result: number
  discarded: number
} {
  for (let discarded = 0; discarded <= 130; discarded++) {
    const event = next()
    if (event.result === 6) return { result: 0, discarded }
    if (event.result !== 0) return { result: event.result, discarded }
  }
  return { result: 5, discarded: 131 }
}
