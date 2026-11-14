import { runInNewContext } from 'node:vm'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  nativeTerminalInputProbeSource,
  nativeReadonlyProbeScript,
  nativeReadonlyPresentationReady,
  type ReadonlyRendererProbe,
} from '../src/main/smoke/native-terminal-input'

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

describe('readonly renderer qualification diagnostics', () => {
  function observe(phase: 'bounds' | 'wheel', fault?: 'missing' | 'rect' | 'wheel') {
    const dispatch = vi.fn()
    const canvas = {
      isConnected: true,
      hidden: false,
      getBoundingClientRect: () => {
        if (fault === 'rect') throw new TypeError('original rectangle error')
        return { x: 1.2, y: 2.3, width: 640.9, height: 480.9, left: 1.2, top: 2.3 }
      },
      dispatchEvent: dispatch,
    }
    const pane = { isConnected: true, hidden: false, getAttribute: () => 'true' }
    class Wheel {
      constructor(
        readonly type: string,
        readonly options: Record<string, unknown>,
      ) {
        if (fault === 'wheel')
          throw new RangeError('original wheel error https://private.invalid/path')
      }
    }
    const result = runInNewContext(nativeReadonlyProbeScript(phase, -120), {
      document: {
        querySelector: (selector: string) =>
          selector.includes(' canvas') ? (fault === 'missing' ? null : canvas) : pane,
        querySelectorAll: (selector: string) => ({
          length: selector.includes(' canvas') && fault === 'missing' ? 0 : 1,
        }),
      },
      window: {
        nativeQualificationModes: [
          'secret-payload',
          ...Array<string>(12).fill('native-pixels'),
        ],
      },
      WheelEvent: Wheel,
    }) as {
      ok: boolean
      phase: string
      bounds?: { x: number; y: number; width: number; height: number }
      error?: { name: string; message: string; stack: string }
      census: {
        canvasCount: number
        paneReadonly: boolean
        statusModes: string[]
        bounds: unknown
      }
    }
    return { result, dispatch }
  }
  it('retains normal finite bounds and dispatches the original single wheel', () => {
    const bounds = observe('bounds')
    expect(bounds.result.ok).toBe(true)
    expect(bounds.result.bounds).toEqual({ x: 2, y: 3, width: 640, height: 480 })
    expect(bounds.dispatch).not.toHaveBeenCalled()
    const wheel = observe('wheel')
    expect(wheel.result.ok).toBe(true)
    expect(wheel.dispatch).toHaveBeenCalledTimes(1)
    expect(wheel.dispatch.mock.calls[0]?.[0]).toMatchObject({
      type: 'wheel',
      options: { deltaY: -120, deltaMode: 0, clientX: 9.2, clientY: 10.3 },
    })
  })
  it('distinguishes missing canvas from original rectangle and WheelEvent failures', () => {
    const missing = observe('bounds', 'missing').result
    expect(missing.ok).toBe(false)
    expect(missing.error?.message).toBe('native canvas missing')
    expect(missing.census.canvasCount).toBe(0)
    const rect = observe('bounds', 'rect').result
    expect(rect.error).toMatchObject({
      name: 'TypeError',
      message: 'original rectangle error',
    })
    expect(rect.census.bounds).toBeNull()
    const wheel = observe('wheel', 'wheel').result
    expect(wheel.phase).toBe('wheel')
    expect(wheel.error).toMatchObject({
      name: 'RangeError',
      message: 'original wheel error [url]',
    })
    expect(wheel.error?.stack).toContain('original wheel error')
    expect(wheel.error?.stack.length).toBeLessThanOrEqual(512)
    expect(JSON.stringify(wheel)).not.toContain('private.invalid')
    expect(wheel.census.statusModes).toEqual(Array<string>(8).fill('native-pixels'))
    expect(wheel.census.paneReadonly).toBe(true)
    expect(JSON.stringify(wheel)).not.toContain('secret-payload')
  })
})

describe('readonly presentation readiness observations', () => {
  function observation(
    options: {
      missingCanvas?: boolean
      session?: string
      exited?: boolean
      readonly?: boolean
      connected?: boolean
      dpr?: number
      width?: number
      height?: number
    } = {},
  ) {
    const dispatch = vi.fn()
    const canvas = {
      isConnected: options.connected ?? true,
      hidden: false,
      width: options.width ?? 800,
      height: options.height ?? 400,
      getBoundingClientRect: () => ({
        x: 1.2,
        y: 2.3,
        left: 1.2,
        top: 2.3,
        width: 400,
        height: 200,
      }),
      dispatchEvent: dispatch,
    }
    const surface = {
      isConnected: true,
      getBoundingClientRect: () => ({ x: 1.2, y: 2.3, width: 400, height: 200 }),
      querySelector: () => (options.missingCanvas ? null : canvas),
    }
    const pane = {
      isConnected: true,
      hidden: false,
      getAttribute: () => (options.readonly === false ? 'false' : 'true'),
      querySelector: () => surface,
    }
    const panel = {
      isConnected: true,
      getAttribute: (name: string) =>
        name === 'data-terminal-session'
          ? (options.session ?? 'expected-session')
          : name === 'data-terminal-status'
            ? options.exited === false
              ? 'pid 42'
              : 'Exited (0)'
            : 'false',
      querySelector: () => pane,
    }
    const result = runInNewContext(
      nativeReadonlyProbeScript('readiness', 0, 'expected-session'),
      {
        document: {
          querySelector: () => {
            throw new Error('unscoped lookup')
          },
          querySelectorAll: (selector: string) =>
            selector === '.terminal-surface'
              ? [panel]
              : selector.includes(' canvas')
                ? options.missingCanvas
                  ? []
                  : [canvas]
                : selector === '.native-terminal-pane'
                  ? [pane]
                  : [surface],
        },
        window: {
          devicePixelRatio: options.dpr ?? 2,
          nativeQualificationModes: ['native-pixels'],
        },
      },
    ) as ReadonlyRendererProbe
    return { result, dispatch }
  }
  const geometry = {
    serial: 5,
    width: 800,
    height: 400,
    backingScale: 2,
    columns: 100,
    rows: 25,
    cellWidth: 8,
    cellHeight: 16,
    contentWidth: 800,
    contentHeight: 400,
    paddingLeft: 0,
    paddingTop: 0,
  }
  it('waits observationally for the exact exited readonly panel and connected current canvas', () => {
    for (const options of [
      { missingCanvas: true },
      { session: 'another-session' },
      { exited: false },
      { readonly: false },
      { connected: false },
    ]) {
      const { result, dispatch } = observation(options)
      expect(result.ok).toBe(true)
      expect(result.ready).toBe(false)
      expect(nativeReadonlyPresentationReady(geometry, geometry, result)).toBe(false)
      expect(dispatch).not.toHaveBeenCalled()
    }
    const { result, dispatch } = observation()
    expect(result.ready).toBe(true)
    expect(nativeReadonlyPresentationReady(geometry, geometry, result)).toBe(true)
    expect(result.bounds).toEqual({ x: 2, y: 3, width: 400, height: 200 })
    expect(dispatch).not.toHaveBeenCalled()
  })
  it('requires A/B matching acknowledgements and actual backing/CSS/DPR agreement', () => {
    const { result } = observation()
    expect(
      nativeReadonlyPresentationReady(geometry, { ...geometry, serial: 6 }, result),
    ).toBe(false)
    expect(
      nativeReadonlyPresentationReady(geometry, { ...geometry, width: 802 }, result),
    ).toBe(false)
    expect(
      nativeReadonlyPresentationReady(
        geometry,
        geometry,
        observation({ width: 799 }).result,
      ),
    ).toBe(false)
    expect(
      nativeReadonlyPresentationReady(
        geometry,
        geometry,
        observation({ height: 399 }).result,
      ),
    ).toBe(false)
    expect(
      nativeReadonlyPresentationReady(geometry, geometry, observation({ dpr: 1 }).result),
    ).toBe(false)
    expect(
      nativeReadonlyPresentationReady(geometry, geometry, {
        ...result,
        layout: { ...result.layout!, cssWidth: 399 },
      }),
    ).toBe(false)
  })
  it('uses observed fractional DPR for physical rounding and native f32 for scale agreement', () => {
    const { result } = observation({ dpr: 1.2, width: 480, height: 240 })
    const fractional = {
      ...geometry,
      width: 480,
      height: 240,
      backingScale: Math.fround(1.2),
    }
    expect(fractional.backingScale).not.toBe(1.2)
    expect(nativeReadonlyPresentationReady(fractional, fractional, result)).toBe(true)
    expect(
      nativeReadonlyPresentationReady(fractional, fractional, {
        ...result,
        layout: { ...result.layout!, backingScale: 1.21 },
      }),
    ).toBe(false)
  })
})
