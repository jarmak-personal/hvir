import { runInNewContext } from 'node:vm'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nativeTerminalInputProbeSource } from '../src/main/smoke/native-terminal-input'

/** The recorder protocol, not a native encoder or real TTY/GPU fixture. */
function recorder(blockProducer = false) {
  const stdin = Object.assign(new EventEmitter(), {
    setRawMode: vi.fn(),
    resume: vi.fn(),
    pause: vi.fn(),
  })
  const writes: string[] = []
  const exit = vi.fn()
  const stdout = Object.assign(new EventEmitter(), {
    write: (text: string, callback?: () => void) => {
      writes.push(text)
      callback?.()
      return !(blockProducer && text.includes('native-continuous-output'))
    },
  })
  runInNewContext(nativeTerminalInputProbeSource(), {
    process: { stdin, stdout, exit },
    require: () => ({ createHash }),
    Buffer,
    setTimeout,
    clearTimeout,
  })
  const emit = (data: string) => stdin.emit('data', Buffer.from(data))
  const command = (name: string) => emit('\x1d' + name + '\x1d')
  const text = () => writes.join('')
  return { stdin, stdout, writes, exit, emit, command, text }
}
beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})
describe('same-PTY native input recorder', () => {
  it('accepts split control/query replies and hashes exact bytes without publishing their body', () => {
    const f = recorder()
    f.emit('\x1dente')
    f.emit('r\x1d')
    expect(f.text()).toContain('\x1b[5n')
    f.emit('\x1b[')
    expect(f.text()).not.toContain('enter_READY')
    f.emit('0n')
    expect(f.text()).toContain('enter_READY')
    f.emit('\r')
    f.command('observe')
    expect(f.text()).toContain('enter_OBSERVED')
    f.command('end')
    expect(f.text()).toContain('enter_OK')
    f.command('quit')
    expect(f.text()).toContain('\x1b[41m native readonly row')
    expect(f.exit).toHaveBeenCalledExactlyOnceWith(0)
    expect(f.stdin.setRawMode.mock.calls).toEqual([[true], [false]])
    expect(f.stdin.pause).toHaveBeenCalledTimes(1)
  })
  it('requires initial focus synchronization before DSR and separately validates explicit blur/gain', () => {
    const f = recorder()
    f.command('focus')
    f.emit('\x1b[I')
    expect(f.text()).not.toContain('focus_READY')
    f.emit('\x1b[0n')
    expect(f.text()).toContain('focus_READY')
    f.emit('\x1b[O\x1b[I')
    f.command('end')
    expect(f.text()).toContain('focus_OK')
    expect(f.exit).not.toHaveBeenCalled()
  })
  it('hashes the fixed sanitized Unicode/CRLF paste with one native bracketed frame', () => {
    const f = recorder()
    f.command('paste')
    f.emit('\x1b[0n')
    f.emit('\x1b[200~é🙂\r\n日本    \tZ\x1b[201~')
    f.command('end')
    expect(f.text()).toContain('paste_OK')
    expect(f.exit).not.toHaveBeenCalled()
  })
  it('honors stdout backpressure and accepts Ctrl-C before stopping the bounded producer', async () => {
    const f = recorder(true)
    f.command('continuous')
    f.emit('\x1b[0n')
    const chunks = () =>
      f.writes.filter((text) => text.includes('native-continuous-output')).length
    expect(chunks()).toBe(1)
    const first = f.writes.find((text) => text.includes('native-continuous-output'))!
    expect(first).toContain('\r\x1b[2Knative-continuous-output\r')
    expect(first).not.toContain('\\x1b')
    expect(first).not.toContain('\n')
    await vi.advanceTimersByTimeAsync(25)
    expect(chunks()).toBe(1)
    f.stdout.emit('drain')
    expect(chunks()).toBe(2)
    expect(f.text()).not.toContain('continuous_TRIGGER__')
    for (
      let i = 0;
      i < 200 && !f.writes.some((text) => text.includes('continuous_TRIGGER__'));
      i++
    )
      f.stdout.emit('drain')
    const warmup = f.text().match(/continuous_WARMUP_([0-9]+)__/)
    expect(Number(warmup?.[1])).toBeGreaterThanOrEqual(65536)
    const atInterrupt = chunks()
    f.emit('\x03')
    expect(f.text()).toContain('continuous_INTERRUPTED_')
    expect(f.stdout.listenerCount('drain')).toBe(0)
    f.command('end')
    expect(f.text()).toContain('continuous_OK')
    await vi.advanceTimersByTimeAsync(25)
    expect(chunks()).toBe(atInterrupt)
    expect(f.exit).not.toHaveBeenCalled()
  })
  it('fails the bounded continuous producer when no interrupt arrives before its deadline', async () => {
    const f = recorder(true)
    f.command('continuous')
    f.emit('\x1b[0n')
    await vi.advanceTimersByTimeAsync(2000)
    expect(f.text()).toContain('FAILED_continuous_continuous-deadline')
    expect(f.exit).toHaveBeenCalledExactlyOnceWith(2)
    expect(f.stdout.listenerCount('drain')).toBe(0)
  })
  it('includes the actual parser reply before user bytes in the concurrent phase digest', () => {
    const f = recorder()
    f.command('concurrent')
    expect(f.text()).toContain('concurrent_QUERY')
    f.emit('\x1b[0n')
    f.emit('\x03')
    f.command('end')
    expect(f.text()).toContain('concurrent_OK')
    expect(f.exit).not.toHaveBeenCalled()
  })
  it('refuses reordered concurrent reply/user bytes rather than manufacturing success', () => {
    const f = recorder()
    f.command('concurrent')
    f.emit('\x03\x1b[0n')
    f.command('end')
    expect(f.text()).toContain('FAILED')
    expect(f.text()).not.toContain('concurrent_OK')
    expect(f.exit).toHaveBeenCalledExactlyOnceWith(2)
  })
  it.each(['wrong-body', 'short-body', 'wrong-query', 'unknown-phase', 'long-control'])(
    'fails closed for %s and restores the recorder terminal',
    (failure) => {
      const f = recorder()
      f.command('enter')
      if (failure === 'wrong-query') f.emit('\x1b[1n')
      else if (failure === 'long-control') f.command('x'.repeat(33))
      else if (failure === 'unknown-phase') f.command('unknown')
      else {
        f.emit('\x1b[0n')
        if (failure === 'wrong-body') f.emit('x')
        f.command('end')
      }
      expect(f.text()).toContain('FAILED')
      expect(f.exit).toHaveBeenCalledExactlyOnceWith(2)
      expect(f.stdin.setRawMode).toHaveBeenLastCalledWith(false)
    },
  )
  it('bounds recorder lifetime without input and releases its raw terminal once', async () => {
    const f = recorder()
    await vi.advanceTimersByTimeAsync(45000)
    expect(f.exit).toHaveBeenCalledExactlyOnceWith(2)
    f.command('quit')
    expect(f.exit).toHaveBeenCalledTimes(1)
  })
})
