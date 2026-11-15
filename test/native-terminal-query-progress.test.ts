import { describe, expect, it, vi } from 'vitest'
import { NativeTerminalQuery } from '../src/main/terminal/native-terminal-query'
import type { NativeTerminalHost } from '../src/main/terminal/native-terminal-host'
import type { NativeTerminalQuerySource } from '../src/main/terminal/native-terminal-query-request'
import type { NativeTerminalQueryUpdate } from '../src/shared/native-terminal-query'
import type { RendererOwner } from '../src/main/renderer-resource-scopes'
import { localPath } from '../src/shared/host-path'
import { nativeTerminalStatus } from './fixtures/native-terminal-host'
vi.mock('electron', () => ({ app: { isPackaged: false }, sharedTexture: {} }))

const viewId = '33333333-3333-4333-8333-333333333333'
const owner = { id: 1, generation: 1 }
const source: NativeTerminalQuerySource = {
  handle: 'surface',
  viewId,
  session: {
    sessionId: '11111111-1111-4111-8111-111111111111',
    instanceId: '22222222-2222-4222-8222-222222222222',
    ...{ ownerId: 1, ownerGeneration: 1 },
    workspaceRoot: localPath('/tmp/query-progress'),
  },
  assertCurrent: () => {},
  prefix: () => ({ parsed: () => Promise.resolve(), replies: () => Promise.resolve() }),
  context: () => Promise.resolve({ screen: 0, geometrySerial: 1 }),
}
const requestId = (n: number) => `44444444-4444-4444-8444-${String(n).padStart(12, '0')}`

describe('Main retained-query progress ownership', () => {
  it('waits for the actual positive highlight-only apply fence before resolving its index', async () => {
    let apply!: (value: ReturnType<typeof nativeTerminalStatus>) => void
    const inspectProducer = vi.fn<NativeTerminalHost['inspectProducer']>(
      () =>
        new Promise((resolve) => {
          apply = resolve
        }),
    )
    const query = vi.fn<NativeTerminalHost['query']>((_handle, _instance, op) => {
      if (op.kind === 'query-begin') return Promise.resolve({ result: 0, query: '71' })
      if (op.kind === 'query-step')
        return Promise.resolve({
          result: 0,
          query: '71',
          revision: '1',
          count: 3,
          status: 2,
        })
      if (op.kind === 'resolve-begin') return Promise.resolve({ cursor: '82' })
      if (op.kind === 'next')
        return Promise.resolve({
          cursor: '82',
          selectionSerial: 1,
          data: new Uint8Array(),
          done: true,
          work: 1,
          visited: 1,
        })
      if (op.kind === 'finish')
        return Promise.resolve({
          result: 0,
          resolved: true,
          revealed: false,
          match: { occurrence: '99', index: 2 },
          requestedMutation: 9,
        })
      return Promise.resolve({ result: 0 })
    })
    const queries = new NativeTerminalQuery(
      { query, inspectProducer },
      () => source,
      vi.fn(),
      vi.fn(),
    )
    try {
      const begun = await queries.action(
        {
          kind: 'begin',
          text: 'hit',
          caseSensitive: false,
          viewId,
          requestId: requestId(1),
        },
        owner,
      )
      if (begun.kind !== 'query') throw new Error('Expected query')
      let delivered = false
      const resolving = queries
        .action(
          {
            kind: 'resolve',
            queryId: begun.queryId,
            occurrenceId: '99',
            viewId,
            requestId: requestId(2),
          },
          owner,
        )
        .then((value) => {
          delivered = true
          return value
        })
      await vi.waitFor(() => expect(inspectProducer).toHaveBeenCalledOnce())
      expect(delivered).toBe(false)
      apply({ ...nativeTerminalStatus(), ioAppliedMutation: 9 })
      await expect(resolving).resolves.toEqual({ kind: 'resolved', index: 2 })
      expect(
        query.mock.calls.filter(([, , operation]) => operation.kind === 'close'),
      ).toHaveLength(0)
    } finally {
      await queries.dispose()
    }
  })
  it.each([
    [6, false, true],
    [6, true, false],
    [7, false, false],
  ] as const)(
    'retries only known-unsent close BUSY (%s/stale=%s)',
    async (code, stale, retries) => {
      let closes = 0
      const query = vi.fn<NativeTerminalHost['query']>((_handle, _instance, op) => {
        if (op.kind === 'query-begin') return Promise.resolve({ result: 0, query: '71' })
        if (op.kind === 'query-step')
          return Promise.resolve({
            result: 0,
            query: '71',
            revision: '1',
            count: 3,
            status: 2,
          })
        if (op.kind === 'query-close' && ++closes === 1)
          return Promise.resolve({ unavailable: code, stale })
        return Promise.resolve({ result: 0 })
      })
      const queries = new NativeTerminalQuery(
        { query, inspectProducer: vi.fn() },
        () => source,
        vi.fn(),
        vi.fn(),
      )
      try {
        const begun = await queries.action(
          {
            kind: 'begin',
            text: 'hit',
            caseSensitive: false,
            viewId,
            requestId: requestId(1),
          },
          owner,
        )
        if (begun.kind !== 'query') throw new Error('Expected query')
        const closing = queries.action(
          { kind: 'close', queryId: begun.queryId, viewId, requestId: requestId(2) },
          owner,
        )
        if (retries) await expect(closing).resolves.toEqual({ kind: 'done' })
        else await expect(closing).rejects.toMatchObject({ code, stale })
        expect(closes).toBe(retries ? 2 : 1)
      } finally {
        await queries.dispose()
      }
    },
  )
  it('publishes useful partial counts, waits for source changes without polling, and keeps indexed access independent', async () => {
    let steps = 0
    const query = vi.fn<NativeTerminalHost['query']>((_handle, _instance, op) => {
      if (op.kind === 'query-begin') return Promise.resolve({ result: 0, query: '71' })
      if (op.kind === 'query-step') {
        steps++
        return Promise.resolve({
          result: 0,
          query: '71',
          revision: String(steps),
          count: steps === 1 ? 10001 : 10002,
          status: steps === 1 ? 0 : steps === 2 ? 1 : 2,
        })
      }
      if (op.kind === 'query-page')
        return Promise.resolve({
          result: 0,
          results: [{ occurrence: '99', index: op.offset }],
        })
      return Promise.resolve({ result: 0 })
    })
    const publish =
      vi.fn<(owner: RendererOwner, update: NativeTerminalQueryUpdate) => void>()
    const queries = new NativeTerminalQuery(
      { query, inspectProducer: vi.fn() },
      () => source,
      publish,
      vi.fn(),
    )
    try {
      const begun = await queries.action(
        {
          kind: 'begin',
          text: 'hit',
          caseSensitive: false,
          viewId,
          requestId: requestId(1),
        },
        owner,
      )
      if (begun.kind !== 'query') throw new Error('Expected query')
      await vi.waitFor(() => expect(steps).toBe(2))
      expect(publish.mock.calls.map(([, update]) => update.snapshot.matchCount)).toEqual([
        10001, 10002,
      ])
      expect(publish.mock.calls.at(-1)?.[1].snapshot.pending).toBe(true)
      await expect(
        queries.action(
          {
            kind: 'at',
            queryId: begun.queryId,
            index: 10001,
            viewId,
            requestId: requestId(2),
          },
          owner,
        ),
      ).resolves.toEqual({ kind: 'occurrence', occurrenceId: '99' })
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(steps).toBe(2)
      queries.changed(source.session)
      await vi.waitFor(() =>
        expect(publish.mock.calls.at(-1)?.[1].snapshot.pending).toBe(false),
      )
      expect(steps).toBe(3)
    } finally {
      await queries.dispose()
    }
  })

  it('retains a parsed wake across an indexed read that pauses a partial native pass', async () => {
    let steps = 0
    let completePartial!: (value: unknown) => void
    const query = vi.fn<NativeTerminalHost['query']>((_handle, _instance, op) => {
      if (op.kind === 'query-begin') return Promise.resolve({ result: 0, query: '71' })
      if (op.kind === 'query-step') {
        steps++
        if (steps === 1)
          return new Promise((resolve) => {
            completePartial = resolve
          })
        return Promise.resolve({
          result: 0,
          query: '71',
          revision: String(steps),
          count: steps === 2 ? 1 : 2,
          status: 2,
        })
      }
      if (op.kind === 'query-page')
        return Promise.resolve({ result: 0, results: [{ occurrence: '99', index: 0 }] })
      return Promise.resolve({ result: 0 })
    })
    const publish =
      vi.fn<(owner: RendererOwner, update: NativeTerminalQueryUpdate) => void>()
    const queries = new NativeTerminalQuery(
      { query, inspectProducer: vi.fn() },
      () => source,
      publish,
      vi.fn(),
    )
    try {
      const begun = await queries.action(
        {
          kind: 'begin',
          text: 'hit',
          caseSensitive: false,
          viewId,
          requestId: requestId(1),
        },
        owner,
      )
      if (begun.kind !== 'query') throw new Error('Expected query')
      await vi.waitFor(() => expect(steps).toBe(1))
      // A later parser write needs a finite reconciliation after this captured
      // pass. Indexed access pauses the pump without consuming that source wake.
      queries.changed(source.session)
      const indexed = queries.action(
        { kind: 'at', queryId: begun.queryId, index: 0, viewId, requestId: requestId(2) },
        owner,
      )
      completePartial({ result: 0, query: '71', revision: '1', count: 1, status: 0 })
      await expect(indexed).resolves.toEqual({ kind: 'occurrence', occurrenceId: '99' })
      await vi.waitFor(() =>
        expect(publish.mock.calls.at(-1)?.[1].snapshot).toMatchObject({
          matchCount: 2,
          pending: false,
        }),
      )
      expect(steps).toBe(3)
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(steps).toBe(3)
    } finally {
      await queries.dispose()
    }
  })

  it('reports a failed native pass as unavailable rather than successful finite completion or automatic restart', async () => {
    let steps = 0
    const query = vi.fn<NativeTerminalHost['query']>((_handle, _instance, op) => {
      if (op.kind === 'query-begin') return Promise.resolve({ result: 0, query: '71' })
      if (op.kind === 'query-step') {
        steps++
        return Promise.resolve({ unavailable: 7, stale: false })
      }
      return Promise.resolve({ result: 0 })
    })
    const publish =
      vi.fn<(owner: RendererOwner, update: NativeTerminalQueryUpdate) => void>()
    const queries = new NativeTerminalQuery(
      { query, inspectProducer: vi.fn() },
      () => source,
      publish,
      vi.fn(),
    )
    try {
      await queries.action(
        {
          kind: 'begin',
          text: 'hit',
          caseSensitive: false,
          viewId,
          requestId: requestId(1),
        },
        owner,
      )
      await vi.waitFor(() => expect(publish).toHaveBeenCalledOnce())
      expect(publish.mock.calls[0]?.[1].snapshot).toMatchObject({
        unavailable: true,
        invalidated: false,
        pending: false,
      })
      queries.changed(source.session)
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(steps).toBe(1)
    } finally {
      await queries.dispose()
    }
  })
})
