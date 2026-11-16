import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, WebFrameMain } from 'electron'
import { nativeWorkbenchGeometryReadiness } from '../src/main/smoke/native-terminal-workbench-geometry'
import type { ManagedPty, PtySupervisor } from '../src/main/pty/pty-supervisor'
import type { NativeTerminalApplication } from '../src/main/terminal/native-terminal-application'
import { NativeTerminalAdmissionError } from '../src/shared/native-terminal'
import { nativeTerminalStatus } from './fixtures/native-terminal-host'

vi.mock('electron', () => ({ clipboard: {} }))

function fixture() {
  const managed = {
    id: 'session',
    instanceId: 'instance',
    pid: 42,
    ownerId: 7,
    ownerGeneration: 3,
  }
  let live = { ...managed }
  let record = {
    handle: 'handle',
    retiring: false,
    unavailable: false,
    session: {
      sessionId: managed.id,
      instanceId: managed.instanceId,
      ownerId: managed.ownerId,
      ownerGeneration: managed.ownerGeneration,
    },
  }
  const initial = nativeTerminalStatus(2)
  const geometry = { ...initial.geometry }
  const status = { ...initial, geometry }
  const bounds = {
    width: geometry.width,
    height: geometry.height,
    canvasWidth: geometry.width,
    canvasHeight: geometry.height,
    canvasCssWidth: geometry.width,
    canvasCssHeight: geometry.height,
    dpr: 1,
  }
  let viewId = 'original-view'
  let frame = { isDestroyed: () => false } as WebFrameMain
  const firstFrame = frame
  const input = { isConnected: true }
  const canvas = {
    isConnected: true,
    get width() {
      return bounds.canvasWidth
    },
    get height() {
      return bounds.canvasHeight
    },
    getBoundingClientRect: () => ({
      width: bounds.canvasCssWidth,
      height: bounds.canvasCssHeight,
    }),
  }
  const surface = {
    isConnected: true,
    get id() {
      return 'native-terminal-' + viewId
    },
    querySelector: () => canvas,
  }
  const pane = {
    isConnected: true,
    querySelector: (selector: string) => (selector === 'textarea' ? input : surface),
    getBoundingClientRect: () => ({
      x: 0,
      y: 0,
      width: bounds.width,
      height: bounds.height,
    }),
  }
  const document = {
    querySelectorAll: () => [
      {
        getAttribute: () => managed.id,
        querySelector: () => pane,
      },
    ],
  }
  const events: string[] = []
  const inspect = vi.fn<NativeTerminalApplication['inspectRetained']>(() => {
    events.push('inspect')
    return Promise.resolve(status)
  })
  const executeJavaScript = vi.fn((script: string): Promise<unknown> => {
    events.push('dom')
    return Promise.resolve(
      runInNewContext(script, { document, devicePixelRatio: bounds.dpr }) as unknown,
    )
  })
  const contents = {
    isDestroyed: () => false,
    get mainFrame() {
      return frame
    },
    executeJavaScript,
  }
  const win = { isDestroyed: () => false, webContents: contents }
  const drawn = vi.fn<NativeTerminalApplication['targets']['drawn']>(() => ({
    screen: 0,
    geometrySerial: geometry.serial,
  }))
  const native = {
    inspectRetained: inspect,
    sessions: { get: () => record },
    targets: { drawn },
  }
  const read = nativeWorkbenchGeometryReadiness(
    win as unknown as BrowserWindow,
    { get: () => live } as unknown as PtySupervisor,
    native as unknown as NativeTerminalApplication,
    managed as ManagedPty,
  )
  return {
    read,
    geometry,
    bounds,
    inspect,
    drawn,
    events,
    executeJavaScript,
    firstFrame,
    replaceView: () => {
      viewId = 'replacement-view'
    },
    replaceFrame: () => {
      frame = { isDestroyed: () => false } as WebFrameMain
    },
    replaceLive: (value: Partial<typeof live>) => {
      live = { ...live, ...value }
    },
    replaceRecord: (value: Partial<typeof record>) => {
      record = { ...record, ...value }
    },
    record: () => record,
  }
}

describe('native workbench settled geometry observation', () => {
  it.each(['absent', 'older'] as const)(
    'does not admit new native cells with %s drawn authority',
    async (state) => {
      const f = fixture()
      f.drawn.mockReturnValue(
        state === 'absent' ? undefined : { screen: 0, geometrySerial: 1 },
      )
      await expect(f.read()).resolves.toBeUndefined()
    },
  )

  it.each([
    'width',
    'height',
    'canvasWidth',
    'canvasHeight',
    'canvasCssWidth',
    'canvasCssHeight',
    'dpr',
  ] as const)('does not admit an intermediate DOM %s', async (field) => {
    const f = fixture()
    f.bounds[field] += 1
    await expect(f.read()).resolves.toBeUndefined()
  })

  it('returns a copied frozen geometry only with the exact current draw and fitted DOM', async () => {
    const f = fixture(),
      observed = await f.read()
    expect(observed).toEqual(f.geometry)
    expect(observed).not.toBe(f.geometry)
    expect(Object.isFrozen(observed)).toBe(true)
    expect(f.drawn).toHaveBeenCalledExactlyOnceWith('original-view', f.firstFrame)
    expect(f.events).toEqual(['dom', 'inspect', 'dom'])
  })

  it('rounds fractional CSS extents to their actual native backing dimensions', async () => {
    const f = fixture()
    Object.assign(f.geometry, { width: 730, height: 64, backingScale: 2 })
    Object.assign(f.bounds, {
      width: 364.75,
      height: 32,
      canvasWidth: 730,
      canvasHeight: 64,
      canvasCssWidth: 364.75,
      canvasCssHeight: 32,
      dpr: 2,
    })
    await expect(f.read()).resolves.toEqual(f.geometry)
  })

  it.each([
    { dpr: 1.1, cssWidth: 100, width: 110, height: 88 },
    { dpr: 1.2, cssWidth: 100, width: 120, height: 96 },
    { dpr: 1.3, cssWidth: 95, width: 124, height: 104 },
    { dpr: 1.3, cssWidth: 815, width: 1060, height: 104 },
  ])(
    'admits native f32 scale at DPR$dpr and raw CSS width$cssWidth',
    async ({ dpr, cssWidth, width, height }) => {
      const f = fixture()
      Object.assign(f.geometry, { width, height, backingScale: Math.fround(dpr) })
      Object.assign(f.bounds, {
        width: cssWidth,
        height: 80,
        canvasWidth: width,
        canvasHeight: height,
        canvasCssWidth: cssWidth,
        canvasCssHeight: 80,
        dpr,
      })
      await expect(f.read()).resolves.toEqual(f.geometry)
    },
  )

  it('refuses a genuinely different normalized device scale', async () => {
    const f = fixture()
    f.bounds.dpr = 1 + 2 ** -22
    await expect(f.read()).resolves.toBeUndefined()
  })

  it('pins the view before a known-unsent refusal and refuses its later replacement', async () => {
    const f = fixture()
    f.inspect.mockImplementationOnce(() => {
      f.events.push('refused-inspect')
      return Promise.reject(new NativeTerminalAdmissionError('native-command-bound'))
    })
    await expect(f.read()).resolves.toBeUndefined()
    expect(f.events).toEqual(['dom', 'refused-inspect'])
    f.replaceView()
    await expect(f.read()).rejects.toThrow('native-workbench-geometry-view')
    expect(f.drawn).not.toHaveBeenCalled()
  })

  it.each(['instance', 'owner', 'handle', 'pid', 'frame'] as const)(
    'refuses %s replacement during known-unsent admission without adopting it',
    async (kind) => {
      const f = fixture()
      f.inspect.mockRejectedValueOnce(
        new NativeTerminalAdmissionError('native-command-bound'),
      )
      await expect(f.read()).resolves.toBeUndefined()
      if (kind === 'instance') f.replaceLive({ instanceId: 'replacement' })
      if (kind === 'owner')
        f.replaceRecord({ session: { ...f.record().session, ownerGeneration: 4 } })
      if (kind === 'handle') f.replaceRecord({ handle: 'replacement' })
      if (kind === 'pid') f.replaceLive({ pid: 43 })
      if (kind === 'frame') f.replaceFrame()
      await expect(f.read()).rejects.toThrow(/native-workbench-geometry-(owner|document)/)
      expect(f.inspect).toHaveBeenCalledOnce()
    },
  )

  it('revalidates the physical instance after asynchronous native inspection', async () => {
    const f = fixture()
    f.inspect.mockImplementationOnce(() => {
      f.replaceLive({ pid: 43 })
      return Promise.resolve({ ...nativeTerminalStatus(2), geometry: f.geometry })
    })
    await expect(f.read()).rejects.toThrow('native-workbench-geometry-owner')
    expect(f.drawn).not.toHaveBeenCalled()
  })

  it('revalidates the document after asynchronous DOM view capture before inspecting', async () => {
    const f = fixture()
    const execute = f.executeJavaScript.getMockImplementation()!
    f.executeJavaScript.mockImplementationOnce(async (script) => {
      const value = await execute(script)
      f.replaceFrame()
      return value
    })
    await expect(f.read()).rejects.toThrow('native-workbench-geometry-document')
    expect(f.inspect).not.toHaveBeenCalled()
  })

  it('surfaces non-admission native failures without a readiness conversion', async () => {
    const f = fixture(),
      failure = new Error('native-command-bound')
    f.inspect.mockRejectedValueOnce(failure)
    await expect(f.read()).rejects.toBe(failure)
    expect(f.inspect).toHaveBeenCalledOnce()
    expect(f.drawn).not.toHaveBeenCalled()
  })
})
