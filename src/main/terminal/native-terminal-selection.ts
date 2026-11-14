import { randomUUID } from 'node:crypto'
import type { HostPath } from '../../shared/host-path'
import {
  NATIVE_TERMINAL_LIMITS as limits,
  NativeTerminalAdmissionError,
} from '../../shared/native-terminal'
import {
  NativeTerminalSelectionRefused,
  validNativeTerminalSelectionRequest,
  validNativeTerminalSelectionCancellation,
  validNativeTerminalSelectionCursor,
  type NativeTerminalSelectionContext,
  type NativeTerminalSelectionRequest,
  type NativeTerminalSelectionResponse,
  type NativeTerminalSelectionReadRequest,
  type NativeTerminalSelectionOperation,
  type NativeTerminalSelectionNativeResult,
} from '../../shared/native-terminal-selection'
import {
  validNativeTerminalLinkIntent,
  type NativeTerminalLinkIntent,
  type NativeTerminalLinkActivation,
  type NativeTerminalLinkCapture,
} from '../../shared/native-terminal-link'
import {
  detectTerminalFileLinks,
  detectTerminalWebLinks,
  detectTerminalExternalLinks,
  isFileUri,
  isTerminalWebTarget,
  isTerminalExternalTarget,
} from '../../shared/terminal-link-targets'
import type { RendererOwner } from '../renderer-resource-scopes'
import type { PtyTerminalInputPrefix } from '../pty/pty-contract'
import type { NativeTerminalHost } from './native-terminal-host'
import {
  nativeSelectionState,
  nativeSelectionChunk,
} from './native-terminal-selection-results'

export interface NativeTerminalSelectionSource {
  readonly handle: string
  readonly instanceId: string
  readonly workspaceRoot: HostPath
  readonly geometry: NativeTerminalSelectionContext
  assertCurrent(): void
  prefix(): PtyTerminalInputPrefix
}
interface ReadRequest {
  readonly viewId: string
  readonly requestId: string
  readonly owner: RendererOwner
  readonly source: NativeTerminalSelectionSource
  readonly mode: 'copy' | 'row' | 'command'
  readonly abort: AbortController
  cursor?: string
  serial?: number
  timer?: ReturnType<typeof setTimeout>
  claimed: boolean
  native?: Promise<unknown>
  closing?: Promise<void>
}
type SelectionHost = Pick<NativeTerminalHost, 'selection' | 'inspectProducer'>

/** Explicit reads own cursors, not PTYs, clipboard permission or an input queue. */
export class NativeTerminalSelection {
  private readonly requests = new Map<string, ReadRequest>()
  private disposed = false
  constructor(
    private readonly host: SelectionHost,
    private readonly source: (
      viewId: string,
      owner: RendererOwner,
    ) => NativeTerminalSelectionSource,
  ) {}

  async action(
    request: NativeTerminalSelectionRequest,
    owner: RendererOwner,
  ): Promise<NativeTerminalSelectionResponse> {
    if (!validNativeTerminalSelectionRequest(request))
      throw new Error('native-selection-request-invalid')
    const record = this.start(
      request.viewId,
      request.requestId ?? randomUUID(),
      owner,
      request.action === 'copy' ? 'copy' : 'command',
    )
    try {
      const prefix = record.source.prefix()
      const action = request.action === 'copy' ? 'state' : request.action
      const state = nativeSelectionState(
        await this.call(
          record,
          {
            kind: 'command',
            action,
            context: record.source.geometry,
          },
          async (signal) => {
            await prefix.parsed(signal)
            record.source.assertCurrent()
          },
        ),
        record.source.geometry,
      )
      if (request.action !== 'copy') {
        await this.applied(record, state.requestedMutation)
        return this.publicState(state)
      }
      const begun = nativeSelectionState(
        await this.call(record, {
          kind: 'begin',
          selectionSerial: state.selectionSerial,
          context: record.source.geometry,
        }),
        record.source.geometry,
      )
      this.capture(record, begun)
      if (!begun.hasSelection) {
        if (record.cursor) throw new Error('native-empty-selection-owned-cursor')
        await this.close(record)
      } else if (!record.cursor) throw new Error('native-selection-cursor-missing')
      return this.publicState(begun)
    } catch (error) {
      await this.close(record).catch(() => undefined)
      throw error
    } finally {
      if (record.mode === 'command') await this.close(record)
    }
  }

  async read(
    request: NativeTerminalSelectionReadRequest,
    owner: RendererOwner,
  ): Promise<NativeTerminalSelectionResponse> {
    const record = this.claim(request, owner, 'copy')
    try {
      const { text, state } = await this.collect(record)
      record.source.assertCurrent()
      return { ...this.publicState(state), text }
    } finally {
      await this.close(record).catch(() => undefined)
    }
  }

  async link(
    request: NativeTerminalLinkIntent,
    owner: RendererOwner,
  ): Promise<NativeTerminalLinkCapture> {
    if (!validNativeTerminalLinkIntent(request))
      throw new Error('native-link-intent-invalid')
    const record = this.start(request.viewId, request.requestId, owner, 'row')
    try {
      const prefix = record.source.prefix()
      const state = nativeSelectionState(
        await this.call(
          record,
          {
            kind: 'link-row-begin',
            query: { x: request.x, y: request.y, ...record.source.geometry },
          },
          async (signal) => {
            await prefix.parsed(signal)
            record.source.assertCurrent()
          },
        ),
        record.source.geometry,
      )
      this.capture(record, state)
      if (state.link) {
        if (record.cursor) throw new Error('native-link-and-row-cursor')
        const link = this.uri(state.link.uri, record.source.workspaceRoot)
        await this.close(record)
        return { pending: false, ...(link ? { link } : {}) }
      }
      if (!record.cursor) {
        await this.close(record)
        return { pending: false }
      }
      return { pending: true }
    } catch (error) {
      await this.close(record).catch(() => undefined)
      throw error
    }
  }

  async readLink(
    request: NativeTerminalSelectionReadRequest,
    owner: RendererOwner,
  ): Promise<NativeTerminalLinkActivation | undefined> {
    const record = this.claim(request, owner, 'row')
    try {
      const body = await this.collect(record)
      record.source.assertCurrent()
      if (body.offset === undefined) return
      const index = this.prefixLength(body.bytes, body.offset)
      const candidates = [
        ...detectTerminalFileLinks(body.text).map((link) => ({
          ...link,
          kind: 'file' as const,
        })),
        ...detectTerminalWebLinks(body.text).map((link) => ({
          ...link,
          kind: 'loopback-http' as const,
        })),
        ...detectTerminalExternalLinks(body.text).map((link) => ({
          ...link,
          kind: 'external-http' as const,
        })),
      ]
      const target = candidates.find((link) => index >= link.start && index <= link.end)
      record.source.assertCurrent()
      return (
        target && {
          kind: target.kind,
          target: target.target,
          workspaceRoot: record.source.workspaceRoot,
        }
      )
    } finally {
      await this.close(record).catch(() => undefined)
    }
  }

  cancel(request: NativeTerminalSelectionReadRequest, owner: RendererOwner): void {
    if (!validNativeTerminalSelectionCancellation(request)) return
    const record = this.requests.get(request.requestId)
    if (record?.viewId === request.viewId && this.owned(record, owner))
      void this.close(record).catch(() => undefined)
  }
  revoke(viewId: string): void {
    for (const record of this.requests.values())
      if (record.viewId === viewId) void this.close(record).catch(() => undefined)
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const record of this.requests.values())
      void this.close(record).catch(() => undefined)
  }
  /** Called only after the existing native-state owner has removed this instance. */
  forget(instanceId: string): void {
    for (const record of this.requests.values())
      if (record.source.instanceId === instanceId) {
        record.abort.abort()
        clearTimeout(record.timer)
        this.requests.delete(record.requestId)
      }
  }

  private start(
    viewId: string,
    requestId: string,
    owner: RendererOwner,
    mode: ReadRequest['mode'],
  ): ReadRequest {
    if (this.disposed) throw new Error('native-selection-closed')
    if (this.requests.has(requestId) || this.requests.size >= limits.states * 2)
      throw new NativeTerminalSelectionRefused(6, false)
    const source = this.source(viewId, owner)
    source.assertCurrent()
    const record: ReadRequest = {
      viewId,
      requestId,
      owner: { ...owner },
      source,
      mode,
      abort: new AbortController(),
      claimed: false,
    }
    this.requests.set(requestId, record)
    return record
  }
  private claim(
    request: NativeTerminalSelectionReadRequest,
    owner: RendererOwner,
    mode: 'copy' | 'row',
  ): ReadRequest {
    if (!validNativeTerminalSelectionCancellation(request))
      throw new Error('native-selection-request-invalid')
    const record = this.requests.get(request.requestId)
    if (
      !record ||
      record.viewId !== request.viewId ||
      !this.owned(record, owner) ||
      record.mode !== mode ||
      record.claimed ||
      !record.cursor ||
      record.abort.signal.aborted
    )
      throw new NativeTerminalSelectionRefused(6, true)
    record.source.assertCurrent()
    record.claimed = true
    clearTimeout(record.timer)
    record.timer = undefined
    return record
  }
  private owned(record: ReadRequest, owner: RendererOwner): boolean {
    return record.owner.id === owner.id && record.owner.generation === owner.generation
  }
  private capture(record: ReadRequest, state: NativeTerminalSelectionNativeResult): void {
    if (state.cursor !== undefined && state.cursor !== '0') {
      if (!validNativeTerminalSelectionCursor(state.cursor))
        throw new Error('native-selection-cursor-invalid')
      record.cursor = state.cursor
      record.serial = state.selectionSerial
      // Only an unclaimed begin expires. Productive reads use per-step timeouts.
      record.timer = setTimeout(() => {
        void this.close(record).catch(() => undefined)
      }, limits.requestMs)
    }
  }
  private async call(
    record: ReadRequest,
    operation: NativeTerminalSelectionOperation,
    eligible?: (signal: AbortSignal) => Promise<void>,
  ): Promise<unknown> {
    record.abort.signal.throwIfAborted()
    record.source.assertCurrent()
    record.native = this.host.selection(
      record.source.handle,
      record.source.instanceId,
      operation,
      record.abort.signal,
      eligible,
    )
    const value = await record.native
    // Resource-producing results are captured before authority can reject delivery.
    if (
      (operation.kind === 'begin' || operation.kind === 'link-row-begin') &&
      value &&
      typeof value === 'object' &&
      'cursor' in value &&
      validNativeTerminalSelectionCursor(value.cursor)
    )
      record.cursor = value.cursor
    record.abort.signal.throwIfAborted()
    record.source.assertCurrent()
    return value
  }
  private async collect(record: ReadRequest) {
    const cursor = record.cursor!
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
    const parts: string[] = [],
      bytes: Uint8Array[] = []
    let offset: number | undefined
    for (;;) {
      const chunk = nativeSelectionChunk(
        await this.call(record, { kind: 'next', cursor }),
        cursor,
      )
      if (record.mode === 'copy' && chunk.selectionSerial !== record.serial)
        throw new NativeTerminalSelectionRefused(6, true)
      parts.push(decoder.decode(chunk.data, { stream: true }))
      if (record.mode === 'row') bytes.push(chunk.data)
      if (chunk.clickedByteOffset !== undefined) offset = chunk.clickedByteOffset
      if (chunk.done) break
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    const finished = await this.call(record, { kind: 'finish', cursor })
    record.cursor = undefined // Definitive Finish reply always closes, including refusal.
    const state = nativeSelectionState(finished, record.source.geometry)
    if (record.mode === 'copy' && state.selectionSerial !== record.serial)
      throw new NativeTerminalSelectionRefused(6, true)
    if (state.clickedByteOffset !== undefined) offset = state.clickedByteOffset
    parts.push(decoder.decode())
    return { text: parts.join(''), state, bytes, offset }
  }
  private async applied(record: ReadRequest, mutation: number): Promise<void> {
    if (!mutation) return
    const deadline = Date.now() + limits.requestMs
    for (;;) {
      const status = await this.host.inspectProducer(
        record.source.handle,
        record.source.instanceId,
      )
      record.source.assertCurrent()
      record.abort.signal.throwIfAborted()
      if (status.ioAppliedMutation >= mutation) return
      if (Date.now() >= deadline) throw new Error('native-selection-apply-timeout')
      await new Promise<void>((resolve) => setTimeout(resolve, 1))
    }
  }
  private close(record: ReadRequest): Promise<void> {
    if (record.closing) return record.closing
    record.abort.abort()
    clearTimeout(record.timer)
    record.closing = (async () => {
      await record.native?.catch(() => undefined)
      if (record.cursor) {
        const deadline = Date.now() + limits.requestMs
        for (;;) {
          try {
            const result = await this.host.selection(
              record.source.handle,
              record.source.instanceId,
              { kind: 'close', cursor: record.cursor },
            )
            if (
              !result ||
              typeof result !== 'object' ||
              !('result' in result) ||
              result.result !== 0
            )
              throw new Error('native-selection-cleanup-failed')
            break
          } catch (error) {
            if (
              !(error instanceof NativeTerminalAdmissionError) ||
              Date.now() >= deadline
            )
              throw error
            await new Promise<void>((resolve) => setTimeout(resolve, 1))
          }
        }
        record.cursor = undefined
      }
      if (this.requests.get(record.requestId) === record)
        this.requests.delete(record.requestId)
    })()
    return record.closing
  }
  private publicState(
    state: NativeTerminalSelectionNativeResult,
  ): NativeTerminalSelectionResponse {
    return { hasSelection: state.hasSelection, selectionSerial: state.selectionSerial }
  }
  private uri(
    target: string,
    workspaceRoot: HostPath,
  ): NativeTerminalLinkActivation | undefined {
    const kind = isFileUri(target)
      ? 'file'
      : isTerminalWebTarget(target)
        ? 'loopback-http'
        : isTerminalExternalTarget(target)
          ? 'external-http'
          : undefined
    return kind && { kind, target, workspaceRoot }
  }
  private prefixLength(chunks: readonly Uint8Array[], offset: number): number {
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
    let remaining = offset,
      length = 0
    for (const chunk of chunks) {
      const size = Math.min(remaining, chunk.byteLength)
      length += decoder.decode(chunk.subarray(0, size), { stream: true }).length
      remaining -= size
      if (!remaining) break
    }
    if (remaining) throw new Error('native-link-offset-invalid')
    return length + decoder.decode().length
  }
}
