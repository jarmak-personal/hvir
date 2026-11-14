import { describe, expect, it, vi } from 'vitest'
import {
  runNativeSelectionStep,
  type NativeSelectionEngineResult,
} from '../src/workers/native-terminal-selection'
import type { NativeTerminalSelectionOperation } from '../src/shared/native-terminal-selection'
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
  it('closes a real physical begin result before exposing logical cancellation', async () => {
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
    const pending = runNativeSelectionStep(begin, invoke, () => cancelled)
    cancelled = true
    resolve(state())
    await expect(pending).rejects.toThrow('cancelled')
    expect(calls).toEqual([begin, { kind: 'close', cursor: '19' }])
  })
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
