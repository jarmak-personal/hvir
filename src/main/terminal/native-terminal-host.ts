import { randomUUID } from 'node:crypto'
import { hostPathEquals } from '../../shared/host-path'
import {
  NATIVE_TERMINAL_PRESENTATION,
  validNativeTerminalScale,
} from '../../shared/native-terminal-presentation'
import {
  NATIVE_TERMINAL_LIMITS as limits,
  NativeTerminalAdmissionError,
  validNativeTerminalExtent,
  type NativeTerminalCommand,
  type NativeTerminalSession,
  type NativeTerminalStatus,
} from '../../shared/native-terminal'

export interface NativeTerminalProcessPort {
  request(command: NativeTerminalCommand, signal?: AbortSignal): Promise<unknown>
  readonly epoch: string
  readonly available: boolean
  dispose(): void
  idle?(): Promise<void>
  /** Observed exit of the owned utility for this exact native generation. */
  hasExited?(epoch: string): boolean
}
export interface NativeTerminalAuthority {
  resolve(sessionId: string): NativeTerminalSession | undefined
  isRendererCurrent(ownerId: number, generation: number): boolean
}
interface Binding {
  readonly session: NativeTerminalSession
  readonly epoch: string
  readonly state: string
  readonly abort: AbortController
  status: NativeTerminalStatus
  stream: number
  attachmentSerial: number
  attachment?: { serial: number; ownerId: number; generation: number }
  requestedGeometry: number
  feeding: boolean
  frameHeld: boolean
  closing: boolean
  nativeDestroyed: boolean
  retiring?: Promise<void>
  finishing?: Promise<void>
}
export interface NativeTerminalFrameMetadata {
  readonly lease: string
  readonly streamSequence: number
  readonly geometrySerial: number
  readonly kind: number
  readonly width: number
  readonly height: number
  readonly colorSpace: number
  readonly origin: number
  readonly premultiplied: boolean
}
export interface NativeTerminalAcquiredFrame {
  readonly metadata: NativeTerminalFrameMetadata
  copyPixels(): Promise<{ bytes: Uint8Array; stride: number }>
  transfer(ticket: string): Promise<void>
  assertCurrent(): void
  release(): Promise<void>
}
/** Main-only authority. Renderer payloads never supply the binding's PTY identity. */
export class NativeTerminalHost {
  private readonly bindings = new Map<string, Binding>()
  private readonly preparing = new Set<string>()
  private deliveryBytes = 0
  private disposed = false
  constructor(
    private readonly process: NativeTerminalProcessPort,
    private readonly authority: NativeTerminalAuthority,
  ) {}
  async prepare(
    session: NativeTerminalSession,
    width: number,
    height: number,
    signal?: AbortSignal,
  ): Promise<string> {
    this.assertSession(session)
    if (!validNativeTerminalExtent(width, height))
      throw new Error('native-extent-invalid')
    if (
      this.disposed ||
      this.bindings.size + this.preparing.size >= limits.states ||
      this.preparing.has(session.instanceId) ||
      [...this.bindings.values()].some((b) => b.session.instanceId === session.instanceId)
    )
      throw new Error('native-state-bound')
    signal?.throwIfAborted()
    this.preparing.add(session.instanceId)
    let value: unknown
    try {
      value = await this.process.request({ kind: 'create', width, height }, signal)
    } catch (error) {
      this.preparing.delete(session.instanceId)
      void this.idle().catch(() => undefined)
      throw error
    }
    const epoch = this.process.epoch
    const prepared = (value ?? {}) as { state?: string; status?: NativeTerminalStatus }
    if (
      !prepared.state ||
      !/^[1-9][0-9]{0,19}$/.test(prepared.state) ||
      !validStatus(prepared.status)
    ) {
      this.preparing.delete(session.instanceId)
      this.process.dispose()
      throw new Error('native-prepare-invalid')
    }
    try {
      this.assertSession(session)
      signal?.throwIfAborted()
      if (this.disposed || !this.process.available || this.process.epoch !== epoch)
        throw new Error('native-host-lost')
    } catch (error) {
      await this.cleanup({ kind: 'destroy', state: prepared.state }, epoch, () => false)
      this.preparing.delete(session.instanceId)
      await this.idle()
      throw error
    }
    const handle = randomUUID()
    this.bindings.set(handle, {
      session,
      epoch,
      state: prepared.state,
      status: prepared.status,
      abort: new AbortController(),
      stream: 0,
      attachmentSerial: 0,
      requestedGeometry: prepared.status.geometry.serial,
      feeding: false,
      frameHeld: false,
      closing: false,
      nativeDestroyed: false,
    })
    this.preparing.delete(session.instanceId)
    return handle
  }
  attach(handle: string, session: NativeTerminalSession): number {
    const binding = this.bindings.get(handle)
    this.assertSession(session)
    if (
      !binding ||
      binding.closing ||
      binding.session.instanceId !== session.instanceId ||
      binding.session.sessionId !== session.sessionId ||
      binding.session.workspaceRoot.hostId !== session.workspaceRoot.hostId
    )
      throw new Error('native-state-foreign')
    if (this.disposed || !this.process.available || binding.epoch !== this.process.epoch)
      throw new Error('native-host-lost')
    // Only authoritative main reattachment may renew renderer/workspace ownership;
    // the immutable PTY instance and parser/native generation remain unchanged.
    const serial = ++binding.attachmentSerial
    binding.attachment = {
      serial,
      ownerId: session.ownerId,
      generation: session.ownerGeneration,
    }
    return serial
  }
  detach(handle: string, ownerId: number, generation: number, attachment: number): void {
    const binding = this.require(handle, ownerId, generation)
    if (binding.attachment?.serial !== attachment)
      throw new Error('native-attachment-stale')
    binding.attachment = undefined
  }
  nativeEpoch(
    handle: string,
    ownerId: number,
    generation: number,
    attachment: number,
  ): string {
    return this.requireAttachment(handle, ownerId, generation, attachment).epoch
  }
  async setVisible(
    handle: string,
    ownerId: number,
    generation: number,
    attachment: number,
    visible: boolean,
  ): Promise<void> {
    if (typeof visible !== 'boolean') throw new Error('native-visibility-invalid')
    if (!visible) {
      const deadline = Date.now() + limits.requestMs
      for (;;) {
        const binding = this.requireHideAttachment(
          handle,
          ownerId,
          generation,
          attachment,
        )
        try {
          // Hide is captured cleanup authority, not a renewed renderer operation.
          // It uses reserved cleanup admission and is never cancelled by its view.
          const result = await this.process.request({
            kind: 'visibility',
            state: binding.state,
            visible: false,
          })
          this.requireHideAttachment(handle, ownerId, generation, attachment)
          if (
            !result ||
            typeof result !== 'object' ||
            !('result' in result) ||
            result.result !== 0
          )
            throw new Error('native-presentation-unavailable')
          return
        } catch (error) {
          if (!(error instanceof NativeTerminalAdmissionError) || Date.now() >= deadline)
            throw error
          await new Promise<void>((resolve) => setTimeout(resolve, 16))
        }
      }
    }
    const binding = this.requireAttachment(handle, ownerId, generation, attachment)
    const result = await this.process.request(
      { kind: 'visibility', state: binding.state, visible },
      binding.abort.signal,
    )
    this.requireAttachment(handle, ownerId, generation, attachment)
    if (
      !result ||
      typeof result !== 'object' ||
      !('result' in result) ||
      result.result !== 0
    )
      throw new Error('native-presentation-unavailable')
  }
  async feed(handle: string, instanceId: string, bytes: Uint8Array): Promise<void> {
    const binding = this.requireProducer(handle, instanceId)
    if (
      !(bytes instanceof Uint8Array) ||
      bytes.buffer instanceof SharedArrayBuffer ||
      bytes.byteLength > limits.queuedBytesPerState
    )
      throw new RangeError('native-feed-payload-bound')
    if (this.deliveryBytes + bytes.byteLength > limits.queuedBytes)
      throw new NativeTerminalAdmissionError('native-feed-capacity')
    if (binding.feeding) {
      await this.retireBinding(binding)
      throw new Error('native-concurrent-delivery')
    }
    const snapshot = bytes.slice()
    this.deliveryBytes += snapshot.byteLength
    binding.feeding = true
    // Admission rejects before accepting an oversized producer delivery; accepted chunks stay ordered.
    try {
      for (
        let offset = 0;
        offset < snapshot.byteLength;
        offset += limits.feedChunkBytes
      ) {
        this.requireProducer(handle, instanceId)
        const sequence = binding.stream + 1
        if (!Number.isSafeInteger(sequence)) throw new Error('native-stream-bound')
        try {
          await this.process.request(
            {
              kind: 'feed',
              state: binding.state,
              sequence,
              bytes: snapshot.subarray(offset, offset + limits.feedChunkBytes),
            },
            binding.abort.signal,
          )
          binding.stream = sequence
        } catch (error) {
          if (error instanceof NativeTerminalAdmissionError && offset === 0) throw error
          await this.retireBinding(binding)
          throw new Error('native-stream-failed', { cause: error })
        }
      }
    } finally {
      binding.feeding = false
      this.deliveryBytes -= snapshot.byteLength
    }
  }
  async inspect(
    handle: string,
    ownerId: number,
    generation: number,
  ): Promise<NativeTerminalStatus> {
    const binding = this.require(handle, ownerId, generation)
    const value = await this.process.request(
      { kind: 'inspect', state: binding.state },
      binding.abort.signal,
    )
    this.require(handle, ownerId, generation)
    if (!validStatus(value)) throw new Error('native-status-invalid')
    binding.status = value
    return value
  }
  async read(handle: string, ownerId: number, generation: number): Promise<Uint8Array> {
    const binding = this.require(handle, ownerId, generation)
    const value = await this.process.request(
      { kind: 'read', state: binding.state },
      binding.abort.signal,
    )
    this.require(handle, ownerId, generation)
    if (!(value instanceof Uint8Array) || value.byteLength > limits.responseBytes)
      throw new Error('native-read-bound')
    return value
  }
  async resize(
    handle: string,
    ownerId: number,
    generation: number,
    attachment: number,
    serial: number,
    width: number,
    height: number,
    backingScale = 1,
  ): Promise<NativeTerminalStatus> {
    const binding = this.requireAttachment(handle, ownerId, generation, attachment)
    if (
      !validNativeTerminalExtent(width, height) ||
      !validNativeTerminalScale(backingScale)
    )
      throw new Error('native-extent-invalid')
    if (!Number.isSafeInteger(serial) || serial <= binding.requestedGeometry)
      throw new Error('native-geometry-stale')
    binding.requestedGeometry = serial
    await this.process.request(
      { kind: 'resize', state: binding.state, serial, width, height, backingScale },
      binding.abort.signal,
    )
    const deadline = Date.now() + 10000
    for (;;) {
      this.requireAttachment(handle, ownerId, generation, attachment)
      if (binding.requestedGeometry !== serial)
        throw new Error('native-geometry-superseded')
      const status = await this.inspect(handle, ownerId, generation)
      if (status.geometryFailureSerial === serial)
        throw new Error('native-geometry-failed')
      if (status.geometry.serial === serial) {
        if (Math.abs(status.geometry.backingScale - backingScale) > 0.00001)
          throw new Error('native-scale-unacknowledged')
        return status
      }
      if (Date.now() >= deadline) throw new Error('native-geometry-timeout')
      await new Promise<void>((resolve) => setTimeout(resolve, 1))
    }
  }
  async takeFrame(
    handle: string,
    ownerId: number,
    generation: number,
    attachment: number,
    signal?: AbortSignal,
  ): Promise<NativeTerminalAcquiredFrame | undefined> {
    const binding = this.requireAttachment(handle, ownerId, generation, attachment)
    if (binding.frameHeld) throw new Error('native-frame-bound')
    binding.frameHeld = true
    let metadata: NativeTerminalFrameMetadata
    let unacquired = false
    try {
      const value = await this.process.request(
        { kind: 'frame', state: binding.state, ticket: randomUUID() },
        signal,
      )
      if (
        value &&
        typeof value === 'object' &&
        'unavailable' in value &&
        Number.isInteger(value.unavailable) &&
        Number(value.unavailable) >= 1 &&
        Number(value.unavailable) <= 9
      ) {
        unacquired = true
        binding.frameHeld = false
        if (binding.closing) await this.finishRetirement(handle, binding)
        if (value.unavailable === 6) return undefined
        if (value.unavailable === 9) throw new Error('native-presentation-unavailable')
        await this.retireBinding(binding)
        throw new Error('native-frame-state-unavailable')
      }
      metadata = value as NativeTerminalFrameMetadata
      if (!validFrame(metadata)) throw new Error('native-frame-invalid')
    } catch (error) {
      if (unacquired) throw error
      if (error instanceof NativeTerminalAdmissionError) {
        binding.frameHeld = false
        if (binding.closing) await this.finishRetirement(handle, binding)
        throw error
      }
      if (signal?.aborted) {
        binding.frameHeld = false
        if (binding.closing)
          void this.finishRetirement(handle, binding).catch(() => undefined)
        throw error
      }
      await this.retireBinding(binding)
      // An unparseable completion may conceal a real lease; stop this native host.
      this.process.dispose()
      binding.frameHeld = false
      throw error
    }
    let released = false
    let releasing: Promise<void> | undefined
    const release = (): Promise<void> => {
      if (releasing) return releasing
      releasing = (async () => {
        await this.cleanup(
          { kind: 'release', state: binding.state, lease: metadata.lease },
          binding.epoch,
          () => false,
        )
        released = true
        binding.frameHeld = false
        if (binding.closing) await this.finishRetirement(handle, binding)
      })()
      return releasing
    }
    const assertCurrent = (): void => {
      signal?.throwIfAborted()
      this.requireAttachment(handle, ownerId, generation, attachment)
      if (
        released ||
        releasing ||
        metadata.geometrySerial !== binding.requestedGeometry ||
        metadata.geometrySerial !== binding.status.geometry.serial ||
        metadata.width !== binding.status.geometry.width ||
        metadata.height !== binding.status.geometry.height
      )
        throw new Error('native-frame-stale')
    }
    try {
      assertCurrent()
    } catch (error) {
      await release()
      throw error
    }
    return {
      metadata,
      assertCurrent,
      release,
      copyPixels: async () => {
        assertCurrent()
        const result = await this.process.request(
          { kind: 'pixels', state: binding.state, lease: metadata.lease },
          signal,
        )
        assertCurrent()
        const pixels = result as { bytes?: unknown; stride?: unknown } | undefined
        if (
          !pixels ||
          !(pixels.bytes instanceof Uint8Array) ||
          pixels.bytes.buffer instanceof SharedArrayBuffer ||
          !Number.isSafeInteger(pixels.stride) ||
          typeof pixels.stride !== 'number' ||
          pixels.stride < metadata.width * 4 ||
          pixels.bytes.byteLength > NATIVE_TERMINAL_PRESENTATION.maximumPixelBytes ||
          pixels.stride * metadata.height !== pixels.bytes.byteLength
        )
          throw new Error('native-pixel-bound')
        return { bytes: pixels.bytes, stride: pixels.stride }
      },
      transfer: async (ticket) => {
        assertCurrent()
        await this.process.request(
          { kind: 'transfer', state: binding.state, lease: metadata.lease, ticket },
          signal,
        )
        assertCurrent()
      },
    }
  }
  async close(handle: string, ownerId: number, generation: number): Promise<void> {
    if (!this.bindings.has(handle)) return
    const binding = this.require(handle, ownerId, generation)
    await this.retireBinding(binding)
    if (!binding.frameHeld) await this.finishRetirement(handle, binding)
  }
  /** Trusted PTY-lifetime cleanup remains valid after renderer or PTY revocation. */
  async end(handle: string, instanceId: string): Promise<void> {
    const binding = this.bindings.get(handle)
    if (!binding) return
    if (binding.session.instanceId !== instanceId) throw new Error('native-state-foreign')
    await this.retireBinding(binding)
    if (!binding.frameHeld) await this.finishRetirement(handle, binding)
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const binding of this.bindings.values()) {
      binding.closing = true
      binding.abort.abort()
    }
    this.bindings.clear()
    this.process.dispose()
  }
  private async idle(): Promise<void> {
    if (!this.disposed && !this.bindings.size && !this.preparing.size)
      await this.process.idle?.()
  }
  private retireBinding(binding: Binding): Promise<void> {
    if (binding.retiring) return binding.retiring
    binding.closing = true
    binding.abort.abort()
    binding.retiring = this.cleanup(
      { kind: 'destroy', state: binding.state },
      binding.epoch,
      () => binding.frameHeld,
    ).then((result) => {
      binding.nativeDestroyed = result === 'complete'
    })
    return binding.retiring
  }
  private finishRetirement(handle: string, binding: Binding): Promise<void> {
    if (binding.finishing) return binding.finishing
    binding.finishing = (async () => {
      await this.retireBinding(binding)
      if (binding.frameHeld) return
      if (!binding.nativeDestroyed) {
        await this.cleanup(
          { kind: 'destroy', state: binding.state },
          binding.epoch,
          () => false,
        )
        binding.nativeDestroyed = true
      }
      this.bindings.delete(handle)
      await this.idle()
    })()
    return binding.finishing
  }
  /** Ownership-affecting work is coalesced per state/lease, never forgotten on
   * proven-unsent pressure. The process reserves cleanup credit within 64/8;
   * remaining contenders yield with bounded admission time before host failure. */
  private async cleanup(
    command:
      | { kind: 'destroy'; state: string }
      | { kind: 'release'; state: string; lease: string },
    epoch: string,
    mayKeepHeldRecord: () => boolean,
  ): Promise<'complete' | 'held'> {
    const deadline = Date.now() + limits.requestMs
    let failure: unknown
    let terminationDeadline = deadline
    for (;;) {
      // An owned, epoch-qualified OS exit is physical evidence, not a C reply.
      if (this.process.hasExited?.(epoch)) return 'complete'
      if (failure) {
        if (Date.now() >= terminationDeadline)
          throw new Error('native-cleanup-failed', { cause: failure })
        await new Promise<void>((resolve) => setTimeout(resolve, 16))
        continue
      }
      try {
        const value = await this.process.request(command)
        if (!value || typeof value !== 'object' || !('result' in value))
          throw new Error('native-cleanup-invalid')
        if (value.result === 0 || (command.kind === 'release' && value.result === 9))
          return 'complete'
        if (command.kind === 'destroy' && value.result === 6) {
          if (mayKeepHeldRecord()) return 'held'
          if (Date.now() < deadline) {
            await new Promise<void>((resolve) => setTimeout(resolve, 16))
            continue
          }
        }
        throw new Error('native-cleanup-unconfirmed')
      } catch (error) {
        if (
          error instanceof NativeTerminalAdmissionError &&
          this.process.available &&
          Date.now() < deadline
        ) {
          await new Promise<void>((resolve) => setTimeout(resolve, 16))
          continue
        }
        this.process.dispose()
        if (this.process.hasExited) {
          failure = error
          terminationDeadline = Date.now() + limits.requestMs
          continue
        }
        throw new Error('native-cleanup-failed', { cause: error })
      }
    }
  }
  private require(handle: string, ownerId: number, generation: number): Binding {
    const binding = this.bindings.get(handle)
    if (!binding || binding.closing || this.disposed)
      throw new Error('native-state-closed')
    const current = this.currentSession(binding)
    if (
      current.ownerId !== ownerId ||
      current.ownerGeneration !== generation ||
      !this.authority.isRendererCurrent(ownerId, generation)
    )
      throw new Error('native-state-foreign')
    if (!this.process.available || binding.epoch !== this.process.epoch)
      throw new Error('native-host-lost')
    return binding
  }
  private requireHideAttachment(
    handle: string,
    ownerId: number,
    generation: number,
    attachment: number,
  ): Binding {
    const binding = this.bindings.get(handle)
    if (!binding || this.disposed) throw new Error('native-state-foreign')
    if (
      !attachment ||
      binding.attachment?.serial !== attachment ||
      binding.attachment.ownerId !== ownerId ||
      binding.attachment.generation !== generation
    )
      throw new Error('native-attachment-stale')
    if (!this.process.available || binding.epoch !== this.process.epoch)
      throw new Error('native-host-lost')
    return binding
  }
  private requireAttachment(
    handle: string,
    ownerId: number,
    generation: number,
    attachment: number,
  ): Binding {
    const binding = this.require(handle, ownerId, generation)
    if (
      !attachment ||
      binding.attachment?.serial !== attachment ||
      binding.attachment.ownerId !== ownerId ||
      binding.attachment.generation !== generation
    )
      throw new Error('native-attachment-stale')
    return binding
  }
  private assertSession(session: NativeTerminalSession): void {
    const current = this.authority.resolve(session.sessionId)
    if (
      !current ||
      current.instanceId !== session.instanceId ||
      current.ownerId !== session.ownerId ||
      current.ownerGeneration !== session.ownerGeneration ||
      !hostPathEquals(current.workspaceRoot, session.workspaceRoot) ||
      !this.authority.isRendererCurrent(session.ownerId, session.ownerGeneration)
    )
      throw new Error('native-session-revoked')
  }
  private currentSession(binding: Binding): NativeTerminalSession {
    const current = this.authority.resolve(binding.session.sessionId)
    if (
      !current ||
      current.instanceId !== binding.session.instanceId ||
      current.workspaceRoot.hostId !== binding.session.workspaceRoot.hostId
    )
      throw new Error('native-session-revoked')
    return current
  }
  private requireProducer(handle: string, instanceId: string): Binding {
    const binding = this.bindings.get(handle)
    if (
      !binding ||
      binding.closing ||
      this.disposed ||
      binding.session.instanceId !== instanceId
    )
      throw new Error('native-producer-revoked')
    this.currentSession(binding)
    if (!this.process.available || binding.epoch !== this.process.epoch)
      throw new Error('native-host-lost')
    return binding
  }
}
function validStatus(value: unknown): value is NativeTerminalStatus {
  const v = value as NativeTerminalStatus | undefined
  if (!v || !v.geometry || typeof v.closing !== 'boolean') return false
  const g = v.geometry
  const unsigned = [
    v.appliedSequence,
    v.replySequence,
    v.queuedReplyBytes,
    v.failure,
    v.rendererHealth,
    v.presentationFailure,
    v.frameCopies,
    v.geometryFailureSerial,
    g.serial,
    g.columns,
    g.rows,
    g.width,
    g.height,
    g.cellWidth,
    g.cellHeight,
    g.contentWidth,
    g.contentHeight,
    g.paddingLeft,
    g.paddingTop,
  ]
  return (
    unsigned.every((n) => Number.isSafeInteger(n) && n >= 0) &&
    validNativeTerminalScale(g.backingScale) &&
    v.queuedReplyBytes <= limits.responseBytes &&
    g.serial > 0 &&
    g.width > 0 &&
    g.width <= 8192 &&
    g.height > 0 &&
    g.height <= 8192 &&
    g.columns > 0 &&
    g.rows > 0 &&
    g.cellWidth > 0 &&
    g.cellHeight > 0 &&
    g.contentWidth + g.paddingLeft <= g.width &&
    g.contentHeight + g.paddingTop <= g.height
  )
}
function validFrame(value: NativeTerminalFrameMetadata): boolean {
  return (
    !!value &&
    /^[1-9][0-9]{0,19}$/.test(value.lease) &&
    [1, 2, 3].includes(value.kind) &&
    Number.isSafeInteger(value.geometrySerial) &&
    value.geometrySerial > 0 &&
    Number.isSafeInteger(value.streamSequence) &&
    value.streamSequence >= 0 &&
    [1, 2].includes(value.colorSpace) &&
    [1, 2].includes(value.origin) &&
    typeof value.premultiplied === 'boolean' &&
    Number.isInteger(value.width) &&
    value.width > 0 &&
    value.width <= 8192 &&
    Number.isInteger(value.height) &&
    value.height > 0 &&
    value.height <= 8192
  )
}
