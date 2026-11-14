import { expect, it } from 'vitest'
import { presenterHeartbeatWindow } from '../scripts/native-terminal/presenter-heartbeat.mts'

it('locates an earlier worst sample without blaming the last context-loss phase', () => {
  const phases = [
    { phase: 'attach', epochMs: 1000 },
    { phase: 'scale-1', epochMs: 1100 },
    { phase: 'context-loss', epochMs: 1900 },
  ]
  const sample = presenterHeartbeatWindow(
    [10, 700, 20],
    {
      startedMs: 0,
      endedMs: 730,
      timeOriginMs: 1000,
      intervalCount: 2,
    },
    phases,
  )
  expect(sample).toMatchObject({
    recordingComplete: true,
    worst: {
      index: 1,
      gapMs: 700,
      fromMs: 10,
      toMs: 710,
      fromEpochMs: 1010,
      toEpochMs: 1710,
      phaseBoundaryIndexesWithinGap: [1],
    },
  })
  expect(sample.worst.phaseBoundaryIndexesWithinGap).not.toContain(2)
})

it('keeps the first worst interval on a tie', () => {
  expect(
    presenterHeartbeatWindow(
      [50, 50, 10],
      {
        startedMs: 100,
        endedMs: 210,
        timeOriginMs: 1000,
        intervalCount: 2,
      },
      [],
    ).worst,
  ).toMatchObject({ index: 0, gapMs: 50, fromMs: 100, toMs: 150 })
})

it('uses the actual end for the final partial sample and reports incomplete recording numerically', () => {
  expect(
    presenterHeartbeatWindow(
      [10, 700],
      {
        startedMs: 100,
        endedMs: 5000,
        timeOriginMs: 1000,
        intervalCount: 12002,
      },
      [],
    ),
  ).toMatchObject({
    recordingComplete: false,
    intervalCount: 12002,
    worst: { index: 1, gapMs: 700, fromMs: 4300, toMs: 5000 },
  })
})

it('bounds phase references independently of the unchanged gap sample acceptance', () => {
  const sample = presenterHeartbeatWindow(
    [20, 10],
    {
      startedMs: 0,
      endedMs: 30,
      timeOriginMs: 0,
      intervalCount: 1,
    },
    Array.from({ length: 100 }, (_, i) => ({ phase: 'scale-1', epochMs: i / 10 })),
  )
  expect(sample.worst.phaseBoundaryIndexesWithinGap).toHaveLength(32)
  expect(sample.worst.gapMs).toBe(20)
})
