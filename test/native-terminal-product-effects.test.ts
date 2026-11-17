import { describe, expect, it } from 'vitest'
import { localPath } from '../src/shared/host-path'
import {
  NATIVE_TERMINAL_EFFECT_LIMITS,
  nativeTerminalSemanticPayloadBytes,
  type NativeTerminalProductEvent,
  type NativeTerminalSemanticEffect,
} from '../src/shared/native-terminal-effects'
import {
  publishNativeTerminalEffects,
  type NativeTerminalProductPublication,
} from '../src/main/terminal/native-terminal-product-effects'

function fixture() {
  const session = {
    sessionId: 'session',
    instanceId: 'instance',
    ownerId: 1,
    ownerGeneration: 2,
    workspaceRoot: localPath('/project'),
  }
  const state = {
    session: { ...session },
    retiring: false,
    readonly: false,
    inputClosed: false,
    unavailable: false,
    inputUnavailable: false,
  }
  const flags = { destroyed: false, currentOwner: true, missing: false }
  const sent: NativeTerminalProductEvent[] = []
  const channels: string[] = []
  let duringSend: (() => void) | undefined
  const view = {
    sessionId: session.sessionId,
    instanceId: session.instanceId,
    owner: { id: 1, generation: 2 },
    detaching: undefined as Promise<void> | undefined,
    frame: {
      isDestroyed: () => flags.destroyed,
      send: (channel: string, message: NativeTerminalProductEvent) => {
        channels.push(channel)
        sent.push(message)
        duringSend?.()
      },
    },
  }
  return {
    session,
    state,
    flags,
    view,
    sent,
    channels,
    duringSend: (callback: () => void) => {
      duringSend = callback
    },
    publish: (value: NativeTerminalProductPublication) =>
      publishNativeTerminalEffects(
        session,
        value,
        [view],
        () => (flags.missing ? undefined : state),
        () => flags.currentOwner,
      ),
  }
}
function semantic(serial: number, options = ''): NativeTerminalSemanticEffect {
  return {
    id: 'session',
    instanceId: 'instance',
    eventSerial: serial,
    effect: {
      kind: 'semantic',
      action: 1,
      boundaryId: `boundary-${serial}`,
      options,
      screen: 'normal',
      row: serial,
      column: 0,
    },
  }
}

describe('native product effect transport', () => {
  it('preserves every ordered record while splitting at the existing record bound', () => {
    const f = fixture()
    const effects = Array.from(
      { length: NATIVE_TERMINAL_EFFECT_LIMITS.records + 1 },
      (_, i) => semantic(i + 1),
    )
    f.publish(effects)
    expect(f.channels).toEqual(['native-terminal:effect', 'native-terminal:effect'])
    expect(
      f.sent.map((event) => ('effects' in event ? event.effects.length : 0)),
    ).toEqual([131, 1])
    expect(f.sent.flatMap((event) => ('effects' in event ? event.effects : []))).toEqual(
      effects,
    )
  })

  it('chunks UTF-8 payloads at the existing byte bound without discarding facts', () => {
    const f = fixture()
    const options = '🙂'.repeat((NATIVE_TERMINAL_EFFECT_LIMITS.pairBytes - 4) / 4)
    const effects = Array.from({ length: 9 }, (_, i) => semantic(i + 1, options))
    f.publish(effects)
    expect(
      f.sent.map((event) => ('effects' in event ? event.effects.length : 0)),
    ).toEqual([7, 2])
    for (const message of f.sent) {
      expect('effects' in message).toBe(true)
      if ('effects' in message)
        expect(
          message.effects.reduce(
            (sum, effect) =>
              sum +
              nativeTerminalSemanticPayloadBytes(
                effect,
                NATIVE_TERMINAL_EFFECT_LIMITS.payloadBytes,
              )!,
            0,
          ),
        ).toBeLessThanOrEqual(NATIVE_TERMINAL_EFFECT_LIMITS.payloadBytes)
    }
    expect(f.sent.flatMap((event) => ('effects' in event ? event.effects : []))).toEqual(
      effects,
    )
  })

  it.each(['owner', 'frame', 'instance', 'retiring', 'missing', 'detaching'] as const)(
    'revalidates %s before every chunk send',
    (change) => {
      const f = fixture()
      f.duringSend(() => {
        if (change === 'owner') f.flags.currentOwner = false
        else if (change === 'frame') f.flags.destroyed = true
        else if (change === 'instance') f.state.session.instanceId = 'replacement'
        else if (change === 'retiring') f.state.retiring = true
        else if (change === 'missing') f.flags.missing = true
        else f.view.detaching = Promise.resolve()
      })
      f.publish(Array.from({ length: 132 }, (_, i) => semantic(i + 1)))
      expect(f.sent).toHaveLength(1)
    },
  )

  it('keeps readonly semantic/title delivery and original scalar transient timing', () => {
    const f = fixture()
    f.state.readonly =
      f.state.inputClosed =
      f.state.unavailable =
      f.state.inputUnavailable =
        true
    const title = {
      id: 'session',
      instanceId: 'instance',
      eventSerial: 1,
      effect: { kind: 'title' as const, title: 'latest title' },
    }
    f.publish(title)
    expect(f.sent).toEqual([title])
    f.publish({
      id: 'session',
      instanceId: 'instance',
      eventSerial: 2,
      effect: { kind: 'bell' },
    })
    expect(f.sent).toHaveLength(1)
    f.publish([
      semantic(3),
      {
        id: 'session',
        instanceId: 'instance',
        eventSerial: 4,
        effect: { kind: 'semantic-gap', controlCutoff: 4 },
      },
    ])
    expect(f.sent).toHaveLength(2)
  })

  it('contains frame send failures without turning them into metadata invalidation', () => {
    const f = fixture()
    f.duringSend(() => {
      throw new Error('renderer send failed')
    })
    expect(() => f.publish([semantic(1)])).not.toThrow()
    expect(() =>
      f.publish({
        id: 'session',
        instanceId: 'instance',
        eventSerial: 2,
        effect: { kind: 'bell' },
      }),
    ).not.toThrow()
    expect(f.sent).toHaveLength(2)
  })

  it('rejects impossible foreign or oversized metadata before any frame publication', () => {
    const f = fixture()
    expect(() => f.publish([{ ...semantic(1), instanceId: 'foreign' }])).toThrow(
      'instance-mismatch',
    )
    expect(() =>
      f.publish([
        semantic(1, 'x'.repeat(NATIVE_TERMINAL_EFFECT_LIMITS.payloadBytes + 1)),
      ]),
    ).toThrow('payload-invalid')
    expect(f.sent).toHaveLength(0)
    f.publish([])
    expect(f.sent).toHaveLength(0)
  })
})
