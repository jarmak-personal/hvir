import type { TerminalEvent } from '../src/renderer/src/terminal/terminal-pane'
import { describe, expect, it, vi } from 'vitest'
import { NativeTerminalPaneEffects } from '../src/renderer/src/terminal/native-terminal-pane-effects'
import { TerminalPaneEventCoordinator } from '../src/renderer/src/terminal/terminal-pane-event-coordinator'
import { validNativeTerminalEffectBatch } from '../src/shared/native-terminal-effects'
describe('bound native pane product effects', () => {
  it('applies a late control cutoff without dropping a newer prompt at identical coordinates or rewinding serials', () => {
    const pane = new NativeTerminalPaneEffects(() => ({
      sessionId: 's',
      instanceId: 'i',
      disposed: false,
    }))
    const regions = new TerminalPaneEventCoordinator('terminal')
    const events: TerminalEvent[] = []
    pane.subscribe((event) => {
      events.push(event)
      regions.handle(event)
    })
    const marker = (eventSerial: number) => ({
      id: 's',
      instanceId: 'i',
      eventSerial,
      effect: {
        kind: 'semantic' as const,
        action: 3,
        options: '',
        screen: 'normal' as const,
        row: 0,
        column: 0,
        boundaryId: `boundary-${eventSerial}`,
      },
    })
    pane.accept(marker(3))
    pane.accept(marker(8))
    pane.accept({
      id: 's',
      instanceId: 'old',
      eventSerial: 5,
      effect: { kind: 'semantic-gap', controlCutoff: 5 },
    })
    pane.accept({
      id: 's',
      instanceId: 'i',
      eventSerial: 5,
      effect: { kind: 'semantic-gap', controlCutoff: 5 },
    })
    expect(regions.snapshot().semanticRegionsAvailable).toBe(true)
    pane.accept(marker(7))
    pane.accept({
      id: 's',
      instanceId: 'i',
      eventSerial: 4,
      effect: { kind: 'semantic-gap', controlCutoff: 4 },
    })
    expect(
      events.map((event) => (event.type === 'semantic' ? event.provenance.id : event)),
    ).toEqual([3, 8, { type: 'semantic-gap', controlCutoff: 5 }])
    pane.accept({
      id: 's',
      instanceId: 'i',
      eventSerial: 8,
      effect: { kind: 'semantic-gap', controlCutoff: 8 },
    })
    expect(regions.snapshot().semanticRegionsAvailable).toBe(false)
  })
  it('requires exact immutable instance, accepts coalesced kinds independently, and revokes disposal', () => {
    const binding: { sessionId: string; instanceId?: string; disposed: boolean } = {
      sessionId: 's',
      disposed: false,
    }
    const pane = new NativeTerminalPaneEffects(() => binding),
      listener = vi.fn<(event: TerminalEvent) => void>()
    pane.subscribe(listener)
    const title = {
      id: 's',
      instanceId: 'i',
      eventSerial: 10,
      effect: { kind: 'title' as const, title: 't' },
    }
    pane.accept(title)
    expect(listener).not.toHaveBeenCalled()
    binding.instanceId = 'i'
    pane.accept({ ...title, instanceId: 'old' })
    pane.accept(title)
    pane.accept({ ...title, eventSerial: 3, effect: { kind: 'bell' } })
    pane.accept(title)
    expect(listener.mock.calls.map((call) => call[0])).toEqual([
      { type: 'title', title: 't' },
      { type: 'bell' },
    ])
    binding.disposed = true
    pane.accept({ ...title, eventSerial: 11 })
    expect(listener).toHaveBeenCalledTimes(2)
  })
  it('forwards parser-owned semantic boundary IDs/options and clears only on an explicit current-instance gap', () => {
    const pane = new NativeTerminalPaneEffects(() => ({
      sessionId: 's',
      instanceId: 'i',
      disposed: false,
    }))
    const listener = vi.fn<(event: TerminalEvent) => void>()
    pane.subscribe(listener)
    const semantic = {
      id: 's',
      instanceId: 'i',
      eventSerial: 3,
      effect: {
        kind: 'semantic' as const,
        action: 7,
        options: '0',
        screen: 'normal' as const,
        row: 4,
        column: 2,
        boundaryId: '00000000-0000-4000-8000-000000000003',
      },
    }
    pane.accept({ ...semantic, instanceId: 'old' })
    pane.accept(semantic)
    pane.accept(semantic)
    pane.accept({
      ...semantic,
      eventSerial: 4,
      effect: { ...semantic.effect, action: 99 },
    })
    pane.accept({ ...semantic, eventSerial: 5, effect: { kind: 'semantic-gap' } })
    expect(listener.mock.calls.map(([event]) => event)).toEqual([
      {
        type: 'semantic',
        action: 'end-command',
        options: '0',
        provenance: {
          id: 3,
          screen: 'normal',
          row: 4,
          column: 2,
          boundaryId: semantic.effect.boundaryId,
        },
      },
      { type: 'semantic-gap' },
    ])
  })
  it('accepts a current-instance gap at the already observed inclusive serial cutoff before a later marker', () => {
    const owner = new NativeTerminalPaneEffects(() => ({
      sessionId: 's',
      instanceId: 'i',
      disposed: false,
    }))
    const listener = vi.fn<(event: TerminalEvent) => void>()
    owner.subscribe(listener)
    const marker = (eventSerial: number) => ({
      id: 's',
      instanceId: 'i',
      eventSerial,
      effect: {
        kind: 'semantic' as const,
        action: 3,
        options: '',
        screen: 'normal' as const,
        row: 0,
        column: 0,
        boundaryId: `b-${eventSerial}`,
      },
    })
    owner.accept(marker(5))
    owner.accept({
      id: 's',
      instanceId: 'i',
      eventSerial: 5,
      effect: { kind: 'semantic-gap' },
    })
    owner.accept(marker(8))
    owner.accept({
      id: 's',
      instanceId: 'i',
      eventSerial: 5,
      effect: { kind: 'semantic-gap' },
    })
    expect(
      listener.mock.calls.map(([event]) =>
        event.type === 'semantic' ? event.provenance.id : event.type,
      ),
    ).toEqual([5, 'semantic-gap', 8])
  })

  it('replays an attach-time loss notification at the snapshot inclusive cutoff', () => {
    const owner = new NativeTerminalPaneEffects(() => ({
      sessionId: 's',
      instanceId: 'i',
      disposed: false,
    }))
    const listener = vi.fn<(event: TerminalEvent) => void>()
    owner.subscribe(listener)
    owner.beginBootstrap('s')
    owner.accept({
      id: 's',
      instanceId: 'i',
      eventSerial: 5,
      effect: { kind: 'semantic-gap' },
    })
    owner.restoreSemantics({
      throughSerial: 5,
      effects: [
        {
          id: 's',
          instanceId: 'i',
          eventSerial: 5,
          effect: {
            kind: 'semantic',
            action: 3,
            options: '',
            screen: 'normal',
            row: 0,
            column: 0,
            boundaryId: 'b-5',
          },
        },
      ],
    })
    expect(listener.mock.calls.map(([event]) => event.type)).toEqual([
      'semantic',
      'semantic-gap',
    ])
  })

  it('merges snapshot-through ordering with preattach events and rejects duplicate/foreign instances', () => {
    const binding = {
      sessionId: undefined as string | undefined,
      instanceId: undefined as string | undefined,
      disposed: false,
    }
    const owner = new NativeTerminalPaneEffects(() => binding)
    const listener = vi.fn<(event: TerminalEvent) => void>()
    owner.subscribe(listener)
    const event = (eventSerial: number, instanceId = 'i') => ({
      id: 's',
      instanceId,
      eventSerial,
      effect: {
        kind: 'semantic' as const,
        action: 3,
        options: '',
        screen: 'normal' as const,
        row: eventSerial,
        column: 0,
        boundaryId: `boundary-${eventSerial}`,
      },
    })
    owner.beginBootstrap('s')
    owner.accept(event(1))
    owner.accept(event(3))
    owner.accept(event(4, 'old-instance'))
    binding.sessionId = 's'
    binding.instanceId = 'i'
    owner.accept(event(3))
    expect(listener).not.toHaveBeenCalled()
    owner.restoreSemantics({ throughSerial: 2, effects: [event(1), event(2)] })
    expect(
      listener.mock.calls.map(([value]) =>
        value.type === 'semantic' ? value.provenance.id : value.type,
      ),
    ).toEqual([1, 2, 3])
    owner.accept(event(2))
    owner.accept(event(5))
    expect(listener).toHaveBeenCalledTimes(4)
    owner.clear()
  })

  it.each(['records', 'bytes'] as const)(
    'reports a truthful semantic gap after bounded bootstrap %s overflow',
    (limit) => {
      const owner = new NativeTerminalPaneEffects(() => ({
        sessionId: 's',
        instanceId: 'i',
        disposed: false,
      }))
      const listener = vi.fn<(event: TerminalEvent) => void>()
      owner.subscribe(listener)
      owner.beginBootstrap('s')
      const count = limit === 'records' ? 513 : 17
      const options = limit === 'bytes' ? 'x'.repeat(65536) : ''
      for (let eventSerial = 1; eventSerial <= count; eventSerial++)
        owner.accept({
          id: 's',
          instanceId: 'i',
          eventSerial,
          effect: {
            kind: 'semantic',
            action: 3,
            options,
            screen: 'normal',
            row: eventSerial,
            column: 0,
            boundaryId: `b-${eventSerial}`,
          },
        })
      owner.restoreSemantics()
      expect(listener.mock.calls.at(-1)?.[0]).toEqual({ type: 'semantic-gap' })
      expect(listener.mock.calls.length).toBeLessThanOrEqual(513)
      owner.clear()
    },
  )

  it('refuses huge incoming text before allocating its UTF8 representation', () => {
    const encode = vi.spyOn(TextEncoder.prototype, 'encode')
    expect(
      validNativeTerminalEffectBatch({
        effects: [
          {
            kind: 'title',
            title: 'x'.repeat(128 * 1024 + 1),
            eventSerial: 1,
            sequence: 1,
          },
        ],
        droppedEffects: 0,
        semanticGeneration: 0,
      }),
    ).toBe(false)
    expect(encode).not.toHaveBeenCalled()
    encode.mockRestore()
  })
})
