import { randomUUID } from 'node:crypto'
import type { RendererOwner } from '../renderer-resource-scopes'
import type { NativeTerminalHost } from './native-terminal-host'
import type { NativeTerminalSession } from '../../shared/native-terminal'
import {
  NATIVE_TERMINAL_LIMITS,
  NativeTerminalAdmissionError,
} from '../../shared/native-terminal'
import {
  validNativeTerminalQueryRequest,
  validNativeTerminalQueryCancellation,
  type NativeTerminalQueryRequest,
  type NativeTerminalQueryResponse,
  type NativeTerminalQuerySnapshot,
  type NativeTerminalQueryUpdate,
  type NativeTerminalQueryCancellation,
} from '../../shared/native-terminal-query'
import {
  validNativeTerminalSelectionCursor,
  NativeTerminalSelectionRefused,
} from '../../shared/native-terminal-selection'
import type { NativeTerminalQueryOperation } from '../../shared/native-terminal-query-operations'
import type {
  NativeTerminalEffectBatch,
  NativeTerminalProductEffect,
} from '../../shared/native-terminal-effects'
import {
  NativeTerminalQueryBoundaries,
  type NativeBoundarySource,
} from './native-terminal-query-boundaries'
import {
  NativeTerminalQueryRequestOwner,
  nativeQueryResult,
  nativeQueryCleanupUnsent,
  type NativeTerminalQuerySource,
} from './native-terminal-query-request'

interface Query {
  readonly id: string
  readonly native: string
  readonly owner: RendererOwner
  readonly source: NativeTerminalQuerySource
  snapshot: NativeTerminalQuerySnapshot
  nativeRevision: string
  dirty: number
  observed: number
  locks: number
  revoked: boolean
  waiting: boolean
  pump?: Promise<void>
  pumpRequest?: NativeTerminalQueryRequestOwner
  closing?: Promise<void>
}
interface Request {
  readonly id: string
  readonly kind: NativeTerminalQueryRequest['kind']
  readonly queryId?: string
  readonly owner: RendererOwner
  readonly work: NativeTerminalQueryRequestOwner
}
type Host = Pick<NativeTerminalHost, 'query' | 'inspectProducer'>

/** Main owns query/request lifetimes; native state owns matching, identity and text. */
export class NativeTerminalQuery {
  private readonly queries = new Map<string, Query>()
  private readonly requests = new Map<string, Request>()
  private readonly boundaries: NativeTerminalQueryBoundaries
  private disposed = false
  constructor(
    private readonly host: Host,
    private readonly source: (
      viewId: string,
      owner: RendererOwner,
    ) => NativeTerminalQuerySource,
    private readonly publish: (
      owner: RendererOwner,
      update: NativeTerminalQueryUpdate,
    ) => void,
    publishEffect: (
      session: NativeTerminalSession,
      effect: NativeTerminalProductEffect,
    ) => void,
  ) {
    this.boundaries = new NativeTerminalQueryBoundaries(
      (source, token) =>
        this.cleanup(source, { kind: 'boundary-close', boundary: token }),
      publishEffect,
    )
  }

  async action(
    request: NativeTerminalQueryRequest,
    owner: RendererOwner,
  ): Promise<NativeTerminalQueryResponse> {
    if (!validNativeTerminalQueryRequest(request))
      throw new Error('native-query-request-invalid')
    if (this.disposed) throw new Error('native-query-owner-disposed')
    const source = this.source(request.viewId, owner)
    const key = `${request.viewId}:${request.requestId}`
    if (this.requests.has(key)) throw new Error('native-query-request-duplicate')
    if (
      this.requests.size >= NATIVE_TERMINAL_LIMITS.commands ||
      Array.from(this.requests.values()).filter(
        ({ work }) => work.source.viewId === request.viewId,
      ).length >= NATIVE_TERMINAL_LIMITS.commandsPerState
    )
      throw new NativeTerminalAdmissionError('native-query-requests-full')
    const record: Request = {
      id: request.requestId,
      kind: request.kind,
      ...('queryId' in request ? { queryId: request.queryId } : {}),
      owner,
      work: new NativeTerminalQueryRequestOwner(this.host, source),
    }
    this.requests.set(key, record)
    try {
      return await this.execute(request, record)
    } finally {
      await record.work.close()
      if (this.requests.get(key) === record) this.requests.delete(key)
    }
  }

  cancel(request: NativeTerminalQueryCancellation, owner: RendererOwner): void {
    if (!validNativeTerminalQueryCancellation(request))
      throw new Error('native-query-cancel-invalid')
    const record = this.requests.get(`${request.viewId}:${request.requestId}`)
    if (record && sameOwner(record.owner, owner)) record.work.abort.abort()
  }

  async consume(
    source: NativeBoundarySource,
    batch: NativeTerminalEffectBatch,
  ): Promise<void> {
    await this.boundaries.consume(source, batch)
    source.assertCurrent()
    this.changed(source.session)
  }
  metadata(source: NativeBoundarySource) {
    return this.boundaries.snapshot(source)
  }

  controlApplied(source: NativeBoundarySource, cutoff: number): Promise<void> {
    return this.boundaries.controlApplied(source, cutoff)
  }
  changed(session: NativeTerminalSession): void {
    for (const query of this.queries.values()) {
      if (query.source.session.instanceId !== session.instanceId) continue
      if (
        query.source.session.ownerId !== session.ownerId ||
        query.source.session.ownerGeneration !== session.ownerGeneration
      ) {
        void this.closeQuery(query).catch(() => undefined)
        continue
      }
      query.dirty++
      this.pump(query)
    }
  }
  revoke(viewId: string): void {
    const query = this.queries.get(viewId)
    if (query) void this.closeQuery(query).catch(() => undefined)
    for (const record of this.requests.values())
      if (record.work.source.viewId === viewId) record.work.abort.abort()
  }
  async remove(instanceId: string): Promise<void> {
    for (const query of this.queries.values())
      if (query.source.session.instanceId === instanceId) await this.closeQuery(query)
    await this.boundaries.remove(instanceId)
  }
  /** The owning host has confirmed destruction of this exact physical Surface. */
  forgetDestroyed(instanceId: string): void {
    for (const query of this.queries.values()) {
      if (query.source.session.instanceId !== instanceId) continue
      query.revoked = true
      query.pumpRequest?.abort.abort()
      this.queries.delete(query.source.viewId)
    }
    for (const [key, record] of this.requests) {
      if (record.work.source.session.instanceId !== instanceId) continue
      record.work.abort.abort()
      this.requests.delete(key)
    }
    this.boundaries.forgetDestroyed(instanceId)
  }
  async dispose(): Promise<void> {
    this.disposed = true
    const records = Array.from(this.requests.values())
    for (const record of records) record.work.abort.abort()
    await Promise.allSettled([
      ...Array.from(this.queries.values(), (query) => this.closeQuery(query)),
      ...records.map(({ work }) => work.close()),
    ])
  }

  private async execute(
    request: NativeTerminalQueryRequest,
    record: Request,
  ): Promise<NativeTerminalQueryResponse> {
    const work = record.work,
      source = work.source
    if (request.kind === 'begin') return this.begin(request, record)
    if ('queryId' in request) {
      const query = this.queries.get(source.viewId)
      if (request.kind === 'close') {
        if (query?.id === request.queryId && sameOwner(query.owner, record.owner))
          await this.closeQuery(query)
        return { kind: 'done' }
      }
      if (
        !query ||
        query.id !== request.queryId ||
        !sameOwner(query.owner, record.owner) ||
        query.revoked
      )
        throw new Error('native-query-handle-stale')
      if (request.kind === 'clear-reveal') {
        nativeQueryResult(
          await work.call({ kind: 'query-clear-reveal', query: query.native }),
        )
        return { kind: 'done' }
      }
      if (request.kind === 'at') {
        const unlock = await this.lock(query)
        try {
          const page = nativeQueryResult(
            await work.call({
              kind: 'query-page',
              query: query.native,
              revision: query.nativeRevision,
              offset: request.index,
              capacity: 1,
            }),
          )
          if (!Array.isArray(page.results) || page.results.length > 1)
            throw new Error('native-query-page-invalid')
          const first = page.results[0] as
            { occurrence?: unknown; index?: unknown } | undefined
          if (
            first &&
            (first.index !== request.index ||
              !validNativeTerminalSelectionCursor(first.occurrence))
          )
            throw new Error('native-query-occurrence-invalid')
          return {
            kind: 'occurrence',
            ...(first ? { occurrenceId: first.occurrence as string } : {}),
          }
        } finally {
          unlock()
        }
      }
      const operation: NativeTerminalQueryOperation =
        request.kind === 'read'
          ? {
              kind: 'range-begin',
              source: {
                kind: 'match',
                query: query.native,
                occurrence: request.occurrenceId,
              },
              context: await source.context(false, work.abort.signal),
            }
          : {
              kind: 'resolve-begin',
              query: query.native,
              occurrence: request.occurrenceId,
              reveal: request.kind === 'reveal',
              context: await source.context(request.kind === 'reveal', work.abort.signal),
            }
      try {
        await this.beginRead(work, operation)
        const { text, finished } = await work.collect()
        if (request.kind === 'read') return { kind: 'text', text }
        const match = finished.match as
          { occurrence?: unknown; index?: unknown } | undefined
        if (
          finished.resolved !== true ||
          !match ||
          match.occurrence !== request.occurrenceId
        )
          throw new Error('native-query-resolution-invalid')
        await work.applied(number(finished.requestedMutation))
        if (request.kind === 'resolve')
          return { kind: 'resolved', index: number(match.index) }
        if (typeof finished.revealed !== 'boolean')
          throw new Error('native-query-reveal-invalid')
        return { kind: 'revealed', revealed: finished.revealed }
      } catch (error) {
        if (!(error instanceof NativeTerminalSelectionRefused) || !error.stale)
          throw error
        return request.kind === 'read'
          ? { kind: 'text' }
          : request.kind === 'resolve'
            ? { kind: 'resolved' }
            : { kind: 'revealed', revealed: false }
      }
    }
    if (request.kind === 'active-screen') {
      const context = await source.context(false, work.abort.signal)
      return { kind: 'screen', screen: context.screen === 0 ? 'normal' : 'alternate' }
    }
    if (request.kind === 'range-read') {
      const start = this.boundaries.lookup(source, request.startId)
      const end =
        request.endId === undefined
          ? undefined
          : this.boundaries.lookup(source, request.endId)
      if (!start || (request.endId !== undefined && !end)) return { kind: 'text' }
      try {
        await this.beginRead(work, {
          kind: 'range-begin',
          source: { kind: 'semantic', start, ...(end ? { end } : {}) },
          context: await source.context(false, work.abort.signal),
        })
        return { kind: 'text', text: (await work.collect()).text }
      } catch (error) {
        if (error instanceof NativeTerminalSelectionRefused && error.stale)
          return { kind: 'text' }
        throw error
      }
    }
    const token = this.boundaries.lookup(source, request.boundaryId)
    if (!token)
      return request.kind === 'boundary-resolve'
        ? { kind: 'boundary' }
        : { kind: 'revealed', revealed: false }
    try {
      await this.beginRead(work, {
        kind: 'boundary-resolve-begin',
        boundary: token,
        reveal: request.kind === 'boundary-reveal',
        context: await source.context(
          request.kind === 'boundary-reveal',
          work.abort.signal,
        ),
      })
      const { finished } = await work.collect()
      const boundary = finished.boundary as Record<string, unknown> | undefined
      if (finished.resolved !== true || boundary?.boundary !== token)
        throw new Error('native-boundary-resolution-invalid')
      if (request.kind === 'boundary-resolve')
        return { kind: 'boundary', location: location(boundary) }
      if (typeof finished.revealed !== 'boolean')
        throw new Error('native-boundary-reveal-invalid')
      await work.applied(number(finished.requestedMutation))
      return { kind: 'revealed', revealed: finished.revealed }
    } catch (error) {
      if (!(error instanceof NativeTerminalSelectionRefused) || !error.stale) throw error
      return request.kind === 'boundary-resolve'
        ? { kind: 'boundary' }
        : { kind: 'revealed', revealed: false }
    }
  }

  private async begin(
    request: Extract<NativeTerminalQueryRequest, { kind: 'begin' }>,
    record: Request,
  ): Promise<NativeTerminalQueryResponse> {
    const work = record.work
    for (const pending of this.requests.values()) {
      if (
        pending !== record &&
        pending.kind === 'begin' &&
        pending.work.source.viewId === work.source.viewId &&
        sameOwner(pending.owner, record.owner)
      ) {
        pending.work.abort.abort()
        await pending.work.close()
      }
    }
    work.current()
    const previous = this.queries.get(work.source.viewId)
    if (previous) await this.closeQuery(previous)
    work.current()
    const prefix = work.source.prefix()
    const value = nativeQueryResult(
      await work.call(
        { kind: 'query-begin', text: request.text, caseSensitive: request.caseSensitive },
        async (signal) => {
          await prefix.parsed(signal)
          work.current()
        },
      ),
    )
    if (!validNativeTerminalSelectionCursor(value.query))
      throw new Error('native-query-token-invalid')
    const query: Query = {
      id: randomUUID(),
      native: value.query,
      owner: record.owner,
      source: work.source,
      nativeRevision: '1',
      snapshot: { revision: 1, matchCount: 0, pending: true, invalidated: false },
      dirty: 1,
      observed: 0,
      locks: 0,
      revoked: false,
      waiting: false,
    }
    this.queries.set(work.source.viewId, query)
    work.transferAcquisition('query-close', value.query)
    this.pump(query)
    return { kind: 'query', queryId: query.id, snapshot: query.snapshot }
  }
  private async beginRead(
    work: NativeTerminalQueryRequestOwner,
    operation: NativeTerminalQueryOperation,
  ): Promise<void> {
    const prefix = work.source.prefix()
    const value = nativeQueryResult(
      await work.call(operation, async (signal) => {
        await prefix.parsed(signal)
        work.current()
      }),
    )
    if (!validNativeTerminalSelectionCursor(value.cursor))
      throw new Error('native-query-cursor-missing')
  }
  private async lock(query: Query): Promise<() => void> {
    query.locks++
    try {
      await query.pump
      if (!this.current(query)) throw new Error('native-query-handle-stale')
    } catch (error) {
      query.locks--
      throw error
    }
    return () => {
      query.locks--
      this.pump(query)
    }
  }
  private pump(query: Query): void {
    if (
      !this.current(query) ||
      query.pump ||
      query.locks ||
      query.snapshot.invalidated ||
      query.snapshot.unavailable ||
      (query.observed === query.dirty && (!query.snapshot.pending || query.waiting))
    )
      return
    const work = new NativeTerminalQueryRequestOwner(this.host, query.source)
    query.pumpRequest = work
    query.pump = (async () => {
      let observed = query.dirty
      while (this.current(query) && !query.locks) {
        const step = nativeQueryResult(
          await work.call({ kind: 'query-step', query: query.native }),
        )
        if (
          !validNativeTerminalSelectionCursor(step.revision) ||
          step.query !== query.native ||
          (step.status !== 0 && step.status !== 1 && step.status !== 2)
        )
          throw new Error('native-query-progress-invalid')
        query.nativeRevision = step.revision
        query.waiting = step.status === 1
        const snapshot = {
          revision: number(BigInt(step.revision)),
          matchCount: number(step.count),
          pending: step.status !== 2,
          invalidated: false,
        }
        query.snapshot = snapshot
        if (this.current(query))
          this.publish(query.owner, {
            viewId: query.source.viewId,
            queryId: query.id,
            snapshot,
          })
        if (step.status === 2) {
          query.observed = observed
          if (observed === query.dirty) break
          observed = query.dirty
        }
        if (step.status === 1) {
          query.observed = observed
          if (observed === query.dirty) break
          observed = query.dirty
        }
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
    })()
      .catch((error: unknown) => {
        if (!this.current(query)) return
        if (
          typeof __HVIR_SMOKE_BUILD__ !== 'undefined' &&
          __HVIR_SMOKE_BUILD__ &&
          process.env['HVIR_SMOKE']
        )
          console.error('HVIR_NATIVE_QUERY_PUMP_FAILURE', {
            errorClass: error instanceof Error ? error.name : typeof error,
            message: error instanceof Error ? error.message : 'non-error',
            ...(error instanceof NativeTerminalSelectionRefused
              ? { nativeCode: error.code, stale: error.stale }
              : {}),
          })
        query.snapshot = {
          ...query.snapshot,
          pending: false,
          invalidated: error instanceof NativeTerminalSelectionRefused && error.stale,
          ...(!(error instanceof NativeTerminalSelectionRefused && error.stale)
            ? { unavailable: true as const, matchCount: 0 }
            : {}),
        }
        query.observed = query.dirty
        this.publish(query.owner, {
          viewId: query.source.viewId,
          queryId: query.id,
          snapshot: query.snapshot,
        })
      })
      .finally(async () => {
        await work.close()
        query.pump = undefined
        query.pumpRequest = undefined
        if (this.current(query) && !query.locks && query.observed !== query.dirty)
          this.pump(query)
      })
  }
  private current(query: Query): boolean {
    return !query.revoked && this.queries.get(query.source.viewId) === query
  }
  private closeQuery(query: Query): Promise<void> {
    if (query.closing) return query.closing
    query.revoked = true
    if (this.queries.get(query.source.viewId) === query)
      this.queries.delete(query.source.viewId)
    query.pumpRequest?.abort.abort()
    for (const record of this.requests.values())
      if (record.queryId === query.id && sameOwner(record.owner, query.owner))
        record.work.abort.abort()
    query.closing = (async () => {
      await query.pump
      await this.cleanup(query.source, { kind: 'query-close', query: query.native })
    })()
    return query.closing
  }
  private async cleanup(
    source: NativeBoundarySource,
    operation: NativeTerminalQueryOperation,
  ): Promise<void> {
    const deadline = Date.now() + NATIVE_TERMINAL_LIMITS.requestMs
    for (;;) {
      try {
        if (
          nativeQueryResult(
            await this.host.query(source.handle, source.session.instanceId, operation),
          ).result !== 0
        )
          throw new Error('native-query-cleanup-failed')
        return
      } catch (error) {
        if (!nativeQueryCleanupUnsent(error) || Date.now() >= deadline) throw error
        await new Promise<void>((resolve) => setTimeout(resolve, 1))
      }
    }
  }
}
function sameOwner(a: RendererOwner, b: RendererOwner): boolean {
  return a.id === b.id && a.generation === b.generation
}
function number(value: unknown): number {
  if (
    typeof value === 'bigint' &&
    value >= 0n &&
    value <= BigInt(Number.MAX_SAFE_INTEGER)
  )
    return Number(value)
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new Error('native-query-number-invalid')
  return value
}
function location(value: Record<string, unknown>) {
  if (value.screen !== 0 && value.screen !== 1)
    throw new Error('native-boundary-screen-invalid')
  return {
    screen: value.screen === 0 ? ('normal' as const) : ('alternate' as const),
    row: number(value.row),
    column: number(value.column),
  }
}
