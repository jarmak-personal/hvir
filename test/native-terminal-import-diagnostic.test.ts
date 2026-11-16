import { describe, expect, it } from 'vitest'
import { nativeReceiverDiagnosticLine } from '../src/main/smoke/native-terminal-import-diagnostic'

const prefix = 'HVIR_NATIVE_RECEIVER_STAGE '
const event = {
  schema: 1,
  event: 1,
  clock: 'renderer performance.now',
  atMs: 5,
  timeOrigin: 100,
  stage: 'receiver-entry',
  resource: 1,
  truncated: false,
  timelineDisabled: false,
  grant: {
    viewId: '00000000-0000-4000-8000-000000000001',
    nativeEpoch: '00000000-0000-4000-8000-000000000002',
    attachment: 1,
    geometrySerial: 1,
    width: 800,
    height: 600,
    backingScale: 2,
  },
}

describe('selected native receiver diagnostic collection', () => {
  it('projects only bounded stage/clock/grant facts from console evidence', () => {
    const line = nativeReceiverDiagnosticLine(
      prefix +
        JSON.stringify({
          ...event,
          transcript: 'private-terminal-body',
          grant: { ...event.grant, privatePath: '/private/credential' },
        }),
    )
    expect(line).toBe(prefix + JSON.stringify(event))
    expect(line).not.toContain('private')
  })

  it.each([
    { ...event, stage: 'private-terminal-body' },
    { ...event, timeOrigin: null },
    { ...event, resource: 0 },
    { ...event, clock: 'arbitrary' },
    { ...event, grant: { ...event.grant, viewId: 'unqualified' } },
  ])('refuses invalid stage identity and clocks', (value) => {
    expect(nativeReceiverDiagnosticLine(prefix + JSON.stringify(value))).toBeUndefined()
  })

  it('ignores unrelated, oversized and malformed console text', () => {
    for (const message of [
      'private-terminal-body',
      prefix + '{',
      prefix + 'x'.repeat(2048),
    ])
      expect(nativeReceiverDiagnosticLine(message)).toBeUndefined()
  })
})
