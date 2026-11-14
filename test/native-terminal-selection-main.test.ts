import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NativeTerminalSelection } from '../src/main/terminal/native-terminal-selection'
import type { NativeTerminalHost } from '../src/main/terminal/native-terminal-host'
import type { NativeTerminalSelectionOperation } from '../src/shared/native-terminal-selection'
import { NATIVE_TERMINAL_LIMITS } from '../src/shared/native-terminal'
import { asHostId, hostPath } from '../src/shared/host-path'
import { nativeTerminalStatus } from './fixtures/native-terminal-host'
const viewId = randomUUID(),
  owner = { id: 4, generation: 2 },
  root = hostPath(asHostId('remote'), '/srv/project')
const context = { screen: 0 as const, geometrySerial: 3 }
const state = (extra: Record<string, unknown> = {}) => ({
  hasSelection: true,
  selectionSerial: 7,
  screen: 0,
  geometrySerial: 3,
  requestedMutation: 0,
  ...extra,
})
const chunk = (text: string, extra: Record<string, unknown> = {}) => ({
  cursor: '19',
  selectionSerial: 7,
  data: new TextEncoder().encode(text),
  done: true,
  visited: text.length,
  work: Math.max(1, text.length),
  ...extra,
})
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}
const disposals: (() => void)[] = []
afterEach(() => {
  disposals.splice(0).forEach((dispose) => dispose())
  vi.useRealTimers()
})
function fixture() {
  let current = true,
    instance = 'instance',
    geometry = 3
  let implementation: (operation: NativeTerminalSelectionOperation) => unknown = (op) =>
    op.kind === 'close'
      ? { result: 0 }
      : op.kind === 'next'
        ? chunk('selected')
        : state(
            op.kind === 'begin' || op.kind === 'link-row-begin' ? { cursor: '19' } : {},
          )
  const host = {
    selection: vi.fn<NativeTerminalHost['selection']>(
      async (_handle, _instance, op, signal, eligible) => {
        await eligible?.(signal ?? new AbortController().signal)
        return implementation(op)
      },
    ),
    inspectProducer: vi.fn<NativeTerminalHost['inspectProducer']>(() =>
      Promise.resolve(nativeTerminalStatus()),
    ),
  }
  const assertCurrent = vi.fn(() => {
    if (!current || instance !== 'instance' || geometry !== 3)
      throw new Error('source-stale')
  })
  const source = vi.fn((view: string, caller: typeof owner) => {
    if (
      view !== viewId ||
      caller.id !== owner.id ||
      caller.generation !== owner.generation
    )
      throw new Error('source-foreign')
    return {
      handle: 'handle',
      instanceId: 'instance',
      workspaceRoot: root,
      geometry: context,
      assertCurrent,
      prefix: () => ({
        parsed: async (signal: AbortSignal) => {
          signal.throwIfAborted()
          await Promise.resolve()
        },
        replies: () => Promise.resolve(),
      }),
    }
  })
  const selection = new NativeTerminalSelection(host, source)
  disposals.push(() => selection.dispose())
  const request = () => ({ viewId, requestId: randomUUID() })
  const operations = () => host.selection.mock.calls.map((call) => call[2])
  return {
    selection,
    host,
    request,
    operations,
    source,
    set: (handler: typeof implementation) => {
      implementation = handler
    },
    revoke: () => {
      current = false
    },
    replace: () => {
      instance = 'replacement'
    },
    resize: () => {
      geometry++
    },
  }
}
describe('main native selection request ownership', () => {
  it('returns only actual Begin acknowledgement, then copies bounded chunks and Finish before exact cleanup', async () => {
    const f = fixture(),
      request = f.request()
    await expect(
      f.selection.action({ ...request, action: 'copy' }, owner),
    ).resolves.toEqual({ hasSelection: true, selectionSerial: 7 })
    expect(f.operations().map((op) => op.kind)).toEqual(['command', 'begin'])
    await expect(f.selection.read(request, owner)).resolves.toEqual({
      hasSelection: true,
      selectionSerial: 7,
      text: 'selected',
    })
    expect(f.operations().map((op) => op.kind)).toEqual([
      'command',
      'begin',
      'next',
      'finish',
    ])
    expect(
      f.host.selection.mock.calls.every(
        (call) => call[0] === 'handle' && call[1] === 'instance',
      ),
    ).toBe(true)
  })
  it('does not create a cursor or continuation for no selection', async () => {
    const f = fixture(),
      request = f.request()
    f.set((op) =>
      state({ hasSelection: false, ...(op.kind === 'begin' ? { cursor: '0' } : {}) }),
    )
    await expect(
      f.selection.action({ ...request, action: 'copy' }, owner),
    ).resolves.toEqual({ hasSelection: false, selectionSerial: 7 })
    await expect(f.selection.read(request, owner)).rejects.toThrow(
      'native-selection-stale',
    )
    expect(f.operations().map((op) => op.kind)).toEqual(['command', 'begin'])
  })
  it('captures a late physically completed Begin before cancellation rejects its delivery and closes only that cursor', async () => {
    const f = fixture(),
      request = f.request(),
      begin = deferred<unknown>()
    f.set((op) =>
      op.kind === 'begin' ? begin.promise : op.kind === 'close' ? { result: 0 } : state(),
    )
    const pending = f.selection.action({ ...request, action: 'copy' }, owner)
    const rejected = expect(pending).rejects.toThrow()
    await vi.waitFor(() => expect(f.operations().at(-1)?.kind).toBe('begin'))
    f.selection.cancel(request, owner)
    begin.resolve(state({ cursor: '19' }))
    await rejected
    await vi.waitFor(() =>
      expect(f.operations().at(-1)).toEqual({ kind: 'close', cursor: '19' }),
    )
    expect(f.operations().filter((op) => op.kind === 'close')).toHaveLength(1)
  })
  it('cancels the acknowledged begin during the cross-RPC window without permitting a read from another owner or view', async () => {
    const f = fixture(),
      request = f.request()
    await f.selection.action({ ...request, action: 'copy' }, owner)
    await expect(f.selection.read(request, { ...owner, generation: 3 })).rejects.toThrow(
      'native-selection-stale',
    )
    f.selection.cancel({ ...request, viewId: randomUUID() }, owner)
    expect(f.operations().filter((op) => op.kind === 'close')).toHaveLength(0)
    f.selection.cancel(request, owner)
    await vi.waitFor(() => expect(f.operations().at(-1)?.kind).toBe('close'))
    await expect(f.selection.read(request, owner)).rejects.toThrow(
      'native-selection-stale',
    )
    expect(f.operations().some((op) => op.kind === 'next')).toBe(false)
  })
  it.each(['revoke', 'replace', 'resize'] as const)(
    'rejects a completed continuation after source %s and closes its exact cursor',
    async (change) => {
      const f = fixture(),
        request = f.request(),
        next = deferred<unknown>()
      await f.selection.action({ ...request, action: 'copy' }, owner)
      f.set((op) =>
        op.kind === 'next' ? next.promise : op.kind === 'close' ? { result: 0 } : state(),
      )
      const reading = f.selection.read(request, owner),
        rejected = expect(reading).rejects.toThrow('source-stale')
      await vi.waitFor(() => expect(f.operations().at(-1)?.kind).toBe('next'))
      f[change]()
      next.resolve(chunk('old'))
      await rejected
      expect(f.operations().at(-1)).toEqual({ kind: 'close', cursor: '19' })
    },
  )
  it('expires only unclaimed Begin resources and has no total deadline on an active productive copy', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const abandoned = fixture(),
      lost = abandoned.request()
    await abandoned.selection.action({ ...lost, action: 'copy' }, owner)
    await vi.advanceTimersByTimeAsync(NATIVE_TERMINAL_LIMITS.requestMs + 1)
    expect(abandoned.operations().at(-1)).toEqual({ kind: 'close', cursor: '19' })
    const active = fixture(),
      request = active.request()
    await active.selection.action({ ...request, action: 'copy' }, owner)
    let next = deferred<unknown>()
    active.set((op) =>
      op.kind === 'next' ? next.promise : op.kind === 'close' ? { result: 0 } : state(),
    )
    const reading = active.selection.read(request, owner)
    for (let step = 0; step < 4; step++) {
      await vi.advanceTimersByTimeAsync(NATIVE_TERMINAL_LIMITS.requestMs / 2)
      expect(active.operations().some((op) => op.kind === 'close')).toBe(false)
      const completing = next
      next = deferred<unknown>()
      completing.resolve(chunk('x', { done: step === 3 }))
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    await expect(reading).resolves.toMatchObject({ text: 'xxxx' })
  })
  it.each(['next', 'finish'] as const)(
    'fails truthfully on %s refusal with no parser effect or leaked cursor',
    async (phase) => {
      const f = fixture(),
        request = f.request()
      await f.selection.action({ ...request, action: 'copy' }, owner)
      f.set((op) =>
        op.kind === phase
          ? { unavailable: 6, stale: true }
          : op.kind === 'next'
            ? chunk('selected')
            : op.kind === 'close'
              ? { result: 0 }
              : state(),
      )
      await expect(f.selection.read(request, owner)).rejects.toThrow(
        'native-selection-stale',
      )
      expect(f.operations().filter((op) => op.kind === 'close')).toHaveLength(
        phase === 'finish' ? 0 : 1,
      )
    },
  )
  it('refuses zero-work non-Done chunks instead of retrying in a tight loop', async () => {
    const f = fixture(),
      request = f.request()
    await f.selection.action({ ...request, action: 'copy' }, owner)
    f.set((op) =>
      op.kind === 'next'
        ? chunk('', { done: false, visited: 0, work: 0 })
        : op.kind === 'close'
          ? { result: 0 }
          : state(),
    )
    await expect(f.selection.read(request, owner)).rejects.toThrow(
      'native-selection-chunk-invalid',
    )
    expect(f.operations().filter((op) => op.kind === 'next')).toHaveLength(1)
    expect(f.operations().at(-1)?.kind).toBe('close')
  })
  it('maps a wide/combining row clicked BYTE offset to UTF16 using copied native chunks and preserves the SSH root', async () => {
    const f = fixture(),
      request = f.request(),
      text = '界e\u0301 ./src/main.ts:9'
    const offset = Buffer.byteLength('界e\u0301 ./src/')
    f.set((op) =>
      op.kind === 'link-row-begin'
        ? state({ cursor: '19', column: 12 })
        : op.kind === 'next'
          ? chunk(text, { selectionSerial: 999, clickedByteOffset: offset })
          : op.kind === 'finish'
            ? state({ selectionSerial: 999, clickedByteOffset: offset })
            : { result: 0 },
    )
    await expect(f.selection.link({ ...request, x: 10, y: 10 }, owner)).resolves.toEqual({
      pending: true,
    })
    await expect(f.selection.readLink(request, owner)).resolves.toEqual({
      kind: 'file',
      target: './src/main.ts:9',
      workspaceRoot: root,
    })
    expect(f.operations().filter((op) => op.kind === 'next')).toHaveLength(1)
  })
  it('uses atomic OSC8 without manufacturing a row cursor and propagates busy without replacing an active copy', async () => {
    const f = fixture(),
      request = f.request()
    f.set(() =>
      state({
        cursor: '0',
        column: 1,
        link: {
          uri: 'https://example.com/',
          screen: 0,
          row: 0,
          column: 1,
          streamSequence: 1,
          snapshotMutation: 1,
          geometrySerial: 3,
        },
      }),
    )
    await expect(f.selection.link({ ...request, x: 1, y: 1 }, owner)).resolves.toEqual({
      pending: false,
      link: {
        kind: 'external-http',
        target: 'https://example.com/',
        workspaceRoot: root,
      },
    })
    expect(f.operations().map((op) => op.kind)).toEqual(['link-row-begin'])
    f.set((op) =>
      op.kind === 'link-row-begin'
        ? { unavailable: 6, stale: false }
        : op.kind === 'close'
          ? { result: 0 }
          : state(op.kind === 'begin' ? { cursor: '19' } : {}),
    )
    const copying = f.request()
    await f.selection.action({ ...copying, action: 'copy' }, owner)
    await expect(f.selection.link({ ...f.request(), x: 1, y: 1 }, owner)).rejects.toThrow(
      'native-selection-unavailable',
    )
    expect(f.operations().some((op) => op.kind === 'close')).toBe(false)
    f.selection.cancel(copying, owner)
    await vi.waitFor(() =>
      expect(f.operations().at(-1)).toEqual({ kind: 'close', cursor: '19' }),
    )
  })
})
