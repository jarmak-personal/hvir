import { describe, expect, it } from 'vitest'
import {
  capacityTerminalMeasurement,
  validCapacityTerminalObservation,
  type CapacityTerminalScrollProof,
} from '../src/main/smoke/capacity-terminal-measurement'

function sample(engine: 'web' | 'native') {
  const grant = {
    viewId: 'current-view',
    nativeEpoch: 'retained-epoch',
    attachment: 2,
    geometrySerial: 7,
  }
  const stateProof: CapacityTerminalScrollProof =
    engine === 'web'
      ? { engine, viewportY: 24, expectedViewportY: 24 }
      : {
          engine,
          sequence: 11,
          requestedMutation: 61,
          ioAppliedMutation: 62,
          frameSnapshotMutation: 61,
          ...grant,
          frameGeometrySerial: 7,
        }
  return {
    startedAtMs: 100,
    firstMatchingVisibleFrameAtMs: 110,
    stateCheckedAtMs: 120,
    captured: { requestedAtMs: 125, completedAtMs: 140 },
    layout: { engine, columns: 102, rows: 24, ...(engine === 'native' ? grant : {}) },
    tag: { row: 2953, sequence: 0, columns: 102, rows: 24 },
    expectedTag: { row: 2953, sequence: 0, columns: 102, rows: 24 },
    expectedViewport: { columns: 102, rows: 24 },
    expectedInputSequence: 11,
    observedInputSequence: 11,
    stateProof,
  }
}
const parsed = (value: unknown): Record<string, unknown> =>
  JSON.parse(JSON.stringify(value)) as Record<string, unknown>

describe('fixture measurement process JSON boundary', () => {
  it.each(['web', 'native'] as const)(
    'retains %s actual clocks, current grant and state witnesses through process JSON',
    (engine) => {
      const observed = sample(engine)
      const process = {
        measurements: { scroll: [capacityTerminalMeasurement(observed, 0)] },
      }
      const wire = JSON.parse(JSON.stringify(process)) as typeof process
      const measurement = wire.measurements.scroll[0]!
      expect(measurement.durationMs).toBe(40)
      expect(measurement.terminalObservation).toEqual({
        startedAtMs: 100,
        firstMatchingVisibleFrameAtMs: 110,
        stateCheckedAtMs: 120,
        captureRequestedAtMs: 125,
        captureCompletedAtMs: 140,
        layout: observed.layout,
        stateProof: observed.stateProof,
      })
      expect(validCapacityTerminalObservation(parsed(measurement), engine, true)).toBe(
        true,
      )
    },
  )
  it('keeps non-scroll observations without inventing state proof', () => {
    const { stateProof: _proof, ...value } = sample('native')
    const measurement = parsed(capacityTerminalMeasurement(value, 0))
    expect(validCapacityTerminalObservation(measurement, 'native', false)).toBe(true)
    expect(validCapacityTerminalObservation(measurement, 'native', true)).toBe(false)
  })
  it.each([
    ['firstMatchingVisibleFrameAtMs', 99],
    ['firstMatchingVisibleFrameAtMs', 141],
    ['stateCheckedAtMs', 99],
    ['stateCheckedAtMs', 126],
    ['captureRequestedAtMs', 141],
    ['captureCompletedAtMs', 139],
    ['startedAtMs', 101],
  ])('refuses missing/inconsistent clock %s', (field, value) => {
    const measurement = parsed(capacityTerminalMeasurement(sample('native'), 0))
    const observation = measurement.terminalObservation as Record<string, unknown>
    observation[field] = value
    expect(validCapacityTerminalObservation(measurement, 'native', true)).toBe(false)
    delete observation[field]
    expect(validCapacityTerminalObservation(measurement, 'native', true)).toBe(false)
  })
  it.each([
    ['sequence', 12],
    ['requestedMutation', 0],
    ['ioAppliedMutation', 60],
    ['frameSnapshotMutation', 60],
    ['viewId', 'old-view'],
    ['nativeEpoch', 'old-epoch'],
    ['attachment', 1],
    ['geometrySerial', 6],
    ['frameGeometrySerial', 6],
  ])('refuses native state mismatch %s', (field, value) => {
    const measurement = parsed(capacityTerminalMeasurement(sample('native'), 0))
    const observation = measurement.terminalObservation as Record<string, unknown>
    const proof = observation.stateProof as Record<string, unknown>
    proof[field] = value
    expect(validCapacityTerminalObservation(measurement, 'native', true)).toBe(false)
  })
  it('refuses rounded web state despite matching visible tag', () => {
    const measurement = parsed(capacityTerminalMeasurement(sample('web'), 0))
    const observation = measurement.terminalObservation as Record<string, unknown>
    const proof = observation.stateProof as Record<string, unknown>
    proof.viewportY = 23.99
    expect(validCapacityTerminalObservation(measurement, 'web', true)).toBe(false)
  })
})
