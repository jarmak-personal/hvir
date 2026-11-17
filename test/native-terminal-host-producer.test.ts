import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  nativeTerminalHostFixture,
  nativeTerminalStatus,
} from './fixtures/native-terminal-host'

async function prepared() {
  const f = nativeTerminalHostFixture()
  const session = f.session()
  const handle = await f.host.prepare(session, 32, 32)
  return { ...f, session, handle }
}

describe('native PTY producer operations', () => {
  it('inspects and drains exact raw replies with no renderer attachment', async () => {
    const f = await prepared()
    f.live.renderer = false
    f.request.mockImplementation((command) =>
      Promise.resolve(
        command.kind === 'drain' ? new Uint8Array([0, 128, 255]) : nativeTerminalStatus(),
      ),
    )
    expect(await f.host.inspectProducer(f.handle, 'instance-0')).toEqual(
      nativeTerminalStatus(),
    )
    expect(await f.host.drainReplies(f.handle, 'instance-0')).toEqual(
      new Uint8Array([0, 128, 255]),
    )
    await expect(f.host.drainReplies(f.handle, 'other')).rejects.toThrow(
      'native-producer-revoked',
    )
  })
  it.each([
    'readProducer',
    'drainEffectsProducer',
    'readLinkProducer',
    'drainReplies',
  ] as const)(
    'rejects stale immutable-instance authority asynchronously at %s without dispatch',
    async (method) => {
      const f = await prepared()
      const calls = f.request.mock.calls.length
      const pending =
        method === 'readLinkProducer'
          ? f.host.readLinkProducer(f.handle, 'other', {
              row: 0,
              column: 0,
              screen: 0,
              expectedSequence: 0,
              expectedMutation: 0,
              expectedGeometrySerial: 1,
            })
          : f.host[method](f.handle, 'other')
      await expect(pending).rejects.toThrow('native-producer-revoked')
      expect(f.request).toHaveBeenCalledTimes(calls)
    },
  )
  it('applies acknowledged scale before initial PTY geometry and refuses invalid geometry before mutation', async () => {
    const f = await prepared()
    f.request.mockImplementation((command) =>
      Promise.resolve(
        command.kind === 'inspect'
          ? {
              ...nativeTerminalStatus(2),
              geometry: { ...nativeTerminalStatus(2).geometry, backingScale: 2 },
            }
          : { result: 0 },
      ),
    )
    await expect(
      f.host.resizeProducer(f.handle, 'instance-0', 2, 32, 32, 2),
    ).resolves.toMatchObject({ geometry: { serial: 2, backingScale: 2 } })
    const calls = f.request.mock.calls.length
    await expect(
      f.host.resizeProducer(f.handle, 'instance-0', 3, 0, 32, 2),
    ).rejects.toThrow('native-extent-invalid')
    expect(f.request).toHaveBeenCalledTimes(calls)
  })
  it('never spreads renderer properties over the trusted native operation or state identity', async () => {
    const f = await prepared()
    f.request.mockResolvedValue({
      bytes: new Uint8Array([120]),
      capacity: 1,
      source: 'user',
      requestedMutation: 0,
    })
    const payload = {
      key: 0,
      modifiers: 0,
      action: 1,
      text: 'x',
      kind: 'destroy',
      state: 'other',
      bytes: new Uint8Array([255]),
      keyEncodingFallback: 'csi-u',
    }
    await f.host.encodeKey(f.handle, 'instance-0', payload)
    expect(f.request).toHaveBeenLastCalledWith(
      {
        kind: 'input',
        state: '1',
        readOnly: false,
        keyEncodingFallback: undefined,
        input: {
          kind: 'key',
          key: 0,
          modifiers: 0,
          action: 1,
          text: 'x',
          consumedModifiers: 0,
          unshiftedCodepoint: 0,
          composing: false,
          optionAsAlt: false,
        },
      },
      expect.any(AbortSignal),
      undefined,
      true,
    )
  })
  it('uses native key bytes without decoding or text re-encoding', async () => {
    const f = await prepared()
    f.request.mockResolvedValue({
      bytes: new Uint8Array([0, 128, 255]),
      capacity: 3,
      source: 'user',
      requestedMutation: 0,
    })
    expect(
      await f.host.encodeKey(f.handle, 'instance-0', {
        key: 0,
        modifiers: 0,
        action: 1,
        text: 'é',
      }),
    ).toEqual(new Uint8Array([0, 128, 255]))
    expect(f.request).toHaveBeenLastCalledWith(
      {
        kind: 'input',
        state: '1',
        readOnly: false,
        keyEncodingFallback: undefined,
        input: {
          kind: 'key',
          key: 0,
          modifiers: 0,
          action: 1,
          text: 'é',
          consumedModifiers: 0,
          unshiftedCodepoint: 0,
          composing: false,
          optionAsAlt: false,
        },
      },
      expect.any(AbortSignal),
      undefined,
      true,
    )
    await expect(
      f.host.encodeKey(f.handle, 'instance-0', {
        key: 0,
        modifiers: 0,
        action: 1,
        text: '\0',
      }),
    ).rejects.toThrow('native-key-invalid')
  })
})

afterEach(() => vi.useRealTimers())

it('retires the exact physical source after its old attachment detached, using original release once', async () => {
  const f = nativeTerminalHostFixture(),
    session = f.session()
  const handle = await f.host.prepare(session, 32, 32)
  const attachment = f.host.attach(handle, session)
  const frame = (await f.host.takeFrame(handle, 1, 1, attachment))!
  const original = f.request.getMockImplementation()!
  f.request.mockImplementation((command, signal) => {
    if (command.kind === 'retire-frame-begin')
      return Promise.resolve({ request: '18446744073709551615' })
    if (command.kind === 'retire-frame-status') return Promise.resolve({ status: 2 })
    return original(command, signal)
  })
  f.host.detach(handle, 1, 1, attachment)
  expect(() => frame.assertCurrent()).toThrow('attachment-stale')
  const work = frame.retireProducer!()
  expect(frame.retireProducer!()).toBe(work)
  await expect(work).resolves.toBe('retired')
  expect(f.request.mock.calls.filter(([command]) => command.kind === 'release')).toEqual([
    [{ kind: 'release', state: '1', lease: frame.metadata.lease }],
  ])
  expect(
    f.request.mock.calls.find(([command]) => command.kind === 'retire-frame-status')?.[0],
  ).toEqual({
    kind: 'retire-frame-status',
    state: '1',
    lease: frame.metadata.lease,
    request: '18446744073709551615',
  })
})

it.each([0, 3, 5])(
  'retains the held source on unconfirmed retirement status %s',
  async (status) => {
    const f = nativeTerminalHostFixture(),
      session = f.session()
    const handle = await f.host.prepare(session, 32, 32)
    const attachment = f.host.attach(handle, session)
    const frame = (await f.host.takeFrame(handle, 1, 1, attachment))!
    const original = f.request.getMockImplementation()!
    f.request.mockImplementation((command, signal) => {
      if (command.kind === 'retire-frame-begin') return Promise.resolve({ request: '7' })
      if (command.kind === 'retire-frame-status') return Promise.resolve({ status })
      return original(command, signal)
    })
    await expect(frame.retireProducer!()).rejects.toThrow('retirement-unconfirmed')
    expect(f.request.mock.calls.some(([command]) => command.kind === 'release')).toBe(
      false,
    )
    await expect(f.host.takeFrame(handle, 1, 1, attachment)).rejects.toThrow(
      'frame-bound',
    )
  },
)

it.each(['actor-ended', 'process-exit'] as const)(
  'never labels %s cleanup as recovered',
  async (ending) => {
    let exited = false
    const f = nativeTerminalHostFixture(() => exited),
      session = f.session()
    const handle = await f.host.prepare(session, 32, 32)
    const attachment = f.host.attach(handle, session)
    const frame = (await f.host.takeFrame(handle, 1, 1, attachment))!
    const original = f.request.getMockImplementation()!
    f.request.mockImplementation((command, signal) => {
      if (command.kind === 'retire-frame-begin') return Promise.resolve({ request: '8' })
      if (command.kind === 'retire-frame-status')
        return Promise.resolve({ status: ending === 'actor-ended' ? 4 : 2 })
      if (command.kind === 'release' && ending === 'process-exit') {
        exited = true
        f.live.available = false
        return Promise.resolve({ result: 0 })
      }
      return original(command, signal)
    })
    await expect(frame.retireProducer!()).resolves.toBe('actor-ended')
  },
)

it('polls only the exact pending request while yielding and never releases on pending', async () => {
  vi.useFakeTimers()
  const f = nativeTerminalHostFixture(),
    session = f.session()
  const handle = await f.host.prepare(session, 32, 32)
  const attachment = f.host.attach(handle, session)
  const frame = (await f.host.takeFrame(handle, 1, 1, attachment))!
  const original = f.request.getMockImplementation()!
  let ready = false
  f.request.mockImplementation((command, signal) => {
    if (command.kind === 'retire-frame-begin') return Promise.resolve({ request: '9' })
    if (command.kind === 'retire-frame-status')
      return Promise.resolve({ status: ready ? 2 : 1 })
    return original(command, signal)
  })
  const work = frame.retireProducer!()
  await vi.advanceTimersByTimeAsync(0)
  expect(f.request.mock.calls.some(([command]) => command.kind === 'release')).toBe(false)
  ready = true
  await vi.advanceTimersByTimeAsync(16)
  await expect(work).resolves.toBe('retired')
})

it('cleans a retirement-requested source after close already joined, without beginning a new fence', async () => {
  const f = nativeTerminalHostFixture(),
    session = f.session()
  const handle = await f.host.prepare(session, 32, 32)
  const attachment = f.host.attach(handle, session)
  const frame = (await f.host.takeFrame(handle, 1, 1, attachment))!
  await f.host.end(handle, session.instanceId)
  expect(f.process.idle).not.toHaveBeenCalled()
  await expect(frame.retireProducer!()).resolves.toBe('actor-ended')
  expect(
    f.request.mock.calls.some(([command]) => command.kind === 'retire-frame-begin'),
  ).toBe(false)
  expect(
    f.request.mock.calls.filter(([command]) => command.kind === 'release'),
  ).toHaveLength(1)
  expect(f.process.idle).toHaveBeenCalledOnce()
})

it('cleans only after joined close while preserving a cached unknown retirement rejection', async () => {
  const f = nativeTerminalHostFixture(),
    session = f.session()
  const handle = await f.host.prepare(session, 32, 32)
  const attachment = f.host.attach(handle, session)
  const frame = (await f.host.takeFrame(handle, 1, 1, attachment))!
  const original = f.request.getMockImplementation()!
  f.request.mockImplementation((command, signal) => {
    if (command.kind === 'retire-frame-begin') return Promise.resolve({ request: '11' })
    if (command.kind === 'retire-frame-status') return Promise.resolve({ status: 3 })
    return original(command, signal)
  })
  const rejected = frame.retireProducer!()
  await expect(rejected).rejects.toThrow('unconfirmed')
  expect(f.request.mock.calls.some(([command]) => command.kind === 'release')).toBe(false)
  await f.host.end(handle, session.instanceId)
  await vi.waitFor(() => expect(f.process.idle).toHaveBeenCalledOnce())
  expect(frame.retireProducer!()).toBe(rejected)
  await expect(rejected).rejects.toThrow('unconfirmed')
  const commands = f.request.mock.calls.map(([command]) => command.kind)
  expect(commands.indexOf('release')).toBeGreaterThan(commands.indexOf('destroy'))
  expect(commands.filter((kind) => kind === 'release')).toHaveLength(1)
})
