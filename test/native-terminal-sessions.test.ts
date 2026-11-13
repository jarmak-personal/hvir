import { describe, expect, it, vi, afterEach } from 'vitest'
import { NativeTerminalSessions } from '../src/main/terminal/native-terminal-sessions'
import { NativeTerminalAdmissionError } from '../src/shared/native-terminal'
import { hostPath, LOCAL_HOST_ID, type HostId } from '../src/shared/host-path'
import { nativeTerminalStatus } from './fixtures/native-terminal-host'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
function fixture() {
  const reservation = {
    sessionId: 'session',
    instanceId: 'instance',
    ownerId: 1,
    ownerGeneration: 1,
    workspaceRoot: hostPath(LOCAL_HOST_ID, '/project'),
  }
  const initial = nativeTerminalStatus()
  const status = {
    ...initial,
    geometry: { ...initial.geometry, width: 640, height: 400, columns: 80, rows: 25 },
  }
  const host = {
    prepare: vi.fn(() => Promise.resolve('handle')),
    inspectProducer: vi.fn(() => Promise.resolve(status)),
    resizeProducer: vi.fn(
      (
        _handle: string,
        _instance: string,
        serial: number,
        width: number,
        height: number,
        backingScale: number,
      ) =>
        Promise.resolve({
          ...status,
          geometry: { ...status.geometry, serial, width, height, backingScale },
        }),
    ),
    feed: vi.fn((_handle: string, _instance: string, _bytes: Uint8Array) =>
      Promise.resolve(),
    ),
    discardEffectsProducer: vi.fn(() => Promise.resolve(0)),
    drainReplies: vi.fn(() => Promise.resolve(new Uint8Array())),
    end: vi.fn(() => Promise.resolve()),
  }
  const current = vi.fn(() => true)
  const sessions = new NativeTerminalSessions(host, current)
  const signal = new AbortController()
  const writer = {
    live: true,
    writeReply: vi.fn((_bytes: Uint8Array) => Promise.resolve()),
  }
  const prepare = () =>
    sessions.prepare(reservation, signal.signal, {
      width: 640,
      height: 400,
      backingScale: 1,
    })
  return { reservation, host, sessions, signal, writer, prepare, current }
}
afterEach(() => vi.useRealTimers())

describe('native supervisor session state', () => {
  it('reports a producer failure once without deleting the retained PTY instance', async () => {
    const f = fixture()
    const unavailable = vi.fn()
    const sessions = new NativeTerminalSessions(f.host, f.current, unavailable)
    const prepared = await sessions.prepare(f.reservation, f.signal.signal, {
      width: 640,
      height: 400,
      backingScale: 1,
    })
    prepared.failed(new Error('output-overrun'))
    prepared.failed(new Error('again'))
    expect(unavailable).toHaveBeenCalledExactlyOnceWith('session', 'instance')
    expect(sessions.get('session')).toMatchObject({ unavailable: true, readonly: true })
    expect(f.host.end).not.toHaveBeenCalled()
  })

  it('registers pending authority before creation and returns actual initial scaled geometry', async () => {
    const f = fixture()
    f.host.prepare.mockImplementation(() => {
      expect(f.sessions.resolve('session')).toEqual(f.reservation)
      expect(f.sessions.get('session')).toBeUndefined()
      return Promise.resolve('handle')
    })
    const prepared = await f.sessions.prepare(f.reservation, f.signal.signal, {
      width: 640,
      height: 400,
      backingScale: 2,
    })
    expect(f.host.resizeProducer).toHaveBeenCalledWith(
      'handle',
      'instance',
      2,
      640,
      400,
      2,
    )
    expect(prepared).toMatchObject({ columns: 80, rows: 25 })
    prepared.connect(f.writer)
    expect(f.sessions.get('session')?.readonly).toBe(false)
    expect(() => prepared.connect(f.writer)).toThrow('already-connected')
  })

  it('cleans cancelled preparation without connecting or resurrecting late creation', async () => {
    const f = fixture()
    const pending = deferred<string>()
    f.host.prepare.mockReturnValue(pending.promise)
    const preparing = f.prepare()
    f.signal.abort()
    pending.resolve('handle')
    await expect(preparing).rejects.toThrow()
    expect(f.host.end).toHaveBeenCalledExactlyOnceWith('handle', 'instance')
    expect(f.sessions.resolve('session')).toBeUndefined()
  })

  it('settles a late native creation after explicit pending removal exactly once', async () => {
    const f = fixture()
    const pending = deferred<string>()
    f.host.prepare.mockReturnValue(pending.promise)
    const preparing = f.prepare()
    await f.sessions.remove('session', 'instance')
    pending.resolve('handle')
    await expect(preparing).rejects.toThrow()
    expect(f.host.end).toHaveBeenCalledExactlyOnceWith('handle', 'instance')
  })

  it('revokes session authority before waiting for physical native cleanup', async () => {
    const f = fixture()
    const prepared = await f.prepare()
    prepared.connect(f.writer)
    const cleanup = deferred<void>()
    f.host.end.mockReturnValue(cleanup.promise)
    const removing = prepared.dispose()
    expect(f.sessions.resolve('session')).toBeUndefined()
    expect(f.sessions.get('session')).toBeUndefined()
    await expect(prepared.output('late')).rejects.toThrow()
    cleanup.resolve()
    await removing
    expect(f.host.end).toHaveBeenCalledTimes(1)
  })

  it('encodes existing decoded output once and drains raw replies between ordered 16KiB feeds', async () => {
    const f = fixture()
    const prepared = await f.prepare()
    prepared.connect(f.writer)
    const order: string[] = []
    f.host.feed.mockImplementation(() => {
      order.push('feed')
      return Promise.resolve()
    })
    f.host.drainReplies.mockImplementation(() => {
      order.push('drain')
      return Promise.resolve(Uint8Array.of(0xff, 0x80, 0x1b))
    })
    const decoded = '☃'.repeat(12_000) + '\u001b[6n'
    await prepared.output(decoded)
    const bytes = Buffer.concat(f.host.feed.mock.calls.map((call) => call[2]))
    expect(bytes.equals(Buffer.from(decoded, 'utf8'))).toBe(true)
    expect(f.host.feed.mock.calls.every((call) => call[2].byteLength <= 16384)).toBe(true)
    expect(order).toEqual(['feed', 'drain', 'feed', 'drain', 'feed', 'drain'])
    expect(f.writer.writeReply.mock.calls).toEqual(
      Array.from({ length: 3 }, () => [Uint8Array.of(0xff, 0x80, 0x1b)]),
    )
  })

  it('keeps parsing independent of revoked renderer and retains exited history readonly', async () => {
    const f = fixture()
    const prepared = await f.prepare()
    prepared.connect(f.writer)
    f.current.mockReturnValue(false)
    await prepared.output('final output')
    await prepared.exited({ exitCode: 0, signal: undefined })
    expect(f.sessions.get('session')).toMatchObject({ handle: 'handle', readonly: true })
    expect(f.sessions.resolve('session')).toEqual(f.reservation)
    expect(f.host.end).not.toHaveBeenCalled()
    await expect(prepared.output('late')).rejects.toThrow('not-live')
    await prepared.dispose()
    await prepared.dispose()
    expect(f.host.end).toHaveBeenCalledTimes(1)
  })

  it('does not replay an accepted prefix after an indeterminate feed failure', async () => {
    const f = fixture()
    const prepared = await f.prepare()
    prepared.connect(f.writer)
    f.host.feed
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('indeterminate'))
    await expect(prepared.output('x'.repeat(32_768))).rejects.toThrow('indeterminate')
    expect(f.host.feed).toHaveBeenCalledTimes(2)
    expect(f.sessions.get('session')?.readonly).toBe(true)
    await expect(prepared.output('retry')).rejects.toThrow('not-live')
    expect(f.host.end).not.toHaveBeenCalled()
  })

  it('finishes accepted output after physical exit, discards raw replies and retains final history', async () => {
    const f = fixture()
    const prepared = await f.prepare()
    prepared.connect(f.writer)
    const pending = deferred<void>()
    f.host.feed.mockReturnValueOnce(pending.promise)
    f.host.drainReplies.mockResolvedValue(Uint8Array.of(0xff))
    const finalOutput = prepared.output('last output')
    f.writer.live = false
    pending.resolve()
    await finalOutput
    await prepared.output('already accepted tail')
    await prepared.exited({ exitCode: 0, signal: undefined })
    expect(f.host.feed).toHaveBeenCalledTimes(2)
    expect(f.host.drainReplies).toHaveBeenCalledTimes(2)
    expect(f.writer.writeReply).not.toHaveBeenCalled()
    expect(f.sessions.get('session')?.readonly).toBe(true)
    expect(f.host.end).not.toHaveBeenCalled()
  })

  it('reports a bounded ingress failure without killing or silently reconstructing the native parser', async () => {
    const f = fixture()
    const prepared = await f.prepare()
    prepared.connect(f.writer)
    prepared.failed(new Error('source-overrun'))
    expect(f.sessions.get('session')?.readonly).toBe(true)
    await expect(prepared.output('late')).rejects.toThrow('not-live')
    expect(f.host.prepare).toHaveBeenCalledTimes(1)
    expect(f.host.end).not.toHaveBeenCalled()
    await prepared.dispose()
    expect(f.host.end).toHaveBeenCalledTimes(1)
  })

  it('retries only a proven unsent admission and keeps the same exact bytes', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const prepared = await f.prepare()
    prepared.connect(f.writer)
    f.host.feed.mockRejectedValueOnce(new NativeTerminalAdmissionError())
    const output = prepared.output('one')
    await vi.advanceTimersByTimeAsync(16)
    await output
    expect(f.host.feed).toHaveBeenCalledTimes(2)
    expect(f.host.feed.mock.calls[0]?.[2]).toEqual(f.host.feed.mock.calls[1]?.[2])
  })

  it('bounds admission retries and cancels them on explicit removal', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const prepared = await f.prepare()
    prepared.connect(f.writer)
    f.host.feed.mockRejectedValue(new NativeTerminalAdmissionError())
    const output = expect(prepared.output('one')).rejects.toThrow()
    await vi.advanceTimersByTimeAsync(16)
    await prepared.dispose()
    await vi.advanceTimersByTimeAsync(16)
    await output
    expect(f.host.feed).toHaveBeenCalledTimes(2)
  })

  it('expires proven-unsent retry pressure without replaying or retiring the parser', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const prepared = await f.prepare()
    prepared.connect(f.writer)
    f.host.feed.mockRejectedValue(new NativeTerminalAdmissionError())
    const output = expect(prepared.output('one')).rejects.toBeInstanceOf(
      NativeTerminalAdmissionError,
    )
    await vi.advanceTimersByTimeAsync(15_008)
    await output
    expect(f.sessions.get('session')).toMatchObject({ readonly: true, unavailable: true })
    expect(f.host.end).not.toHaveBeenCalled()
  })

  it('rejects invalid viewport before allocation and revoked late preparation before activation', async () => {
    const f = fixture()
    await expect(
      f.sessions.prepare(f.reservation, f.signal.signal, {
        width: 0,
        height: 400,
        backingScale: 1,
      }),
    ).rejects.toThrow('geometry-invalid')
    expect(f.host.prepare).not.toHaveBeenCalled()
    const pending = deferred<string>()
    f.host.prepare.mockReturnValue(pending.promise)
    const preparing = f.prepare()
    f.current.mockReturnValue(false)
    pending.resolve('handle')
    await expect(preparing).rejects.toThrow('session-revoked')
    expect(f.host.end).toHaveBeenCalledExactlyOnceWith('handle', 'instance')
  })

  it('rejects stale instance disposal and host-changing transfer without affecting current state', async () => {
    const f = fixture()
    const prepared = await f.prepare()
    prepared.connect(f.writer)
    await expect(f.sessions.remove('session', 'old-instance')).rejects.toThrow(
      'instance-stale',
    )
    expect(() =>
      f.sessions.transferOwner(
        'session',
        'instance',
        2,
        2,
        hostPath('ssh:other' as HostId, '/project'),
      ),
    ).toThrow('transfer-stale')
    f.sessions.transferOwner('session', 'instance', 2, 2, hostPath(LOCAL_HOST_ID, '/new'))
    expect(f.sessions.resolve('session')).toMatchObject({
      ownerId: 2,
      ownerGeneration: 2,
      workspaceRoot: hostPath(LOCAL_HOST_ID, '/new'),
    })
    await prepared.output('same parser')
    expect(f.host.end).not.toHaveBeenCalled()
  })
})
