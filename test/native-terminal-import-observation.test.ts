import type {
  ImportSharedTextureOptions,
  SharedTextureImported,
  WebFrameMain,
} from 'electron'
import type { Receipt } from '../packages/native-terminal/resource'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createObservedNativeFrameImports } from '../src/main/smoke/native-terminal-import-diagnostic'

const TIMEOUT =
  'transfer shared texture timed out after 1000ms, ensure you have registered receiver at renderer process.'
const grant = {
  viewId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  nativeEpoch: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  attachment: 1,
  geometrySerial: 2,
  width: 64,
  height: 32,
  backingScale: 1,
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}
function fixture() {
  const callbacks: ImportSharedTextureOptions[] = []
  const source = {
    metadata: {
      lease: 'private-lease-never-log',
      snapshotMutation: 0,
      screen: 0 as const,
      streamSequence: 7,
      geometrySerial: 2,
      kind: 1,
      width: 64,
      height: 32,
      colorSpace: 1,
      origin: 1,
      premultiplied: true,
      resource: { fourcc: 0x42475241, modifier: '0', planes: [] },
    },
    assertCurrent: vi.fn(),
    transfer: vi.fn(() => Promise.resolve()),
    copyPixels: vi.fn(() =>
      Promise.resolve({ bytes: new Uint8Array(8192), stride: 256 }),
    ),
    release: vi.fn(() => Promise.resolve()),
  }
  const edge = {
    receive: vi.fn((ticket: string): Promise<Receipt> =>
      Promise.resolve({
        ticket,
        kind: 1,
        width: 64,
        height: 32,
        fourcc: 0x42475241,
        colorSpace: 1,
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
  const mainRelease = vi.fn()
  const textures = {
    importSharedTexture: vi.fn((options: ImportSharedTextureOptions) => {
      callbacks.push(options)
      return { release: mainRelease } as unknown as SharedTextureImported
    }),
    sendSharedTexture: vi.fn((_options: unknown, _metadata?: unknown) =>
      Promise.resolve(),
    ),
  }
  const target = {
    frame: { isDestroyed: () => false } as WebFrameMain,
    isCurrent: () => true,
    ready: true,
    presentation: { nativeTerminal: grant, screen: 0 as const, origin: 1, colorSpace: 1 },
  }
  const owner = createObservedNativeFrameImports(edge, textures)
  return { callbacks, source, edge, mainRelease, textures, target, owner }
}
interface ObservationEvent {
  event: number
  resource: number
  stage: string
  error?: string
}
interface ObservationTail {
  schema: number
  truncated: boolean
  events: ObservationEvent[]
}
function records<T = ObservationEvent>(
  log: { mock: { calls: readonly (readonly unknown[])[] } },
  prefix = 'HVIR_NATIVE_IMPORT_STAGE ',
): T[] {
  return log.mock.calls.flatMap(([line]) =>
    typeof line === 'string' && line.startsWith(prefix)
      ? [JSON.parse(line.slice(prefix.length)) as T]
      : [],
  )
}
beforeEach(() => {
  vi.stubGlobal('__HVIR_SMOKE_BUILD__', true)
  vi.stubEnv('HVIR_NATIVE_IMPORT_DIAGNOSTICS', '1')
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('native import diagnostic ownership evidence', () => {
  it('associates an earlier settled receive with its source and passes the actual imported object to Electron', async () => {
    const log = vi.mocked(console.log)
    const f = fixture()
    const value = await f.owner.acquire(f.source, f.target)
    await value.send()
    const sent = f.textures.sendSharedTexture.mock.calls[0]![0] as {
      importedSharedTexture: SharedTextureImported
    }
    expect(sent.importedSharedTexture).toBe(
      f.textures.importSharedTexture.mock.results[0]!.value,
    )
    const stages = records(log).map((event) => event.stage)
    expect(stages.indexOf('receive-resolved')).toBeLessThan(
      stages.indexOf('transfer-enter'),
    )
    f.callbacks[0]!.allReferencesReleased!()
    await value.released
    expect(records(log).map((event) => event.stage)).toContain('receipt-release-return')
    expect(records(log).every((event) => event.resource === 1)).toBe(true)
  })

  it('can enable the selected diagnostic window after construction without changing the ordinary metadata', async () => {
    vi.stubEnv('HVIR_NATIVE_IMPORT_DIAGNOSTICS', undefined)
    const log = vi.mocked(console.log)
    const f = fixture()
    const ordinary = await f.owner.acquire(f.source, f.target)
    await ordinary.send()
    expect(f.textures.sendSharedTexture.mock.calls[0]![1]).toEqual(f.target.presentation)
    expect(log).not.toHaveBeenCalled()
    f.callbacks[0]!.allReferencesReleased!()
    await ordinary.released
    vi.stubEnv('HVIR_NATIVE_IMPORT_DIAGNOSTICS', '1')
    const observed = await f.owner.acquire(f.source, f.target)
    await observed.send()
    expect(records(log).map((event) => event.stage)).toContain('send-resolved')
    f.callbacks[1]!.allReferencesReleased!()
    await observed.released
  })

  it('omits invalid grant strings and contains an unavailable diagnostic clock', async () => {
    const log = vi.mocked(console.log)
    const f = fixture()
    await expect(
      f.owner.acquire(f.source, {
        ...f.target,
        presentation: {
          ...f.target.presentation,
          nativeTerminal: { ...grant, viewId: 'private-invalid-grant' },
        },
      }),
    ).rejects.toBeDefined()
    expect(JSON.stringify(log.mock.calls)).not.toContain('private-invalid-grant')
    expect(records(log).every((event) => !('grant' in event))).toBe(true)
    log.mockClear()
    vi.spyOn(performance, 'now').mockImplementation(() => {
      throw new Error('private-clock')
    })
    const g = fixture()
    const value = await g.owner.acquire(g.source, g.target)
    await value.send()
    g.callbacks[0]!.allReferencesReleased!()
    await value.released
    expect(
      records<ObservationEvent & { atMs: number | null }>(log).every(
        (event) => event.atMs === null,
      ),
    ).toBe(true)
    expect(g.source.release).toHaveBeenCalledOnce()
  })

  it('records actual callback entries during import and later without inventing physical state', async () => {
    const log = vi.mocked(console.log)
    const f = fixture()
    f.textures.importSharedTexture.mockImplementationOnce((options) => {
      f.callbacks.push(options)
      options.allReferencesReleased!()
      return { release: f.mainRelease } as unknown as SharedTextureImported
    })
    const value = await f.owner.acquire(f.source, f.target)
    await value.released
    expect(
      records(log).filter((event) => event.stage === 'references-released'),
    ).toHaveLength(1)
    expect(f.source.release).toHaveBeenCalledOnce()
    f.callbacks[0]!.allReferencesReleased!()
    expect(records(log).at(-1)?.stage).toBe('references-released')
    expect(
      records(log).filter((event) => event.stage === 'references-released'),
    ).toHaveLength(2)
    expect(f.source.release).toHaveBeenCalledOnce()
  })

  it('separates send settlement, consumer callback and delayed producer cleanup', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const f = fixture(),
      release = deferred(),
      entered = deferred()
    f.source.release.mockImplementation(() => {
      entered.resolve()
      return release.promise
    })
    const value = await f.owner.acquire(f.source, f.target)
    await value.send()
    expect(records(log).map((x) => x.stage)).toContain('send-resolved')
    expect(records(log).map((x) => x.stage)).not.toContain('references-released')
    f.callbacks[0]!.allReferencesReleased!()
    await entered.promise
    expect(records(log).at(-1)).toMatchObject({
      stage: 'producer-release-enter',
    })
    release.resolve()
    await value.released
    expect(records(log).map((event) => event.stage)).toContain('producer-release-return')
    expect(records(log).map((event) => event.stage)).not.toContain('credit-returned')
    expect(f.source.release).toHaveBeenCalledOnce()
    expect(f.edge.release).toHaveBeenCalledOnce()
  })

  it('records actual pinned send timeout and late callback without claiming reclamation', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const f = fixture()
    f.textures.sendSharedTexture.mockRejectedValueOnce(new Error(TIMEOUT))
    const value = await f.owner.acquire(f.source, f.target)
    await expect(value.send()).rejects.toThrow('native-import-quarantined')
    f.callbacks[0]!.allReferencesReleased!()
    expect(records(log).find((x) => x.stage === 'send-rejected')).toMatchObject({
      error: 'send-timeout-1000ms',
    })
    expect(records(log).at(-1)).toMatchObject({
      stage: 'references-released',
    })
    expect(f.source.release).not.toHaveBeenCalled()
    expect(f.edge.release).not.toHaveBeenCalled()
    expect(f.mainRelease).not.toHaveBeenCalled()
    const tail = records<ObservationTail>(log, 'HVIR_NATIVE_IMPORT_TAIL ').at(-1)!
    expect(tail).toMatchObject({
      schema: 1,
      truncated: false,
      clock: 'main performance.now',
    })
    expect(tail.events.at(-1)).toMatchObject({ stage: 'references-released' })
    expect(JSON.stringify(log.mock.calls)).not.toMatch(
      /outstanding|quarantined|credit-returned|references-released-late/,
    )
  })

  it('distinguishes unknown import ownership from producer release failure without raw error text', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const f = fixture()
    f.textures.importSharedTexture.mockImplementationOnce(() => {
      throw new Error('private-import-payload')
    })
    await expect(f.owner.acquire(f.source, f.target)).rejects.toThrow(
      'native-import-quarantined',
    )
    expect(records(log).map((x) => x.stage)).not.toContain('send-enter')
    expect(records(log).find((x) => x.stage === 'import-rejected')?.error).toBe('unknown')
    const g = fixture()
    const value = await g.owner.acquire(g.source, g.target)
    g.source.release.mockRejectedValueOnce(new Error('private-release-payload'))
    const rejected = expect(value.released).rejects.toThrow('private-release-payload')
    await value.send()
    g.callbacks[0]!.allReferencesReleased!()
    await rejected
    expect(records(log).at(-1)).toMatchObject({
      stage: 'producer-release-rejected',
      error: 'unknown',
    })
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/private-(import|release|lease)/)
  })

  it('pins each delayed send to its own opaque diagnostic resource and leaves ordinary metadata unchanged', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const f = fixture()
    const a = await f.owner.acquire(f.source, f.target)
    const b = await f.owner.acquire({ ...f.source }, f.target)
    await a.send()
    await b.send()
    expect(
      f.textures.sendSharedTexture.mock.calls.map(
        ([, metadata]) =>
          (metadata as { hvirImportObservation: number }).hvirImportObservation,
      ),
    ).toEqual([1, 2])
    expect(f.target.presentation).not.toHaveProperty('hvirImportObservation')
    for (const build of [false, true]) {
      vi.stubGlobal('__HVIR_SMOKE_BUILD__', build)
      if (build) vi.stubEnv('HVIR_NATIVE_IMPORT_DIAGNOSTICS', undefined)
      const ordinary = fixture()
      log.mockClear()
      const value = await ordinary.owner.acquire(ordinary.source, ordinary.target)
      await value.send()
      expect(ordinary.textures.sendSharedTexture.mock.calls[0]![1]).toEqual(
        ordinary.target.presentation,
      )
      expect(log).not.toHaveBeenCalled()
    }
  })

  it('keeps a bounded ordered tail after normal logs saturate and never changes ownership when logging fails', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const f = fixture()
    for (let index = 0; index < 200; index++) {
      const value = await f.owner.acquire({ ...f.source }, f.target)
      await value.send()
      f.callbacks[index]!.allReferencesReleased!()
      await value.released
    }
    f.textures.sendSharedTexture.mockRejectedValueOnce(new Error('private-late-failure'))
    const value = await f.owner.acquire({ ...f.source }, f.target)
    await expect(value.send()).rejects.toThrow('native-import-quarantined')
    expect(records(log)).toHaveLength(2048)
    const tail = records<ObservationTail>(log, 'HVIR_NATIVE_IMPORT_TAIL ').at(-1)!
    expect(tail).toMatchObject({ truncated: true })
    expect(tail.events).toHaveLength(2048)
    expect(tail.events.at(-1)).toMatchObject({ resource: 201, stage: 'send-rejected' })
    expect(
      tail.events.every((x, i) => {
        const previous = tail.events[i - 1]
        return i === 0 || (previous !== undefined && x.event === previous.event + 1)
      }),
    ).toBe(true)
    const g = fixture()
    log.mockImplementation(() => {
      throw new Error('diagnostic-unavailable')
    })
    const ordinary = await g.owner.acquire(g.source, g.target)
    await ordinary.send()
    g.callbacks[0]!.allReferencesReleased!()
    await ordinary.released
    expect(g.source.release).toHaveBeenCalledOnce()
    expect(g.mainRelease).toHaveBeenCalledOnce()
  })
})

describe('native receiver diagnostic stage marks', () => {
  it('correlates a real receiver submission and cleanup without granting authority from the diagnostic ID', async () => {
    vi.resetModules()
    const { NativeTerminalPresentationReceiver } =
      await import('../src/preload/native-terminal-presentation')
    const mark = vi.spyOn(performance, 'mark'),
      clear = vi.spyOn(performance, 'clearMarks')
    const frame = { close: vi.fn() }
    const texture = { getVideoFrame: vi.fn(() => frame), release: vi.fn() }
    const canvas = { draw: vi.fn(), pixels: vi.fn(), dispose: vi.fn() }
    const drawn = vi.fn()
    const receiver = new NativeTerminalPresentationReceiver(
      () => canvas,
      undefined,
      drawn,
    )
    const metadata = {
      nativeTerminal: grant,
      screen: 0,
      origin: 1,
      colorSpace: 1,
      hvirImportObservation: 7,
    }
    receiver.receive(texture, metadata)
    expect(canvas.draw).not.toHaveBeenCalled()
    expect(texture.release).toHaveBeenCalledOnce()
    receiver.mount(grant.viewId, 'observation-terminal')
    receiver.grant({ viewId: grant.viewId, grant })
    receiver.receive(texture, metadata)
    const stages = mark.mock.calls.flatMap(([name, options]) =>
      name === 'hvir.native.presentation.resource-stage'
        ? [(options as { detail: { stage: string } }).detail.stage]
        : [],
    )
    expect(stages).toEqual([
      'receiver-entry',
      'receiver-ineligible',
      'texture-release-enter',
      'texture-release-return',
      'receiver-entry',
      'video-frame-acquired',
      'canvas-submitted',
      'frame-close-enter',
      'frame-close-return',
      'texture-release-enter',
      'texture-release-return',
    ])
    expect(frame.close).toHaveBeenCalledOnce()
    expect(drawn).toHaveBeenCalledOnce()
    expect(
      clear.mock.calls.filter(
        ([name]) => name === 'hvir.native.presentation.resource-stage',
      ),
    ).toHaveLength(stages.length)
    const consoleStages = records<{ stage: string; schema: number; clock: string }>(
      vi.mocked(console.log),
      'HVIR_NATIVE_RECEIVER_STAGE ',
    )
    expect(consoleStages.map((value) => value.stage)).toEqual(stages)
    expect(
      consoleStages.every(
        (value) => value.schema === 1 && value.clock === 'renderer performance.now',
      ),
    ).toBe(true)
    expect(
      performance.getEntriesByName('hvir.native.presentation.resource-stage'),
    ).toEqual([])
  })

  it('bounds cleared marks and ignores missing IDs/ordinary builds with only allowlisted grant fields', async () => {
    vi.resetModules()
    const { nativePresentationResourceStage } =
      await import('../src/preload/native-terminal-presentation-smoke')
    const mark = vi.spyOn(performance, 'mark')
    nativePresentationResourceStage('receiver-entry', { nativeTerminal: grant })
    expect(mark).not.toHaveBeenCalled()
    const metadata = {
      nativeTerminal: { ...grant, private: 'never-log' },
      hvirImportObservation: 1,
    }
    vi.stubGlobal('__HVIR_SMOKE_BUILD__', false)
    nativePresentationResourceStage('receiver-entry', metadata)
    expect(mark).not.toHaveBeenCalled()
    vi.stubGlobal('__HVIR_SMOKE_BUILD__', true)
    for (let index = 0; index < 2050; index++)
      nativePresentationResourceStage('receiver-entry', metadata)
    expect(mark).toHaveBeenCalledTimes(2048)
    expect(mark.mock.calls.at(-1)![1]).toMatchObject({ detail: { truncated: true } })
    expect(JSON.stringify(mark.mock.calls)).not.toContain('never-log')
    vi.stubGlobal('__HVIR_SMOKE_BUILD__', false)
    nativePresentationResourceStage('receiver-entry', metadata)
    expect(mark).toHaveBeenCalledTimes(2048)
  })

  it('preserves a real frame close error and texture release when stage marks fail', async () => {
    vi.resetModules()
    const { NativeTerminalPresentationReceiver } =
      await import('../src/preload/native-terminal-presentation')
    vi.spyOn(performance, 'mark').mockImplementation(() => {
      throw new Error('stage-mark-unavailable')
    })
    vi.spyOn(performance, 'clearMarks').mockImplementation(() => {
      throw new Error('stage-clear-unavailable')
    })
    const original = new Error('original-frame-close')
    const frame = {
      close: vi.fn(() => {
        throw original
      }),
    }
    const texture = { getVideoFrame: () => frame, release: vi.fn() }
    const receiver = new NativeTerminalPresentationReceiver(() => ({
      draw: vi.fn(),
      pixels: vi.fn(),
      dispose: vi.fn(),
    }))
    receiver.mount(grant.viewId, 'observation-terminal')
    receiver.grant({ viewId: grant.viewId, grant })
    expect(() =>
      receiver.receive(texture, {
        nativeTerminal: grant,
        screen: 0,
        origin: 1,
        colorSpace: 1,
        hvirImportObservation: 1,
      }),
    ).toThrow(original)
    expect(frame.close).toHaveBeenCalledOnce()
    expect(texture.release).toHaveBeenCalledOnce()
    expect(
      records<{ timelineDisabled: boolean }>(
        vi.mocked(console.log),
        'HVIR_NATIVE_RECEIVER_STAGE ',
      ).at(-1),
    ).toMatchObject({ timelineDisabled: true })
  })
})
