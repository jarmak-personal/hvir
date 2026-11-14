import type { TerminalEvent } from '../src/renderer/src/terminal/terminal-pane'
import { describe, expect, it, vi } from 'vitest'
import { NativeTerminalPaneEffects } from '../src/renderer/src/terminal/native-terminal-pane-effects'
import { validNativeTerminalEffectBatch } from '../src/shared/native-terminal-effects'
describe('bound native pane product effects', () => {
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
