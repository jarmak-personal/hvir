import { EventEmitter } from 'node:events'
import { runInNewContext } from 'node:vm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  nativeEffectsFixtureCases,
  nativeEffectsRecorderSource,
} from '../src/main/smoke/native-terminal-effects'

function recorder() {
  const input = Object.assign(new EventEmitter(), {
    setRawMode: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
  })
  const output = Object.assign(new EventEmitter(), {
    write: (text: string, done?: () => void) => {
      writes.push(text)
      done?.()
      return true
    },
  })
  const writes: string[] = [],
    exit = vi.fn()
  runInNewContext(nativeEffectsRecorderSource(), {
    Buffer,
    setTimeout,
    clearTimeout,
    setImmediate,
    process: { stdin: input, stdout: output, exit },
  })
  return {
    writes,
    exit,
    input,
    command: (name: string) => input.emit('data', Buffer.from('\x1d' + name + '\x1d')),
    reply: (text: string) => input.emit('data', Buffer.from(text)),
  }
}
beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})
describe('native effects fixture protocol (not native parser or policy proof)', () => {
  it('keeps delivery compact and generates complete64KiB plus oversized OSC52 inside the recorder', async () => {
    expect(nativeEffectsRecorderSource().length).toBeLessThan(6000)
    const f = recorder()
    f.command('fullClipboard')
    await vi.advanceTimersByTimeAsync(20)
    const sequence = f.writes.find((text) => text.startsWith('\x1b]52;c;'))!
    expect(sequence.slice(7, -2).length).toBe(65536)
    f.reply('\x1b[0n')
    expect(f.writes.join('')).toContain('fullClipboard_OK')
    f.command('refusedClipboard')
    await vi.advanceTimersByTimeAsync(20)
    expect(
      f.writes.find((text) => text.startsWith('\x1b]52;c;') && text.length > 65545)
        ?.length,
    ).toBe(65549)
    f.reply('\x1b[0n')
    expect(f.writes.join('')).toContain('refusedClipboard_OK')
    expect(f.exit).not.toHaveBeenCalled()
  })
  it('requires exact ordered native replies, while split source writes remain only a source-level fact', async () => {
    const f = recorder()
    f.command('title')
    await vi.advanceTimersByTimeAsync(20)
    expect(f.writes).toContain('\x1b]2;HVIR_NATIVE_')
    expect(f.writes).toContain('EFFECTS_TITLE\x1b\\')
    f.reply('\x1b[')
    expect(f.writes.join('')).not.toContain('title_OK')
    f.reply('0n')
    f.command('palette')
    await vi.advanceTimersByTimeAsync(20)
    const expected = nativeEffectsFixtureCases().find((p) => p.name === 'palette')!.reply
    f.reply(expected)
    expect(f.writes.join('')).toContain('palette_OK')
    f.command('quit')
    expect(f.exit).toHaveBeenCalledExactlyOnceWith(0)
    expect(f.input.setRawMode.mock.calls).toEqual([[true], [false]])
  })
  it('fails on unsolicited clipboard read data or missing completion instead of treating it as authority', async () => {
    const f = recorder()
    f.command('refusedClipboard')
    await vi.advanceTimersByTimeAsync(20)
    f.reply('private clipboard bytes')
    expect(f.exit).toHaveBeenCalledExactlyOnceWith(2)
    expect(f.writes.join('')).not.toContain('private clipboard bytes')
    const pending = recorder()
    pending.command('link')
    await vi.advanceTimersByTimeAsync(45000)
    expect(pending.exit).toHaveBeenCalledExactlyOnceWith(2)
  })
})
