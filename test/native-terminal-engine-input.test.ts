import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface Request {
  id: number
  operation: string
  args: unknown[]
}
const boundary = vi.hoisted(() => ({
  receive: undefined as ((request: Request) => void) | undefined,
  postMessage: vi.fn<(value: unknown) => void>(),
  close: vi.fn<() => void>(),
  input: vi.fn<(...args: unknown[]) => unknown>(),
  feed: vi.fn<(...args: unknown[]) => unknown>(),
  inspect: vi.fn<(...args: unknown[]) => unknown>(),
}))
vi.mock('node:worker_threads', () => ({
  parentPort: {
    postMessage: boundary.postMessage,
    close: boundary.close,
    on: (_event: string, receive: (request: Request) => void) => {
      boundary.receive = receive
    },
  },
  workerData: { library: '/fixed/native-library' },
}))
vi.mock('@hvir/native-terminal/engine', () => ({
  default: {
    open: () => ({ result: 0, host: {} }),
    input: boundary.input,
    feed: boundary.feed,
    inspect: boundary.inspect,
  },
}))
const unsent = () =>
  Object.assign(new Error('fixed preallocation refusal'), {
    code: 'HVIR_INPUT_ALLOCATION_UNSENT',
  })
const paste = { kind: 'paste', text: 'fixed fixture' }
const send = (id: number, operation = 'input', args: unknown[] = ['1', paste]) => {
  if (!boundary.receive) throw new Error('engine owner listener missing')
  boundary.receive({ id, operation, args })
}
let originalExitCode: typeof process.exitCode
beforeEach(async () => {
  originalExitCode = process.exitCode
  process.exitCode = undefined
  vi.resetModules()
  boundary.receive = undefined
  boundary.postMessage.mockReset()
  boundary.close.mockReset()
  boundary.input.mockReset().mockReturnValue({
    result: 0,
    data: Buffer.from([1]),
    capacity: 1,
    requestedMutation: 1n,
    source: 'user',
  })
  boundary.feed.mockReset().mockReturnValue({ result: 0 })
  boundary.inspect.mockReset().mockReturnValue({ result: 0, status: { failure: 0 } })
  await import('../src/workers/native-terminal-engine')
  expect(boundary.postMessage).toHaveBeenCalledExactlyOnceWith({ kind: 'ready' })
  boundary.postMessage.mockClear()
})
afterEach(() => {
  process.exitCode = originalExitCode
})
describe('designated engine input allocation boundary', () => {
  it('returns a proven-unsent allocation result and preserves subsequent input and parser jobs', () => {
    boundary.input.mockImplementationOnce(() => {
      throw unsent()
    })
    send(1)
    expect(boundary.postMessage).toHaveBeenCalledExactlyOnceWith({
      id: 1,
      value: { result: 7, requestedMutation: 0n, capacity: 0 },
    })
    expect(boundary.close).not.toHaveBeenCalled()
    expect(process.exitCode).toBeUndefined()
    send(2)
    send(3, 'feed', ['1', '1', Uint8Array.of(1)])
    send(4, 'inspect', ['1'])
    expect(boundary.postMessage).toHaveBeenLastCalledWith({
      id: 4,
      value: { result: 0, status: { failure: 0 } },
    })
    expect(boundary.input).toHaveBeenCalledTimes(2)
    expect(boundary.feed).toHaveBeenCalledOnce()
    expect(boundary.close).not.toHaveBeenCalled()
  })
  it('forwards a returned C capture allocation refusal without changing its mutation proof', () => {
    boundary.input.mockReturnValueOnce({ result: 7, requestedMutation: 0n, capacity: 0 })
    send(1)
    expect(boundary.postMessage).toHaveBeenCalledExactlyOnceWith({
      id: 1,
      value: { result: 7, requestedMutation: 0n, capacity: 0 },
    })
    expect(boundary.close).not.toHaveBeenCalled()
  })
  it.each([
    new RangeError('generic allocation failure'),
    Object.assign(new Error('unknown coded failure'), {
      code: 'ERR_MEMORY_ALLOCATION_FAILED',
    }),
  ])('keeps unproven input exceptions fatal', (error) => {
    boundary.input.mockImplementationOnce(() => {
      throw error
    })
    send(1)
    expect(boundary.postMessage).toHaveBeenCalledExactlyOnceWith({ id: 1, fatal: true })
    expect(boundary.close).toHaveBeenCalledOnce()
    expect(process.exitCode).toBe(1)
  })
  it('does not recover the same reserved code thrown by another native operation', () => {
    boundary.feed.mockImplementationOnce(() => {
      throw unsent()
    })
    send(1, 'feed', ['1', '1', Uint8Array.of(1)])
    expect(boundary.postMessage).toHaveBeenCalledExactlyOnceWith({ id: 1, fatal: true })
    expect(boundary.close).toHaveBeenCalledOnce()
    expect(process.exitCode).toBe(1)
  })
  it('keeps a result-clone failure fatal even if it happens to carry the reserved code', () => {
    boundary.postMessage.mockImplementationOnce(() => {
      throw unsent()
    })
    send(1)
    expect(boundary.postMessage.mock.calls[0]?.[0]).toMatchObject({
      id: 1,
      value: { result: 0, requestedMutation: 1n },
    })
    expect(boundary.postMessage).toHaveBeenLastCalledWith({ id: 1, fatal: true })
    expect(boundary.close).toHaveBeenCalledOnce()
    expect(process.exitCode).toBe(1)
  })
})
