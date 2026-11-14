import { describe, expect, it } from 'vitest'
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
