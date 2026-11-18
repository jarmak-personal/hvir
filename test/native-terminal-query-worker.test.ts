import { describe, expect, it, vi } from 'vitest'
import {
  runNativeQueryStep,
  NativeQueryCleanupFailed,
} from '../src/workers/native-terminal-query'
import { NATIVE_TERMINAL_LIMITS } from '../src/shared/native-terminal'
import type { NativeTerminalQueryOperation } from '../src/shared/native-terminal-query-operations'

const context = { screen: 0 as const, geometrySerial: 3 }
const state = {
  result: 0,
  stale: false,
  hasSelection: false,
  selectionSerial: 4n,
  screen: 0,
  geometrySerial: 3n,
  requestedMutation: 10n,
}

describe('native query physical step boundary', () => {
  it.each([
    [6, false, true],
    [6, true, false],
    [7, false, false],
  ] as const)(
    'owns late query cleanup through only known-unsent BUSY (%s/stale=%s)',
    async (result, stale, retries) => {
      const invoke = vi
        .fn()
        .mockResolvedValueOnce({ result: 0, query: 71n })
        .mockResolvedValueOnce({ result, stale })
        .mockResolvedValue({ result: 0 })
      const pending = runNativeQueryStep(
        { kind: 'query-begin', text: 'hit', caseSensitive: false },
        invoke,
        () => true,
      )
      await expect(pending).rejects.toThrow(retries ? 'cancelled' : 'cleanup-failed')
      const error: unknown = await pending.catch((value: unknown) => value)
      if (retries) expect(error).not.toBeInstanceOf(NativeQueryCleanupFailed)
      else {
        expect(error).toBeInstanceOf(NativeQueryCleanupFailed)
        if (!(error instanceof NativeQueryCleanupFailed))
          throw new Error('Expected physical cleanup failure')
        expect(error.cleanup).toEqual({ kind: 'query-close', query: '71' })
        expect(Object.isFrozen(error.cleanup)).toBe(true)
      }
      expect(invoke).toHaveBeenCalledTimes(retries ? 3 : 2)
      expect(invoke).toHaveBeenNthCalledWith(2, { kind: 'query-close', query: '71' })
      if (retries)
        expect(invoke).toHaveBeenNthCalledWith(3, { kind: 'query-close', query: '71' })
    },
  )
  it('classifies cleanup deadline exhaustion with the exact retained physical token', async () => {
    const now = vi
      .spyOn(Date, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValue(NATIVE_TERMINAL_LIMITS.requestMs + 1)
    try {
      const invoke = vi
        .fn()
        .mockResolvedValueOnce({ result: 0, query: 71n })
        .mockResolvedValue({ result: 6, stale: false })
      const pending = runNativeQueryStep(
        { kind: 'query-begin', text: 'hit', caseSensitive: false },
        invoke,
        () => true,
      )
      await expect(pending).rejects.toBeInstanceOf(NativeQueryCleanupFailed)
      await expect(pending).rejects.toMatchObject({
        cleanup: { kind: 'query-close', query: '71' },
      })
      expect(invoke).toHaveBeenCalledTimes(2)
    } finally {
      now.mockRestore()
    }
  })
  it('cleans late query, range and semantic acquisitions by their exact token', async () => {
    const cases: readonly [NativeTerminalQueryOperation, object, object][] = [
      [
        { kind: 'query-begin', text: 'alpha', caseSensitive: false },
        { result: 0, query: 71n },
        { kind: 'query-close', query: '71' },
      ],
      [
        {
          kind: 'range-begin',
          source: { kind: 'match', query: '71', occurrence: '9' },
          context,
        },
        { ...state, cursor: 82n },
        { kind: 'close', cursor: '82' },
      ],
      [
        { kind: 'boundary-resolve-begin', boundary: '93', reveal: false, context },
        { ...state, cursor: 94n },
        { kind: 'close', cursor: '94' },
      ],
    ]
    for (const [operation, result, cleanup] of cases) {
      const invoke = vi
        .fn()
        .mockResolvedValueOnce(result)
        .mockResolvedValueOnce({ result: 0 })
      await expect(runNativeQueryStep(operation, invoke, () => true)).rejects.toThrow(
        'cancelled',
      )
      expect(invoke.mock.calls).toEqual([[operation], [cleanup]])
    }
  })

  it('preserves busy/stale refusals while rejecting oversized work and no-progress continuations', async () => {
    const operation = { kind: 'query-step' as const, query: '71' }
    const invoke = vi.fn().mockResolvedValue({ result: 7, stale: false })
    await expect(runNativeQueryStep(operation, invoke, () => false)).resolves.toEqual({
      unavailable: 7,
      stale: false,
    })
    const progress = {
      result: 0,
      query: 71n,
      revision: 2n,
      count: 12001,
      status: 0,
      work: 8192,
      visited: 4000,
    }
    invoke.mockResolvedValue(progress)
    await expect(
      runNativeQueryStep(operation, invoke, () => false),
    ).resolves.toMatchObject({ count: 12001, work: 8192, status: 0 })
    invoke.mockResolvedValue({ ...progress, work: 8193 })
    await expect(runNativeQueryStep(operation, invoke, () => false)).rejects.toThrow(
      'work-invalid',
    )
    invoke.mockResolvedValue({ ...progress, work: 0 })
    await expect(runNativeQueryStep(operation, invoke, () => false)).rejects.toThrow(
      'progress-invalid',
    )
  })

  it.each([0, 1] as const)(
    'bounds ordered result pages for screen %s independently of the total result count',
    async (screen) => {
      const operation = {
        kind: 'query-page' as const,
        query: '71',
        revision: '2',
        offset: 12000,
        capacity: 1,
      }
      const match = {
        occurrence: 9n,
        index: 12000,
        screen,
        row: 1000,
        column: 2,
        endRow: 1001,
        endColumn: 4,
      }
      const invoke = vi
        .fn()
        .mockResolvedValue({ result: 0, revision: 2n, count: 100000, results: [match] })
      await expect(
        runNativeQueryStep(operation, invoke, () => false),
      ).resolves.toMatchObject({
        count: 100000,
        results: [{ occurrence: '9', index: 12000, screen }],
      })
      invoke.mockResolvedValue({
        result: 0,
        revision: 2n,
        count: 100000,
        results: [match, match],
      })
      await expect(runNativeQueryStep(operation, invoke, () => false)).rejects.toThrow(
        'page-invalid',
      )
      invoke.mockResolvedValue({
        result: 0,
        revision: 2n,
        count: 100000,
        results: [{ ...match, index: 12001 }],
      })
      await expect(runNativeQueryStep(operation, invoke, () => false)).rejects.toThrow(
        'order-invalid',
      )
    },
  )

  it.each([0, 1] as const)(
    'preserves screen %s on a resolved occurrence',
    async (screen) => {
      const invoke = vi.fn().mockResolvedValue({
        ...state,
        screen,
        resolved: true,
        revealed: true,
        match: {
          occurrence: 9n,
          index: 2,
          screen,
          row: 4,
          column: 0,
          endRow: 4,
          endColumn: 4,
        },
      })
      await expect(
        runNativeQueryStep({ kind: 'finish', cursor: '82' }, invoke, () => false),
      ).resolves.toMatchObject({
        resolved: true,
        revealed: true,
        match: { occurrence: '9', index: 2, screen },
      })
      invoke.mockResolvedValue({ ...state, resolved: true, revealed: false })
      await expect(
        runNativeQueryStep({ kind: 'finish', cursor: '82' }, invoke, () => false),
      ).rejects.toThrow('resolution-invalid')
    },
  )

  it.each([2, -1, 1.5, '1', undefined])(
    'rejects malformed occurrence screen %s in pages and resolutions',
    async (screen) => {
      const match = {
        occurrence: 9n,
        index: 2,
        screen,
        row: 4,
        column: 0,
        endRow: 4,
        endColumn: 4,
      }
      const invoke = vi.fn().mockResolvedValue({
        result: 0,
        revision: 2n,
        count: 3,
        results: [match],
      })
      await expect(
        runNativeQueryStep(
          { kind: 'query-page', query: '71', revision: '2', offset: 2, capacity: 1 },
          invoke,
          () => false,
        ),
      ).rejects.toThrow()
      invoke.mockResolvedValue({ ...state, resolved: true, revealed: true, match })
      await expect(
        runNativeQueryStep({ kind: 'finish', cursor: '82' }, invoke, () => false),
      ).rejects.toThrow()
    },
  )
})
