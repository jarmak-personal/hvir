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
    receive: vi.fn(),
    release: vi.fn(),
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
  postMessage(value: unknown) {
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
const owners: NativeTerminalProcess[] = [],
  children: Child[] = []
function owner() {
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
async function flush() {
  await vi.advanceTimersByTimeAsync(0)
}
async function ready(process: NativeTerminalProcess) {
  await flush()
  const child = children.at(-1)!
  expect(child).toBeDefined()
  child.emit('spawn')
  child.emit('message', { kind: 'ready', epoch: process.epoch, pid: child.pid })
  await flush()
  return child
}
function last(child: Child) {
  return child.requests().at(-1)!
}
function reply(child: Child, request: SentRequest, value: unknown) {
  child.emit('message', {
    kind: 'result',
    epoch: request.epoch,
    id: request.id,
    ok: true,
    value,
  })
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
describe('native process selection acquisition ownership', () => {
  it('closes a late native selection acquisition using its accepted state after logical cancellation', async () => {
    const process = owner(),
      cancel = new AbortController()
    const command: Extract<NativeTerminalCommand, { kind: 'selection' }> = {
      kind: 'selection',
      state: '41',
      operation: {
        kind: 'begin',
        selectionSerial: 7,
        context: { screen: 0, geometrySerial: 3 },
      },
    }
    const pending = call(process, command, cancel.signal),
      child = await ready(process),
      acquisition = last(child)
    command.state = 'forged'
    cancel.abort()
    await expect(pending).rejects.toThrow('cancelled')
    reply(child, acquisition, {
      cursor: '19',
      hasSelection: true,
      selectionSerial: 7,
      screen: 0,
      geometrySerial: 3,
      requestedMutation: 0,
    })
    await flush()
    const cleanup = last(child)
    expect(cleanup.id).not.toBe(acquisition.id)
    expect(cleanup.command).toEqual({
      kind: 'selection',
      state: '41',
      operation: { kind: 'close', cursor: '19' },
    })
    reply(child, cleanup, { result: 0 })
    await flush()
    expect(process.available).toBe(true)
    expect(child.kill).not.toHaveBeenCalled()
  })
  it('frees the completed begin slot before trusted close even at all64 global and8 state physical slots', async () => {
    const process = owner(),
      cancel = new AbortController()
    const begin = call(
      process,
      {
        kind: 'selection',
        state: '1',
        operation: {
          kind: 'begin',
          selectionSerial: 7,
          context: { screen: 0, geometrySerial: 3 },
        },
      },
      cancel.signal,
    )
    const feeds: Promise<unknown>[] = []
    for (let index = 0; index < 63; index++) {
      const offset = index + 1
      feeds.push(
        call(process, {
          kind: 'feed',
          state: String(1 + Math.floor(offset / 8)),
          sequence: 1 + (offset % 8),
          bytes: new Uint8Array(NATIVE_TERMINAL_LIMITS.feedChunkBytes),
        }),
      )
    }
    const child = await ready(process),
      sent = child.requests(),
      acquisition = sent.find((request) => request.command.kind === 'selection')!
    expect(sent).toHaveLength(64)
    cancel.abort()
    await expect(begin).rejects.toThrow('cancelled')
    await expect(
      call(process, {
        kind: 'selection',
        state: '1',
        operation: { kind: 'close', cursor: '999' },
      }),
    ).rejects.toThrow('bound')
    reply(child, acquisition, {
      cursor: '19',
      hasSelection: true,
      selectionSerial: 7,
      screen: 0,
      geometrySerial: 3,
      requestedMutation: 0,
    })
    await flush()
    const cleanup = last(child)
    expect(child.requests()).toHaveLength(65)
    expect(cleanup.command).toEqual({
      kind: 'selection',
      state: '1',
      operation: { kind: 'close', cursor: '19' },
    })
    reply(child, cleanup, { result: 0 })
    for (const request of sent)
      if (request !== acquisition) reply(child, request, { result: 0 })
    await Promise.all(feeds)
    await flush()
    expect(process.available).toBe(true)
  })
  it.each([
    { cursor: '0', hasSelection: false },
    { cursor: '0', link: { uri: 'https://example.com/' } },
    { unavailable: 5, stale: true },
  ])(
    'does not manufacture cleanup for a cancelled begin without a resource',
    async (result) => {
      const process = owner(),
        cancel = new AbortController(),
        pending = call(
          process,
          {
            kind: 'selection',
            state: '1',
            operation: {
              kind: 'begin',
              selectionSerial: 7,
              context: { screen: 0, geometrySerial: 3 },
            },
          },
          cancel.signal,
        )
      const child = await ready(process),
        request = last(child)
      cancel.abort()
      await expect(pending).rejects.toThrow('cancelled')
      reply(child, request, result)
      await flush()
      expect(child.requests()).toHaveLength(1)
      expect(process.available).toBe(true)
    },
  )
  it('never posts a selection begin canceled before physical admission', async () => {
    const process = owner(),
      cancel = new AbortController()
    cancel.abort()
    await expect(
      call(
        process,
        {
          kind: 'selection',
          state: '1',
          operation: {
            kind: 'begin',
            selectionSerial: 7,
            context: { screen: 0, geometrySerial: 3 },
          },
        },
        cancel.signal,
      ),
    ).rejects.toThrow('cancelled')
    await flush()
    expect(mocks.spawn).not.toHaveBeenCalled()
  })
  it.each(['foreign', '-1', '18446744073709551616'])(
    'refuses invalid late acquisition cursor %s without posting a forged close',
    async (cursor) => {
      const process = owner(),
        cancel = new AbortController(),
        pending = call(
          process,
          {
            kind: 'selection',
            state: '1',
            operation: {
              kind: 'begin',
              selectionSerial: 7,
              context: { screen: 0, geometrySerial: 3 },
            },
          },
          cancel.signal,
        )
      const child = await ready(process),
        request = last(child)
      cancel.abort()
      await expect(pending).rejects.toThrow('cancelled')
      reply(child, request, { cursor })
      await flush()
      expect(process.available).toBe(false)
      expect(child.requests()).toHaveLength(1)
    },
  )
})
