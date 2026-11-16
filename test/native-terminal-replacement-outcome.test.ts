import { describe, expect, it } from 'vitest'
import {
  qualifyNativeReplacement,
  type NativeReplacementExpected,
  type NativeReplacementSnapshot,
} from '../src/main/smoke/native-terminal-replacement-outcome'

type Snapshot = NativeReplacementSnapshot
type Observations = NonNullable<NonNullable<Snapshot['presentation']>['observations']>
type Event = NonNullable<Observations['currentView']>[number]
const expected: NativeReplacementExpected = {
  sessionId: 'session',
  instanceId: 'instance',
  pid: 123,
  handle: 'native-handle',
  ownerId: 1,
  previousOwnerGeneration: 1,
  providerId: 'captured-provider',
  profileId: 'captured-profile',
  workspaceRoot: { hostId: 'host-a', path: '/repo' },
}

/** The observed 2ed causal sequence with opaque fixture identities. This test
 * classifies receipts; existing real owner tests qualify late quarantine physics. */
function loss(): Snapshot {
  const viewId = 'replacement-view'
  return {
    recoveryDecision: true,
    owner: { id: 1, generation: 2 },
    retained: {
      id: expected.sessionId,
      instanceId: expected.instanceId,
      pid: expected.pid,
      ownerId: 1,
      ownerGeneration: 2,
      providerId: expected.providerId,
      profileId: expected.profileId,
      workspaceRoot: { ...expected.workspaceRoot },
    },
    native: {
      handle: expected.handle,
      instanceId: expected.instanceId,
      ownerId: 1,
      ownerGeneration: 2,
      workspaceRoot: { ...expected.workspaceRoot },
      retiring: false,
      unavailable: false,
      inputUnavailable: false,
      inputClosed: false,
      readonly: false,
    },
    presentation: {
      viewId,
      drawn: null,
      observations: {
        startedBeforeReload: true,
        total: 77,
        truncated: false,
        readFailed: false,
        mainSendIsNotReceiverDelivery: true,
        unboundRetained: 2,
        otherViewRetained: 4,
        demandSummary: {
          started: 33,
          fulfilled: 33,
          trueResults: 0,
          falseResults: 33,
          scope: 'all-observed',
        },
        currentView: [
          {
            operation: 'update',
            state: 'started',
            viewId,
            ownerId: 1,
            ownerGeneration: 2,
            visible: true,
            sequence: 9,
          },
          {
            operation: 'grant',
            state: 'returned',
            viewId,
            target: 1,
            frameCurrent: true,
            issued: true,
            refit: false,
            attachment: 2,
            nativeEpoch: 'same-native-epoch',
            geometrySerial: 8,
            sequence: 11,
          },
          {
            operation: 'update',
            state: 'fulfilled',
            viewId,
            ownerId: 1,
            ownerGeneration: 2,
            visible: true,
            sequence: 12,
          },
          {
            operation: 'grant',
            state: 'returned',
            viewId,
            target: 1,
            frameCurrent: true,
            issued: false,
            refit: false,
            sequence: 75,
          },
          {
            operation: 'status',
            state: 'returned',
            viewId,
            target: 1,
            frameCurrent: true,
            mode: 'unavailable',
            reason: 'import-unavailable',
            sequence: 76,
          },
        ],
      },
    },
    dom: {
      hasCanvas: false,
      canvasCount: 0,
      dialogPresent: false,
      restorePresent: false,
      restoreDisabled: null,
      panes: [
        {
          viewId: 'native-terminal-' + viewId,
          sessionId: expected.sessionId,
          connected: true,
          paneUnavailable: false,
          surfaceUnavailable: true,
          inputDisabled: false,
          canvasPresent: false,
        },
      ],
    },
  }
}
function events(
  snapshot: Snapshot,
  change: (value: readonly Event[]) => readonly Event[],
): Snapshot {
  const presentation = snapshot.presentation!,
    observations = presentation.observations!
  return {
    ...snapshot,
    presentation: {
      ...presentation,
      observations: { ...observations, currentView: change(observations.currentView!) },
    },
  }
}
function event(snapshot: Snapshot, index: number, patch: Partial<Event>): Snapshot {
  return events(snapshot, (values) =>
    values.map((value, i) => (i === index ? { ...value, ...patch } : value)),
  )
}
function observation(snapshot: Snapshot, patch: Partial<Observations>): Snapshot {
  return {
    ...snapshot,
    presentation: {
      ...snapshot.presentation,
      observations: { ...snapshot.presentation!.observations, ...patch },
    },
  }
}
function pane(
  snapshot: Snapshot,
  patch: Partial<NonNullable<NonNullable<Snapshot['dom']>['panes']>[number]>,
): Snapshot {
  return {
    ...snapshot,
    dom: { ...snapshot.dom, panes: [{ ...snapshot.dom!.panes![0], ...patch }] },
  }
}
function drawn(): Snapshot {
  const snapshot = loss()
  return events(
    {
      ...pane(snapshot, { canvasPresent: true, surfaceUnavailable: false }),
      presentation: {
        ...snapshot.presentation,
        drawn: { screen: 0, geometrySerial: 8 },
        issuedGrant: {
          viewId: 'replacement-view',
          target: 1,
          frameCurrent: true,
          attachment: 2,
          nativeEpoch: 'same-native-epoch',
          geometrySerial: 8,
        },
      },
    },
    (values) => values.slice(0, 3),
  )
}
const classify = (snapshot: Snapshot) => qualifyNativeReplacement(expected, snapshot)

describe('native replacement closed qualification outcomes', () => {
  it('classifies only the complete exact-view loss sequence and current drawn branch', () => {
    expect(classify(loss())).toBe('quarantined')
    expect(classify(drawn())).toBe('drawn')
    expect(classify({})).toBeUndefined()
  })

  it('does not make healthy current drawing depend on loss-only ring completeness', () => {
    expect(
      classify(
        observation(drawn(), {
          truncated: true,
          readFailed: true,
          startedBeforeReload: false,
          total: undefined,
          currentView: undefined,
        }),
      ),
    ).toBe('drawn')
  })

  it('accepts an explicitly absent captured profile without inventing one', () => {
    const snapshot = loss()
    expect(
      qualifyNativeReplacement(
        { ...expected, profileId: null },
        {
          ...snapshot,
          retained: { ...snapshot.retained, profileId: null },
        },
      ),
    ).toBe('quarantined')
    expect(
      classify({ ...snapshot, retained: { ...snapshot.retained, profileId: undefined } }),
    ).toBeUndefined()
  })

  it.each([
    ['session id', { id: 'replacement' }],
    ['instance id', { instanceId: 'replacement' }],
    ['PID', { pid: 124 }],
    ['owner id', { ownerId: 2 }],
    ['owner generation', { ownerGeneration: 1 }],
    ['provider', { providerId: 'other-provider' }],
    ['profile', { profileId: 'other-profile' }],
    ['host', { workspaceRoot: { hostId: 'host-b', path: '/repo' } }],
    ['path', { workspaceRoot: { hostId: 'host-a', path: '/other' } }],
  ] as const)('refuses different retained %s', (_label, patch) => {
    const snapshot = loss()
    expect(
      classify({ ...snapshot, retained: { ...snapshot.retained, ...patch } }),
    ).toBeUndefined()
  })

  it.each([
    ['handle', { handle: 'replacement' }],
    ['instance', { instanceId: 'replacement' }],
    ['owner', { ownerId: 2 }],
    ['generation', { ownerGeneration: 1 }],
    ['host', { workspaceRoot: { hostId: 'host-b', path: '/repo' } }],
    ['path', { workspaceRoot: { hostId: 'host-a', path: '/other' } }],
  ] as const)('refuses different native %s', (_label, patch) => {
    const snapshot = loss()
    expect(
      classify({ ...snapshot, native: { ...snapshot.native, ...patch } }),
    ).toBeUndefined()
  })

  it.each([
    'retiring',
    'unavailable',
    'inputUnavailable',
    'inputClosed',
    'readonly',
  ] as const)('requires explicit healthy native %s in both branches', (field) => {
    for (const snapshot of [loss(), drawn()]) {
      expect(
        classify({ ...snapshot, native: { ...snapshot.native, [field]: true } }),
      ).toBeUndefined()
      expect(
        classify({ ...snapshot, native: { ...snapshot.native, [field]: undefined } }),
      ).toBeUndefined()
    }
  })

  it.each([{ id: 2, generation: 2 }, { id: 1, generation: 1 }, { id: 1 }])(
    'refuses a wrong or incomplete current owner %j',
    (owner) => {
      expect(classify({ ...loss(), owner })).toBeUndefined()
    },
  )

  it.each([
    { connected: false },
    { connected: undefined },
    { paneUnavailable: true },
    { paneUnavailable: undefined },
    { inputDisabled: true },
    { inputDisabled: undefined },
    { viewId: 'native-terminal-other-view' },
  ])('refuses unsafe pane metadata %j', (patch) => {
    expect(classify(pane(loss(), patch))).toBeUndefined()
    expect(classify(pane(drawn(), patch))).toBeUndefined()
  })

  it('does not use an unrelated global canvas or ambiguous duplicate pane as current evidence', () => {
    expect(
      classify(
        pane(
          { ...drawn(), dom: { ...drawn().dom, hasCanvas: true, canvasCount: 1 } },
          {
            canvasPresent: false,
          },
        ),
      ),
    ).toBeUndefined()
    const snapshot = loss()
    expect(
      classify({
        ...snapshot,
        dom: {
          ...snapshot.dom,
          panes: [...snapshot.dom!.panes!, ...snapshot.dom!.panes!],
        },
      }),
    ).toBeUndefined()
    expect(classify(pane(loss(), { canvasPresent: undefined }))).toBeUndefined()
  })

  it.each([
    { startedBeforeReload: false },
    { startedBeforeReload: undefined },
    { truncated: true },
    { truncated: undefined },
    { readFailed: true },
    { readFailed: undefined },
    { currentView: undefined },
    { total: undefined },
  ])('does not classify incomplete loss observation %j', (patch) => {
    expect(classify(observation(loss(), patch))).toBeUndefined()
  })

  it.each([0, 1, 2, 3, 4])(
    'requires causal event %s rather than an incomplete subsequence',
    (index) => {
      expect(
        classify(events(loss(), (values) => values.filter((_value, i) => i !== index))),
      ).toBeUndefined()
    },
  )

  it.each([
    'native-lost',
    'renderer-lost',
    'pixel-bound',
    'geometry-failed',
    'unknown',
    undefined,
  ])('does not accept unavailable reason %s as import quarantine', (reason) => {
    expect(classify(event(loss(), 4, { reason }))).toBeUndefined()
  })

  it.each([
    { target: 2 },
    { target: undefined },
    { frameCurrent: false },
    { frameCurrent: undefined },
    { state: 'threw' },
    { state: undefined },
    { viewId: 'old-view' },
    { mode: 'native-pixels' },
  ])('requires the returned current target loss status %j', (patch) => {
    expect(classify(event(loss(), 4, patch))).toBeUndefined()
  })

  it.each([
    { target: 0 },
    { target: undefined },
    { attachment: 0 },
    { attachment: undefined },
    { geometrySerial: 0 },
    { geometrySerial: undefined },
    { nativeEpoch: '' },
    { nativeEpoch: undefined },
    { frameCurrent: false },
    { state: 'threw' },
    { viewId: 'old-view' },
  ])('requires qualified issued grant %j', (patch) => {
    expect(classify(event(loss(), 1, patch))).toBeUndefined()
  })

  it.each([
    { target: 0 },
    { target: undefined },
    { attachment: 0 },
    { attachment: undefined },
    { nativeEpoch: '' },
    { nativeEpoch: undefined },
    { frameCurrent: false },
    { frameCurrent: undefined },
    { viewId: 'old-view' },
    { viewId: undefined },
    { geometrySerial: 7 },
    { geometrySerial: undefined },
  ])('requires dedicated current drawn-grant scope %j', (patch) => {
    const snapshot = drawn()
    expect(
      classify({
        ...snapshot,
        presentation: {
          ...snapshot.presentation,
          issuedGrant: { ...snapshot.presentation!.issuedGrant, ...patch },
        },
      }),
    ).toBeUndefined()
  })

  it.each([
    { target: 2 },
    { frameCurrent: false },
    { state: 'threw' },
    { issued: true },
    { issued: undefined },
  ])('requires current target withdrawal %j before the loss status', (patch) => {
    expect(classify(event(loss(), 3, patch))).toBeUndefined()
  })

  it.each([0, 2])('requires exact current-owner visible update at event%s', (index) => {
    for (const patch of [
      { ownerId: 2 },
      { ownerGeneration: 1 },
      { visible: false },
      { visible: undefined },
    ])
      expect(classify(event(loss(), index, patch))).toBeUndefined()
  })

  it('refuses out-of-order, duplicate, or unaccounted event sequence numbers', () => {
    expect(classify(event(loss(), 4, { sequence: 75 }))).toBeUndefined()
    expect(classify(event(loss(), 4, { sequence: 78 }))).toBeUndefined()
    expect(classify(event(loss(), 2, { sequence: 10 }))).toBeUndefined()
    expect(classify(event(loss(), 1, { sequence: undefined }))).toBeUndefined()
  })

  it.each([
    {
      label: 'geometry update rejection',
      detail: {
        operation: 'update',
        state: 'rejected',
        ownerId: 1,
        ownerGeneration: 2,
        visible: true,
        error: 'native-geometry-failed',
      },
    },
    {
      label: 'demand rejection',
      detail: {
        operation: 'demand',
        state: 'rejected',
        ownerId: 1,
        ownerGeneration: 2,
        error: 'other',
      },
    },
    {
      label: 'earlier renderer loss',
      detail: {
        operation: 'status',
        state: 'returned',
        target: 1,
        frameCurrent: true,
        mode: 'unavailable',
        reason: 'renderer-lost',
      },
    },
  ])('does not let quarantine mask $label in the same current view', ({ detail }) => {
    const mixed = events(loss(), (values) => [
      ...values.slice(0, 3),
      { ...detail, viewId: 'replacement-view', sequence: 13 },
      ...values.slice(3),
    ])
    expect(classify(mixed)).toBeUndefined()
  })

  it.each([
    {
      label: 'wrong-owner demand',
      detail: { operation: 'demand', state: 'fulfilled', ownerId: 2, ownerGeneration: 2 },
    },
    {
      label: 'wrong-generation update',
      detail: {
        operation: 'update',
        state: 'fulfilled',
        ownerId: 1,
        ownerGeneration: 1,
        visible: true,
      },
    },
    {
      label: 'wrong-frame status',
      detail: {
        operation: 'status',
        state: 'returned',
        target: 1,
        frameCurrent: false,
        mode: 'native-gpu',
      },
    },
    {
      label: 'wrong-target status',
      detail: {
        operation: 'status',
        state: 'returned',
        target: 2,
        frameCurrent: true,
        mode: 'native-gpu',
      },
    },
    {
      label: 'wrong-target grant',
      detail: {
        operation: 'grant',
        state: 'returned',
        target: 2,
        frameCurrent: true,
        issued: false,
      },
    },
    {
      label: 'unknown operation',
      detail: {
        operation: 'unknown',
        state: 'fulfilled',
        ownerId: 1,
        ownerGeneration: 2,
      },
    },
  ])('rejects an extra $label despite an otherwise complete loss chain', ({ detail }) => {
    expect(
      classify(
        events(loss(), (values) => [
          ...values.slice(0, 3),
          { ...detail, viewId: 'replacement-view', sequence: 13 },
          ...values.slice(3),
        ]),
      ),
    ).toBeUndefined()
  })

  it.each([false, undefined])(
    'requires the loss receipt legend to be explicitly true, got%s',
    (mainSendIsNotReceiverDelivery) => {
      expect(
        classify(observation(loss(), { mainSendIsNotReceiverDelivery })),
      ).toBeUndefined()
    },
  )

  it('bounds the complete loss event array to the existing observer capacity', () => {
    const padded = (count: number) =>
      events(loss(), (values) => [
        ...values.slice(0, 3),
        ...Array.from({ length: count }, (_value, index) => ({
          operation: 'demand',
          state: 'fulfilled',
          viewId: 'replacement-view',
          ownerId: 1,
          ownerGeneration: 2,
          result: false,
          sequence: 13 + index,
        })),
        ...values.slice(3),
      ])
    expect(classify(padded(27))).toBe('quarantined')
    expect(classify(padded(28))).toBeUndefined()
  })

  it('requires the terminal causal loss event rather than an earlier status before another operation', () => {
    expect(
      classify(
        events(loss(), (values) => [
          ...values,
          {
            operation: 'demand',
            state: 'fulfilled',
            viewId: 'replacement-view',
            ownerId: 1,
            ownerGeneration: 2,
            result: false,
            sequence: 77,
          },
        ]),
      ),
    ).toBeUndefined()
  })

  it('does not turn a raw error label or generic absent canvas into quarantine proof', () => {
    const incomplete = events(loss(), (values) => [
      ...values.slice(0, 3),
      {
        operation: 'demand',
        state: 'rejected',
        viewId: 'replacement-view',
        ownerId: 1,
        ownerGeneration: 2,
        error: 'native-import-quarantined',
        sequence: 76,
      },
    ])
    expect(classify(incomplete)).toBeUndefined()
    expect(classify(pane(incomplete, { surfaceUnavailable: undefined }))).toBeUndefined()
  })

  it('requires explicit absence of current drawing for loss and exact serial for drawing', () => {
    const snapshot = loss()
    expect(
      classify({
        ...snapshot,
        presentation: { ...snapshot.presentation, drawn: undefined },
      }),
    ).toBeUndefined()
    expect(
      classify({
        ...snapshot,
        presentation: {
          ...snapshot.presentation,
          drawn: { screen: 0, geometrySerial: 8 },
        },
      }),
    ).toBeUndefined()
    const healthy = drawn()
    expect(
      classify({
        ...healthy,
        presentation: {
          ...healthy.presentation,
          drawn: { screen: 0, geometrySerial: 7 },
        },
      }),
    ).toBeUndefined()
    expect(classify(events(healthy, () => []))).toBe('drawn')
    expect(
      classify({
        ...healthy,
        presentation: { ...healthy.presentation, issuedGrant: undefined },
      }),
    ).toBeUndefined()
  })
})
