import { describe, expect, it, vi } from 'vitest'
import {
  runNativeSelectionStep,
  NativeSelectionCleanupFailed,
  type NativeSelectionEngineResult,
} from '../src/workers/native-terminal-selection'
import type { NativeTerminalSelectionOperation } from '../src/shared/native-terminal-selection'
import { NATIVE_TERMINAL_LIMITS } from '../src/shared/native-terminal'
const begin: NativeTerminalSelectionOperation = {
  kind: 'begin',
  selectionSerial: 7,
  context: { screen: 0, geometrySerial: 3 },
}
const state = (): NativeSelectionEngineResult => ({
  result: 0,
  stale: false,
  hasSelection: true,
  selectionSerial: 7n,
  screen: 0,
  geometrySerial: 3n,
  requestedMutation: 4n,
  cursor: 19n,
})
function engine(value: NativeSelectionEngineResult) {
  return vi.fn<
    (operation: NativeTerminalSelectionOperation) => Promise<NativeSelectionEngineResult>
  >((op) => Promise.resolve(op.kind === 'close' ? { result: 0 } : value))
}
describe('native worker selection step ownership', () => {
  it.each([
    [6, false, true],
    [6, true, false],
    [6, undefined, false],
    [7, false, false],
  ] as const)(
    'retries only known-unsent selection cleanup (%s/stale=%s)',
    async (result, stale, retries) => {
      const acquired = state()
      const invoke = vi
        .fn<
          (
            operation: NativeTerminalSelectionOperation,
          ) => Promise<NativeSelectionEngineResult>
        >()
        .mockResolvedValueOnce(acquired)
        .mockImplementationOnce(() => {
          // Native result objects may be reused; cleanup retains the actual token.
          acquired.cursor = 20n
          return Promise.resolve({ result, stale })
        })
        .mockResolvedValue({ result: 0 })
      const pending = runNativeSelectionStep(begin, invoke, () => true)
      await expect(pending).rejects.toThrow(retries ? 'cancelled' : 'cleanup-failed')
      const error: unknown = await pending.catch((value: unknown) => value)
      expect(error instanceof NativeSelectionCleanupFailed).toBe(!retries)
      if (error instanceof NativeSelectionCleanupFailed) {
        expect(error.cleanup).toEqual({ kind: 'close', cursor: '19' })
        expect(Object.isFrozen(error.cleanup)).toBe(true)
      }
      expect(invoke).toHaveBeenCalledTimes(retries ? 3 : 2)
      expect(invoke.mock.calls.slice(1).map(([operation]) => operation)).toEqual(
        Array.from({ length: retries ? 2 : 1 }, () => ({ kind: 'close', cursor: '19' })),
      )
      expect(Object.isFrozen(invoke.mock.calls[1]![0])).toBe(true)
    },
  )
  it('retains the exact cursor when known-unsent cleanup exhausts the existing deadline', async () => {
    const now = vi
      .spyOn(Date, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValue(NATIVE_TERMINAL_LIMITS.requestMs + 1)
    try {
      const invoke = vi
        .fn()
        .mockResolvedValueOnce(state())
        .mockResolvedValue({ result: 6, stale: false })
      const pending = runNativeSelectionStep(begin, invoke, () => true)
      await expect(pending).rejects.toBeInstanceOf(NativeSelectionCleanupFailed)
      await expect(pending).rejects.toMatchObject({
        cleanup: { kind: 'close', cursor: '19' },
      })
      expect(invoke).toHaveBeenCalledTimes(2)
    } finally {
      now.mockRestore()
    }
  })
  it('does not invent cleanup for an ordinary refusal without a physical acquisition', async () => {
    const invoke = vi.fn().mockResolvedValue({ result: 7, stale: false, cursor: 0n })
    await expect(runNativeSelectionStep(begin, invoke, () => false)).resolves.toEqual({
      unavailable: 7,
      stale: false,
    })
    expect(invoke).toHaveBeenCalledOnce()
  })
  it('classifies a thrown exact physical close as unprovable cleanup', async () => {
    const cause = new Error('physical-close-failed')
    const invoke = vi.fn().mockResolvedValueOnce(state()).mockRejectedValue(cause)
    await expect(runNativeSelectionStep(begin, invoke, () => true)).rejects.toMatchObject(
      {
        cleanup: { kind: 'close', cursor: '19' },
        cause,
      },
    )
    expect(invoke).toHaveBeenCalledTimes(2)
  })
  it.each<NativeTerminalSelectionOperation>([
    begin,
    { kind: 'link-row-begin', query: { screen: 0, geometrySerial: 3, x: 1, y: 2 } },
  ])(
    'closes a real physical $kind result before exposing logical cancellation',
    async (operation) => {
      let resolve!: (value: NativeSelectionEngineResult) => void
      const calls: NativeTerminalSelectionOperation[] = []
      const invoke = vi.fn<
        (op: NativeTerminalSelectionOperation) => Promise<NativeSelectionEngineResult>
      >((op) => {
        calls.push(op)
        return op.kind === 'close'
          ? Promise.resolve({ result: 0 })
          : new Promise((yes) => {
              resolve = yes
            })
      })
      let cancelled = false
      const pending = runNativeSelectionStep(operation, invoke, () => cancelled)
      cancelled = true
      resolve(state())
      await expect(pending).rejects.toThrow('cancelled')
      expect(calls).toEqual([operation, { kind: 'close', cursor: '19' }])
    },
  )
  it.each([
    { ...state(), stale: undefined },
    { ...state(), result: 42 },
    { ...state(), selectionSerial: -1n },
  ])('cleans an owned positive cursor after malformed result', async (value) => {
    const invoke = engine(value)
    await expect(runNativeSelectionStep(begin, invoke, () => false)).rejects.toThrow(
      /native-selection/,
    )
    expect(invoke.mock.calls.map(([op]) => op)).toEqual([
      begin,
      { kind: 'close', cursor: '19' },
    ])
  })
  it('closes a refused begin resource and fails explicitly if its cleanup cannot be proven', async () => {
    const invoke = engine({ ...state(), result: 5, stale: true })
    await expect(runNativeSelectionStep(begin, invoke, () => false)).resolves.toEqual({
      unavailable: 5,
      stale: true,
    })
    expect(invoke).toHaveBeenLastCalledWith({ kind: 'close', cursor: '19' })
    invoke.mockImplementation((op) =>
      Promise.resolve(op.kind === 'close' ? { result: 6 } : state()),
    )
    await expect(runNativeSelectionStep(begin, invoke, () => true)).rejects.toThrow(
      'native-selection-cancel-cleanup-failed',
    )
  })
  it('preserves bounded chunk bytes and exact zero clicked offset without translating encoding', async () => {
    const data = new Uint8Array([0, 0xff, 0xc3, 0xa9]),
      invoke = engine({
        ...state(),
        data,
        done: false,
        visited: 3,
        work: 3,
        clickedByteOffset: 0n,
      })
    await expect(
      runNativeSelectionStep({ kind: 'next', cursor: '19' }, invoke, () => false),
    ).resolves.toEqual({
      cursor: '19',
      selectionSerial: 7,
      data,
      done: false,
      visited: 3,
      work: 3,
      clickedByteOffset: 0,
    })
    expect(invoke).toHaveBeenCalledOnce()
  })
  it.each([
    { data: new Uint8Array(65537), done: true, visited: 1, work: 1 },
    { data: new Uint8Array(), done: false, visited: 0, work: 0 },
    { data: new Uint8Array(), done: false, visited: 8193, work: 1 },
    { data: new Uint8Array(), done: false, visited: -1, work: 1 },
    { data: new Uint8Array(), done: false, visited: 1, work: 1, cursor: 20n },
  ])('rejects invalid or zero-progress next without silently retrying', async (chunk) => {
    const invoke = engine({ ...state(), ...chunk })
    await expect(
      runNativeSelectionStep({ kind: 'next', cursor: '19' }, invoke, () => false),
    ).rejects.toThrow('native-selection-chunk-invalid')
    expect(invoke).toHaveBeenCalledOnce()
  })
  it('accepts a real internal-work yield without inventing visited cells or an EOF', async () => {
    const invoke = engine({
      ...state(),
      data: new Uint8Array(),
      done: false,
      visited: 0,
      work: 8192,
    })
    await expect(
      runNativeSelectionStep({ kind: 'next', cursor: '19' }, invoke, () => false),
    ).resolves.toEqual({
      cursor: '19',
      selectionSerial: 7,
      data: new Uint8Array(),
      done: false,
      visited: 0,
      work: 8192,
    })
  })
  it('preserves actual bounded work on refused next and never forwards refused bytes or retries', async () => {
    const invoke = engine({
      result: 5,
      stale: true,
      visited: 8192,
      work: 8192,
      data: new Uint8Array(),
    })
    await expect(
      runNativeSelectionStep({ kind: 'next', cursor: '19' }, invoke, () => false),
    ).resolves.toEqual({ unavailable: 5, stale: true, visited: 8192, work: 8192 })
    expect(invoke).toHaveBeenCalledOnce()
  })
  it.each([
    { visited: 8193, work: 8192, data: new Uint8Array() },
    { visited: 1, work: 1, data: new Uint8Array([1]) },
  ])('refuses malformed failure work metadata', async (invalid) => {
    const invoke = engine({ result: 5, stale: true, ...invalid })
    await expect(
      runNativeSelectionStep({ kind: 'next', cursor: '19' }, invoke, () => false),
    ).rejects.toThrow(/native-selection/)
  })
  it('maps finish stale/resource outcomes separately and keeps targeted close idempotent', async () => {
    const invoke = engine({ result: 5, stale: true })
    await expect(
      runNativeSelectionStep({ kind: 'finish', cursor: '19' }, invoke, () => false),
    ).resolves.toEqual({ unavailable: 5, stale: true })
    invoke.mockImplementation((op) =>
      Promise.resolve(op.kind === 'close' ? { result: 0 } : { result: 7, stale: false }),
    )
    await expect(
      runNativeSelectionStep({ kind: 'finish', cursor: '19' }, invoke, () => false),
    ).resolves.toEqual({ unavailable: 7, stale: false })
    await expect(
      runNativeSelectionStep({ kind: 'close', cursor: '19' }, invoke, () => false),
    ).resolves.toEqual({ result: 0 })
    await expect(
      runNativeSelectionStep({ kind: 'close', cursor: '19' }, invoke, () => false),
    ).resolves.toEqual({ result: 0 })
  })
})
