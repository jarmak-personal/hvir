import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface Terminal {
  readonly inputClosed: boolean
  pause(): unknown
  resume(): unknown
  write(data: string): void
  kill(signal?: string): void
  destroy(): void
  onData(listener: (data: string) => void): { dispose(): void }
  onExit(listener: (exit: { exitCode: number; signal: number }) => void): {
    dispose(): void
  }
}

/** Only the immediate tty/native dependency is controlled. All exit timers,
 * public pause/kill behavior and listener cleanup execute installed node-pty JS. */
class ReadSocket extends EventEmitter {
  readable = true
  destroyed = false
  private paused = false
  private readonly pending: string[] = []
  readonly destroy = vi.fn(() => {
    if (this.destroyed) return this
    this.destroyed = true
    this.readable = false
    this.pending.length = 0
    this.emit('close')
    return this
  })
  setEncoding(): this {
    return this
  }
  isPaused(): boolean {
    return this.paused
  }
  pause(): this {
    this.paused = true
    this.emit('pause')
    return this
  }
  resume(): this {
    this.paused = false
    this.emit('resume')
    while (!this.paused && !this.destroyed && this.pending.length)
      this.emit('data', this.pending.shift()!)
    return this
  }
  incoming(text: string): void {
    if (this.destroyed) throw new Error('read socket already destroyed')
    if (this.paused) this.pending.push(text)
    else this.emit('data', text)
  }
  eof(): void {
    this.destroy()
  }
}

function fixture() {
  const hostRequire = createRequire(import.meta.url)
  const root = dirname(hostRequire.resolve('node-pty/package.json'))
  const sourceFile = join(root, 'lib/unixTerminal.js')
  const localRequire = createRequire(sourceFile)
  const socket = new ReadSocket()
  let physicalExit!: (code: number, signal: number) => void
  const native = {
    fork: vi.fn((...args: unknown[]) => {
      physicalExit = args.at(-1) as typeof physicalExit
      return { fd: 19, pid: 4242, pty: '/dev/fixture' }
    }),
  }
  const utils = localRequire(join(root, 'lib/utils.js')) as {
    assign: (target: object, ...sources: object[]) => object
  }
  const signals = vi.fn()
  const write = vi.fn(
    (
      _fd: number,
      _buffer: Buffer,
      _offset: number,
      callback: (error: { code: string }, written: number) => void,
    ) => callback({ code: 'EAGAIN' }, 0),
  )
  const exports: {
    UnixTerminal?: new (file: string, args: string[], options: object) => Terminal
  } = {}
  const module = { exports }
  runInNewContext(
    readFileSync(sourceFile, 'utf8'),
    {
      exports,
      module,
      __dirname: dirname(sourceFile),
      Buffer,
      console,
      setTimeout,
      clearTimeout,
      setImmediate,
      clearImmediate,
      process: { ...process, kill: signals },
      require: (name: string): unknown => {
        if (name === 'tty')
          return {
            ReadStream: function () {
              return socket
            },
          }
        if (name === 'fs') return { write }
        if (name === './utils')
          return {
            ...utils,
            loadNativeModule: () => ({ module: native, dir: '../build/Release' }),
          }
        return localRequire(name) as unknown
      },
    },
    { filename: sourceFile, timeout: 1000 },
  )
  if (!module.exports.UnixTerminal) throw new Error('installed UnixTerminal missing')
  const terminal = new module.exports.UnixTerminal('/bin/sh', [], {
    cwd: '/fixture',
    env: { TERM: 'xterm' },
  })
  const data: string[] = []
  const exits: Array<{ exitCode: number; signal: number }> = []
  const subscription = terminal.onData((text) => data.push(text))
  terminal.onExit((exit) => exits.push(exit))
  const baseline = (): number[] =>
    ['pause', 'resume', 'data', 'close'].map((event) => socket.listenerCount(event))
  return {
    terminal,
    socket,
    signals,
    data,
    exits,
    baseline,
    subscription,
    write,
    physicalExit: (code = 0, signal = 0) => physicalExit(code, signal),
  }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('installed node-pty Unix exit drain', () => {
  it('exposes physical input closure while paused tail remains owned and public exit is pending', async () => {
    const f = fixture()
    const exits = vi.fn(),
      data = vi.fn()
    f.terminal.onExit(exits)
    f.terminal.onData(data)
    expect(f.terminal.inputClosed).toBe(false)
    f.terminal.pause()
    f.socket.incoming('retained tail')
    f.physicalExit(7)
    expect(f.terminal.inputClosed).toBe(true)
    await vi.advanceTimersByTimeAsync(500)
    expect(exits).not.toHaveBeenCalled()
    expect(data).not.toHaveBeenCalled()
    f.terminal.resume()
    expect(data).toHaveBeenCalledExactlyOnceWith('retained tail')
    f.socket.eof()
    expect(exits).toHaveBeenCalledExactlyOnceWith({ exitCode: 7, signal: 0 })
    expect(f.terminal.inputClosed).toBe(true)
  })
  it('preserves unread final bytes through a pause longer than the idle guard', async () => {
    const f = fixture()
    const baseline = f.baseline()
    f.terminal.pause()
    f.socket.incoming('last decoded bytes é🙂')
    f.physicalExit(7)
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.socket.destroy).not.toHaveBeenCalled()
    expect(f.exits).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
    f.terminal.resume()
    expect(f.data).toEqual(['last decoded bytes é🙂'])
    f.socket.eof()
    expect(f.exits).toEqual([{ exitCode: 7, signal: 0 }])
    expect(f.baseline()).toEqual(baseline)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retains exactly the 200ms unpaused idle cleanup boundary', async () => {
    const f = fixture()
    f.physicalExit(4, 2)
    await vi.advanceTimersByTimeAsync(199)
    expect(f.socket.destroy).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(f.socket.destroy).toHaveBeenCalledTimes(1)
    expect(f.exits).toEqual([{ exitCode: 4, signal: 2 }])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rearms idle expiry on actual data progress without extending it arbitrarily', async () => {
    const f = fixture()
    f.physicalExit()
    await vi.advanceTimersByTimeAsync(150)
    f.socket.incoming('progress')
    await vi.advanceTimersByTimeAsync(199)
    expect(f.socket.destroy).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(f.data).toEqual(['progress'])
    expect(f.socket.destroy).toHaveBeenCalledTimes(1)
    expect(f.exits).toHaveLength(1)
  })

  it('cancels and rearms through repeated pauses and synchronous pause during resume', async () => {
    const f = fixture()
    f.physicalExit()
    await vi.advanceTimersByTimeAsync(150)
    f.terminal.pause()
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.socket.destroy).not.toHaveBeenCalled()
    const stop = f.terminal.onData(() => f.terminal.pause())
    f.socket.incoming('tail one')
    f.terminal.resume()
    expect(f.socket.isPaused()).toBe(true)
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.socket.destroy).not.toHaveBeenCalled()
    stop.dispose()
    f.socket.incoming('tail two')
    f.terminal.resume()
    expect(f.data).toEqual(['tail one', 'tail two'])
    f.socket.eof()
    expect(f.exits).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cleans only scoped listeners on EOF and leaves unrelated socket listeners intact', () => {
    const f = fixture()
    const unrelated = { pause: vi.fn(), resume: vi.fn(), data: vi.fn() }
    for (const [event, listener] of Object.entries(unrelated))
      f.socket.on(event, listener)
    const baseline = f.baseline()
    f.physicalExit()
    f.socket.incoming('tail')
    f.socket.eof()
    expect(f.baseline()).toEqual(baseline)
    expect(unrelated.data).toHaveBeenCalledExactlyOnceWith('tail')
    f.socket.emit('pause')
    f.socket.emit('resume')
    expect(unrelated.pause).toHaveBeenCalledOnce()
    expect(unrelated.resume).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['kill', 'destroy'] as const)(
    'does not signal a reaped PID on paused physical-exit %s',
    async (method) => {
      const f = fixture()
      const baseline = f.baseline()
      f.terminal.pause()
      f.terminal.write('pending write')
      expect(f.write).toHaveBeenCalledOnce()
      f.physicalExit()
      f.terminal[method]()
      expect(f.signals).not.toHaveBeenCalled()
      expect(f.socket.destroyed).toBe(true)
      expect(f.exits).toHaveLength(1)
      expect(f.baseline()).toEqual(baseline)
      expect(vi.getTimerCount()).toBe(0)
      await vi.advanceTimersByTimeAsync(1000)
      expect(f.write).toHaveBeenCalledOnce()
      expect(f.signals).not.toHaveBeenCalled()
    },
  )

  it.each(['kill', 'destroy'] as const)(
    'still signals a live process with %s',
    async (method) => {
      const f = fixture()
      f.terminal[method]()
      expect(f.signals).toHaveBeenCalledExactlyOnceWith(4242, 'SIGHUP')
      f.physicalExit(0, 1)
      await vi.advanceTimersByTimeAsync(200)
      expect(f.socket.destroyed).toBe(true)
      expect(f.exits).toEqual([{ exitCode: 0, signal: 1 }])
      expect(vi.getTimerCount()).toBe(0)
    },
  )

  it('does not accumulate timers or guard listeners across independent close cycles', async () => {
    for (let iteration = 0; iteration < 10; iteration++) {
      const f = fixture()
      const baseline = f.baseline()
      f.terminal.pause()
      f.physicalExit()
      await vi.advanceTimersByTimeAsync(500)
      f.terminal.resume()
      f.socket.incoming(`tail-${iteration}`)
      f.socket.eof()
      expect(f.exits).toHaveLength(1)
      expect(f.data).toEqual([`tail-${iteration}`])
      expect(f.baseline()).toEqual(baseline)
      expect(vi.getTimerCount()).toBe(0)
    }
  })
})
