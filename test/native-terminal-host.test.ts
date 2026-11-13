import { afterEach, describe, expect, it, vi } from 'vitest'
import { hostPath, LOCAL_HOST_ID } from '../src/shared/host-path'
import {
  NativeTerminalAdmissionError,
  type NativeTerminalCommand,
  type NativeTerminalSession,
  type NativeTerminalStatus,
} from '../src/shared/native-terminal'
import type { WebFrameMain } from 'electron'
import { NativeTerminalFrameImports } from '../src/main/terminal/native-terminal-import'
import { NativeTerminalHost } from '../src/main/terminal/native-terminal-host'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
function status(serial = 1): NativeTerminalStatus {
  return {
    appliedSequence: 0,
    replySequence: 0,
    queuedReplyBytes: 0,
    failure: 0,
    closing: false,
    rendererHealth: 0,
    presentationFailure: 0,
    frameCopies: 0,
    geometryFailureSerial: 0,
    geometry: {
      serial,
      backingScale: 1,
      columns: 4,
      rows: 4,
      width: 32,
      height: 32,
      cellWidth: 8,
      cellHeight: 8,
      contentWidth: 32,
      contentHeight: 32,
      paddingLeft: 0,
      paddingTop: 0,
    },
  }
}
function fixture(exitEvidence?: (epoch: string) => boolean) {
  const sessions = new Map<string, NativeTerminalSession>()
  const live = {
    renderer: true,
    owner: 1,
    generation: 1,
    available: true,
    status: status(),
  }
  let nextState = 0
  let nextLease = 0
  const held = new Set<string>()
  const request = vi.fn(
    (command: NativeTerminalCommand, _signal?: AbortSignal): Promise<unknown> => {
      switch (command.kind) {
        case 'create':
          return Promise.resolve({ state: String(++nextState), status: status() })
        case 'inspect':
          return Promise.resolve(live.status)
        case 'read':
          return Promise.resolve(new Uint8Array([1]))
        case 'frame':
          held.add(command.state)
          return Promise.resolve({
            lease: String(++nextLease),
            streamSequence: 0,
            geometrySerial: 1,
            kind: 1,
            width: 32,
            height: 32,
            colorSpace: 2,
            origin: 1,
            premultiplied: true,
          })
        case 'release':
          held.delete(command.state)
          return Promise.resolve({ result: 0 })
        case 'destroy':
          return Promise.resolve({ result: held.has(command.state) ? 6 : 0 })
        default:
          return Promise.resolve({ result: 0 })
      }
    },
  )
  const process = {
    epoch: 'host-1',
    ...(exitEvidence ? { hasExited: vi.fn(exitEvidence) } : {}),
    get available() {
      return live.available
    },
    request,
    idle: vi.fn(() => Promise.resolve()),
    dispose: vi.fn(() => {
      live.available = false
    }),
  }
  const authority = {
    resolve: (id: string) => sessions.get(id),
    isRendererCurrent: (owner: number, generation: number) =>
      live.renderer && owner === live.owner && generation === live.generation,
  }
  const session = (id = 0): NativeTerminalSession => {
    const value = {
      sessionId: `session-${id}`,
      instanceId: `instance-${id}`,
      ownerId: live.owner,
      ownerGeneration: live.generation,
      workspaceRoot: hostPath(LOCAL_HOST_ID, '/native-proof'),
    }
    sessions.set(value.sessionId, value)
    return value
  }
  return {
    host: new NativeTerminalHost(process, authority),
    process,
    request,
    sessions,
    live,
    session,
  }
}

afterEach(() => vi.useRealTimers())

describe('native terminal main session authority', () => {
  it('distinguishes absent frames from presentation failure while preserving parser authority', async () => {
    const f = fixture(),
      session = f.session()
    const handle = await f.host.prepare(session, 32, 32)
    const attachment = f.host.attach(handle, session)
    f.request.mockResolvedValueOnce({ unavailable: 6 })
    await expect(f.host.takeFrame(handle, 1, 1, attachment)).resolves.toBeUndefined()
    f.request.mockResolvedValueOnce({ unavailable: 9 })
    await expect(f.host.takeFrame(handle, 1, 1, attachment)).rejects.toThrow(
      'native-presentation-unavailable',
    )
    await f.host.feed(handle, session.instanceId, Uint8Array.of(65))
    await expect(f.host.read(handle, 1, 1)).resolves.toEqual(Uint8Array.of(1))
    expect(f.request.mock.calls.some(([command]) => command.kind === 'destroy')).toBe(
      false,
    )
    expect(f.process.dispose).not.toHaveBeenCalled()
    const frame = await f.host.takeFrame(handle, 1, 1, attachment)
    expect(frame).toBeDefined()
    expect('retire' in frame!).toBe(false)
    await frame!.release()
    await f.host.end(handle, session.instanceId)
  })
  it('reserves duplicate and global state capacity while preparation is still pending', async () => {
    const f = fixture(),
      creation = deferred<void>()
    let nativeState = 0
    f.request.mockImplementation(() => {
      const state = String(++nativeState)
      return creation.promise.then(() => ({ state, status: status() }))
    })
    const first = f.session()
    const pending = [f.host.prepare(first, 32, 32)]
    await expect(f.host.prepare(first, 32, 32)).rejects.toThrow('native-state-bound')
    for (let i = 1; i < 32; i++) pending.push(f.host.prepare(f.session(i), 32, 32))
    await expect(f.host.prepare(f.session(32), 32, 32)).rejects.toThrow(
      'native-state-bound',
    )
    expect(f.request).toHaveBeenCalledTimes(32)
    creation.resolve()
    expect(await Promise.all(pending)).toHaveLength(32)
    f.host.dispose()
  })

  it('feeds one immutable producer snapshot across renderer rollover and absent presentation', async () => {
    const f = fixture(),
      original = f.session()
    const handle = await f.host.prepare(original, 32, 32)
    const attachment = f.host.attach(handle, original)
    f.host.detach(handle, 1, 1, attachment)
    const firstChunk = deferred<unknown>(),
      entered = deferred<void>()
    f.request.mockImplementation((command) => {
      if (command.kind === 'feed' && command.sequence === 1) {
        entered.resolve()
        return firstChunk.promise
      }
      return Promise.resolve({ result: 0 })
    })
    const bytes = new Uint8Array(16385).fill(7)
    const feeding = f.host.feed(handle, original.instanceId, bytes)
    await entered.promise
    bytes.fill(9)
    f.live.owner = 2
    f.live.generation = 2
    f.live.renderer = false
    f.sessions.set(original.sessionId, { ...original, ownerId: 2, ownerGeneration: 2 })
    firstChunk.resolve(undefined)
    await feeding
    const chunks = f.request.mock.calls
      .map(([command]) => command)
      .filter((command) => command.kind === 'feed')
    expect(
      chunks.map((command) => [
        command.sequence,
        command.bytes.byteLength,
        command.bytes[0],
      ]),
    ).toEqual([
      [1, 16384, 7],
      [2, 1, 7],
    ])
    await expect(f.host.read(handle, 1, 1)).rejects.toThrow('native-state-foreign')
  })

  it('rejects overlapping delivery and retires the admitted state without merging output', async () => {
    const f = fixture(),
      current = f.session()
    const handle = await f.host.prepare(current, 32, 32)
    const active = deferred<unknown>(),
      entered = deferred<void>()
    f.request.mockImplementation((command) => {
      if (command.kind === 'feed') {
        entered.resolve()
        return active.promise
      }
      return Promise.resolve({ result: 0 })
    })
    const first = f.host.feed(handle, current.instanceId, new Uint8Array(16385))
    const rejected = expect(first).rejects.toThrow('native-producer-revoked')
    await entered.promise
    await expect(
      f.host.feed(handle, current.instanceId, new Uint8Array([2])),
    ).rejects.toThrow('native-concurrent-delivery')
    active.resolve(undefined)
    await rejected
    expect(
      f.request.mock.calls
        .map(([command]) => command.kind)
        .filter((kind) => kind === 'feed'),
    ).toHaveLength(1)
    expect(f.request.mock.calls.map(([command]) => command.kind)).toContain('destroy')
  })

  it('rejects a detached presentation even when its former serial is guessed correctly', async () => {
    const f = fixture(),
      current = f.session()
    const handle = await f.host.prepare(current, 32, 32)
    const serial = f.host.attach(handle, current)
    f.host.detach(handle, 1, 1, serial)
    const before = f.request.mock.calls.length
    await expect(f.host.resize(handle, 1, 1, serial, 2, 32, 32)).rejects.toThrow(
      'native-attachment-stale',
    )
    await expect(f.host.takeFrame(handle, 1, 1, serial)).rejects.toThrow(
      'native-attachment-stale',
    )
    expect(f.request.mock.calls).toHaveLength(before)
  })

  it('invalidates a held frame on a newer equal-size request before its acknowledgement', async () => {
    const f = fixture(),
      current = f.session()
    const handle = await f.host.prepare(current, 32, 32)
    const attachment = f.host.attach(handle, current)
    const frame = await f.host.takeFrame(handle, 1, 1, attachment)
    expect(frame).toBeDefined()
    const resized = deferred<unknown>(),
      entered = deferred<void>()
    f.request.mockImplementation((command) => {
      if (command.kind === 'resize') {
        entered.resolve()
        return resized.promise
      }
      if (command.kind === 'inspect') return Promise.resolve(f.live.status)
      return Promise.resolve({ result: 0 })
    })
    const resizing = f.host.resize(handle, 1, 1, attachment, 2, 32, 32)
    await entered.promise
    expect(() => frame!.assertCurrent()).toThrow('native-frame-stale')
    f.live.status = status(2)
    resized.resolve(undefined)
    expect((await resizing).geometry.serial).toBe(2)
    await frame!.release()
  })

  it('retains parser identity through authorized renderer reattachment and rejects the old owner', async () => {
    const f = fixture(),
      previous = f.session()
    const handle = await f.host.prepare(previous, 32, 32)
    const first = f.host.attach(handle, previous)
    f.live.owner = 2
    f.live.generation = 2
    const next = { ...previous, ownerId: 2, ownerGeneration: 2 }
    f.sessions.set(previous.sessionId, next)
    expect(f.host.attach(handle, next)).toBeGreaterThan(first)
    await expect(f.host.read(handle, 1, 1)).rejects.toThrow('native-state-foreign')
    expect(await f.host.read(handle, 2, 2)).toEqual(new Uint8Array([1]))
    await f.host.feed(handle, previous.instanceId, new Uint8Array([2]))
    expect(
      f.request.mock.calls.filter(([command]) => command.kind === 'create'),
    ).toHaveLength(1)
  })

  it('stops the shared process when a malformed completion can conceal a real lease', async () => {
    const f = fixture(),
      current = f.session()
    const handle = await f.host.prepare(current, 32, 32)
    const attachment = f.host.attach(handle, current)
    const sibling = f.session(1)
    const other = await f.host.prepare(sibling, 32, 32)
    f.request.mockImplementation((command) =>
      Promise.resolve(command.kind === 'frame' ? { lease: 'malformed' } : { result: 0 }),
    )
    await expect(f.host.takeFrame(handle, 1, 1, attachment)).rejects.toThrow(
      'native-frame-invalid',
    )
    expect(f.process.dispose).toHaveBeenCalledTimes(1)
    await expect(
      f.host.feed(other, sibling.instanceId, new Uint8Array([1])),
    ).rejects.toThrow('native-host-lost')
  })

  it('settles a held frame after trusted lifetime end once even after renderer revocation', async () => {
    const f = fixture(),
      current = f.session()
    const handle = await f.host.prepare(current, 32, 32)
    const attachment = f.host.attach(handle, current)
    const frame = await f.host.takeFrame(handle, 1, 1, attachment)
    expect(frame).toBeDefined()
    f.sessions.delete(current.sessionId)
    await f.host.end(handle, current.instanceId)
    expect(() => frame!.assertCurrent()).toThrow('native-state-closed')
    await frame!.release()
    await frame!.release()
    await f.host.end(handle, current.instanceId)
    const commands = f.request.mock.calls.map(([command]) => command.kind)
    expect(commands.filter((kind) => kind === 'release')).toHaveLength(1)
    expect(commands.filter((kind) => kind === 'destroy')).toHaveLength(2)
  })
})

it('preserves parser and stream sequence on a proven-unsent first chunk refusal', async () => {
  const f = fixture(),
    session = f.session()
  const handle = await f.host.prepare(session, 32, 32)
  let refuse = true
  const ordinary = f.request.getMockImplementation()!
  f.request.mockImplementation((command, signal) => {
    if (command.kind === 'feed' && refuse) {
      refuse = false
      return Promise.reject(new NativeTerminalAdmissionError())
    }
    return ordinary(command, signal)
  })
  await expect(
    f.host.feed(handle, session.instanceId, new Uint8Array([1, 2])),
  ).rejects.toBeInstanceOf(NativeTerminalAdmissionError)
  await f.host.feed(handle, session.instanceId, new Uint8Array([1, 2]))
  const feeds = f.request.mock.calls
    .map(([command]) => command)
    .filter((command) => command.kind === 'feed')
  expect(feeds.map((command) => command.sequence)).toEqual([1, 1])
  expect(f.request.mock.calls.some(([command]) => command.kind === 'destroy')).toBe(false)
  expect(f.process.available).toBe(true)
})

it('reports a non-retriable stream failure after an accepted partial whole delivery', async () => {
  const f = fixture(),
    session = f.session(),
    sibling = f.session(1)
  const handle = await f.host.prepare(session, 32, 32)
  const other = await f.host.prepare(sibling, 32, 32)
  const ordinary = f.request.getMockImplementation()!
  f.request.mockImplementation((command, signal) =>
    command.kind === 'feed' && command.state === '1' && command.sequence === 2
      ? Promise.reject(new NativeTerminalAdmissionError())
      : ordinary(command, signal),
  )
  const failed = f.host.feed(handle, session.instanceId, new Uint8Array(16385))
  await expect(failed).rejects.toThrow('native-stream-failed')
  await expect(failed).rejects.not.toBeInstanceOf(NativeTerminalAdmissionError)
  await expect(
    f.host.feed(handle, session.instanceId, new Uint8Array([1])),
  ).rejects.toThrow('revoked')
  await f.host.feed(other, sibling.instanceId, new Uint8Array([2]))
  expect(f.process.available).toBe(true)
})

it.each([
  [0, 32],
  [31, 32],
  [8193, 32],
  [32.5, 32],
  [32, 0],
  [32, 8193],
  [NaN, 32],
])(
  'refuses invalid extent %s x %s before preparation or admitted geometry changes',
  async (width, height) => {
    const f = fixture(),
      session = f.session()
    await expect(f.host.prepare(session, width, height)).rejects.toThrow('extent-invalid')
    expect(f.request).not.toHaveBeenCalled()
    const handle = await f.host.prepare(session, 32, 32)
    const attachment = f.host.attach(handle, session)
    const frame = await f.host.takeFrame(
      handle,
      session.ownerId,
      session.ownerGeneration,
      attachment,
    )
    const before = f.request.mock.calls.length
    await expect(
      f.host.resize(handle, 1, 1, attachment, 2, width, height),
    ).rejects.toThrow('extent-invalid')
    expect(f.request).toHaveBeenCalledTimes(before)
    expect(() => frame!.assertCurrent()).not.toThrow()
    expect(f.process.available).toBe(true)
    await frame!.release()
    f.live.status = status(2)
    await f.host.resize(handle, 1, 1, attachment, 2, 32, 32)
  },
)

it.each([0, 9])(
  'retains and coalesces a safely refused release until native acknowledgement %s',
  async (result) => {
    vi.useFakeTimers()
    const f = fixture(),
      session = f.session()
    const handle = await f.host.prepare(session, 32, 32)
    const attachment = f.host.attach(handle, session)
    const frame = await f.host.takeFrame(handle, 1, 1, attachment)
    expect(frame).toBeDefined()
    const ordinary = f.request.getMockImplementation()!
    const acknowledged = deferred<void>()
    let attempts = 0
    f.request.mockImplementation((command, signal) => {
      if (command.kind !== 'release') return ordinary(command, signal)
      if (++attempts === 1) return Promise.reject(new NativeTerminalAdmissionError())
      return acknowledged.promise.then(async () => {
        await ordinary(command, signal)
        return { result }
      })
    })
    let released = false
    const first = frame!.release().then(() => {
      released = true
    })
    const duplicate = frame!.release()
    await vi.advanceTimersByTimeAsync(0)
    expect(attempts).toBe(1)
    expect(released).toBe(false)
    await expect(f.host.takeFrame(handle, 1, 1, attachment)).rejects.toThrow(
      'native-frame-bound',
    )
    expect(f.process.idle).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(16)
    expect(attempts).toBe(2)
    expect(released).toBe(false)
    acknowledged.resolve()
    await Promise.all([first, duplicate])
    expect(released).toBe(true)
    expect(attempts).toBe(2)
    const replacement = await f.host.takeFrame(handle, 1, 1, attachment)
    expect(replacement).toBeDefined()
    // Subsequent cleanup uses the immediate native dependency again.
    f.request.mockImplementation(ordinary)
    await replacement!.release()
    await f.host.end(handle, session.instanceId)
    expect(f.process.idle).toHaveBeenCalledTimes(1)
    expect(f.process.dispose).not.toHaveBeenCalled()
  },
)

it('retains a retiring state through unsent destroy pressure and a pending C acknowledgement', async () => {
  vi.useFakeTimers()
  const f = fixture(),
    session = f.session()
  const handle = await f.host.prepare(session, 32, 32)
  const ordinary = f.request.getMockImplementation()!
  const acknowledgement = deferred<unknown>()
  let attempts = 0
  f.request.mockImplementation((command, signal) => {
    if (command.kind !== 'destroy') return ordinary(command, signal)
    return ++attempts === 1
      ? Promise.reject(new NativeTerminalAdmissionError())
      : acknowledgement.promise
  })
  let ended = false
  const ending = f.host.end(handle, session.instanceId).then(() => {
    ended = true
  })
  const repeated = f.host.end(handle, session.instanceId)
  await vi.advanceTimersByTimeAsync(16)
  expect(attempts).toBe(2)
  expect(ended).toBe(false)
  expect(f.process.idle).not.toHaveBeenCalled()
  await expect(f.host.prepare(session, 32, 32)).rejects.toThrow('native-state-bound')
  acknowledgement.resolve({ result: 0 })
  await Promise.all([ending, repeated])
  expect(f.process.idle).toHaveBeenCalledTimes(1)
  expect(attempts).toBe(2)
  f.request.mockImplementation(ordinary)
  expect(await f.host.prepare(session, 32, 32)).toBeTypeOf('string')
})

it('never reports successful release after a native resource failure', async () => {
  const f = fixture(),
    session = f.session()
  const handle = await f.host.prepare(session, 32, 32)
  const attachment = f.host.attach(handle, session)
  const frame = await f.host.takeFrame(handle, 1, 1, attachment)
  const ordinary = f.request.getMockImplementation()!
  f.request.mockImplementation((command, signal) =>
    command.kind === 'release'
      ? Promise.resolve({ result: 5 })
      : ordinary(command, signal),
  )
  await expect(frame!.release()).rejects.toThrow('native-cleanup')
  await expect(frame!.release()).rejects.toThrow('native-cleanup')
  expect(
    f.request.mock.calls.filter(([command]) => command.kind === 'release'),
  ).toHaveLength(1)
  expect(f.process.dispose).toHaveBeenCalledTimes(1)
  expect(f.process.idle).not.toHaveBeenCalled()
  expect(f.process.available).toBe(false)
})

it('bounds repeated unsent cleanup pressure with fake time and fails explicitly without an idle claim', async () => {
  vi.useFakeTimers()
  const f = fixture(),
    session = f.session()
  const handle = await f.host.prepare(session, 32, 32)
  const attachment = f.host.attach(handle, session)
  const frame = await f.host.takeFrame(handle, 1, 1, attachment)
  const ordinary = f.request.getMockImplementation()!
  f.request.mockImplementation((command, signal) =>
    command.kind === 'release'
      ? Promise.reject(new NativeTerminalAdmissionError())
      : ordinary(command, signal),
  )
  const rejected = expect(frame!.release()).rejects.toThrow('native-cleanup')
  await vi.advanceTimersByTimeAsync(15016)
  await rejected
  expect(
    f.request.mock.calls.filter(([command]) => command.kind === 'release').length,
  ).toBeGreaterThan(1)
  expect(f.process.dispose).toHaveBeenCalledTimes(1)
  expect(f.process.idle).not.toHaveBeenCalled()
})

it('keeps cancelled physical frame cleanup owned through BUSY until final destroy while another state progresses', async () => {
  vi.useFakeTimers()
  const f = fixture(),
    session = f.session(),
    sibling = f.session(1)
  const handle = await f.host.prepare(session, 32, 32)
  const other = await f.host.prepare(sibling, 32, 32)
  const attachment = f.host.attach(handle, session)
  const physical = deferred<unknown>(),
    entered = deferred<void>()
  const ordinary = f.request.getMockImplementation()!
  const destroys: number[] = []
  let latePhysicalCleanupComplete = false
  f.request.mockImplementation((command, signal) => {
    if (command.kind === 'frame' && command.state === '1') {
      entered.resolve()
      return physical.promise
    }
    if (command.kind === 'destroy' && command.state === '1') {
      const result = latePhysicalCleanupComplete ? 0 : 6
      destroys.push(result)
      return Promise.resolve({ result })
    }
    return ordinary(command, signal)
  })
  const controller = new AbortController()
  const pending = f.host.takeFrame(handle, 1, 1, attachment, controller.signal)
  const cancelled = expect(pending).rejects.toThrow('frame-cancelled')
  await entered.promise
  let ended = false
  const ending = f.host.end(handle, session.instanceId).then(() => {
    ended = true
  })
  controller.abort()
  physical.reject(new Error('frame-cancelled'))
  await cancelled
  await vi.advanceTimersByTimeAsync(16)
  expect(destroys).toContain(6)
  expect(ended).toBe(false)
  expect(f.process.idle).not.toHaveBeenCalled()
  await expect(f.host.prepare(session, 32, 32)).rejects.toThrow('native-state-bound')
  await f.host.feed(other, sibling.instanceId, new Uint8Array([7]))
  // The immediate process port's late-acquisition cleanup has now received its
  // release acknowledgement. Main still requires a fresh final destroy ack.
  latePhysicalCleanupComplete = true
  await vi.advanceTimersByTimeAsync(16)
  await ending
  expect(destroys.at(-1)).toBe(0)
  expect(f.process.dispose).not.toHaveBeenCalled()
  expect(f.process.idle).not.toHaveBeenCalled()
  await f.host.end(other, sibling.instanceId)
  expect(f.process.idle).toHaveBeenCalledTimes(1)
})

it('retains a transport-failed lease until the captured epoch has physically exited', async () => {
  vi.useFakeTimers()
  const exited = new Set<string>()
  const f = fixture((epoch) => exited.has(epoch)),
    session = f.session()
  const handle = await f.host.prepare(session, 32, 32)
  const attachment = f.host.attach(handle, session)
  const frame = await f.host.takeFrame(handle, 1, 1, attachment)
  f.live.available = false
  const ordinary = f.request.getMockImplementation()!
  f.request.mockImplementation((command, signal) =>
    command.kind === 'release'
      ? Promise.reject(new Error('transport-unavailable'))
      : ordinary(command, signal),
  )
  let released = false
  const releasing = frame!.release().then(() => {
    released = true
  })
  await vi.advanceTimersByTimeAsync(160)
  expect(released).toBe(false)
  expect(f.process.dispose).toHaveBeenCalledTimes(1)
  expect(f.process.idle).not.toHaveBeenCalled()
  await expect(f.host.prepare(session, 32, 32)).rejects.toThrow('native-state-bound')
  exited.add('host-0')
  await vi.advanceTimersByTimeAsync(160)
  expect(released).toBe(false)
  exited.add('host-1')
  await vi.advanceTimersByTimeAsync(16)
  await releasing
  expect(released).toBe(true)
  expect(f.process.hasExited).toHaveBeenCalledWith('host-1')
  // The state remains explicitly owned until trusted lifetime end, even though
  // its final consumer has now settled the epoch-qualified dead source lease.
  await f.host.end(handle, session.instanceId)
  expect(f.process.idle).toHaveBeenCalledTimes(1)
})

it('keeps a confirmed dead source record until its final consumer releases, then admits a fresh generation', async () => {
  vi.useFakeTimers()
  const exited = new Set<string>()
  const f = fixture((epoch) => exited.has(epoch)),
    session = f.session()
  const handle = await f.host.prepare(session, 32, 32)
  const attachment = f.host.attach(handle, session)
  const frame = await f.host.takeFrame(handle, 1, 1, attachment)
  const ordinary = f.request.getMockImplementation()!
  f.live.available = false
  f.request.mockImplementation(() => Promise.reject(new Error('transport-unavailable')))
  let ended = false
  const ending = f.host.end(handle, session.instanceId).then(() => {
    ended = true
  })
  await vi.advanceTimersByTimeAsync(32)
  expect(ended).toBe(false)
  exited.add('host-1')
  await vi.advanceTimersByTimeAsync(16)
  await ending
  expect(f.process.idle).not.toHaveBeenCalled()
  await expect(f.host.prepare(session, 32, 32)).rejects.toThrow('native-state-bound')
  const before = f.request.mock.calls.length
  await frame!.release()
  expect(f.request.mock.calls).toHaveLength(before)
  expect(f.process.idle).toHaveBeenCalledTimes(1)
  f.process.epoch = 'host-2'
  f.live.available = true
  f.request.mockImplementation(ordinary)
  const fresh = await f.host.prepare(session, 32, 32)
  const nextAttachment = f.host.attach(fresh, session)
  const nextFrame = await f.host.takeFrame(fresh, 1, 1, nextAttachment)
  const acknowledgement = deferred<unknown>()
  f.request.mockImplementation((command, signal) =>
    command.kind === 'release' ? acknowledgement.promise : ordinary(command, signal),
  )
  let released = false
  const releasing = nextFrame!.release().then(() => {
    released = true
  })
  await vi.advanceTimersByTimeAsync(32)
  expect(released).toBe(false)
  expect(f.process.hasExited).toHaveBeenLastCalledWith('host-2')
  expect(exited.has('host-2')).toBe(false)
  // Old host-1 exit evidence cannot substitute for a fresh host-2 C reply.
  acknowledgement.resolve({ result: 0 })
  await releasing
  expect(released).toBe(true)
})

it('rejects cleanup after a bounded wait when process exit remains unconfirmed', async () => {
  vi.useFakeTimers()
  const f = fixture(() => false),
    session = f.session()
  const handle = await f.host.prepare(session, 32, 32)
  const attachment = f.host.attach(handle, session)
  const frame = await f.host.takeFrame(handle, 1, 1, attachment)
  f.live.available = false
  f.request.mockImplementation(() => Promise.reject(new Error('transport-unavailable')))
  let released = false
  const releasing = frame!.release().then(() => {
    released = true
  })
  const rejected = expect(releasing).rejects.toThrow('native-cleanup-failed')
  await vi.advanceTimersByTimeAsync(15016)
  await rejected
  expect(released).toBe(false)
  expect(f.process.idle).not.toHaveBeenCalled()
  expect(f.process.dispose).toHaveBeenCalledTimes(1)
  expect(f.process.hasExited).toHaveBeenCalledWith('host-1')
})

it('keeps parser authority after proven-unsent frame admission pressure', async () => {
  const f = fixture(),
    session = f.session()
  const handle = await f.host.prepare(session, 32, 32)
  const attachment = f.host.attach(handle, session)
  f.request.mockRejectedValueOnce(new NativeTerminalAdmissionError())
  await expect(f.host.takeFrame(handle, 1, 1, attachment)).rejects.toBeInstanceOf(
    NativeTerminalAdmissionError,
  )
  expect(f.process.dispose).not.toHaveBeenCalled()
  expect(f.request.mock.calls.some(([command]) => command.kind === 'destroy')).toBe(false)
  await f.host.feed(handle, session.instanceId, new Uint8Array([128]))
  const frame = await f.host.takeFrame(handle, 1, 1, attachment)
  expect(frame).toBeDefined()
  await frame!.release()
})
it('copies only the held current lease and validates the bounded pixel result', async () => {
  const f = fixture(),
    session = f.session()
  const handle = await f.host.prepare(session, 32, 32)
  const attachment = f.host.attach(handle, session)
  expect(f.host.nativeEpoch(handle, 1, 1, attachment)).toBe('host-1')
  const frame = (await f.host.takeFrame(handle, 1, 1, attachment))!
  const bytes = new Uint8Array(32 * 32 * 4)
  f.request.mockResolvedValueOnce({ bytes, stride: 128 })
  await expect(frame.copyPixels()).resolves.toEqual({ bytes, stride: 128 })
  expect(f.request).toHaveBeenLastCalledWith(
    { kind: 'pixels', state: '1', lease: '1' },
    undefined,
  )
  f.request.mockResolvedValueOnce({ bytes: new Uint8Array(4), stride: 128 })
  await expect(frame.copyPixels()).rejects.toThrow('native-pixel-bound')
  f.host.detach(handle, 1, 1, attachment)
  const before = f.request.mock.calls.length
  await expect(frame.copyPixels()).rejects.toThrow('native-attachment-stale')
  expect(f.request).toHaveBeenCalledTimes(before)
  await frame.release()
})
it('reports an acknowledged geometry failure promptly while retaining feed/read authority', async () => {
  const f = fixture(),
    session = f.session()
  const handle = await f.host.prepare(session, 32, 32)
  const attachment = f.host.attach(handle, session)
  f.live.status = { ...status(), geometryFailureSerial: 2 }
  await expect(f.host.resize(handle, 1, 1, attachment, 2, 32, 32, 2)).rejects.toThrow(
    'native-geometry-failed',
  )
  expect(f.process.dispose).not.toHaveBeenCalled()
  await f.host.feed(handle, session.instanceId, new Uint8Array([129]))
  await expect(f.host.read(handle, 1, 1)).resolves.toEqual(new Uint8Array([1]))
})

it('keeps the same parser feeding and readable under an indeterminate GPU import quarantine', async () => {
  const f = fixture(),
    session = f.session()
  const handle = await f.host.prepare(session, 32, 32)
  const attachment = f.host.attach(handle, session)
  const source = (await f.host.takeFrame(handle, 1, 1, attachment))!
  const edge = {
    receive: vi.fn((ticket: string) =>
      Promise.resolve({
        ticket,
        kind: 1,
        width: 32,
        height: 32,
        fourcc: 0x42475241,
        colorSpace: 2,
        origin: 1,
        premultiplied: true,
        modifier: 0n,
        planeCount: 0,
        planes: [],
        surface: Buffer.alloc(8),
      }),
    ),
    release: vi.fn(),
  }
  const imports = new NativeTerminalFrameImports(edge, {
    importSharedTexture: () => {
      throw new Error('post-create import failure')
    },
    sendSharedTexture: () => Promise.resolve(),
  })
  await expect(
    imports.acquire(
      source,
      {
        ready: true,
        isCurrent: () => true,
        frame: { isDestroyed: () => false } as WebFrameMain,
      },
      { allowPixelFallback: true },
    ),
  ).rejects.toThrow('post-create import failure')
  await f.host.feed(handle, session.instanceId, new Uint8Array([128, 255]))
  await expect(f.host.read(handle, 1, 1)).resolves.toEqual(new Uint8Array([1]))
  expect(edge.release).not.toHaveBeenCalled()
  expect(
    f.request.mock.calls.some(
      ([command]) => command.kind === 'destroy' || command.kind === 'release',
    ),
  ).toBe(false)
  expect(f.process.dispose).not.toHaveBeenCalled()
})

it('keeps the same parser alive after send quarantine without trusting target death or old release callbacks', async () => {
  const f = fixture(),
    session = f.session(),
    handle = await f.host.prepare(session, 32, 32)
  const attachment = f.host.attach(handle, session),
    source = (await f.host.takeFrame(handle, 1, 1, attachment))!
  let released: (() => void) | undefined
  const mainRelease = vi.fn(),
    releaseReceipt = vi.fn()
  const imports = new NativeTerminalFrameImports(
    {
      receive: (ticket: string) =>
        Promise.resolve({
          ticket,
          kind: 1,
          width: 32,
          height: 32,
          fourcc: 0x42475241,
          colorSpace: 2,
          origin: 1,
          premultiplied: true,
          modifier: 0n,
          planeCount: 0,
          planes: [],
          surface: Buffer.alloc(8),
        }),
      release: releaseReceipt,
    },
    {
      importSharedTexture: (options) => {
        released = options.allReferencesReleased
        return { release: mainRelease } as unknown as ReturnType<
          import('electron').SharedTexture['importSharedTexture']
        >
      },
      sendSharedTexture: () => Promise.reject(new Error('transfer timed out')),
    },
  )
  let dead = false
  const imported = await imports.acquire(source, {
    ready: true,
    isCurrent: () => true,
    frame: { isDestroyed: () => dead } as WebFrameMain,
  })
  await expect(imported.send()).rejects.toThrow('transfer timed out')
  await expect(imported.released).rejects.toThrow('transfer timed out')
  dead = true
  imported.release()
  released?.()
  await f.host.feed(handle, session.instanceId, new Uint8Array([128, 255]))
  await expect(f.host.read(handle, 1, 1)).resolves.toEqual(new Uint8Array([1]))
  expect(mainRelease).not.toHaveBeenCalled()
  expect(releaseReceipt).not.toHaveBeenCalled()
  expect(
    f.request.mock.calls.some(
      ([command]) => command.kind === 'destroy' || command.kind === 'release',
    ),
  ).toBe(false)
  expect(f.process.dispose).not.toHaveBeenCalled()
})
