import { describe, expect, it, vi } from 'vitest'
import { hostPath, LOCAL_HOST_ID } from '../src/shared/host-path'
import {
  NativeTerminalAdmissionError,
  type NativeTerminalCommand,
  type NativeTerminalSession,
  type NativeTerminalStatus,
} from '../src/shared/native-terminal'
import { NativeTerminalHost } from '../src/main/terminal/native-terminal-host'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
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
    geometry: {
      serial,
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
function fixture() {
  const sessions = new Map<string, NativeTerminalSession>()
  const live = {
    renderer: true,
    owner: 1,
    generation: 1,
    available: true,
    status: status(),
  }
  let nextState = 0
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
          return Promise.resolve({
            lease: '1',
            streamSequence: 0,
            geometrySerial: 1,
            kind: 1,
            width: 32,
            height: 32,
            colorSpace: 2,
            origin: 1,
            premultiplied: true,
          })
        default:
          return Promise.resolve(undefined)
      }
    },
  )
  const process = {
    epoch: 'host-1',
    get available() {
      return live.available
    },
    request,
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

describe('native terminal main session authority', () => {
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
      return Promise.resolve(undefined)
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
      return Promise.resolve(undefined)
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
      return Promise.resolve(undefined)
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
      Promise.resolve(command.kind === 'frame' ? { lease: 'malformed' } : undefined),
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
