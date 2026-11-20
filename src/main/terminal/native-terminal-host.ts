import { validNativeTerminalStatus as validStatus } from './native-terminal-status'
import { applyNativeTerminalAppearance } from './native-terminal-appearance'
import type { NativeTerminalAppearance } from '../../shared/native-terminal-appearance'
import {
  readNativeTerminalProducer,
  drainNativeTerminalProducerEffects,
  readNativeTerminalProducerLink,
  inputNativeTerminalProducer,
  selectionNativeTerminalProducer,
  queryNativeTerminalProducer,
  retireNativeTerminalProducerFrame,
  validNativeTerminalProducerFrame,
  validNativeTerminalProducerRendererInfo,
} from './native-terminal-producer'
import type { NativeTerminalLinkQuery } from '../../shared/native-terminal-link'
import type { NativeTerminalQueryOperation } from '../../shared/native-terminal-query-operations'
import { randomUUID } from 'node:crypto'
import {
  nativeTerminalKeyOperation,
  type NativeTerminalInputOperation,
  type NativeTerminalKeyEncodingFallback,
  type NativeTerminalInputResult,
} from '../../shared/native-terminal-input'
import { hostPathEquals, localPath } from '../../shared/host-path'
import {
  validNativeTerminalExportMode,
  type NativeTerminalExportMode,
} from '../../shared/native-terminal-linux'
import {
  nativeTerminalPackedPixelLayout,
  validNativeTerminalScale,
} from '../../shared/native-terminal-presentation'
import {
  NATIVE_TERMINAL_LIMITS as limits,
  NativeTerminalAdmissionError,
  validNativeTerminalExtent,
  type NativeTerminalCommand,
  type NativeTerminalSession,
  type NativeTerminalStatus,
  type NativeTerminalFrameInfo,
  type NativeTerminalRendererInfo,
} from '../../shared/native-terminal'

export interface NativeTerminalProcessPort {
  request(
    command: NativeTerminalCommand,
    signal?: AbortSignal,
    eligible?: (signal: AbortSignal) => Promise<void>,
    physicalInput?: true,
  ): Promise<unknown>
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
  requestedAppearance: number
  feeding: boolean
  frameHeld: boolean
  closing: boolean
  nativeDestroyed: boolean
  surfaceEnded?: boolean
  retirementRelease?: () => Promise<void>
  lastFrame?: NativeTerminalFrameInfo
  retiring?: Promise<void>
  finishing?: Promise<void>
}
export interface NativeTerminalFrameMetadata extends NativeTerminalFrameInfo {
  readonly lease: string
}
export interface NativeTerminalAcquiredFrame {
  readonly metadata: NativeTerminalFrameMetadata
  copyPixels(): Promise<{ bytes: Uint8Array; stride: number }>
  transfer(ticket: string): Promise<void>
  assertCurrent(): void
  release(): Promise<void>
  /** Exact producer-writer fence and original release; never consumer completion. */
  retireProducer?(): Promise<'retired' | 'actor-ended'>
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
      requestedAppearance: prepared.status.appliedAppearanceSerial,
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
  geometryIssuanceFloor(
    ...attachment: Parameters<NativeTerminalHost['nativeEpoch']>
  ): number {
    return this.requireAttachment(...attachment).requestedGeometry
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
  /** Immutable PTY authority keeps parser/reply work independent of view generations. */
  async inspectProducer(
    handle: string,
    instanceId: string,
    producerProgress = false,
  ): Promise<NativeTerminalStatus> {
    const binding = this.requireProducer(handle, instanceId)
    const value = await this.process.request(
      { kind: producerProgress ? 'producer-inspect' : 'inspect', state: binding.state },
      binding.abort.signal,
    )
    this.requireProducer(handle, instanceId)
    if (!validStatus(value)) throw new Error('native-status-invalid')
    binding.status = value
    return value
  }
  async input(
    handle: string,
    instanceId: string,
    input: NativeTerminalInputOperation,
    eligible?: (signal: AbortSignal) => Promise<void>,
    readOnly = false,
    keyEncodingFallback?: NativeTerminalKeyEncodingFallback,
    selectionContext?: import('../../shared/native-terminal-selection').NativeTerminalSelectionContext,
  ): Promise<NativeTerminalInputResult> {
    return inputNativeTerminalProducer(this.producerContext(handle, instanceId), input, {
      eligible,
      readOnly,
      keyEncodingFallback,
      selectionContext,
    })
  }
  async encodeKey(
    handle: string,
    instanceId: string,
    input: { key: number; modifiers: number; action: number; text: string },
  ): Promise<Uint8Array> {
    return (await this.input(handle, instanceId, nativeTerminalKeyOperation(input))).bytes
  }
  async selection(
    handle: string,
    instanceId: string,
    operation: import('../../shared/native-terminal-selection').NativeTerminalSelectionOperation,
    signal?: AbortSignal,
    eligible?: (signal: AbortSignal) => Promise<void>,
  ): Promise<unknown> {
    return selectionNativeTerminalProducer(
      this.producerContext(handle, instanceId),
      operation,
      signal,
      eligible,
    )
  }
  async query(
    handle: string,
    instanceId: string,
    operation: NativeTerminalQueryOperation,
    signal?: AbortSignal,
    eligible?: (signal: AbortSignal) => Promise<void>,
  ): Promise<unknown> {
    const producer = this.producerContext(handle, instanceId)
    return queryNativeTerminalProducer(producer, operation, signal, eligible)
  }
  async readProducer(handle: string, instanceId: string): Promise<Uint8Array> {
    return readNativeTerminalProducer(this.producerContext(handle, instanceId), 'read')
  }
  async drainEffectsProducer(handle: string, instanceId: string) {
    return drainNativeTerminalProducerEffects(this.producerContext(handle, instanceId))
  }
  async readLinkProducer(
    handle: string,
    instanceId: string,
    query: NativeTerminalLinkQuery,
  ) {
    return readNativeTerminalProducerLink(this.producerContext(handle, instanceId), query)
  }
  async drainReplies(handle: string, instanceId: string): Promise<Uint8Array> {
    return readNativeTerminalProducer(this.producerContext(handle, instanceId), 'drain')
  }
  async resizeProducer(
    handle: string,
    instanceId: string,
    serial: number,
    width: number,
    height: number,
    backingScale: number,
  ): Promise<NativeTerminalStatus> {
    const binding = this.requireProducer(handle, instanceId)
    return this.applyGeometry(
      binding,
      serial,
      width,
      height,
      backingScale,
      () => this.requireProducer(handle, instanceId),
      () => this.inspectProducer(handle, instanceId),
    )
  }
  /** Main-only qualification facts, separately authorized from renderer commands. */
  async rendererInfo(
    handle: string,
    instanceId: string,
  ): Promise<NativeTerminalRendererInfo> {
    const binding = this.requireProducer(handle, instanceId)
    const value = await this.process.request(
      { kind: 'renderer-info', state: binding.state },
      binding.abort.signal,
    )
    this.requireProducer(handle, instanceId)
    if (!validNativeTerminalProducerRendererInfo(value))
      throw new Error('native-renderer-info-invalid')
    const status = await this.inspectProducer(handle, instanceId)
    return {
      ...value,
      renderNode: value.renderNode ? localPath(value.renderNode) : undefined,
      frameCopies: status.frameCopies,
      lastFrame: binding.lastFrame && structuredClone(binding.lastFrame),
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
    return this.applyGeometry(
      binding,
      serial,
      width,
      height,
      backingScale,
      () => this.requireAttachment(handle, ownerId, generation, attachment),
      () => this.inspect(handle, ownerId, generation),
    )
  }
  async appearanceProducer(
    handle: string,
    instanceId: string,
    appearance: NativeTerminalAppearance,
  ): Promise<NativeTerminalStatus> {
    const binding = this.requireProducer(handle, instanceId)
    return applyNativeTerminalAppearance({
      binding,
      port: this.process,
      serial: binding.requestedAppearance + 1,
      appearance,
      current: () => {
        this.requireProducer(handle, instanceId)
      },
      inspect: () => this.inspectProducer(handle, instanceId),
    })
  }
  async appearance(
    handle: string,
    ownerId: number,
    generation: number,
    attachment: number,
    appearance: NativeTerminalAppearance,
  ): Promise<NativeTerminalStatus> {
    const binding = this.requireAttachment(handle, ownerId, generation, attachment)
    const serial = binding.requestedAppearance + 1
    return applyNativeTerminalAppearance({
      binding,
      port: this.process,
      serial,
      appearance,
      current: () => {
        this.requireAttachment(handle, ownerId, generation, attachment)
      },
      inspect: () => this.inspect(handle, ownerId, generation),
    })
  }
  private async applyGeometry(
    binding: Binding,
    serial: number,
    width: number,
    height: number,
    backingScale: number,
    assertCurrent: () => void,
    inspect: () => Promise<NativeTerminalStatus>,
  ): Promise<NativeTerminalStatus> {
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
      assertCurrent()
      if (binding.requestedGeometry !== serial)
        throw new Error('native-geometry-superseded')
      const status = await inspect()
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
  /** Success means the renderer request was enqueued, not that a frame applied it. */
  async presentationMode(
    handle: string,
    ownerId: number,
    generation: number,
    attachment: number,
    mode: NativeTerminalExportMode,
  ): Promise<void> {
    const binding = this.requireAttachment(handle, ownerId, generation, attachment)
    if (!validNativeTerminalExportMode(mode)) throw new Error('native-mode-invalid')
    const result = await this.process.request(
      { kind: 'presentation-mode', state: binding.state, mode },
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
      if (!validNativeTerminalProducerFrame(metadata))
        throw new Error('native-frame-invalid')
      const { lease: _lease, ...frameInfo } = metadata
      binding.lastFrame = structuredClone(frameInfo)
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
    let retiring: Promise<'retired' | 'actor-ended'> | undefined
    const release = (): Promise<void> => {
      if (releasing) return releasing
      releasing = (async () => {
        await this.cleanup(
          { kind: 'release', state: binding.state, lease: metadata.lease },
          binding.epoch,
          () => false,
        )
        released = true
        if (binding.retirementRelease === release) binding.retirementRelease = undefined
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
      retireProducer: () => {
        retiring ??= (async () => {
          const current = (): void => {
            if (
              this.disposed ||
              this.bindings.get(handle) !== binding ||
              released ||
              releasing ||
              !binding.frameHeld ||
              !this.process.available ||
              binding.epoch !== this.process.epoch
            )
              throw new Error('native-frame-retirement-stale')
          }
          if (this.process.hasExited?.(binding.epoch)) {
            await release()
            return 'actor-ended'
          }
          current()
          binding.retirementRelease = release
          if (binding.surfaceEnded) {
            await release()
            return 'actor-ended'
          }
          let outcome: 'retired' | 'actor-ended'
          try {
            outcome = await retireNativeTerminalProducerFrame({
              port: this.process,
              state: binding.state,
              lease: metadata.lease,
              current,
            })
          } catch (error) {
            if (!binding.surfaceEnded) throw error
            await release()
            return 'actor-ended'
          }
          await release()
          if (
            outcome === 'actor-ended' ||
            binding.nativeDestroyed ||
            this.process.hasExited?.(binding.epoch)
          )
            return 'actor-ended'
          // Cleanup may settle after a physical process exit. That is not recovery.
          if (this.requireProducer(handle, binding.session.instanceId) !== binding)
            throw new Error('native-frame-retirement-stale')
          return 'retired'
        })()
        return retiring
      },
      copyPixels: async () => {
        assertCurrent()
        const result = await this.process.request(
          { kind: 'pixels', state: binding.state, lease: metadata.lease },
          signal,
        )
        assertCurrent()
        const pixels = result as { bytes?: unknown; stride?: unknown } | undefined
        const layout = nativeTerminalPackedPixelLayout(metadata.width, metadata.height)
        if (
          !pixels ||
          !layout ||
          !(pixels.bytes instanceof Uint8Array) ||
          pixels.bytes.buffer instanceof SharedArrayBuffer ||
          typeof pixels.stride !== 'number' ||
          pixels.stride !== layout.stride ||
          pixels.bytes.byteLength !== layout.byteLength
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
      // C BUSY here follows joined surface_free; physical exit is also cleanup
      // evidence. Neither is a same-parser writer-retirement success.
      binding.surfaceEnded = true
      binding.nativeDestroyed = result === 'complete'
    })
    void binding.retiring.then(() => binding.retirementRelease?.()).catch(() => undefined)
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
  private producerContext(handle: string, instanceId: string) {
    return {
      port: this.process,
      binding: this.requireProducer(handle, instanceId),
      current: () => {
        this.requireProducer(handle, instanceId)
      },
    }
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
