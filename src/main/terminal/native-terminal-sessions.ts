import {
  nativeTerminalWorkingDirectory,
  type NativeTerminalEffectBatch,
} from '../../shared/native-terminal-effects'
import type { NativeTerminalEffectPolicy } from './native-terminal-effect-policy'
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
  inspectProducer(
    handle: string,
    instanceId: string,
    producerProgress?: boolean,
  ): Promise<NativeTerminalStatus>
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
  drainEffectsProducer(
    handle: string,
    instanceId: string,
  ): Promise<NativeTerminalEffectBatch>
  end(handle: string, instanceId: string): Promise<void>
}
interface NativeSession {
  session: NativeTerminalSession
  handle?: string
  readonly abort: AbortController
  readonly parentSignal: AbortSignal
  readonly cancel: () => void
  phase: 'preparing' | 'live' | 'readonly' | 'failed' | 'removed'
  writer?: Parameters<PtyPreparedTerminal['connect']>[0]
  feeding: boolean
  inputUnavailable: boolean
  effectSerial?: number
  title?: { readonly title: string; readonly eventSerial: number }
  cwd?: HostPath
  effectState?: { readonly droppedEffects: number; readonly semanticGeneration: number }
  inputSettlement?: Promise<void>
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
    private readonly effectPolicy?: Pick<NativeTerminalEffectPolicy, 'consume'>,
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
        inputClosed: boolean
        inputUnavailable: boolean
        unavailable: boolean
        title?: { readonly title: string; readonly eventSerial: number }
        cwd?: HostPath
        effectState?: {
          readonly droppedEffects: number
          readonly semanticGeneration: number
        }
      }
    | undefined {
    const record = this.sessions.get(sessionId)
    if (!record?.handle || record.phase === 'preparing' || record.phase === 'removed')
      return
    return {
      handle: record.handle,
      title: record.title,
      cwd: record.cwd,
      effectState: record.effectState,
      session: record.session,
      readonly: record.phase !== 'live',
      inputClosed: record.phase !== 'live' || record.writer?.live === false,
      inputUnavailable: record.inputUnavailable,
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
      inputUnavailable: false,
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
  /** An indeterminate write belongs to the immutable PTY, not its current view. */
  blockInput(sessionId: string, instanceId: string): void {
    const record = this.sessions.get(sessionId)
    if (!record || record.session.instanceId !== instanceId || record.phase === 'removed')
      return
    record.inputUnavailable = true
  }

  /** Physical input lifetime survives view disposal and renderer ownership changes. */
  inputSettled(sessionId: string, instanceId: string): Promise<void> | undefined {
    const record = this.sessions.get(sessionId)
    if (!record || record.session.instanceId !== instanceId || record.phase === 'removed')
      throw new Error('native-session-instance-stale')
    return record.inputSettlement
  }
  retainInput(sessionId: string, instanceId: string, pending: Promise<unknown>): void {
    const record = this.sessions.get(sessionId)
    if (!record || record.session.instanceId !== instanceId || record.phase === 'removed')
      throw new Error('native-session-instance-stale')
    // Captured cleanup may run alongside an active transport write. Their settlement
    // is one lifetime fence, not a queue dispatching work or swallowing caller errors.
    const settlement = Promise.allSettled([record.inputSettlement, pending]).then(
      () => undefined,
    )
    record.inputSettlement = settlement
    void settlement.then(() => {
      if (record.inputSettlement === settlement) record.inputSettlement = undefined
    })
  }

  /** Focus cleanup shares the captured response writer, never user observation. */
  async writeControl(
    sessionId: string,
    instanceId: string,
    bytes: Uint8Array,
  ): Promise<void> {
    const record = this.sessions.get(sessionId)
    if (!record || record.session.instanceId !== instanceId)
      throw new Error('native-session-instance-stale')
    this.assertCurrent(record)
    if (!record.inputUnavailable && record.writer?.live && bytes.byteLength)
      await record.writer.writeReply(bytes)
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
        const producingSession = record.session
        await this.retryUnsent(record, () =>
          this.host.feed(
            record.handle!,
            record.session.instanceId,
            encoded.subarray(offset, offset + NATIVE_TERMINAL_LIMITS.feedChunkBytes),
          ),
        )
        record.writer?.parsed(
          Math.min(NATIVE_TERMINAL_LIMITS.feedChunkBytes, encoded.byteLength - offset),
        )
        await this.awaitFeedReplies(record)
        const replies = await this.retryUnsent(record, () =>
          this.host.drainReplies(record.handle!, record.session.instanceId),
        )
        this.assertCurrent(record)
        // Append an already-generated reply before another input result can write.
        // The transport call owns zero native credit; this remains ONE producer
        // C job per state, and neither outcome starts the next feed early.
        const writing =
          !record.inputUnavailable && replies.byteLength && record.writer?.live
            ? record.writer.writeReply(replies)
            : Promise.resolve()
        const effects = this.retryUnsent(record, () =>
          this.host.drainEffectsProducer(record.handle!, record.session.instanceId),
        )
        record.writer?.repliesDispatched(
          Math.min(NATIVE_TERMINAL_LIMITS.feedChunkBytes, encoded.byteLength - offset),
        )
        const consuming = effects.then((batch) => {
          this.assertCurrent(record)
          const previous = record.effectSerial ?? 0
          // Copied facts belong to the current native instance, not its presentation owner.
          record.effectState = {
            droppedEffects: batch.droppedEffects,
            semanticGeneration: batch.semanticGeneration,
          }
          for (const effect of batch.effects) {
            if (effect.eventSerial <= previous) continue
            if (effect.kind === 'title')
              record.title = { title: effect.title, eventSerial: effect.eventSerial }
            if (effect.kind === 'cwd')
              record.cwd = nativeTerminalWorkingDirectory(
                producingSession.workspaceRoot.hostId,
                effect.uri,
              )
          }
          this.effectPolicy?.consume(
            producingSession,
            {
              ...batch,
              effects: batch.effects.filter((effect) => effect.eventSerial > previous),
            },
            {
              current: () => {
                try {
                  this.assertCurrent(record)
                } catch {
                  return false
                }
                return (
                  record.session === producingSession &&
                  this.isRendererCurrent(
                    producingSession.ownerId,
                    producingSession.ownerGeneration,
                  )
                )
              },
              live: () =>
                record.phase === 'live' &&
                !record.inputUnavailable &&
                record.writer?.live === true,
            },
          )
          record.effectSerial = Math.max(
            previous,
            ...batch.effects.map((effect) => effect.eventSerial),
          )
        })
        const outcomes = await Promise.allSettled([writing, consuming])
        const failure = outcomes.find((outcome) => outcome.status === 'rejected')
        if (failure?.status === 'rejected') throw failure.reason
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
  private async awaitFeedReplies(record: NativeSession): Promise<void> {
    const deadline = performance.now() + NATIVE_TERMINAL_LIMITS.requestMs
    for (;;) {
      const status = await this.retryUnsent(record, () =>
        this.host.inspectProducer(record.handle!, record.session.instanceId, true),
      )
      if (status.failure) throw new Error('native-reply-state-failed')
      if (status.ioAppliedSequence >= status.appliedSequence) return
      if (performance.now() >= deadline) throw new Error('native-reply-apply-timeout')
      await new Promise<void>((resolve) => setTimeout(resolve, 1))
    }
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
