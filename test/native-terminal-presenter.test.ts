import type { WebFrameMain } from 'electron'
import type {
  NativeTerminalPixelFrame,
  NativeTerminalViewGrant,
} from '../src/shared/native-terminal-presentation'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { localPath } from '../src/shared/host-path'
import type {
  NativeTerminalSession,
  NativeTerminalStatus,
} from '../src/shared/native-terminal'
import {
  NativeTerminalPresenter,
  type NativeTerminalPresentationTarget,
} from '../src/main/terminal/native-terminal-presenter'
import {
  NativeTerminalGpuImportUnavailable,
  NativeTerminalImportQuarantined,
} from '../src/main/terminal/native-terminal-import'
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (value: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
function fixture() {
  let serial = 1,
    attachment = 0,
    width = 64,
    height = 32,
    backingScale = 1
  const live = {
    current: true,
    dead: false,
    epoch: '11111111-1111-4111-8111-111111111111',
  }
  const session: NativeTerminalSession = {
    sessionId: 'session',
    instanceId: 'instance',
    ownerId: 1,
    ownerGeneration: 1,
    workspaceRoot: localPath('/project'),
  }
  const status = (): NativeTerminalStatus => ({
    appliedSequence: 1,
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
      width,
      height,
      backingScale,
      columns: 8,
      rows: 2,
      cellWidth: 8,
      cellHeight: 16,
      contentWidth: width,
      contentHeight: height,
      paddingLeft: 0,
      paddingTop: 0,
    },
  })
  const sources: ReturnType<typeof source>[] = []
  function source() {
    return {
      metadata: {
        lease: '1',
        streamSequence: 1,
        geometrySerial: serial,
        kind: 1,
        width,
        height,
        colorSpace: 2,
        origin: 1,
        premultiplied: true,
      },
      assertCurrent: vi.fn(),
      transfer: vi.fn(() => Promise.resolve()),
      release: vi.fn(() => Promise.resolve()),
      copyPixels: vi.fn(() =>
        Promise.resolve({ bytes: new Uint8Array(width * height * 4), stride: width * 4 }),
      ),
    }
  }
  const host = {
    attach: vi.fn(() => ++attachment),
    detach: vi.fn(),
    nativeEpoch: vi.fn(() => live.epoch),
    inspect: vi.fn(() => Promise.resolve(status())),
    resize: vi.fn(
      (
        _handle: string,
        _owner: number,
        _generation: number,
        _attachment: number,
        next: number,
        w: number,
        h: number,
        scale: number = 1,
      ) => {
        serial = next
        width = w
        height = h
        backingScale = scale
        return Promise.resolve(status())
      },
    ),
    setVisible: vi.fn(
      (
        _handle: string,
        _owner: number,
        _generation: number,
        _attachment: number,
        _visible: boolean,
      ) => Promise.resolve(),
    ),
    takeFrame: vi.fn((): Promise<ReturnType<typeof source> | undefined> => {
      const value = source()
      sources.push(value)
      return Promise.resolve(value)
    }),
  }
  const consumed = deferred<void>()
  const imported = {
    metadata: { ...source().metadata, ticket: 'ticket' },
    send: vi.fn(() => Promise.resolve()),
    release: vi.fn(),
    released: consumed.promise,
  }
  const imports = { acquire: vi.fn(() => Promise.resolve(imported)) }
  const unavailableCallbacks: ((grant: NativeTerminalViewGrant) => void)[] = []
  const unbindUnavailable = vi.fn()
  const target = {
    onUnavailable: vi.fn((callback: (grant: NativeTerminalViewGrant) => void) => {
      unavailableCallbacks.push(callback)
      return unbindUnavailable
    }),
    frame: { isDestroyed: () => live.dead } as WebFrameMain,
    ready: true,
    isCurrent: () => live.current,
    publishGrant: vi.fn(),
    publishStatus: vi.fn(),
    sendPixels: vi.fn((_frame: NativeTerminalPixelFrame) => Promise.resolve()),
  } satisfies NativeTerminalPresentationTarget
  const owner = new NativeTerminalPresenter(host, imports)
  return {
    owner,
    host,
    imports,
    imported,
    consumed,
    sources,
    target,
    unavailableCallbacks,
    unbindUnavailable,
    live,
    session,
    source,
    status,
  }
}
afterEach(() => vi.useRealTimers())
describe('main native presentation attachment', () => {
  it('publishes actual backing geometry only after acknowledgement, including equal-size changes', async () => {
    const f = fixture(),
      id = await f.owner.attach('state', f.session, f.target)
    expect(f.target.publishGrant).not.toHaveBeenCalled()
    const first = await f.owner.update(id, {
      width: 64,
      height: 32,
      backingScale: 2,
      visible: true,
    })
    expect(first).toMatchObject({
      width: 128,
      height: 64,
      backingScale: 2,
      geometrySerial: 2,
      nativeEpoch: f.live.epoch,
    })
    const second = await f.owner.update(id, {
      width: 64,
      height: 32,
      backingScale: 2,
      visible: true,
    })
    expect(second!.geometrySerial).toBe(3)
    expect(f.host.resize.mock.calls[0]!.slice(4)).toEqual([2, 128, 64, 2])
  })
  it('rejects invalid layout before revoking current authority or native admission', async () => {
    const f = fixture(),
      id = await f.owner.attach('state', f.session, f.target)
    await f.owner.update(id, { width: 64, height: 32, backingScale: 1, visible: true })
    const grants = f.target.publishGrant.mock.calls.length
    expect(() =>
      f.owner.update(id, { width: 0, height: 32, backingScale: 1, visible: true }),
    ).toThrow('geometry-invalid')
    expect(f.host.resize).toHaveBeenCalledTimes(1)
    expect(f.target.publishGrant).toHaveBeenCalledTimes(grants)
  })
  it('holds one source lease through slow physical consumption and coalesces demands', async () => {
    const f = fixture(),
      id = await f.owner.attach('state', f.session, f.target)
    await f.owner.update(id, { width: 64, height: 32, backingScale: 1, visible: true })
    const first = f.owner.demand(id),
      second = f.owner.demand(id)
    expect(first).toBe(second)
    await vi.waitFor(() => expect(f.imported.send).toHaveBeenCalledOnce())
    expect(f.host.takeFrame).toHaveBeenCalledOnce()
    expect(f.sources[0]!.copyPixels).not.toHaveBeenCalled()
    f.consumed.resolve()
    await first
    expect(f.sources[0]!.release).not.toHaveBeenCalled() // Importer owns physical release.
    expect(f.target.publishStatus).toHaveBeenLastCalledWith({
      viewId: id,
      mode: 'native-gpu',
    })
  })
  it('hides promptly while a successful GPU consumer retains its immutable lease', async () => {
    const f = fixture(),
      id = await f.owner.attach('state', f.session, f.target)
    const first = await f.owner.update(id, {
      width: 64,
      height: 32,
      backingScale: 1,
      visible: true,
    })
    const active = f.owner.demand(id)
    await vi.waitFor(() => expect(f.imported.send).toHaveBeenCalled())
    const hidden = f.owner.update(id, {
      width: 64,
      height: 32,
      backingScale: 1,
      visible: false,
    })
    expect(f.target.publishGrant).toHaveBeenLastCalledWith(undefined)
    await f.owner.demand(id)
    expect(f.host.takeFrame).toHaveBeenCalledOnce()
    await expect(hidden).resolves.toBeUndefined()
    expect(f.host.setVisible).toHaveBeenLastCalledWith('state', 1, 1, 1, false)
    expect(f.sources[0]!.release).not.toHaveBeenCalled()
    expect(f.host.setVisible.mock.calls.at(-1)?.at(-1)).toBe(false)
    f.consumed.resolve()
    await active
    await f.owner.demand(id)
    expect(f.host.takeFrame).toHaveBeenCalledOnce()
    const revealed = await f.owner.update(id, {
      width: 64,
      height: 32,
      backingScale: 1,
      visible: true,
    })
    expect(revealed!.geometrySerial).toBeGreaterThan(first!.geometrySerial)
  })
  it('copies only the safely retained GPU-unavailable source and paces compatibility requests', async () => {
    const f = fixture(),
      id = await f.owner.attach('state', f.session, f.target)
    await f.owner.update(id, { width: 64, height: 32, backingScale: 1, visible: true })
    f.imports.acquire.mockRejectedValue(
      new NativeTerminalGpuImportUnavailable(new Error('GPU unavailable')),
    )
    await f.owner.demand(id)
    expect(f.sources[0]!.copyPixels).toHaveBeenCalledOnce()
    expect(f.sources[0]!.release).toHaveBeenCalledOnce()
    expect(f.target.sendPixels.mock.calls[0]![0]).toMatchObject({
      nativeTerminal: { viewId: id, geometrySerial: 2 },
      stride: 256,
      origin: 1,
      premultiplied: false,
    })
    expect(f.owner.isInputCurrent(id)).toBe(true)
    expect(f.target.publishStatus).toHaveBeenLastCalledWith({
      viewId: id,
      mode: 'native-pixels',
      reason: 'import-unavailable',
    })
    await f.owner.demand(id)
    expect(f.host.takeFrame).toHaveBeenCalledOnce()
  })
  it('retains copied source ownership until the bounded receiver upload acknowledgement', async () => {
    const f = fixture(),
      id = await f.owner.attach('state', f.session, f.target),
      uploaded = deferred<void>()
    await f.owner.update(id, { width: 64, height: 32, backingScale: 1, visible: true })
    f.imports.acquire.mockRejectedValue(
      new NativeTerminalGpuImportUnavailable(new Error('GPU unavailable')),
    )
    f.target.sendPixels.mockReturnValue(uploaded.promise)
    const pending = f.owner.demand(id)
    await vi.waitFor(() => expect(f.target.sendPixels).toHaveBeenCalled())
    expect(f.sources[0]!.release).not.toHaveBeenCalled()
    uploaded.resolve()
    await pending
    expect(f.sources[0]!.release).toHaveBeenCalledOnce()
  })
  it('never copies pixels or reuses a quarantined source after an indeterminate send failure', async () => {
    const f = fixture(),
      id = await f.owner.attach('state', f.session, f.target)
    await f.owner.update(id, { width: 64, height: 32, backingScale: 1, visible: true })
    f.imported.send.mockRejectedValue(
      new NativeTerminalImportQuarantined(new Error('send timeout')),
    )
    await expect(f.owner.demand(id)).rejects.toThrow('send timeout')
    expect(f.host.setVisible.mock.calls.at(-1)?.at(-1)).toBe(false)
    expect(f.sources[0]!.copyPixels).not.toHaveBeenCalled()
    expect(f.sources[0]!.release).not.toHaveBeenCalled()
    await expect(f.owner.demand(id)).resolves.toBe(false)
    expect(f.host.takeFrame).toHaveBeenCalledOnce()
    f.consumed.resolve()
    await f.owner.detach(id)
    const replacement = await f.owner.attach('state', f.session, f.target)
    await f.owner.update(replacement, {
      width: 64,
      height: 32,
      backingScale: 1,
      visible: true,
    })
    expect(f.host.setVisible.mock.calls.at(-1)?.at(-1)).toBe(false)
    await expect(f.owner.demand(replacement)).resolves.toBe(false)
    expect(f.target.publishStatus.mock.calls.at(-1)?.[0]).toMatchObject({
      mode: 'unavailable',
    })
    await f.owner.detach(replacement)
  })
  it('rejects stale native geometry before GPU import or compatibility copy', async () => {
    const f = fixture(),
      id = await f.owner.attach('state', f.session, f.target)
    await f.owner.update(id, { width: 64, height: 32, backingScale: 1, visible: true })
    const frame = f.source()
    frame.metadata.geometrySerial--
    f.host.takeFrame.mockResolvedValue(frame)
    await expect(f.owner.demand(id)).rejects.toThrow('frame-stale')
    expect(f.imports.acquire).not.toHaveBeenCalled()
    expect(frame.copyPixels).not.toHaveBeenCalled()
    expect(frame.release).toHaveBeenCalledOnce()
  })
  it('revokes old attachment before reparenting without ending the retained parser', async () => {
    const f = fixture(),
      old = await f.owner.attach('state', f.session, f.target)
    await f.owner.update(old, { width: 64, height: 32, backingScale: 1, visible: true })
    const current = await f.owner.attach('state', f.session, f.target)
    expect(current).not.toBe(old)
    expect(f.host.detach).toHaveBeenCalledOnce()
    expect(() => f.owner.demand(old)).toThrow('view-stale')
    await f.owner.update(current, {
      width: 64,
      height: 32,
      backingScale: 1,
      visible: true,
    })
    expect(f.target.publishGrant.mock.calls.at(-1)![0]).toMatchObject({
      viewId: current,
      attachment: 2,
    })
  })
  it('rejects stale target and native generations before any frame demand', async () => {
    const f = fixture(),
      id = await f.owner.attach('state', f.session, f.target)
    await f.owner.update(id, { width: 64, height: 32, backingScale: 1, visible: true })
    f.live.epoch = '22222222-2222-4222-8222-222222222222'
    expect(() => f.owner.demand(id)).toThrow('view-stale')
    expect(f.host.takeFrame).not.toHaveBeenCalled()
  })
})

it('coalesces a resize burst to one active and one latest geometry request', async () => {
  const f = fixture(),
    id = await f.owner.attach('state', f.session, f.target),
    ack = deferred<NativeTerminalStatus>()
  f.host.resize.mockReturnValueOnce(ack.promise)
  const first = f.owner.update(id, {
    width: 64,
    height: 32,
    backingScale: 1,
    visible: true,
  })
  let latest = first
  for (let i = 0; i < 25; i++)
    latest = f.owner.update(id, {
      width: 80 + i,
      height: 32,
      backingScale: 1,
      visible: true,
    })
  expect(first).toBe(latest)
  expect(f.host.resize).toHaveBeenCalledTimes(1)
  ack.resolve({ ...f.status(), geometry: { ...f.status().geometry, serial: 2 } })
  const grant = await latest
  expect(f.host.resize).toHaveBeenCalledTimes(2)
  expect(grant).toMatchObject({ geometrySerial: 27, width: 104, height: 32 })
})
it('replaces attachment authority while the previous successful consumer retains its physical lease', async () => {
  const f = fixture(),
    old = await f.owner.attach('state', f.session, f.target)
  await f.owner.update(old, { width: 64, height: 32, backingScale: 1, visible: true })
  const demand = f.owner.demand(old)
  await vi.waitFor(() => expect(f.imported.send).toHaveBeenCalled())
  const fresh = await f.owner.attach('state', f.session, f.target)
  expect(f.host.attach).toHaveBeenCalledTimes(2)
  expect(f.target.publishGrant).toHaveBeenLastCalledWith(undefined)
  await f.owner.update(fresh, { width: 64, height: 32, backingScale: 1, visible: true })
  f.host.takeFrame.mockRejectedValueOnce(new Error('native-frame-bound'))
  await expect(f.owner.demand(fresh)).resolves.toBe(false)
  expect(f.sources[0]!.release).not.toHaveBeenCalled()
  f.consumed.resolve()
  await demand
  await expect(f.owner.demand(fresh)).resolves.toBe(true)
})

it('reports no completed frame for an unready native producer without readback', async () => {
  const f = fixture(),
    id = await f.owner.attach('state', f.session, f.target)
  await f.owner.update(id, { width: 64, height: 32, backingScale: 1, visible: true })
  f.host.takeFrame.mockResolvedValue(undefined)
  await expect(f.owner.demand(id)).resolves.toBe(false)
  expect(f.imports.acquire).not.toHaveBeenCalled()
  expect(f.target.sendPixels).not.toHaveBeenCalled()
})
it('keeps an unknown importer failure unavailable without retiring or releasing its parser source', async () => {
  const f = fixture(),
    id = await f.owner.attach('state', f.session, f.target)
  await f.owner.update(id, { width: 64, height: 32, backingScale: 1, visible: true })
  f.imports.acquire.mockRejectedValue(
    new NativeTerminalImportQuarantined(new Error('unknown import ownership')),
  )
  await expect(f.owner.demand(id)).rejects.toThrow('unknown import ownership')
  expect(f.sources[0]!.release).not.toHaveBeenCalled()
  expect(f.sources[0]!.copyPixels).not.toHaveBeenCalled()
  await expect(f.owner.demand(id)).resolves.toBe(false)
  expect(f.host.takeFrame).toHaveBeenCalledOnce()
})

it('keeps an uncertain prepared handle unavailable across a new attachment', async () => {
  const f = fixture(),
    old = await f.owner.attach('state', f.session, f.target)
  await f.owner.update(old, { width: 64, height: 32, backingScale: 1, visible: true })
  f.imports.acquire.mockRejectedValue(
    new NativeTerminalImportQuarantined(new Error('unknown import')),
  )
  await expect(f.owner.demand(old)).rejects.toThrow('unknown import')
  expect(f.target.publishGrant).toHaveBeenLastCalledWith(undefined)
  const fresh = await f.owner.attach('state', f.session, f.target)
  await expect(
    f.owner.update(fresh, { width: 64, height: 32, backingScale: 1, visible: true }),
  ).resolves.toBeUndefined()
  await expect(f.owner.demand(fresh)).resolves.toBe(false)
  expect(f.host.takeFrame).toHaveBeenCalledOnce()
  expect(f.target.publishStatus).toHaveBeenLastCalledWith({
    viewId: fresh,
    mode: 'unavailable',
    reason: 'import-unavailable',
  })
})
it('publishes the actual acknowledged fractional backing scale rather than an echo', async () => {
  const f = fixture(),
    id = await f.owner.attach('state', f.session, f.target)
  f.host.resize.mockResolvedValueOnce({
    ...f.status(),
    geometry: {
      ...f.status().geometry,
      serial: 2,
      width: 83,
      height: 42,
      backingScale: Math.fround(1.3),
    },
  })
  const grant = await f.owner.update(id, {
    width: 64,
    height: 32,
    backingScale: 1.3,
    visible: true,
  })
  expect(grant!.backingScale).toBe(Math.fround(1.3))
  expect(grant).toMatchObject({ width: 83, height: 42, geometrySerial: 2 })
})

it('hides exact native attachment before detach despite a destroyed receiver notification', async () => {
  const f = fixture(),
    id = await f.owner.attach('state', f.session, f.target),
    hidden = deferred<void>()
  await f.owner.update(id, { width: 64, height: 32, backingScale: 1, visible: true })
  f.target.publishGrant.mockImplementationOnce(() => {
    throw new Error('receiver destroyed')
  })
  f.host.setVisible.mockReturnValueOnce(hidden.promise)
  const closing = f.owner.detach(id)
  expect(f.host.setVisible).toHaveBeenLastCalledWith('state', 1, 1, 1, false)
  expect(f.host.detach).not.toHaveBeenCalled()
  hidden.resolve()
  await closing
  expect(f.host.detach).toHaveBeenCalledWith('state', 1, 1, 1)
})
it('waits an old pending hide before renewing and showing a replacement attachment', async () => {
  const f = fixture(),
    id = await f.owner.attach('state', f.session, f.target),
    hidden = deferred<void>()
  await f.owner.update(id, { width: 64, height: 32, backingScale: 1, visible: true })
  f.host.setVisible.mockReturnValueOnce(hidden.promise)
  const closing = f.owner.detach(id),
    replacing = f.owner.attach('state', f.session, f.target)
  await Promise.resolve()
  expect(f.host.attach).toHaveBeenCalledTimes(1)
  hidden.resolve()
  await closing
  const fresh = await replacing
  await f.owner.update(fresh, { width: 64, height: 32, backingScale: 1, visible: true })
  expect(f.host.setVisible.mock.calls.map((call) => call.slice(3))).toEqual([
    [1, false],
    [1, true],
    [1, false],
    [2, false],
    [2, true],
  ])
})
it('refuses over-budget compatibility before issuing a native pixel copy', async () => {
  const f = fixture(),
    id = await f.owner.attach('state', f.session, f.target)
  await f.owner.update(id, { width: 3000, height: 2000, backingScale: 1, visible: true })
  f.imports.acquire.mockRejectedValue(
    new NativeTerminalGpuImportUnavailable(new Error('GPU unavailable')),
  )
  await expect(f.owner.demand(id)).rejects.toThrow('native-pixel-bound')
  expect(f.sources[0]!.copyPixels).not.toHaveBeenCalled()
  expect(f.sources[0]!.release).toHaveBeenCalledOnce()
  expect(f.target.sendPixels).not.toHaveBeenCalled()
  expect(f.target.publishStatus).toHaveBeenLastCalledWith({
    viewId: id,
    mode: 'unavailable',
    reason: 'pixel-bound',
  })
  await expect(f.owner.demand(id)).resolves.toBe(false)
})

it.each([true, false])(
  'supersedes pending acquisition without blocking visible=%s geometry',
  async (visible) => {
    const f = fixture(),
      id = await f.owner.attach('state', f.session, f.target)
    await f.owner.update(id, { width: 64, height: 32, backingScale: 1, visible: true })
    const oldFrame = f.source(),
      pending = deferred<ReturnType<typeof f.source> | undefined>()
    f.host.takeFrame.mockReturnValueOnce(pending.promise)
    const stale = f.owner.demand(id)
    const geometry = f.owner.update(id, {
      width: 96,
      height: 48,
      backingScale: 1,
      visible,
    })
    const grant = await geometry
    expect(f.host.resize).toHaveBeenCalledTimes(2)
    if (visible) expect(grant).toMatchObject({ width: 96, height: 48, geometrySerial: 3 })
    else expect(grant).toBeUndefined()
    pending.resolve(oldFrame)
    await expect(stale).resolves.toBe(false)
    expect(oldFrame.release).toHaveBeenCalledOnce()
    expect(f.imports.acquire).not.toHaveBeenCalled()
    expect(f.target.publishStatus).not.toHaveBeenCalled()
    if (visible) {
      f.consumed.resolve()
      await expect(f.owner.demand(id)).resolves.toBe(true)
      expect(f.host.takeFrame).toHaveBeenCalledTimes(2)
    }
  },
)
it('treats Host-cleaned stale acquisition as supersession but preserves a genuine native error', async () => {
  const f = fixture(),
    id = await f.owner.attach('state', f.session, f.target)
  await f.owner.update(id, { width: 64, height: 32, backingScale: 1, visible: true })
  const pending = deferred<ReturnType<typeof f.source> | undefined>()
  f.host.takeFrame.mockReturnValueOnce(pending.promise)
  const stale = f.owner.demand(id)
  await f.owner.update(id, { width: 96, height: 48, backingScale: 1, visible: true })
  pending.reject(new Error('native-frame-stale'))
  await expect(stale).resolves.toBe(false)
  const failure = deferred<ReturnType<typeof f.source> | undefined>()
  f.host.takeFrame.mockReturnValueOnce(failure.promise)
  const failed = f.owner.demand(id)
  await f.owner.update(id, { width: 128, height: 64, backingScale: 1, visible: true })
  failure.reject(new Error('native-renderer-operation-failed'))
  await expect(failed).rejects.toThrow('native-renderer-operation-failed')
})
it('acknowledges newer geometry before a prior successful consumer physically releases', async () => {
  const f = fixture(),
    id = await f.owner.attach('state', f.session, f.target)
  await f.owner.update(id, { width: 64, height: 32, backingScale: 1, visible: true })
  const old = f.owner.demand(id)
  await vi.waitFor(() => expect(f.imported.send).toHaveBeenCalled())
  const grant = await f.owner.update(id, {
    width: 96,
    height: 48,
    backingScale: 2,
    visible: true,
  })
  expect(grant).toMatchObject({
    width: 192,
    height: 96,
    geometrySerial: 3,
    backingScale: 2,
  })
  expect(f.sources[0]!.release).not.toHaveBeenCalled()
  expect(f.imported.release).toHaveBeenCalledOnce()
  f.consumed.resolve()
  await old
  await expect(f.owner.demand(id)).resolves.toBe(true)
})

it('occludes an ungranted attachment before returning it to its main owner', async () => {
  const f = fixture()
  const id = await f.owner.attach('state', f.session, f.target)
  expect(f.host.setVisible).toHaveBeenCalledExactlyOnceWith('state', 1, 1, 1, false)
  expect(f.target.publishGrant).not.toHaveBeenCalled()
  await expect(f.owner.demand(id)).resolves.toBe(false)
  expect(f.host.takeFrame).not.toHaveBeenCalled()
})

it('revokes a healthy view and stops polling on native presentation failure while busy remains no-frame', async () => {
  const f = fixture(),
    id = await f.owner.attach('state', f.session, f.target)
  await f.owner.update(id, { width: 64, height: 32, backingScale: 1, visible: true })
  f.host.takeFrame.mockResolvedValueOnce(undefined)
  await expect(f.owner.demand(id)).resolves.toBe(false)
  expect(f.target.publishStatus).not.toHaveBeenCalled()
  f.host.takeFrame.mockRejectedValueOnce(new Error('native-presentation-unavailable'))
  await expect(f.owner.demand(id)).rejects.toThrow('native-presentation-unavailable')
  expect(f.target.publishGrant).toHaveBeenLastCalledWith(undefined)
  expect(f.target.publishStatus).toHaveBeenLastCalledWith({
    viewId: id,
    mode: 'unavailable',
    reason: 'native-lost',
  })
  await expect(f.owner.demand(id)).resolves.toBe(false)
  expect(f.host.takeFrame).toHaveBeenCalledTimes(2)
  expect(f.imports.acquire).not.toHaveBeenCalled()
  expect(f.target.sendPixels).not.toHaveBeenCalled()
})

it('propagates a late old-view quarantine to the current replacement of the same native epoch', async () => {
  const f = fixture(),
    old = await f.owner.attach('state', f.session, f.target),
    send = deferred<void>()
  await f.owner.update(old, { width: 64, height: 32, backingScale: 1, visible: true })
  f.imported.send.mockReturnValue(send.promise)
  const prior = f.owner.demand(old)
  await vi.waitFor(() => expect(f.imported.send).toHaveBeenCalled())
  await f.owner.detach(old)
  const fresh = await f.owner.attach('state', f.session, f.target)
  await f.owner.update(fresh, { width: 96, height: 48, backingScale: 1, visible: true })
  send.reject(new NativeTerminalImportQuarantined(new Error('late old send')))
  await expect(prior).resolves.toBe(false)
  expect(f.target.publishGrant).toHaveBeenLastCalledWith(undefined)
  expect(f.target.publishStatus).toHaveBeenLastCalledWith({
    viewId: fresh,
    mode: 'unavailable',
    reason: 'import-unavailable',
  })
  expect(f.host.setVisible).toHaveBeenLastCalledWith('state', 1, 1, 2, false)
  await expect(f.owner.demand(fresh)).resolves.toBe(false)
  await expect(
    f.owner.update(fresh, { width: 96, height: 48, backingScale: 1, visible: true }),
  ).resolves.toBeUndefined()
  expect(f.host.setVisible).toHaveBeenLastCalledWith('state', 1, 1, 2, false)
  expect(f.host.takeFrame).toHaveBeenCalledOnce()
  expect(f.sources[0]!.release).not.toHaveBeenCalled()
})
it('does not carry an old quarantine into a replacement native epoch', async () => {
  const f = fixture(),
    old = await f.owner.attach('state', f.session, f.target),
    send = deferred<void>()
  await f.owner.update(old, { width: 64, height: 32, backingScale: 1, visible: true })
  f.imported.send.mockReturnValueOnce(send.promise)
  const prior = f.owner.demand(old)
  await vi.waitFor(() => expect(f.imported.send).toHaveBeenCalled())
  await f.owner.detach(old)
  f.live.epoch = '22222222-2222-4222-8222-222222222222'
  const fresh = await f.owner.attach('state', f.session, f.target)
  const grant = await f.owner.update(fresh, {
    width: 96,
    height: 48,
    backingScale: 1,
    visible: true,
  })
  const notifications = f.target.publishStatus.mock.calls.length
  send.reject(new NativeTerminalImportQuarantined(new Error('old generation')))
  await prior
  expect(f.target.publishStatus).toHaveBeenCalledTimes(notifications)
  expect(f.target.publishGrant).toHaveBeenLastCalledWith(grant)
  f.consumed.resolve()
  await expect(f.owner.demand(fresh)).resolves.toBe(true)
})
it('rechecks an already updating replacement before it can show after late quarantine', async () => {
  const f = fixture(),
    old = await f.owner.attach('state', f.session, f.target),
    send = deferred<void>(),
    geometry = deferred<NativeTerminalStatus>()
  await f.owner.update(old, { width: 64, height: 32, backingScale: 1, visible: true })
  f.imported.send.mockReturnValue(send.promise)
  const prior = f.owner.demand(old)
  await vi.waitFor(() => expect(f.imported.send).toHaveBeenCalled())
  await f.owner.detach(old)
  const fresh = await f.owner.attach('state', f.session, f.target)
  f.host.resize.mockReturnValueOnce(geometry.promise)
  const updating = f.owner.update(fresh, {
    width: 96,
    height: 48,
    backingScale: 1,
    visible: true,
  })
  send.reject(new NativeTerminalImportQuarantined(new Error('late old send')))
  await prior
  geometry.resolve({
    ...f.status(),
    geometry: { ...f.status().geometry, serial: 3, width: 96, height: 48 },
  })
  await expect(updating).resolves.toBeUndefined()
  expect(
    f.host.setVisible.mock.calls
      .filter((call) => call[3] === 2)
      .every((call) => call[4] === false),
  ).toBe(true)
  expect(f.target.publishGrant).toHaveBeenLastCalledWith(undefined)
})
it('handles exact current receiver loss promptly without requiring frame demand', async () => {
  const f = fixture(),
    id = await f.owner.attach('state', f.session, f.target)
  const grant = (await f.owner.update(id, {
    width: 64,
    height: 32,
    backingScale: 1,
    visible: true,
  }))!
  f.live.current = false
  f.unavailableCallbacks[0]!(grant)
  await vi.waitFor(() =>
    expect(f.host.setVisible).toHaveBeenLastCalledWith('state', 1, 1, 1, false),
  )
  expect(f.target.publishGrant).toHaveBeenLastCalledWith(undefined)
  expect(f.target.publishStatus).toHaveBeenLastCalledWith({
    viewId: id,
    mode: 'unavailable',
    reason: 'renderer-lost',
  })
  expect(f.host.takeFrame).not.toHaveBeenCalled()
  await expect(f.owner.demand(id)).resolves.toBe(false)
})
it('ignores stale grant loss and unbinds a detached view callback', async () => {
  const f = fixture(),
    id = await f.owner.attach('state', f.session, f.target)
  const old = (await f.owner.update(id, {
    width: 64,
    height: 32,
    backingScale: 1,
    visible: true,
  }))!
  await f.owner.update(id, { width: 64, height: 32, backingScale: 1, visible: true })
  const calls = f.target.publishStatus.mock.calls.length
  f.unavailableCallbacks[0]!(old)
  expect(f.target.publishStatus).toHaveBeenCalledTimes(calls)
  await f.owner.detach(id)
  expect(f.unbindUnavailable).toHaveBeenCalledOnce()
  f.unavailableCallbacks[0]!(old)
  expect(f.target.publishStatus).toHaveBeenCalledTimes(calls)
})
it('does not let failed loss notifications prevent native occlusion cleanup', async () => {
  const f = fixture(),
    id = await f.owner.attach('state', f.session, f.target)
  const grant = (await f.owner.update(id, {
    width: 64,
    height: 32,
    backingScale: 1,
    visible: true,
  }))!
  f.target.publishGrant.mockImplementationOnce(() => {
    throw new Error('renderer gone')
  })
  f.target.publishStatus.mockImplementationOnce(() => {
    throw new Error('renderer gone')
  })
  f.live.current = false
  expect(() => f.unavailableCallbacks[0]!(grant)).not.toThrow()
  await vi.waitFor(() =>
    expect(f.host.setVisible).toHaveBeenLastCalledWith('state', 1, 1, 1, false),
  )
})
