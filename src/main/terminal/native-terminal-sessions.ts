import type { PtyPreparedTerminal, PtyTerminalReservation } from '../pty/pty-contract'
import {
  NATIVE_TERMINAL_LIMITS,
  NativeTerminalAdmissionError,
  validNativeTerminalExtent,
  type NativeTerminalSession,
  type NativeTerminalStatus,
} from '../../shared/native-terminal'
import { validNativeTerminalScale } from '../../shared/native-terminal-presentation'
import { type HostPath } from '../../shared/host-path'

interface SessionHost {
  prepare(
    session: NativeTerminalSession,
    width: number,
    height: number,
    signal?: AbortSignal,
  ): Promise<string>
  inspectProducer(handle: string, instanceId: string): Promise<NativeTerminalStatus>
  resizeProducer(
    handle: string,
    instanceId: string,
    serial: number,
    width: number,
    height: number,
    backingScale: number,
  ): Promise<NativeTerminalStatus>
  feed(handle: string, instanceId: string, bytes: Uint8Array): Promise<void>
  drainReplies(handle: string, instanceId: string): Promise<Uint8Array>
  discardEffectsProducer(handle: string, instanceId: string): Promise<number>
  end(handle: string, instanceId: string): Promise<void>
}
interface NativeSession {
  session: NativeTerminalSession
  handle?: string
  readonly abort: AbortController
  readonly parentSignal: AbortSignal
  readonly cancel: () => void
  phase: 'preparing' | 'live' | 'readonly' | 'failed' | 'removed'
  writer?: { readonly live: boolean; writeReply(bytes: Uint8Array): Promise<void> }
  feeding: boolean
  disposing?: Promise<void>
}
export interface NativeTerminalViewport {
  /** Physical backing extent; the presenter performs CSS conversion once. */
  width: number
  height: number
  backingScale: number
}

/** Owns native state for supervisor-reserved instances, never PTY launch policy.
 * The supervisor serializes/pressures decoded output independently of renderer replay. */
export class NativeTerminalSessions {
  private readonly sessions = new Map<string, NativeSession>()
  constructor(
    private readonly host: SessionHost,
    private readonly isRendererCurrent: (ownerId: number, generation: number) => boolean,
    private readonly onUnavailable?: (sessionId: string, instanceId: string) => void,
  ) {}

  resolve(sessionId: string): NativeTerminalSession | undefined {
    const record = this.sessions.get(sessionId)
    return record?.phase === 'removed' ? undefined : record?.session
  }

  get(sessionId: string):
    | {
        handle: string
        session: NativeTerminalSession
        readonly: boolean
        unavailable: boolean
      }
    | undefined {
    const record = this.sessions.get(sessionId)
    if (!record?.handle || record.phase === 'preparing' || record.phase === 'removed')
      return
    return {
      handle: record.handle,
      session: record.session,
      readonly: record.phase !== 'live',
      unavailable: record.phase === 'failed',
    }
  }

  async prepare(
    reservation: PtyTerminalReservation,
    signal: AbortSignal,
    viewport: NativeTerminalViewport,
  ): Promise<PtyPreparedTerminal> {
    signal.throwIfAborted()
    if (
      !validNativeTerminalExtent(viewport.width, viewport.height) ||
      !validNativeTerminalScale(viewport.backingScale)
    )
      throw new Error('native-initial-geometry-invalid')
    if (
      this.sessions.has(reservation.sessionId) ||
      this.sessions.size >= NATIVE_TERMINAL_LIMITS.states
    )
      throw new Error('native-session-bound')
    if (!this.isRendererCurrent(reservation.ownerId, reservation.ownerGeneration))
      throw new Error('native-session-revoked')
    const abort = new AbortController()
    const record: NativeSession = {
      session: { ...reservation },
      abort,
      parentSignal: signal,
      cancel: () => abort.abort(),
      phase: 'preparing',
      feeding: false,
    }
    signal.addEventListener('abort', record.cancel, { once: true })
    this.sessions.set(reservation.sessionId, record)
    try {
      record.handle = await this.host.prepare(
        record.session,
        viewport.width,
        viewport.height,
        abort.signal,
      )
      if (record.phase === 'removed')
        await this.host.end(record.handle, reservation.instanceId)
      this.assertCurrent(record)
      let geometry = (
        await this.host.inspectProducer(record.handle, reservation.instanceId)
      ).geometry
      this.assertCurrent(record)
      if (geometry.backingScale !== viewport.backingScale) {
        geometry = (
          await this.host.resizeProducer(
            record.handle,
            reservation.instanceId,
            geometry.serial + 1,
            viewport.width,
            viewport.height,
            viewport.backingScale,
          )
        ).geometry
        this.assertCurrent(record)
      }
      if (
        geometry.width !== viewport.width ||
        geometry.height !== viewport.height ||
        Math.abs(geometry.backingScale - viewport.backingScale) > 0.0001 ||
        geometry.columns < 1 ||
        geometry.rows < 1
      )
        throw new Error('native-initial-geometry-unapplied')
      return {
        columns: geometry.columns,
        rows: geometry.rows,
        connect: (writer) => {
          this.assertCurrent(record)
          if (record.phase !== 'preparing' || record.writer)
            throw new Error('native-session-already-connected')
          record.writer = writer
          record.phase = 'live'
          signal.removeEventListener('abort', record.cancel)
        },
        output: (decoded) => this.output(record, decoded),
        exited: () => {
          if (record.phase === 'live') record.phase = 'readonly'
          record.writer = undefined
          return Promise.resolve()
        },
        failed: () => this.failed(record),
        dispose: () => this.dispose(record),
      }
    } catch (error) {
      await this.dispose(record)
      throw error
    }
  }

  transferOwner(
    sessionId: string,
    instanceId: string,
    ownerId: number,
    ownerGeneration: number,
    workspaceRoot: HostPath,
  ): void {
    const record = this.sessions.get(sessionId)
    if (
      !record ||
      record.session.instanceId !== instanceId ||
      record.phase === 'preparing' ||
      record.phase === 'removed' ||
      record.session.workspaceRoot.hostId !== workspaceRoot.hostId ||
      !this.isRendererCurrent(ownerId, ownerGeneration)
    )
      throw new Error('native-session-transfer-stale')
    record.session = { ...record.session, ownerId, ownerGeneration, workspaceRoot }
  }

  async remove(sessionId: string, instanceId: string): Promise<void> {
    const record = this.sessions.get(sessionId)
    if (!record) return
    if (record.session.instanceId !== instanceId)
      throw new Error('native-session-instance-stale')
    await this.dispose(record)
  }

  private async output(record: NativeSession, decoded: string): Promise<void> {
    this.assertCurrent(record)
    if (record.phase !== 'live' || !record.writer || !record.handle)
      throw new Error('native-session-not-live')
    if (record.feeding) throw new Error('native-session-concurrent-output')
    // Preserve the ProjectHost decoder contract; this is not arbitrary binary replay.
    const encoded = new TextEncoder().encode(decoded)
    record.feeding = true
    try {
      for (
        let offset = 0;
        offset < encoded.byteLength;
        offset += NATIVE_TERMINAL_LIMITS.feedChunkBytes
      ) {
        this.assertCurrent(record)
        await this.retryUnsent(record, () =>
          this.host.feed(
            record.handle!,
            record.session.instanceId,
            encoded.subarray(offset, offset + NATIVE_TERMINAL_LIMITS.feedChunkBytes),
          ),
        )
        const replies = await this.retryUnsent(record, () =>
          this.host.drainReplies(record.handle!, record.session.instanceId),
        )
        await this.retryUnsent(record, () =>
          this.host.discardEffectsProducer(record.handle!, record.session.instanceId),
        )
        this.assertCurrent(record)
        if (replies.byteLength && record.writer?.live)
          await record.writer.writeReply(replies)
      }
    } catch (error) {
      this.failed(record)
      throw error
    } finally {
      record.feeding = false
    }
  }

  private failed(record: NativeSession): void {
    if (record.phase === 'removed' || record.phase === 'failed') return
    record.phase = 'failed'
    record.writer = undefined
    this.onUnavailable?.(record.session.sessionId, record.session.instanceId)
  }

  private async retryUnsent<T>(
    record: NativeSession,
    operation: () => Promise<T>,
  ): Promise<T> {
    const deadline = performance.now() + NATIVE_TERMINAL_LIMITS.requestMs
    for (;;) {
      this.assertCurrent(record)
      try {
        return await operation()
      } catch (error) {
        if (
          !(error instanceof NativeTerminalAdmissionError) ||
          performance.now() >= deadline
        )
          throw error
        await new Promise<void>((resolve) => setTimeout(resolve, 16))
      }
    }
  }

  private assertCurrent(record: NativeSession): void {
    record.abort.signal.throwIfAborted()
    if (
      record.phase === 'preparing' &&
      !this.isRendererCurrent(record.session.ownerId, record.session.ownerGeneration)
    )
      throw new Error('native-session-revoked')
    if (
      record.phase === 'removed' ||
      this.sessions.get(record.session.sessionId) !== record
    )
      throw new Error('native-session-stale')
  }

  private dispose(record: NativeSession): Promise<void> {
    if (record.disposing) return record.disposing
    record.phase = 'removed'
    record.writer = undefined
    record.abort.abort()
    record.parentSignal.removeEventListener('abort', record.cancel)
    record.disposing = (async () => {
      if (record.handle) await this.host.end(record.handle, record.session.instanceId)
      if (this.sessions.get(record.session.sessionId) === record)
        this.sessions.delete(record.session.sessionId)
    })()
    return record.disposing
  }
}
