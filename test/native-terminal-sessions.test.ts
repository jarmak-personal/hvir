import { NativeTerminalEffectPolicy } from '../src/main/terminal/native-terminal-effect-policy'
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
function fixture(effectPolicy?: NativeTerminalEffectPolicy) {
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
    drainEffectsProducer: vi.fn<
      () => Promise<
        import('../src/shared/native-terminal-effects').NativeTerminalEffectBatch
      >
    >(() => Promise.resolve({ effects: [], droppedEffects: 0, semanticGeneration: 0 })),
    drainReplies: vi.fn(() => Promise.resolve(new Uint8Array())),
    end: vi.fn(() => Promise.resolve()),
  }
  const current = vi.fn(() => true)
  const sessions = new NativeTerminalSessions(host, current, undefined, effectPolicy)
  const signal = new AbortController()
  const writer = {
    live: true,
    parsed: vi.fn<(bytes: number) => void>(),
    repliesDispatched: vi.fn<(bytes: number) => void>(),
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
  it('retains immutable native facts across owner transfer without authorizing old-owner effects', async () => {
    const clipboard = { writeText: vi.fn() },
      publish = vi.fn()
    const f = fixture(new NativeTerminalEffectPolicy(clipboard, publish))
    const prepared = await f.prepare()
    prepared.connect(f.writer)
    const feeding = deferred<void>()
    f.host.feed.mockReturnValueOnce(feeding.promise)
    f.host.drainEffectsProducer.mockResolvedValue({
      effects: [
        {
          kind: 'clipboard',
          protocol: 'osc-52',
          selection: '',
          data: 'YQ==',
          sequence: 1,
          eventSerial: 1,
        },
        { kind: 'bell', sequence: 1, eventSerial: 2 },
        { kind: 'title', title: 'actual native title', sequence: 1, eventSerial: 3 },
        {
          kind: 'cwd',
          uri: 'file://reported-host/actual/native/path',
          sequence: 1,
          eventSerial: 4,
        },
      ],
      droppedEffects: 4,
      semanticGeneration: 2,
    })
    const output = prepared.output('A')
    await vi.waitFor(() => expect(f.host.feed).toHaveBeenCalledTimes(1))
    f.sessions.transferOwner('session', 'instance', 2, 2, f.reservation.workspaceRoot)
    feeding.resolve()
    await output
    expect(clipboard.writeText).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
    expect(f.sessions.get('session')).toMatchObject({
      session: { instanceId: 'instance', ownerId: 2, ownerGeneration: 2 },
      title: { title: 'actual native title', eventSerial: 3 },
      cwd: hostPath(f.reservation.workspaceRoot.hostId, '/actual/native/path'),
      effectState: { droppedEffects: 4, semanticGeneration: 2 },
    })
    f.host.drainEffectsProducer.mockResolvedValue({
      effects: [
        {
          kind: 'clipboard',
          protocol: 'osc-52',
          selection: '',
          data: 'Yg==',
          sequence: 2,
          eventSerial: 5,
        },
      ],
      droppedEffects: 4,
      semanticGeneration: 2,
    })
    await prepared.output('B')
    expect(clipboard.writeText).toHaveBeenCalledExactlyOnceWith('b')
    f.writer.live = false
    f.host.drainEffectsProducer.mockResolvedValue({
      effects: [
        { kind: 'title', title: 'current B finished title', sequence: 3, eventSerial: 6 },
        {
          kind: 'clipboard',
          protocol: 'osc-52',
          selection: '',
          data: 'Yw==',
          sequence: 3,
          eventSerial: 7,
        },
        { kind: 'bell', sequence: 3, eventSerial: 8 },
      ],
      droppedEffects: 4,
      semanticGeneration: 2,
    })
    await prepared.output('B retained tail')
    expect(publish).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ ownerId: 2, ownerGeneration: 2 }),
      {
        id: 'session',
        instanceId: 'instance',
        eventSerial: 6,
        effect: { kind: 'title', title: 'current B finished title' },
      },
    )
    expect(clipboard.writeText).toHaveBeenCalledTimes(1)
    expect(f.sessions.get('session')?.title).toEqual({
      title: 'current B finished title',
      eventSerial: 6,
    })
  })
  it('rejects an old copied batch after removal without changing a replacement native instance', async () => {
    const clipboard = { writeText: vi.fn() },
      publish = vi.fn()
    const f = fixture(new NativeTerminalEffectPolicy(clipboard, publish))
    const prepared = await f.prepare()
    prepared.connect(f.writer)
    const effects =
      deferred<
        import('../src/shared/native-terminal-effects').NativeTerminalEffectBatch
      >()
    f.host.drainEffectsProducer.mockReturnValueOnce(effects.promise)
    const oldOutput = prepared.output('old instance')
    void oldOutput.catch(() => undefined)
    await vi.waitFor(() => expect(f.host.drainEffectsProducer).toHaveBeenCalledTimes(1))
    await f.sessions.remove('session', 'instance')
    f.host.prepare.mockResolvedValueOnce('fresh-handle')
    const fresh = await f.sessions.prepare(
      { ...f.reservation, instanceId: 'replacement' },
      f.signal.signal,
      { width: 640, height: 400, backingScale: 1 },
    )
    fresh.connect(f.writer)
    effects.resolve({
      effects: [
        { kind: 'title', title: 'removed title', sequence: 1, eventSerial: 1 },
        { kind: 'cwd', uri: 'file:///removed/path', sequence: 1, eventSerial: 2 },
      ],
      droppedEffects: 9,
      semanticGeneration: 4,
    })
    await expect(oldOutput).rejects.toThrow()
    expect(f.sessions.get('session')).toMatchObject({
      handle: 'fresh-handle',
      session: { instanceId: 'replacement' },
      unavailable: false,
    })
    expect(f.sessions.get('session')?.title).toBeUndefined()
    expect(f.sessions.get('session')?.cwd).toBeUndefined()
    expect(f.sessions.get('session')?.effectState).toBeUndefined()
    expect(publish).not.toHaveBeenCalled()
    expect(clipboard.writeText).not.toHaveBeenCalled()
  })
  it('does not duplicate coalesced effects and survives failed resource execution', async () => {
    const publish = vi.fn(),
      clipboard = {
        writeText: vi.fn(() => {
          throw new Error('clipboard failed')
        }),
      }
    const f = fixture(new NativeTerminalEffectPolicy(clipboard, publish))
    const prepared = await f.prepare()
    prepared.connect(f.writer)
    const effects = [
      { kind: 'bell' as const, sequence: 1, eventSerial: 3 },
      {
        kind: 'clipboard' as const,
        protocol: 'osc-52' as const,
        data: 'YQ==',
        selection: '',
        sequence: 1,
        eventSerial: 4,
      },
      { kind: 'title' as const, title: 'latest', sequence: 1, eventSerial: 10 },
    ]
    f.host.drainEffectsProducer.mockResolvedValue({
      effects,
      droppedEffects: 1,
      semanticGeneration: 2,
    })
    await prepared.output('a')
    await prepared.output('b')
    expect(publish).toHaveBeenCalledTimes(2)
    expect(clipboard.writeText).toHaveBeenCalledTimes(1)
    expect(f.sessions.get('session')?.unavailable).toBe(false)
    expect(f.host.feed).toHaveBeenCalledTimes(2)
    expect(f.sessions.get('session')?.title).toEqual({ title: 'latest', eventSerial: 10 })
    expect(f.sessions.get('session')?.effectState).toEqual({
      droppedEffects: 1,
      semanticGeneration: 2,
    })
  })
  it.each(['unknown-input', 'input-closed', 'renderer-revoked'] as const)(
    'continues parse and the sole drain without side effects after %s',
    async (reason) => {
      const clipboard = { writeText: vi.fn() },
        publish = vi.fn()
      const f = fixture(new NativeTerminalEffectPolicy(clipboard, publish))
      const prepared = await f.prepare()
      prepared.connect(f.writer)
      f.host.drainEffectsProducer.mockResolvedValue({
        effects: [
          { kind: 'bell', sequence: 1, eventSerial: 1 },
          {
            kind: 'clipboard',
            protocol: 'osc-52',
            selection: '',
            data: 'YQ==',
            sequence: 1,
            eventSerial: 2,
          },
        ],
        droppedEffects: 0,
        semanticGeneration: 0,
      })
      if (reason === 'unknown-input') f.sessions.blockInput('session', 'instance')
      else if (reason === 'input-closed') f.writer.live = false
      else f.current.mockReturnValue(false)
      await prepared.output('still parsed')
      expect(f.host.feed).toHaveBeenCalledTimes(1)
      expect(f.host.drainEffectsProducer).toHaveBeenCalledTimes(1)
      expect(clipboard.writeText).not.toHaveBeenCalled()
      expect(publish).not.toHaveBeenCalled()
      expect(f.sessions.get('session')?.unavailable).toBe(false)
    },
  )
  it('waits for definitive feed IO completion before draining a final silent query', async () => {
    const f = fixture()
    const prepared = await f.prepare()
    prepared.connect(f.writer)
    const parsed = { ...nativeTerminalStatus(), appliedSequence: 1, ioAppliedSequence: 0 }
    f.host.inspectProducer.mockResolvedValue(parsed)
    f.host.drainReplies.mockResolvedValueOnce(new Uint8Array([27, 91, 48, 110]))
    const output = prepared.output('\x1b[5n')
    await vi.waitFor(() => expect(f.writer.parsed).toHaveBeenCalledExactlyOnceWith(4))
    expect(f.host.drainReplies).not.toHaveBeenCalled()
    expect(f.writer.writeReply).not.toHaveBeenCalled()
    f.host.inspectProducer.mockResolvedValue({ ...parsed, ioAppliedSequence: 1 })
    await output
    expect(f.host.inspectProducer).toHaveBeenCalledWith('handle', 'instance', true)
    expect(f.writer.writeReply).toHaveBeenCalledExactlyOnceWith(
      new Uint8Array([27, 91, 48, 110]),
    )
    expect(f.writer.repliesDispatched).toHaveBeenCalledExactlyOnceWith(4)
  })
  it('appends parser replies before waiting for effects, retaining one physical producer slot', async () => {
    const f = fixture(),
      effects = deferred<{
        effects: []
        droppedEffects: number
        semanticGeneration: number
      }>(),
      written = deferred<void>()
    const prepared = await f.prepare()
    prepared.connect(f.writer)
    f.host.drainReplies.mockResolvedValueOnce(new Uint8Array([27, 91, 48, 110]))
    f.host.drainEffectsProducer.mockReturnValueOnce(effects.promise)
    f.writer.writeReply.mockReturnValueOnce(written.promise)
    const output = prepared.output('x'.repeat(17000))
    await vi.waitFor(() => expect(f.host.drainEffectsProducer).toHaveBeenCalledOnce())
    expect(f.writer.writeReply).toHaveBeenCalledExactlyOnceWith(
      new Uint8Array([27, 91, 48, 110]),
    )
    expect(f.writer.parsed).toHaveBeenCalledExactlyOnceWith(16384)
    effects.resolve({ effects: [], droppedEffects: 0, semanticGeneration: 0 })
    await Promise.resolve()
    expect(f.host.feed).toHaveBeenCalledOnce()
    written.resolve()
    await output
    expect(f.host.feed).toHaveBeenCalledTimes(2)
  })
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
  it('keeps an indeterminate input block on the immutable instance through output and owner transfer', async () => {
    const f = fixture(),
      prepared = await f.prepare()
    prepared.connect(f.writer)
    f.sessions.blockInput('session', 'other-instance')
    expect(f.sessions.get('session')?.inputUnavailable).toBe(false)
    f.sessions.blockInput('session', 'instance')
    f.host.drainReplies.mockResolvedValue(new Uint8Array([27, 91, 48, 110]))
    await prepared.output('first')
    await f.sessions.writeControl('session', 'instance', new Uint8Array([1]))
    f.sessions.transferOwner('session', 'instance', 1, 2, f.reservation.workspaceRoot)
    await prepared.output('second')
    expect(f.sessions.get('session')).toMatchObject({
      inputUnavailable: true,
      readonly: false,
      unavailable: false,
      session: { instanceId: 'instance', ownerGeneration: 2 },
    })
    expect(f.host.feed).toHaveBeenCalledTimes(2)
    expect(f.host.drainReplies).toHaveBeenCalledTimes(2)
    expect(f.writer.parsed).toHaveBeenCalledTimes(2)
    expect(f.writer.repliesDispatched).toHaveBeenCalledTimes(2)
    expect(f.writer.writeReply).not.toHaveBeenCalled()
    expect(f.host.end).not.toHaveBeenCalled()
  })

  it('discards control and reply bytes after known physical input close while parsing the tail', async () => {
    const f = fixture(),
      prepared = await f.prepare()
    prepared.connect(f.writer)
    f.writer.live = false
    f.host.drainReplies.mockResolvedValue(new Uint8Array([1]))
    await prepared.output('admitted-tail')
    await f.sessions.writeControl('session', 'instance', new Uint8Array([2]))
    expect(f.sessions.get('session')).toMatchObject({
      inputClosed: true,
      inputUnavailable: false,
    })
    expect(f.host.feed).toHaveBeenCalledOnce()
    expect(f.host.drainReplies).toHaveBeenCalledOnce()
    expect(f.writer.writeReply).not.toHaveBeenCalled()
  })
  it('joins active input and captured cleanup across owner transfer without an old ACK clearing newer work', async () => {
    const f = fixture()
    const prepared = await f.prepare()
    prepared.connect(f.writer)
    const write = deferred<void>(),
      cleanup = deferred<void>()
    expect(f.sessions.inputSettled('session', 'instance')).toBeUndefined()
    f.sessions.retainInput('session', 'instance', write.promise)
    const oldFence = f.sessions.inputSettled('session', 'instance')!
    f.sessions.retainInput('session', 'instance', cleanup.promise)
    const joinedFence = f.sessions.inputSettled('session', 'instance')!
    expect(joinedFence).not.toBe(oldFence)
    f.sessions.transferOwner('session', 'instance', 1, 2, f.reservation.workspaceRoot)
    expect(f.sessions.inputSettled('session', 'instance')).toBe(joinedFence)
    f.sessions.blockInput('session', 'instance')
    write.resolve()
    await oldFence
    expect(f.sessions.inputSettled('session', 'instance')).toBe(joinedFence)
    cleanup.resolve()
    await joinedFence
    expect(f.sessions.inputSettled('session', 'instance')).toBeUndefined()
    expect(f.sessions.get('session')).toMatchObject({
      inputUnavailable: true,
      session: { instanceId: 'instance', ownerGeneration: 2 },
    })
  })

  it('isolates foreign, removed and reused session instances from late input settlement', async () => {
    const f = fixture()
    const prepared = await f.prepare()
    prepared.connect(f.writer)
    const oldWrite = deferred<void>(),
      freshCleanup = deferred<void>()
    f.sessions.retainInput('session', 'instance', oldWrite.promise)
    const oldFence = f.sessions.inputSettled('session', 'instance')!
    expect(() => f.sessions.inputSettled('session', 'foreign')).toThrow(
      'native-session-instance-stale',
    )
    expect(() => f.sessions.retainInput('session', 'foreign', Promise.resolve())).toThrow(
      'native-session-instance-stale',
    )
    await f.sessions.remove('session', 'instance')
    expect(() => f.sessions.inputSettled('session', 'instance')).toThrow(
      'native-session-instance-stale',
    )
    expect(() =>
      f.sessions.retainInput('session', 'instance', Promise.resolve()),
    ).toThrow('native-session-instance-stale')
    const fresh = await f.sessions.prepare(
      { ...f.reservation, instanceId: 'fresh-instance' },
      new AbortController().signal,
      { width: 640, height: 400, backingScale: 1 },
    )
    fresh.connect(f.writer)
    expect(f.sessions.inputSettled('session', 'fresh-instance')).toBeUndefined()
    f.sessions.retainInput('session', 'fresh-instance', freshCleanup.promise)
    const freshFence = f.sessions.inputSettled('session', 'fresh-instance')!
    oldWrite.resolve()
    await oldFence
    f.sessions.blockInput('session', 'instance')
    expect(f.sessions.inputSettled('session', 'fresh-instance')).toBe(freshFence)
    expect(f.sessions.get('session')).toMatchObject({
      inputUnavailable: false,
      session: { instanceId: 'fresh-instance' },
    })
    expect(() =>
      f.sessions.retainInput('session', 'instance', Promise.resolve()),
    ).toThrow('native-session-instance-stale')
    freshCleanup.reject(new Error('captured-cleanup-failed'))
    await expect(freshCleanup.promise).rejects.toThrow('captured-cleanup-failed')
    await freshFence
    expect(f.sessions.inputSettled('session', 'fresh-instance')).toBeUndefined()
  })
})
