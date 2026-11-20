import { EventEmitter } from 'node:events'
import type { Frame, Status } from '@hvir/native-terminal/engine'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runNativeTerminalHost } from '../src/workers/native-terminal-runtime'
import type { NativeTerminalHostMessage } from '../src/shared/native-terminal'

// The real utility runtime owns scheduling, validation, held frames and results.
// Only its immediate worker/resource dependencies are controlled; no GPU claim.
const boundary = vi.hoisted(() => ({
  spawn: vi.fn<(...args: unknown[]) => unknown>(),
  sendFrame: vi.fn<(...args: unknown[]) => Promise<void>>(),
}))
vi.mock('node:worker_threads', () => ({
  Worker: function (...args: unknown[]) {
    return boundary.spawn(...args)
  },
}))
vi.mock('@hvir/native-terminal/resource', () => ({
  default: { sendFrame: boundary.sendFrame },
}))
interface Call {
  id: number
  operation: string
  args: unknown[]
}
class Engine extends EventEmitter {
  readonly calls: Call[] = []
  postMessage(value: Call) {
    this.calls.push(structuredClone(value))
  }
}
class Port extends EventEmitter {
  readonly messages: NativeTerminalHostMessage[] = []
  postMessage(value: NativeTerminalHostMessage) {
    this.messages.push(structuredClone(value))
  }
  send(id: number, command: unknown) {
    this.emit('message', { data: { kind: 'request', epoch: 'epoch', id, command } })
  }
  result(id: number) {
    return this.messages.find((value) => value.kind === 'result' && value.id === id)
  }
}
class UtilityExit extends Error {}
let engine: Engine
let port: Port
let exited: boolean
const lease = '9007199254740993'
const request = '18446744073709551615'
const last = () => engine.calls.at(-1)!
const flush = () => vi.advanceTimersByTimeAsync(0)
async function complete(value: unknown) {
  engine.emit('message', { id: last().id, value })
  await flush()
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('__dirname', '/native-worker')
  engine = new Engine()
  port = new Port()
  exited = false
  boundary.spawn.mockReturnValue(engine)
  boundary.sendFrame.mockResolvedValue(undefined)
  vi.spyOn(process, 'exit').mockImplementation((): never => {
    exited = true
    throw new UtilityExit()
  })
  runNativeTerminalHost(port, {
    epoch: 'epoch',
    library: '/trusted/native',
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
async function holdFrame() {
  port.send(1, { kind: 'create', width: 800, height: 600 })
  await complete({ result: 0, id: 7n })
  const status: Status = {
    ioAppliedSequence: 0n,
    ioAppliedMutation: 0n,
    inputFailure: 0,
    appliedSequence: 0n,
    replySequence: 0n,
    queuedReplyBytes: 0,
    failure: 0,
    closing: false,
    rendererHealth: 0,
    presentationFailure: 0,
    frameCopies: 0n,
    geometryFailureSerial: 0n,
    appliedAppearanceSerial: 0n,
    appearanceFailureSerial: 0n,
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
  await complete({ result: 0, status })
  const frame: Frame = {
    lease: BigInt(lease),
    snapshotMutation: 0n,
    screen: 0,
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
  port.send(2, { kind: 'frame', state: '7', ticket: 'fixture' })
  await complete({ result: 0, frame })
  expect(port.result(2)).toMatchObject({ ok: true, value: { lease } })
}

describe('native utility held-frame retirement', () => {
  it.each([1, 2, 3, 4])(
    'preserves exact serials and closed status %s through physical control scheduling',
    async (status) => {
      await holdFrame()
      port.send(3, { kind: 'retire-frame-begin', state: '7', lease })
      port.send(4, { kind: 'retire-frame-status', state: '7', lease, request })
      expect(last()).toMatchObject({
        operation: 'retire-frame-begin',
        args: ['7', lease],
      })
      await complete({ result: 0, request: BigInt(request) })
      expect(port.result(3)).toMatchObject({ ok: true, value: { request } })
      expect(last()).toMatchObject({
        operation: 'retire-frame-status',
        args: ['7', lease, request],
      })
      await complete({ result: 0, retirementStatus: status })
      expect(port.result(4)).toMatchObject({ ok: true, value: { status } })
      expect(engine.calls.some((value) => value.operation === 'release')).toBe(false)
    },
  )

  it('refuses foreign state/lease and a released frame without native dispatch', async () => {
    await holdFrame()
    const before = engine.calls.length
    port.send(3, { kind: 'retire-frame-begin', state: '8', lease })
    port.send(4, { kind: 'retire-frame-status', state: '7', lease: '11', request })
    await flush()
    expect(engine.calls).toHaveLength(before)
    for (const id of [3, 4])
      expect(port.result(id)).toMatchObject({
        ok: false,
        error: 'native-operation-failed',
      })
    port.send(5, { kind: 'release', state: '7', lease })
    await complete({ result: 0 })
    const released = engine.calls.length
    port.send(6, { kind: 'retire-frame-begin', state: '7', lease })
    await flush()
    expect(engine.calls).toHaveLength(released)
    expect(port.result(6)).toMatchObject({ ok: false })
  })

  it('keeps the exact held resource after cancellation of an already sent begin', async () => {
    await holdFrame()
    port.send(3, { kind: 'retire-frame-begin', state: '7', lease })
    port.emit('message', { data: { kind: 'cancel', epoch: 'epoch', id: 3 } })
    await complete({ result: 0, request: BigInt(request) })
    port.send(4, { kind: 'retire-frame-status', state: '7', lease, request })
    expect(last()).toMatchObject({
      operation: 'retire-frame-status',
      args: ['7', lease, request],
    })
    await complete({ result: 0, retirementStatus: 1 })
    expect(port.result(4)).toMatchObject({ ok: true, value: { status: 1 } })
    expect(engine.calls.some((value) => value.operation === 'release')).toBe(false)
  })

  it.each([0n, 0x10000000000000000n, 12, undefined])(
    'refuses malformed begin result %s while retaining its held frame',
    async (value) => {
      await holdFrame()
      port.send(3, { kind: 'retire-frame-begin', state: '7', lease })
      await complete({ result: 0, request: value })
      expect(port.result(3)).toMatchObject({
        ok: false,
        error: 'native-operation-failed',
      })
      port.send(4, { kind: 'transfer', state: '7', lease, ticket: 'still-held' })
      await flush()
      expect(port.result(4)).toMatchObject({ ok: true })
      expect(boundary.sendFrame).toHaveBeenCalledOnce()
      expect(engine.calls.some((value) => value.operation === 'release')).toBe(false)
    },
  )

  it.each([0, 5, 1.5, '2', undefined])(
    'refuses noncontract status %s without releasing its held frame',
    async (status) => {
      await holdFrame()
      port.send(3, { kind: 'retire-frame-status', state: '7', lease, request })
      await complete({ result: 0, retirementStatus: status })
      expect(port.result(3)).toMatchObject({
        ok: false,
        error: 'native-operation-failed',
      })
      expect(engine.calls.some((value) => value.operation === 'release')).toBe(false)
    },
  )

  it('preserves native refusal as an operation error and leaves the lease owned', async () => {
    await holdFrame()
    port.send(3, { kind: 'retire-frame-begin', state: '7', lease })
    await complete({ result: 6 })
    expect(port.result(3)).toMatchObject({ ok: false, error: 'native-operation-failed' })
    port.send(4, { kind: 'retire-frame-status', state: '7', lease, request })
    await complete({ result: 0, retirementStatus: 3 })
    expect(port.result(4)).toMatchObject({ ok: true, value: { status: 3 } })
    expect(exited).toBe(false)
  })

  it.each([
    { kind: 'retire-frame-begin', state: '7', lease: '0' },
    { kind: 'retire-frame-begin', state: '7', lease: '18446744073709551616' },
    { kind: 'retire-frame-status', state: '7', lease, request: '01' },
    { kind: 'retire-frame-status', state: '7', lease, request: 12 },
    { kind: 'retire-frame-status', state: '7', lease, request: '18446744073709551616' },
  ])('keeps invalid wire serials fatal: %s', (command) => {
    expect(() => port.send(1, command)).toThrow(UtilityExit)
    expect(exited).toBe(true)
    expect(engine.calls).toHaveLength(0)
  })
})
