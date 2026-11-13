import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NativeTerminalProcess } from '../src/main/terminal/native-terminal-process'
import {
  NATIVE_TERMINAL_LIMITS,
  type NativeTerminalCommand,
} from '../src/shared/native-terminal'

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  createEndpoint: vi.fn(),
  closeEndpoint: vi.fn(),
  receive: vi.fn(),
  release: vi.fn(),
}))
vi.mock('electron', () => ({}))
vi.mock('../src/main/worker-host', () => ({
  spawnUtilityWorker: mocks.spawn,
  workerPath: (file: string) => `/worker/${file}`,
}))
vi.mock('@hvir/native-terminal/resource', () => ({
  default: {
    createEndpoint: mocks.createEndpoint,
    closeEndpoint: mocks.closeEndpoint,
    receive: mocks.receive,
    release: mocks.release,
  },
}))
interface SentRequest {
  kind: 'request'
  epoch: string
  id: number
  command: NativeTerminalCommand
}
class Child extends EventEmitter {
  readonly messages: unknown[] = []
  readonly kill = vi.fn(() => {
    this.emit('exit', 0)
    return true
  })
  constructor(readonly pid: number) {
    super()
  }
  postMessage(value: unknown): void {
    this.messages.push(structuredClone(value))
  }
  requests(): SentRequest[] {
    return this.messages.filter((value): value is SentRequest =>
      Boolean(
        value && typeof value === 'object' && 'kind' in value && value.kind === 'request',
      ),
    )
  }
}
const owners: NativeTerminalProcess[] = []
const children: Child[] = []
function owner(): NativeTerminalProcess {
  const value = new NativeTerminalProcess('/trusted/libghostty')
  owners.push(value)
  return value
}
function call(
  process: NativeTerminalProcess,
  command: NativeTerminalCommand,
  signal?: AbortSignal,
) {
  const promise = process.request(command, signal)
  void promise.catch(() => undefined)
  return promise
}
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}
async function ready(
  process: NativeTerminalProcess,
  index = children.length - 1,
): Promise<Child> {
  await flush()
  const child = children[index < 0 ? 0 : index]!
  expect(child).toBeDefined()
  child.emit('spawn')
  child.emit('message', { kind: 'ready', epoch: process.epoch, pid: child.pid })
  await flush()
  return child
}
function reply(child: Child, request: SentRequest, value: unknown, ok = true): void {
  child.emit('message', {
    kind: 'result',
    epoch: request.epoch,
    id: request.id,
    ok,
    ...(ok ? { value } : { error: 'cancelled' }),
  })
}
function last(child: Child): SentRequest {
  return child.requests().at(-1)!
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.resetAllMocks()
  owners.length = 0
  children.length = 0
  mocks.createEndpoint.mockImplementation((address: string) =>
    Promise.resolve({ address }),
  )
  mocks.closeEndpoint.mockImplementation(() => Promise.resolve())
  mocks.spawn.mockImplementation(() => {
    const child = new Child(10000 + children.length)
    children.push(child)
    return child
  })
})
afterEach(() => {
  for (const process of owners) process.dispose()
  vi.useRealTimers()
})

describe('native process cancelled acquisition ownership', () => {
  it('copies admitted output before asynchronous startup can expose caller mutation', async () => {
    const process = owner()
    const bytes = Uint8Array.from([0, 128, 255])
    const command = { kind: 'feed' as const, state: '1', sequence: 1, bytes }
    const pending = call(process, command)
    bytes.fill(42)
    command.state = 'forged'
    const child = await ready(process)
    expect(last(child).command).toEqual({
      kind: 'feed',
      state: '1',
      sequence: 1,
      bytes: Uint8Array.from([0, 128, 255]),
    })
    reply(child, last(child), { result: 0 })
    await expect(pending).resolves.toEqual({ result: 0 })
  })

  it('destroys a late created state using the accepted command snapshot without losing the host', async () => {
    const process = owner()
    expect(mocks.spawn).not.toHaveBeenCalled()
    const cancel = new AbortController()
    const command = { kind: 'create' as const, width: 1000, height: 600 }
    const pending = call(process, command, cancel.signal)
    Object.assign(command, { kind: 'frame', state: 'forged' })
    const child = await ready(process)
    const acquisition = last(child)
    expect(acquisition.command).toEqual({ kind: 'create', width: 1000, height: 600 })
    cancel.abort()
    await expect(pending).rejects.toThrow('cancelled')
    reply(child, acquisition, { state: '7' })
    await flush()
    const cleanup = last(child)
    expect(cleanup.id).not.toBe(acquisition.id)
    expect(cleanup.command).toEqual({ kind: 'destroy', state: '7' })
    reply(child, cleanup, { result: 0 })
    await flush()
    expect(process.available).toBe(true)
    expect(child.kill).not.toHaveBeenCalled()
    const subsequent = call(process, { kind: 'inspect', state: '9' })
    await flush()
    reply(child, last(child), { result: 0 })
    await expect(subsequent).resolves.toEqual({ result: 0 })
  })

  it.each([0, 9])(
    'releases a late frame with the original state and returned lease (result %s)',
    async (cleanupResult) => {
      const process = owner()
      const cancel = new AbortController()
      const command = { kind: 'frame' as const, state: '41', ticket: 'ticket' }
      const pending = call(process, command, cancel.signal)
      const child = await ready(process)
      const acquisition = last(child)
      command.state = 'forged'
      cancel.abort()
      await expect(pending).rejects.toThrow('cancelled')
      reply(child, acquisition, { state: '999', lease: '11' })
      await flush()
      const cleanup = last(child)
      expect(cleanup.command).toEqual({ kind: 'release', state: '41', lease: '11' })
      reply(child, cleanup, { result: cleanupResult })
      await flush()
      expect(process.available).toBe(true)
      expect(child.kill).not.toHaveBeenCalled()
    },
  )

  it('keeps all 64 physical slots and byte credit after logical abort until responses arrive', async () => {
    const process = owner()
    const cancels = Array.from({ length: 64 }, () => new AbortController())
    const pending = cancels.map((cancel, index) =>
      call(
        process,
        {
          kind: 'feed',
          state: String(1 + Math.floor(index / 8)),
          sequence: 1 + (index % 8),
          bytes: new Uint8Array(NATIVE_TERMINAL_LIMITS.feedChunkBytes),
        },
        cancel.signal,
      ),
    )
    const child = await ready(process)
    const sent = child.requests()
    expect(sent).toHaveLength(64)
    for (const cancel of cancels) cancel.abort()
    expect(
      (await Promise.allSettled(pending)).every((result) => result.status === 'rejected'),
    ).toBe(true)
    await expect(call(process, { kind: 'inspect', state: '99' })).rejects.toThrow('bound')
    expect(child.requests()).toHaveLength(64)
    reply(child, sent[0]!, undefined, false)
    await flush()
    await expect(
      call(process, {
        kind: 'feed',
        state: '99',
        sequence: 1,
        bytes: new Uint8Array(2 * NATIVE_TERMINAL_LIMITS.feedChunkBytes),
      }),
    ).rejects.toThrow('bound')
    const reused = call(process, {
      kind: 'feed',
      state: '99',
      sequence: 1,
      bytes: new Uint8Array(NATIVE_TERMINAL_LIMITS.feedChunkBytes),
    })
    await flush()
    expect(child.requests()).toHaveLength(65)
    for (const request of sent.slice(1)) reply(child, request, undefined, false)
    reply(child, last(child), { result: 0 })
    await expect(reused).resolves.toEqual({ result: 0 })
    expect(process.available).toBe(true)
  })

  it('drains late owned cleanup before idle can submit shutdown', async () => {
    const process = owner()
    const cancel = new AbortController()
    const pending = call(
      process,
      { kind: 'create', width: 1000, height: 600 },
      cancel.signal,
    )
    const child = await ready(process)
    const acquisition = last(child)
    cancel.abort()
    await expect(pending).rejects.toThrow('cancelled')
    const idle = process.idle()
    await flush()
    expect(child.requests().some((request) => request.command.kind === 'shutdown')).toBe(
      false,
    )
    reply(child, acquisition, { state: '73' })
    await flush()
    const cleanup = last(child)
    expect(cleanup.command).toEqual({ kind: 'destroy', state: '73' })
    expect(child.kill).not.toHaveBeenCalled()
    reply(child, cleanup, { result: 0 })
    await flush()
    expect(last(child).command).toEqual({ kind: 'shutdown' })
    reply(child, last(child), { result: 0 })
    await idle
    expect(child.kill).toHaveBeenCalledOnce()
    expect(process.available).toBe(true)
  })
})

describe('native process failure containment', () => {
  it('rejects startup operations on the concrete child error path', async () => {
    const process = owner()
    const first = call(process, { kind: 'inspect', state: '1' })
    const second = call(process, { kind: 'read', state: '2' })
    await flush()
    const child = children[0]!
    child.emit('error', new Error('initialization failed'))
    await expect(first).rejects.toThrow('native-host-error')
    await expect(second).rejects.toThrow('native-host-error')
    expect(process.available).toBe(false)
    expect(child.kill).toHaveBeenCalledOnce()
    expect(mocks.closeEndpoint).toHaveBeenCalledOnce()
  })

  it.each([
    [
      'foreign response',
      (request: SentRequest) => ({
        kind: 'result',
        epoch: request.epoch,
        id: 999,
        ok: true,
        value: {},
      }),
    ],
    [
      'wrong epoch',
      (request: SentRequest) => ({
        kind: 'result',
        epoch: 'old',
        id: request.id,
        ok: true,
        value: {},
      }),
    ],
    [
      'malformed result',
      (request: SentRequest) => ({
        kind: 'result',
        epoch: request.epoch,
        id: request.id,
        ok: 'yes',
      }),
    ],
  ] as const)('sticky-loses on %s', async (_name, message) => {
    const process = owner()
    const first = call(process, { kind: 'inspect', state: '1' })
    const second = call(process, { kind: 'read', state: '1' })
    const child = await ready(process)
    child.emit('message', message(last(child)))
    await expect(first).rejects.toThrow('native-')
    await expect(second).rejects.toThrow('native-')
    expect(process.available).toBe(false)
    await expect(call(process, { kind: 'inspect', state: '1' })).rejects.toThrow(
      'native-',
    )
    expect(mocks.spawn).toHaveBeenCalledOnce()
    expect(child.kill).toHaveBeenCalledOnce()
    expect(mocks.closeEndpoint).toHaveBeenCalledOnce()
  })

  it('loses on a malformed late acquisition instead of forgetting resource ownership', async () => {
    const process = owner()
    const cancel = new AbortController()
    const pending = call(
      process,
      { kind: 'create', width: 1000, height: 600 },
      cancel.signal,
    )
    const child = await ready(process)
    const acquisition = last(child)
    cancel.abort()
    await expect(pending).rejects.toThrow('cancelled')
    reply(child, acquisition, { state: 'not-a-native-id' })
    expect(process.available).toBe(false)
    expect(child.kill).toHaveBeenCalledOnce()
  })

  it('rejects all on initialization error without automatically spawning again', async () => {
    mocks.createEndpoint.mockRejectedValueOnce(new Error('endpoint failed'))
    const process = owner()
    const first = call(process, { kind: 'inspect', state: '1' })
    const second = call(process, { kind: 'read', state: '2' })
    await expect(first).rejects.toThrow('initialization')
    await expect(second).rejects.toThrow('initialization')
    expect(process.available).toBe(false)
    await expect(call(process, { kind: 'inspect', state: '1' })).rejects.toThrow(
      'initialization',
    )
    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it('rejects every pending operation on child exit and remains failed', async () => {
    const process = owner()
    const first = call(process, { kind: 'inspect', state: '1' })
    const second = call(process, { kind: 'read', state: '2' })
    const child = await ready(process)
    child.emit('exit', 1)
    await expect(first).rejects.toThrow('native-host-lost')
    await expect(second).rejects.toThrow('native-host-lost')
    await expect(call(process, { kind: 'inspect', state: '1' })).rejects.toThrow(
      'native-host-lost',
    )
    expect(mocks.spawn).toHaveBeenCalledOnce()
  })

  it('retains a cancelled physical deadline and loses the host if completion never arrives', async () => {
    const process = owner()
    const cancel = new AbortController()
    const pending = call(process, { kind: 'inspect', state: '1' }, cancel.signal)
    const child = await ready(process)
    cancel.abort()
    await expect(pending).rejects.toThrow('cancelled')
    await vi.advanceTimersByTimeAsync(NATIVE_TERMINAL_LIMITS.requestMs - 1)
    expect(process.available).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(process.available).toBe(false)
    expect(child.kill).toHaveBeenCalledOnce()
  })
})

it('settles idle on the caller thread, then creates a fresh utility and ignores retired callbacks', async () => {
  const process = owner()
  const first = call(process, { kind: 'inspect', state: '1' })
  const child = await ready(process)
  reply(child, last(child), { result: 0 })
  await first
  const oldEpoch = process.epoch
  let close!: () => void
  mocks.closeEndpoint.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        close = resolve
      }),
  )
  const idle = process.idle()
  const next = call(process, { kind: 'inspect', state: '2' })
  await flush()
  const shutdown = last(child)
  expect(shutdown.command).toEqual({ kind: 'shutdown' })
  reply(child, shutdown, { result: 0 })
  await flush()
  expect(child.kill).toHaveBeenCalledOnce()
  expect(children).toHaveLength(1)
  close()
  await idle
  expect(process.epoch).not.toBe(oldEpoch)
  await flush()
  expect(children).toHaveLength(2)
  const fresh = await ready(process, 1)
  expect(last(fresh).epoch).toBe(process.epoch)
  child.emit('message', { kind: 'result', epoch: oldEpoch, id: 999, ok: true, value: {} })
  child.emit('error', new Error('retired transport'))
  child.emit('exit', 1)
  expect(process.available).toBe(true)
  expect(fresh.kill).not.toHaveBeenCalled()
  reply(fresh, last(fresh), { result: 0 })
  await expect(next).resolves.toEqual({ result: 0 })
})

it('bounds and snapshots next-generation work while idle teardown is pending', async () => {
  const process = owner()
  const first = call(process, { kind: 'inspect', state: '1' })
  const child = await ready(process)
  reply(child, last(child), { result: 0 })
  await first
  const idle = process.idle()
  const bytes = new Uint8Array(NATIVE_TERMINAL_LIMITS.feedChunkBytes).fill(7)
  const queued = Array.from({ length: NATIVE_TERMINAL_LIMITS.commands - 1 }, (_, index) =>
    call(process, { kind: 'feed', state: String(index + 1), sequence: 1, bytes }),
  )
  bytes.fill(99)
  await expect(call(process, { kind: 'inspect', state: '100' })).rejects.toThrow('bound')
  await flush()
  reply(child, last(child), { result: 0 })
  await idle
  const fresh = await ready(process, 1)
  expect(fresh.requests()).toHaveLength(63)
  const command = fresh.requests()[0]!.command
  expect(command.kind).toBe('feed')
  if (command.kind === 'feed') expect(command.bytes[0]).toBe(7)
  for (const request of fresh.requests()) reply(fresh, request, { result: 0 })
  await Promise.all(queued)
})
