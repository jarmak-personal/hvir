import { EventEmitter } from 'node:events'
import type { Frame, Status } from '@hvir/native-terminal/engine'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runNativeTerminalHost } from '../src/workers/native-terminal-runtime'
import type { NativeTerminalHostMessage } from '../src/shared/native-terminal'

const mocks = vi.hoisted(() => ({
  spawn: vi.fn<() => unknown>(),
  sendFrame: vi.fn<(...args: unknown[]) => Promise<void>>(),
}))
vi.mock('node:worker_threads', () => ({
  Worker: function () {
    return mocks.spawn()
  },
}))
vi.mock('@hvir/native-terminal/resource', () => ({
  default: { sendFrame: mocks.sendFrame },
}))
interface Call {
  id: number
  operation: string
  args: unknown[]
}
class Engine extends EventEmitter {
  readonly calls: Call[] = []
  postMessage(call: Call): void {
    this.calls.push(structuredClone(call))
  }
}
class Port extends EventEmitter {
  readonly messages: NativeTerminalHostMessage[] = []
  postMessage(message: NativeTerminalHostMessage): void {
    this.messages.push(structuredClone(message))
  }
  send(id: number, command: unknown, epoch = 'epoch'): void {
    this.emit('message', { data: { kind: 'request', epoch, id, command } })
  }
  cancel(id: number): void {
    this.emit('message', { data: { kind: 'cancel', epoch: 'epoch', id } })
  }
  result(id: number) {
    return this.messages.find((message) => message.kind === 'result' && message.id === id)
  }
}
class UtilityExit extends Error {}
let engine: Engine
let port: Port
let exited: boolean
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}
function last(): Call {
  return engine.calls.at(-1)!
}
async function complete(value: unknown, call = last()): Promise<void> {
  engine.emit('message', { id: call.id, value })
  await flush()
}
function status(): Status {
  return {
    appliedSequence: 0n,
    replySequence: 0n,
    queuedReplyBytes: 0,
    failure: 0,
    closing: false,
    rendererHealth: 0,
    presentationFailure: 0,
    frameCopies: 0n,
    geometryFailureSerial: 0n,
    geometry: {
      serial: 1n,
      columns: 80,
      rows: 24,
      width: 800,
      height: 600,
      cellWidth: 10,
      cellHeight: 20,
      contentWidth: 800,
      contentHeight: 480,
      paddingLeft: 0,
      paddingTop: 0,
      backingScale: 1,
    },
  }
}
function frame(): Frame {
  return {
    lease: 9007199254740993n,
    streamSequence: 2n,
    geometrySerial: 1n,
    kind: 1,
    width: 800,
    height: 600,
    fourcc: 1,
    premultiplied: true,
    colorSpace: 2,
    origin: 1,
    modifier: 0n,
    planeCount: 0,
    planes: [],
    surface: Buffer.from([1, 2, 3, 4]),
  }
}
async function create(): Promise<void> {
  port.send(1, { kind: 'create', width: 800, height: 600 })
  expect(last().operation).toBe('create')
  await complete({ result: 0, id: 7n })
  expect(last()).toMatchObject({ operation: 'inspect', args: ['7'] })
  await complete({ result: 0, status: status() })
  expect(port.result(1)).toMatchObject({ ok: true, value: { state: '7' } })
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('__dirname', '/native-worker')
  engine = new Engine()
  port = new Port()
  exited = false
  mocks.spawn.mockReturnValue(engine)
  mocks.sendFrame.mockResolvedValue(undefined)
  vi.spyOn(process, 'exit').mockImplementation((): never => {
    exited = true
    throw new UtilityExit()
  })
  runNativeTerminalHost(port, {
    epoch: 'epoch',
    library: '/trusted/libghostty',
    resourceAddress: '/private/resource',
    mainPid: 456,
  })
  engine.emit('message', { kind: 'ready' })
})
afterEach(async () => {
  if (!exited) expect(() => engine.emit('exit', 0)).toThrow(UtilityExit)
  await flush()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('native utility owner', () => {
  it('rejects parent work before the engine is ready', () => {
    const unreadyEngine = new Engine()
    const unreadyPort = new Port()
    mocks.spawn.mockReturnValue(unreadyEngine)
    runNativeTerminalHost(unreadyPort, {
      epoch: 'unready',
      library: '/trusted/libghostty',
      resourceAddress: '/private/resource',
      mainPid: 456,
    })
    expect(() => unreadyPort.send(1, { kind: 'read', state: '7' }, 'unready')).toThrow(
      UtilityExit,
    )
    expect(unreadyEngine.calls).toEqual([])
  })

  it('rejects a duplicate native completion after its original result settled', async () => {
    port.send(1, { kind: 'read', state: '7' })
    const call = last()
    await complete({ result: 0, data: Uint8Array.of(65) }, call)
    expect(port.result(1)).toMatchObject({ ok: true })
    expect(() => engine.emit('message', { id: call.id, value: { result: 0 } })).toThrow(
      UtilityExit,
    )
  })

  it('runs the native key encoder on the caller worker and returns exact bytes', async () => {
    await create()
    port.send(2, { kind: 'key', state: '7', key: 22, modifiers: 2, action: 1, text: 'c' })
    expect(last()).toMatchObject({ operation: 'key', args: ['7', 22, 2, 1, 'c'] })
    await complete({ result: 0, data: new Uint8Array([0, 128, 255]) })
    expect(port.result(2)).toMatchObject({
      ok: true,
      value: new Uint8Array([0, 128, 255]),
    })
  })

  it.each([
    { kind: 'key', state: '7', key: 176, modifiers: 0, action: 1, text: '' },
    { kind: 'key', state: '7', key: 0, modifiers: 1024, action: 1, text: '' },
    { kind: 'key', state: '7', key: 0, modifiers: 0, action: 3, text: '' },
    { kind: 'key', state: '7', key: 0, modifiers: 0, action: 1, text: '\0' },
    { kind: 'key', state: '7', key: 0, modifiers: 0, action: 1, text: 'é'.repeat(2049) },
    { kind: 'read' },
    { kind: 'read', state: 7 },
    { kind: 'read', state: '0' },
    { kind: 'resize', state: '7', width: 31, height: 600, serial: 1 },
    { kind: 'feed', state: '7', sequence: 1, bytes: new Uint8Array(16385) },
    {
      kind: 'feed',
      state: '7',
      sequence: 1,
      bytes: new Uint8Array(new SharedArrayBuffer(1)),
    },
    { kind: 'transfer', state: '7', ticket: 't', lease: '0' },
    { kind: 'release', state: '7', lease: 1 },
    { kind: 'transfer', state: '7', ticket: 't', lease: 1 },
    { kind: 'frame', state: '7', ticket: '' },
    { kind: 'transfer', state: '7', ticket: '', lease: '1' },
    { kind: 'frame', state: '7', ticket: 'bad\nrecord' },
    { kind: 'unknown', state: '7' },
  ])('rejects malformed same-epoch commands before native dispatch: %j', (command) => {
    expect(() => port.send(1, command)).toThrow(UtilityExit)
    expect(engine.calls).toEqual([])
  })

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid request ID %s',
    (id) => {
      expect(() => port.send(id, { kind: 'read', state: '7' })).toThrow(UtilityExit)
      expect(engine.calls).toEqual([])
    },
  )

  it('ignores stale epochs, including stale malformed messages', async () => {
    port.send(0, { kind: 'unknown' }, 'retired')
    expect(engine.calls).toEqual([])
    port.send(1, { kind: 'read', state: '7' })
    await complete({ result: 0, data: Uint8Array.of(0, 255) })
    expect(port.result(1)).toMatchObject({ ok: true, value: Uint8Array.of(0, 255) })
    expect(exited).toBe(false)
  })

  it('rejects a duplicate pending request without dispatching it twice', () => {
    port.send(1, { kind: 'read', state: '7' })
    expect(() => port.send(1, { kind: 'read', state: '7' })).toThrow(UtilityExit)
    expect(engine.calls).toHaveLength(1)
  })

  it('rejects forged engine completions and engine loss', () => {
    port.send(1, { kind: 'read', state: '7' })
    expect(() =>
      engine.emit('message', { id: last().id + 1, value: { result: 0 } }),
    ).toThrow(UtilityExit)
    expect(exited).toBe(true)
  })

  it('fails pending work when the engine exits', async () => {
    port.send(1, { kind: 'read', state: '7' })
    expect(() => engine.emit('exit', 1)).toThrow(UtilityExit)
    await flush()
    expect(port.result(1)).toMatchObject({ ok: false, error: 'native-operation-failed' })
  })

  it('destroys the actual returned state after cancelled creation', async () => {
    port.send(1, { kind: 'create', width: 800, height: 600 })
    port.cancel(1)
    await complete({ result: 0, id: 987n })
    expect(last()).toMatchObject({ operation: 'destroy', args: ['987'] })
    await complete({ result: 0 })
    expect(port.result(1)).toMatchObject({ ok: false, error: 'cancelled' })
    port.send(2, { kind: 'shutdown' })
    expect(last().operation).toBe('close')
    await complete({ result: 0 })
    expect(port.result(2)).toMatchObject({ ok: true })
  })

  it('cleans up failed initial geometry without publishing the state', async () => {
    port.send(1, { kind: 'create', width: 800, height: 600 })
    await complete({ result: 0, id: 44n })
    await complete({ result: 0, status: { ...status(), failure: 17 } })
    expect(last()).toMatchObject({ operation: 'destroy', args: ['44'] })
    await complete({ result: 0 })
    expect(port.result(1)).toMatchObject({ ok: false })
  })

  it('releases a late cancelled frame using its exact lease and keeps the owner usable', async () => {
    await create()
    port.send(2, { kind: 'frame', state: '7', ticket: 'ticket' })
    port.cancel(2)
    await complete({ result: 0, frame: frame() })
    expect(last()).toMatchObject({
      operation: 'release',
      args: ['7', '9007199254740993'],
    })
    await complete({ result: 9 })
    expect(port.result(2)).toMatchObject({ ok: false, error: 'cancelled' })
    port.send(3, {
      kind: 'transfer',
      state: '7',
      lease: '9007199254740993',
      ticket: 'forged',
    })
    await flush()
    expect(port.result(3)).toMatchObject({ ok: false })
    expect(mocks.sendFrame).not.toHaveBeenCalled()
    port.send(4, { kind: 'read', state: '7' })
    await complete({ result: 0, data: Uint8Array.of(65) })
    expect(port.result(4)).toMatchObject({ ok: true })
    expect(exited).toBe(false)
  })

  it('loses the owner when cancelled frame cleanup cannot prove release', async () => {
    await create()
    port.send(2, { kind: 'frame', state: '7', ticket: 'ticket' })
    port.cancel(2)
    await complete({ result: 0, frame: frame() })
    expect(last()).toMatchObject({
      operation: 'release',
      args: ['7', '9007199254740993'],
    })
    await complete({ result: 4 })
    expect(exited).toBe(true)
  })

  it('loses the owner when failed creation cleanup cannot prove destruction', async () => {
    port.send(1, { kind: 'create', width: 800, height: 600 })
    port.cancel(1)
    await complete({ result: 0, id: 987n })
    expect(last()).toMatchObject({ operation: 'destroy', args: ['987'] })
    await complete({ result: 6 })
    expect(exited).toBe(true)
  })

  it('keeps OS handles local, checks transfer leases, and retires release result 9', async () => {
    await create()
    port.send(2, { kind: 'frame', state: '7', ticket: 'ticket' })
    await complete({ result: 0, frame: frame() })
    expect(port.result(2)).toMatchObject({
      ok: true,
      value: { lease: '9007199254740993' },
    })
    const published = port.result(2)
    expect(
      published && 'value' in published ? published.value : undefined,
    ).not.toHaveProperty('surface')
    port.send(3, {
      kind: 'transfer',
      state: '7',
      lease: '9007199254740993',
      ticket: 'ticket',
    })
    await flush()
    expect(mocks.sendFrame).toHaveBeenCalledWith(
      '/private/resource',
      456,
      'ticket',
      expect.objectContaining({ surface: Buffer.from([1, 2, 3, 4]) }),
    )
    port.send(4, { kind: 'release', state: '7', lease: '9007199254740993' })
    await complete({ result: 9 })
    expect(port.result(4)).toMatchObject({ ok: true, value: { result: 9 } })
    port.send(5, {
      kind: 'transfer',
      state: '7',
      lease: '9007199254740993',
      ticket: 'late',
    })
    await flush()
    expect(port.result(5)).toMatchObject({ ok: false })
    expect(mocks.sendFrame).toHaveBeenCalledTimes(1)
  })

  it('refuses shutdown during creation and while a live state remains', async () => {
    port.send(1, { kind: 'create', width: 800, height: 600 })
    port.send(2, { kind: 'shutdown' })
    await flush()
    expect(port.result(2)).toMatchObject({ ok: false })
    expect(engine.calls.map((call) => call.operation)).toEqual(['create'])
    await complete({ result: 0, id: 7n })
    await complete({ result: 0, status: status() })
    port.send(3, { kind: 'shutdown' })
    await flush()
    expect(port.result(3)).toMatchObject({ ok: false })
    port.send(4, { kind: 'destroy', state: '7' })
    await complete({ result: 0 })
    port.send(5, { kind: 'shutdown' })
    expect(last().operation).toBe('close')
    await complete({ result: 0 })
    expect(port.result(5)).toMatchObject({ ok: true })
  })

  it('admits exactly 64 physical jobs across states and serializes their completion', async () => {
    for (let id = 1; id <= 64; id++) {
      port.send(id, {
        kind: 'feed',
        state: String(Math.ceil(id / 8)),
        sequence: id,
        bytes: new Uint8Array(16384),
      })
      port.cancel(id)
    }
    expect(engine.calls).toHaveLength(1)
    expect(exited).toBe(false)
    expect(port.messages.filter((message) => message.kind === 'result')).toHaveLength(0)
    for (let index = 0; index < 64; index++) {
      expect(engine.calls).toHaveLength(index + 1)
      await complete({ result: 0 })
    }
    expect(engine.calls).toHaveLength(64)
    expect(new Set(engine.calls.map((call) => call.id)).size).toBe(64)
    expect(port.messages.filter((message) => message.kind === 'result')).toHaveLength(64)
    expect(exited).toBe(false)
  })

  it('treats a forged 65th outstanding parent request as owner loss', () => {
    for (let id = 1; id <= 64; id++) {
      port.send(id, { kind: 'read', state: String(Math.ceil(id / 8)) })
    }
    expect(() => port.send(65, { kind: 'read', state: '9' })).toThrow(UtilityExit)
    expect(engine.calls).toHaveLength(1)
  })

  it('retains physical scheduler credits after cancellation and rejects unsent overflow', async () => {
    for (let id = 1; id <= 8; id++) {
      port.send(id, {
        kind: 'feed',
        state: '7',
        sequence: id,
        bytes: new Uint8Array(16384),
      })
      port.cancel(id)
    }
    expect(engine.calls).toHaveLength(1)
    port.send(9, { kind: 'feed', state: '7', sequence: 9, bytes: Uint8Array.of(9) })
    await flush()
    expect(port.result(9)).toMatchObject({ ok: false, error: 'native-admission-bound' })
    expect(engine.calls).toHaveLength(1)
    for (let id = 1; id <= 8; id++) await complete({ result: 0 })
    expect(engine.calls).toHaveLength(8)
    port.send(10, { kind: 'feed', state: '7', sequence: 10, bytes: Uint8Array.of(10) })
    await complete({ result: 0 })
    expect(port.result(10)).toMatchObject({ ok: true })
  })
})
