import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import type { NativeTerminalStatus } from '../src/shared/native-terminal'
import type { NativeTerminalApplication } from '../src/main/terminal/native-terminal-application'
import type { PtySupervisor } from '../src/main/pty/pty-supervisor'
import { NativeTerminalPresentationTargets } from '../src/main/terminal/native-terminal-presentation-target'
import {
  assertNativeCapacityIdentity,
  assertNativeCapacityStatus,
  createNativeCapacityTerminals,
  verifyNativeCapacityActivity,
  type NativeCapacitySample,
} from '../src/main/smoke/capacity-native-terminals'

vi.mock('electron', () => ({ app: {}, clipboard: {} }))

function samples(): NativeCapacitySample[] {
  return Array.from({ length: 12 }, (_, index) => ({
    sessionId: `session-${index}`,
    instanceId: `instance-${index}`,
    handle: `handle-${index}`,
    viewId: randomUUID(),
    visible: index === 0,
    canvases: index === 0 ? 1 : 0,
    currentDrawnGrant: index === 0,
    receiverDraws: index === 0 ? 10 : 0,
    appliedSequence: 10,
    appearanceSerial: 1,
    semanticRegions: 256,
    semanticRegionLimit: 256,
    delivery: {
      nativeDataEvents: 20,
      deliveryCallbacks: 4,
      receivedBytes: 1000,
      deliveredBytes: 1000,
      peakBufferedBytes: 4096,
      bufferedBytes: 0,
      presentation: index === 0 ? 'visible' : 'hidden',
      pending: false,
    },
  }))
}
function loaded(before: readonly NativeCapacitySample[]): NativeCapacitySample[] {
  return before.map((item) => ({
    ...item,
    appliedSequence: item.appliedSequence + 10,
    receiverDraws: item.receiverDraws + (item.visible ? 5 : 0),
    delivery: {
      ...item.delivery,
      nativeDataEvents: item.delivery.nativeDataEvents + 20,
      deliveryCallbacks: item.delivery.deliveryCallbacks + 5,
    },
  }))
}
const fixtureIds = Array.from({ length: 11 }, (_, index) => `session-${index + 1}`)

function status(): NativeTerminalStatus {
  return {
    failure: 0,
    inputFailure: 0,
    presentationFailure: 0,
    geometryFailureSerial: 0,
    appearanceFailureSerial: 0,
    closing: false,
    appliedSequence: 10,
    appliedAppearanceSerial: 1,
    ioAppliedSequence: 10,
    ioAppliedMutation: 10,
    replySequence: 0,
    queuedReplyBytes: 0,
    rendererHealth: 0,
    frameCopies: 0,
    geometry: {
      serial: 1,
      columns: 80,
      rows: 24,
      width: 800,
      height: 480,
      cellWidth: 10,
      cellHeight: 20,
      contentWidth: 800,
      contentHeight: 480,
      paddingLeft: 0,
      paddingTop: 0,
      backingScale: 1,
    },
  }
}

describe('native capacity observation at parser and actual receiver ownership', () => {
  it('distinguishes native hidden parsing from accepted visible receiver submission', () => {
    const before = samples(),
      after = loaded(before)
    expect(verifyNativeCapacityActivity(before, after, fixtureIds)).toEqual({
      engine: 'native',
      hiddenPanes: 11,
      hiddenAppliedSequenceDelta: 110,
      hiddenReceiverDrawDelta: 0,
      visibleReceiverDrawDelta: 5,
      nativeDataEvents: 240,
      deliveryCallbacks: 60,
      peakBufferedBytes: 4096,
      semanticCapExercised: true,
      physicalReclamationQualified: false,
    })
  })
  it.each(['mounted-canvas', 'current-grant', 'receiver-draw'])(
    'refuses hidden presentation work from %s',
    (kind) => {
      const before = samples(),
        after = loaded(before)
      const hidden = after[1]!
      if (kind === 'mounted-canvas') after[1] = { ...hidden, canvases: 1 }
      if (kind === 'current-grant') after[1] = { ...hidden, currentDrawnGrant: true }
      if (kind === 'receiver-draw') after[1] = { ...hidden, receiverDraws: 1 }
      expect(() => verifyNativeCapacityActivity(before, after, fixtureIds)).toThrow(
        'hidden-consumer-work',
      )
    },
  )
  it('requires real hidden source progress and visible receiver progress', () => {
    const before = samples(),
      after = loaded(before)
    after[1] = { ...after[1]!, appliedSequence: before[1]!.appliedSequence }
    expect(() => verifyNativeCapacityActivity(before, after, fixtureIds)).toThrow(
      'hidden-parser-stalled',
    )
    after[1] = loaded(before)[1]!
    after[0] = { ...after[0]!, receiverDraws: before[0]!.receiverDraws }
    expect(() => verifyNativeCapacityActivity(before, after, fixtureIds)).toThrow(
      'visible-submission-stalled',
    )
  })
  it('preserves twelve exact instances and rejects duplicate IDs or replaced native state', () => {
    const before = samples(),
      after = loaded(before)
    after[1] = { ...after[1]!, handle: 'replacement' }
    expect(() => assertNativeCapacityIdentity(before, after)).toThrow(
      'retained-state-replaced',
    )
    after[1] = { ...after[0]! }
    expect(() => assertNativeCapacityIdentity(before, after)).toThrow(
      'retained-state-replaced',
    )
  })
  it('requires actual coalescing, delivery bounds and exercised semantic retention', () => {
    const before = samples(),
      after = loaded(before)
    after[1] = { ...after[1]!, semanticRegions: 255 }
    expect(() => verifyNativeCapacityActivity(before, after, fixtureIds)).toThrow(
      'semantic-cap-not-exercised',
    )
    after[1] = loaded(before)[1]!
    after[1] = {
      ...after[1],
      delivery: { ...after[1].delivery, peakBufferedBytes: 65537 },
    }
    expect(() => verifyNativeCapacityActivity(before, after, fixtureIds)).toThrow(
      'delivery-byte-bound',
    )
    const uncoalesced = after.map((item, index) => ({
      ...item,
      delivery: {
        ...item.delivery,
        peakBufferedBytes: 4096,
        deliveryCallbacks: before[index]!.delivery.deliveryCallbacks + 20,
      },
    }))
    expect(() => verifyNativeCapacityActivity(before, uncoalesced, fixtureIds)).toThrow(
      'delivery-not-coalesced',
    )
  })
  it('rejects invalid or regressed observation fields instead of passing NaN comparisons', () => {
    const before = samples(),
      after = loaded(before)
    after[2] = { ...after[2]!, appliedSequence: NaN }
    expect(() => verifyNativeCapacityActivity(before, after, fixtureIds)).toThrow(
      'observation-invalid',
    )
    after[2] = { ...loaded(before)[2]!, appliedSequence: 1 }
    expect(() => verifyNativeCapacityActivity(before, after, fixtureIds)).toThrow(
      'counter-regressed',
    )
  })
  it.each([
    'failure',
    'inputFailure',
    'presentationFailure',
    'geometryFailureSerial',
    'appearanceFailureSerial',
  ] as const)('does not qualify a native state carrying %s', (field) => {
    expect(() => assertNativeCapacityStatus({ ...status(), [field]: 1 })).toThrow(
      'state-failed',
    )
  })
  it('counts only acknowledgements for a live exact issued grant and restores adapters on dispose', async () => {
    const view = samples(),
      targets = new NativeTerminalPresentationTargets()
    const originalCreate: unknown = Reflect.get(targets, 'create'),
      originalAck: unknown = Reflect.get(targets, 'acknowledge')
    const frame = {
      send: vi.fn(),
      isDestroyed: () => false,
    } as unknown as BrowserWindow['webContents']['mainFrame']
    const win = {
      webContents: {
        mainFrame: frame,
        executeJavaScript: vi.fn(() => Promise.resolve(view)),
      },
    } as unknown as BrowserWindow
    const terminals = view.map((item) => ({
      id: item.sessionId,
      instanceId: item.instanceId,
      ownerId: 1,
      ownerGeneration: 1,
    }))
    const supervisor = {
      get: (id: string) => terminals.find((item) => item.id === id),
    } as unknown as PtySupervisor
    const native = {
      targets,
      sessions: {
        get: (id: string) => {
          const item = view.find((item) => item.sessionId === id)
          return item && { handle: item.handle, session: { instanceId: item.instanceId } }
        },
      },
      inspectRetained: () => Promise.resolve(status()),
    } as unknown as NativeTerminalApplication
    const adapter = createNativeCapacityTerminals(win, supervisor, native)
    try {
      const target = targets.create(
        frame,
        () => true,
        () => true,
      )
      const grant = {
        viewId: view[0]!.viewId,
        attachment: 1,
        nativeEpoch: randomUUID(),
        geometrySerial: 1,
        width: 800,
        height: 480,
        backingScale: 1,
      }
      target.publishGrant(grant)
      targets.acknowledge(frame, { kind: 'drawn', screen: 0, grant })
      expect((await adapter.snapshot())[0]!.receiverDraws).toBe(1)
      // An earlier accepted draw must not make a later rejected ACK look accepted.
      targets.acknowledge(frame, {
        kind: 'drawn',
        screen: 0,
        grant: { ...grant, attachment: 2 },
      })
      targets.acknowledge(frame, { kind: 'drawn', screen: 2, grant })
      expect((await adapter.snapshot())[0]!.receiverDraws).toBe(1)
      target.publishGrant(undefined)
      targets.acknowledge(frame, { kind: 'drawn', screen: 0, grant })
      expect((await adapter.snapshot())[0]!.receiverDraws).toBe(1)
      expect((await adapter.snapshot())[0]!.currentDrawnGrant).toBe(false)
    } finally {
      adapter.dispose()
    }
    expect(Reflect.get(targets, 'create')).toBe(originalCreate)
    expect(Reflect.get(targets, 'acknowledge')).toBe(originalAck)
  })
})
