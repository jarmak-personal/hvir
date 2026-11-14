import { describe, expect, it } from 'vitest'
import { nativeTerminalHostFixture } from './fixtures/native-terminal-host'
const empty = { effects: [], droppedEffects: 0, semanticGeneration: 0 }
const query = {
  row: 0,
  column: 1,
  screen: 0 as const,
  expectedSequence: 0,
  expectedMutation: 0,
  expectedGeometrySerial: 1,
}
describe('copied native producer authority', () => {
  it('rejects future or duplicate native effects before exposing the batch to policy', async () => {
    const f = nativeTerminalHostFixture(),
      session = f.session()
    const handle = await f.host.prepare(session, 32, 32)
    for (const effects of [
      [{ kind: 'bell', eventSerial: 1, sequence: 1 }],
      [
        { kind: 'bell', eventSerial: 1, sequence: 0 },
        { kind: 'bell', eventSerial: 1, sequence: 0 },
      ],
    ]) {
      f.request.mockResolvedValueOnce({ ...empty, effects })
      await expect(
        f.host.drainEffectsProducer(handle, session.instanceId),
      ).rejects.toThrow('native-effect-drain-invalid')
    }
    f.request.mockResolvedValueOnce({
      ...empty,
      effects: [{ kind: 'bell', eventSerial: 1, sequence: 0 }],
    })
    await expect(
      f.host.drainEffectsProducer(handle, session.instanceId),
    ).resolves.toMatchObject({ effects: [{ kind: 'bell' }] })
    await f.host.end(handle, session.instanceId)
  })
  it('does not expose a copied effect batch after immutable instance replacement', async () => {
    const f = nativeTerminalHostFixture(),
      session = f.session()
    const handle = await f.host.prepare(session, 32, 32)
    let resolve!: (value: unknown) => void
    f.request.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done
      }),
    )
    const pending = f.host.drainEffectsProducer(handle, session.instanceId)
    f.sessions.set(session.sessionId, { ...session, instanceId: 'replacement' })
    resolve(empty)
    await expect(pending).rejects.toThrow()
    f.host.dispose()
  })
  it('refuses coordinates outside the native uint32 domain before dispatch without losing parser authority', async () => {
    const f = nativeTerminalHostFixture(),
      session = f.session()
    const handle = await f.host.prepare(session, 32, 32)
    const calls = f.request.mock.calls.length
    await expect(
      f.host.readLinkProducer(handle, session.instanceId, {
        ...query,
        row: Number.MAX_SAFE_INTEGER,
      }),
    ).rejects.toThrow('native-link-query-invalid')
    expect(f.request).toHaveBeenCalledTimes(calls)
    await expect(f.host.readProducer(handle, session.instanceId)).resolves.toEqual(
      Uint8Array.of(1),
    )
    expect(f.process.dispose).not.toHaveBeenCalled()
    await f.host.end(handle, session.instanceId)
  })
  it('returns only a same-snapshot copied link and refuses stale/malformed results', async () => {
    const f = nativeTerminalHostFixture(),
      session = f.session()
    const handle = await f.host.prepare(session, 32, 32)
    const link = {
      uri: 'file:///outside/file.txt',
      row: 0,
      column: 1,
      screen: 0,
      streamSequence: 0,
      snapshotMutation: 0,
      geometrySerial: 1,
    }
    f.request.mockResolvedValueOnce(link)
    await expect(
      f.host.readLinkProducer(handle, session.instanceId, query),
    ).resolves.toEqual(link)
    f.request.mockResolvedValueOnce({ ...link, geometrySerial: 2 })
    await expect(
      f.host.readLinkProducer(handle, session.instanceId, query),
    ).rejects.toThrow('native-link-result-invalid')
    f.request.mockResolvedValueOnce({ unavailable: 6 })
    await expect(
      f.host.readLinkProducer(handle, session.instanceId, query),
    ).resolves.toBeUndefined()
    f.request.mockResolvedValueOnce({})
    await expect(
      f.host.readLinkProducer(handle, session.instanceId, query),
    ).resolves.toBeUndefined()
    await f.host.end(handle, session.instanceId)
  })
})
