export interface PresenterHeartbeatPhase {
  readonly phase: string
  readonly epochMs: number
}

/** Probe-only projection of existing samples; no timers, scheduling or acceptance policy. */
export function presenterHeartbeatWindow(
  gaps: readonly number[],
  clock: {
    startedMs: number
    endedMs: number
    timeOriginMs: number
    intervalCount: number
  },
  phases: readonly PresenterHeartbeatPhase[],
) {
  let index = 0,
    elapsedMs = clock.startedMs,
    fromMs = clock.startedMs
  for (let i = 0; i < gaps.length; i++) {
    if (gaps[i]! > gaps[index]!) {
      index = i
      fromMs = elapsedMs
    }
    elapsedMs += gaps[i]!
  }
  const gapMs = gaps[index]!
  // The final partial interval has an actual endpoint even if the existing array cap filled.
  if (index === gaps.length - 1) fromMs = clock.endedMs - gapMs
  const toMs = fromMs + gapMs,
    fromEpochMs = clock.timeOriginMs + fromMs,
    toEpochMs = clock.timeOriginMs + toMs
  return {
    recordingComplete: clock.intervalCount === gaps.length - 1,
    intervalCount: clock.intervalCount,
    startedMs: clock.startedMs,
    endedMs: clock.endedMs,
    timeOriginMs: clock.timeOriginMs,
    worst: {
      index,
      gapMs,
      fromMs,
      toMs,
      fromEpochMs,
      toEpochMs,
      phaseBoundaryIndexesWithinGap: phases
        .slice(0, 32)
        .flatMap((phase, i) =>
          phase.epochMs >= fromEpochMs && phase.epochMs <= toEpochMs ? [i] : [],
        ),
    },
  }
}
