import { randomUUID } from 'node:crypto'
import {
  validNativeTerminalViewGrant,
  type NativeTerminalPresentedFrame,
} from '../../shared/native-terminal-presentation'
import type {
  SharedTexture,
  SharedTextureImportTextureInfo,
  WebFrameMain,
} from 'electron'
import type { Receipt } from '../../../packages/native-terminal/resource'
import type {
  NativeTerminalAcquiredFrame,
  NativeTerminalFrameMetadata,
} from './native-terminal-host'

interface ResourceReceipts {
  receive(ticket: string): Promise<Receipt>
  release(receipt: Receipt): void
}
type ImportObservationStage =
  | 'admitted'
  | 'admission-refused'
  | 'transfer-receive-settled'
  | 'receive-resolved'
  | 'receive-rejected'
  | 'transfer-resolved'
  | 'transfer-rejected'
  | 'import-enter'
  | 'import-return'
  | 'import-rejected'
  | 'send-enter'
  | 'send-resolved'
  | 'send-rejected'
  | 'main-release-enter'
  | 'main-release-return'
  | 'main-release-rejected'
  | 'references-released'
  | 'references-released-late'
  | 'references-released-duplicate'
  | 'receipt-release-enter'
  | 'receipt-release-return'
  | 'receipt-release-rejected'
  | 'producer-release-enter'
  | 'producer-release-return'
  | 'producer-release-rejected'
  | 'credit-returned'
  | 'cleanup-credit-retained'
  | 'quarantined'
type ImportObservation = ((stage: ImportObservationStage, error?: unknown) => void) & {
  readonly resource: number
}
type ImportObservationEvent = {
  schema: 1
  clock: 'main performance.now'
  timeOrigin: number
  event: number
  resource: number
  stage: ImportObservationStage
  atMs: number
  outstanding: number
  quarantined: number
  error?:
    'send-timeout-1000ms' | 'gpu-unavailable-before-import' | 'target-stale' | 'unknown'
  grant?: NativeTerminalPresentedFrame['nativeTerminal']
  nominalRgbaBytes?: number
  targetFrame?: NativeImportFrameFacts
}
export interface NativeImportFrameFacts {
  isDestroyed: boolean | null
  detached: boolean | null
  processId: number | null
  osProcessId: number | null
  routingId: number | null
  frameTreeNodeId: number | null
  frameToken: string | null
  readUnavailable: boolean
}

/** Closed scalar snapshot only. Chromium IDs and LocalFrameToken are not document authority. */
export function nativeImportFrameFacts(frame?: WebFrameMain): NativeImportFrameFacts {
  const facts: NativeImportFrameFacts = {
    isDestroyed: null,
    detached: null,
    processId: null,
    osProcessId: null,
    routingId: null,
    frameTreeNodeId: null,
    frameToken: null,
    readUnavailable: true,
  }
  if (!frame) return facts
  try {
    const value = frame.isDestroyed()
    if (typeof value !== 'boolean') return facts
    facts.isDestroyed = value
    if (value) return facts
  } catch {
    return facts
  }
  for (const key of [
    'processId',
    'osProcessId',
    'routingId',
    'frameTreeNodeId',
  ] as const) {
    try {
      const value = frame[key]
      if (Number.isSafeInteger(value) && value >= (key === 'osProcessId' ? 1 : 0))
        facts[key] = value
    } catch {
      /* An unavailable getter remains unknown. */
    }
  }
  try {
    const value = frame.detached
    if (typeof value === 'boolean') facts.detached = value
  } catch {
    /* Unknown. */
  }
  try {
    const token = frame.frameToken
    if (typeof token === 'string' && /^[a-fA-F0-9-]{1,128}$/.test(token))
      facts.frameToken = token
  } catch {
    /* Unknown, not a dead-frame identity. */
  }
  facts.readUnavailable = Object.entries(facts).some(
    ([key, value]) => key !== 'readUnavailable' && value === null,
  )
  return facts
}
interface ImportObservationState {
  resource: number
  event: number
  printed: number
  snapshots: number
  ring: ImportObservationEvent[]
}
export interface ImportTarget {
  readonly presentation?: NativeTerminalPresentedFrame
  readonly frame: WebFrameMain
  readonly ready: boolean
  isCurrent(): boolean
}
/** Only validated pre-import rejection or a proven unsent failure permits compatibility. */
export class NativeTerminalGpuImportUnavailable extends Error {
  constructor(cause: unknown) {
    super('native-gpu-import-unavailable', { cause })
  }
}
/** GPU ownership has no usable physical release proof for this app lifetime. */
export class NativeTerminalImportQuarantined extends Error {
  constructor(cause: unknown) {
    super(
      `native-import-quarantined: ${cause instanceof Error ? cause.message : 'unknown ownership'}`,
      { cause },
    )
  }
}
class UnsupportedNativeTextureFormat extends Error {}

export interface ImportedNativeFrame {
  readonly metadata: NativeTerminalFrameMetadata & { readonly ticket: string }
  send(): Promise<void>
  release(): void
  readonly released: Promise<void>
}

/** Main's short Electron import edge; parser/PTY and production pane policy stay
 * with their existing owners. An endpoint handshake completes before its successor. */
export class NativeTerminalFrameImports {
  private serial: Promise<void> = Promise.resolve()
  private outstanding = 0
  private observation?: ImportObservationState
  // An import that throws after entering Electron may conceal GPU ownership.
  // No public release handle exists: keep source/resource and credit until this
  // app process exits. Never infer GPU completion from target-frame destruction.
  private readonly quarantined = new Set<{
    source: NativeTerminalAcquiredFrame
    receipt?: Receipt
    imported?: ReturnType<SharedTexture['importSharedTexture']>
  }>()

  constructor(
    private readonly edge: ResourceReceipts,
    private readonly textures: Pick<
      SharedTexture,
      'importSharedTexture' | 'sendSharedTexture'
    >,
  ) {}

  async acquire(
    source: NativeTerminalAcquiredFrame,
    target: ImportTarget,
    options?: { readonly allowPixelFallback: true },
  ): Promise<ImportedNativeFrame> {
    let trace: ImportObservation | undefined
    if (
      typeof __HVIR_SMOKE_BUILD__ !== 'undefined' &&
      __HVIR_SMOKE_BUILD__ &&
      process.env['HVIR_NATIVE_IMPORT_DIAGNOSTICS'] === '1'
    ) {
      const state = (this.observation ??= {
        resource: 0,
        event: 0,
        printed: 0,
        snapshots: 0,
        ring: [],
      })
      trace = observeNativeImport(state, source, target, () => ({
        outstanding: this.outstanding,
        quarantined: this.quarantined.size,
      }))
    }
    const releaseSource = trace
      ? async (): Promise<void> => {
          trace?.('producer-release-enter')
          try {
            await source.release()
            trace?.('producer-release-return')
          } catch (error) {
            trace?.('producer-release-rejected', error)
            throw error
          }
        }
      : (): Promise<void> => source.release()
    if (this.outstanding >= 3) {
      trace?.('admission-refused')
      await releaseSource()
      throw new Error('native-import-bound')
    }
    this.outstanding++
    trace?.('admitted')
    const previous = this.serial
    let next!: () => void
    this.serial = new Promise<void>((resolve) => {
      next = resolve
    })
    await previous
    let receipt: Receipt | undefined
    let transferred = false
    let indeterminateImport = false
    let receiptReleased = false
    const releaseReceipt = (): void => {
      if (receipt && !receiptReleased) {
        trace?.('receipt-release-enter')
        try {
          this.edge.release(receipt)
          receiptReleased = true
          trace?.('receipt-release-return')
        } catch (error) {
          trace?.('receipt-release-rejected', error)
          throw error
        }
      }
    }
    try {
      assertCurrent(source, target)
      if (source.metadata.kind !== 1 && source.metadata.kind !== 2)
        throw new Error('native-resource-kind')
      const presentation = target.presentation
        ? {
            ...target.presentation,
            nativeTerminal: { ...target.presentation.nativeTerminal },
          }
        : undefined
      if (
        presentation &&
        (!validNativeTerminalViewGrant(presentation.nativeTerminal) ||
          presentation.nativeTerminal.geometrySerial !== source.metadata.geometrySerial ||
          presentation.nativeTerminal.width !== source.metadata.width ||
          presentation.nativeTerminal.height !== source.metadata.height ||
          presentation.origin !== source.metadata.origin ||
          presentation.colorSpace !== source.metadata.colorSpace)
      )
        throw new Error('native-import-presentation-invalid')
      const ticket = randomUUID()
      // Settle both sides even if one fails: an accepted receive may still own a
      // resource and must finish before this shared endpoint can accept another.
      const received = this.edge.receive(ticket).then(
        (value) => {
          receipt = value
          trace?.('receive-resolved')
        },
        (error: unknown) => {
          trace?.('receive-rejected', error)
          throw error
        },
      )
      const transfer = Promise.resolve().then(() => source.transfer(ticket))
      const results = await Promise.allSettled([
        received,
        trace
          ? transfer.then(
              () => {
                trace?.('transfer-resolved')
              },
              (error: unknown) => {
                trace?.('transfer-rejected', error)
                throw error
              },
            )
          : transfer,
      ])
      const failed = results.find((result) => result.status === 'rejected')
      trace?.(
        'transfer-receive-settled',
        failed?.status === 'rejected' ? failed.reason : undefined,
      )
      if (failed?.status === 'rejected') throw failed.reason
      assertCurrent(source, target)
      if (!receipt || receipt.ticket !== ticket) throw new Error('native-resource-ticket')
      let textureInfo: SharedTextureImportTextureInfo
      try {
        textureInfo = texture(receipt, source.metadata)
      } catch (error) {
        if (
          options?.allowPixelFallback &&
          error instanceof UnsupportedNativeTextureFormat
        )
          throw new NativeTerminalGpuImportUnavailable(error)
        throw error
      }
      let physical = false
      let mainReleased = false
      let state: 'unsent' | 'sending' | 'sent' | 'quarantine' = 'unsent'
      let resolveReleased!: () => void
      let rejectReleased!: (reason: unknown) => void
      const released = new Promise<void>((resolve, reject) => {
        resolveReleased = resolve
        rejectReleased = reject
      })
      void released.catch(() => undefined)
      const ownedReceipt = receipt
      let importDecision: 'pending' | 'imported' | 'discarded' = 'pending'
      let releasePending = false
      const finish = (): void => {
        if (importDecision === 'pending') {
          releasePending = true
          return
        }
        if (importDecision === 'discarded' || state === 'quarantine') return
        if (physical) return
        physical = true
        let releaseError: unknown
        try {
          releaseReceipt()
        } catch (error) {
          releaseError = error
        }
        void Promise.resolve()
          .then(() => releaseSource())
          .then(
            () => {
              if (releaseError) {
                trace?.('cleanup-credit-retained', releaseError)
                rejectReleased(releaseError)
              } else {
                this.outstanding--
                trace?.('credit-returned')
                resolveReleased()
              }
            },
            (error: unknown) => {
              // An unconfirmed producer release retains this import's credit.
              // The failed native generation must not silently reuse its pool.
              rejectReleased(error)
            },
          )
      }
      let imported: ReturnType<SharedTexture['importSharedTexture']>
      try {
        trace?.('import-enter')
        imported = this.textures.importSharedTexture({
          textureInfo,
          // Observe the external callback, not finish's internal replay after
          // a synchronous callback arrives before import returns its handle.
          allReferencesReleased: trace
            ? () => {
                trace?.(
                  state === 'quarantine'
                    ? 'references-released-late'
                    : physical
                      ? 'references-released-duplicate'
                      : 'references-released',
                )
                finish()
              }
            : finish,
        })
        importDecision = 'imported'
        trace?.('import-return')
        if (releasePending) finish()
      } catch (error) {
        trace?.('import-rejected', error)
        importDecision = 'discarded'
        // Pinned Electron rejects here before CreateSharedImage: no GPU work
        // has received this source. A general import throw is not this proof.
        const beforeGpuImport =
          error instanceof Error &&
          error.message === 'Failed to import shared texture: GPU is not available'
        if (options?.allowPixelFallback && beforeGpuImport)
          throw new NativeTerminalGpuImportUnavailable(error)
        indeterminateImport = !beforeGpuImport
        throw error
      }
      const releaseMain = (): void => {
        if (mainReleased) return
        mainReleased = true
        trace?.('main-release-enter')
        try {
          imported.release()
          trace?.('main-release-return')
        } catch (error) {
          trace?.('main-release-rejected', error)
          throw error
        }
      }
      let sendPromise: Promise<void> | undefined
      const send = (): Promise<void> => {
        if (sendPromise) return sendPromise
        sendPromise = (async () => {
          if (mainReleased) throw new Error('native-import-released')
          try {
            assertCurrent(source, target)
          } catch (error) {
            releaseMain()
            throw error
          }
          state = 'sending'
          trace?.('send-enter')
          try {
            const ordinaryMetadata = presentation ?? { ...source.metadata, ticket }
            let metadata: typeof ordinaryMetadata & {
              readonly hvirImportObservation?: number
            } = ordinaryMetadata
            if (
              typeof __HVIR_SMOKE_BUILD__ !== 'undefined' &&
              __HVIR_SMOKE_BUILD__ &&
              trace
            )
              metadata = {
                ...metadata,
                hvirImportObservation: trace.resource,
              }
            await this.textures.sendSharedTexture(
              { frame: target.frame, importedSharedTexture: imported },
              metadata,
            )
            state = 'sent'
            trace?.('send-resolved')
            releaseMain()
          } catch (error) {
            trace?.('send-rejected', error)
            state = 'quarantine'
            // Electron's timeout can precede late consumer acquisition without
            // recording its sync token. Neither target death nor an old callback
            // proves that late GPU work gone. Keep all owners and bounded credit
            // for this app lifetime; the parser itself remains live.
            this.quarantined.add({ source, receipt: ownedReceipt, imported })
            trace?.('quarantined', error)
            const unavailable = new NativeTerminalImportQuarantined(error)
            rejectReleased(unavailable)
            throw unavailable
          }
        })()
        return sendPromise
      }
      transferred = true
      return {
        metadata: { ...source.metadata, ticket },
        send,
        released,
        release: () => {
          if (state !== 'quarantine' && state !== 'sending') releaseMain()
        },
      }
    } catch (error) {
      if (indeterminateImport) {
        this.quarantined.add({ source, receipt })
        trace?.('quarantined', error)
        // Keep the immutable renderer lease, not a parser retirement. PTY feed
        // and readback stay live while this presentation remains unavailable.
        throw new NativeTerminalImportQuarantined(error)
      }
      try {
        releaseReceipt()
      } catch (cleanupError) {
        await releaseSource()
        throw cleanupError
      }
      if (error instanceof NativeTerminalGpuImportUnavailable) {
        try {
          assertCurrent(source, target)
        } catch (staleError) {
          await releaseSource()
          throw staleError
        }
        // No send occurred; the caller now retains the same immutable source lease.
        throw error
      }
      await releaseSource()
      throw error
    } finally {
      if (!transferred && !indeterminateImport) {
        this.outstanding--
        trace?.('credit-returned')
      }
      next()
    }
  }
}

/** Explicit diagnostic only; this module-local factory is referenced solely
 * inside the smoke compile guard and is removable from ordinary builds. */
function observeNativeImport(
  state: ImportObservationState,
  source: NativeTerminalAcquiredFrame,
  target: ImportTarget,
  accounting: () => { outstanding: number; quarantined: number },
): ImportObservation {
  const resource = ++state.resource
  return Object.assign(
    (stage: ImportObservationStage, error?: unknown) => {
      try {
        const current = accounting()
        const event: ImportObservationEvent = {
          schema: 1,
          clock: 'main performance.now',
          timeOrigin: performance.timeOrigin,
          event: state.event++,
          resource,
          stage,
          atMs: performance.now(),
          outstanding: current.outstanding,
          quarantined: current.quarantined,
        }
        if (!Number.isFinite(event.atMs) || !Number.isFinite(event.timeOrigin)) return
        if (
          [
            'admitted',
            'import-enter',
            'send-enter',
            'send-rejected',
            'quarantined',
          ].includes(stage)
        ) {
          let frame: WebFrameMain | undefined
          try {
            frame = target.frame
          } catch {
            /* Unknown, without probing policy. */
          }
          event.targetFrame = nativeImportFrameFacts(frame)
        }
        const grant = target.presentation?.nativeTerminal
        if (validNativeTerminalViewGrant(grant))
          event.grant = {
            viewId: grant.viewId,
            attachment: grant.attachment,
            nativeEpoch: grant.nativeEpoch,
            geometrySerial: grant.geometrySerial,
            width: grant.width,
            height: grant.height,
            backingScale: grant.backingScale,
          }
        const { width, height } = source.metadata
        if ([width, height].every((n) => Number.isInteger(n) && n > 0 && n <= 8192))
          event.nominalRgbaBytes = width * height * 4
        if (error !== undefined) {
          const message = error instanceof Error ? error.message : undefined
          event.error =
            stage === 'send-rejected' &&
            message ===
              'transfer shared texture timed out after 1000ms, ensure you have registered receiver at renderer process.'
              ? 'send-timeout-1000ms'
              : stage === 'import-rejected' &&
                  message === 'Failed to import shared texture: GPU is not available'
                ? 'gpu-unavailable-before-import'
                : message === 'native-import-target-stale'
                  ? 'target-stale'
                  : 'unknown'
        }
        state.ring[event.event % 2048] = event
        if (state.printed < 2048) {
          state.printed++
          console.log('HVIR_NATIVE_IMPORT_STAGE ' + JSON.stringify(event))
        }
        if (
          state.snapshots < 16 &&
          [
            'quarantined',
            'producer-release-rejected',
            'receipt-release-rejected',
            'references-released-late',
            'admission-refused',
            'cleanup-credit-retained',
          ].includes(stage)
        ) {
          state.snapshots++
          console.log(
            'HVIR_NATIVE_IMPORT_TAIL ' +
              JSON.stringify({
                schema: 1,
                snapshot: state.snapshots,
                clock: 'main performance.now',
                timeOrigin: performance.timeOrigin,
                truncated: state.event > 2048,
                events: state.ring.slice().sort((a, b) => a.event - b.event),
              }),
          )
        }
      } catch {
        /* Diagnostic failure cannot change ownership or cleanup. */
      }
    },
    { resource },
  )
}

function destroyed(frame: WebFrameMain): boolean {
  try {
    return frame.isDestroyed()
  } catch {
    return true
  }
}
function assertCurrent(source: NativeTerminalAcquiredFrame, target: ImportTarget): void {
  source.assertCurrent()
  if (!target.ready || !target.isCurrent() || destroyed(target.frame))
    throw new Error('native-import-target-stale')
}
function texture(
  receipt: Receipt,
  expected: NativeTerminalFrameMetadata,
): SharedTextureImportTextureInfo {
  if (
    receipt.kind !== expected.kind ||
    receipt.width !== expected.width ||
    receipt.height !== expected.height ||
    !Number.isInteger(receipt.width) ||
    receipt.width <= 0 ||
    receipt.width > 8192 ||
    !Number.isInteger(receipt.height) ||
    receipt.height <= 0 ||
    receipt.height > 8192 ||
    receipt.premultiplied !== true ||
    expected.premultiplied !== true ||
    receipt.colorSpace !== expected.colorSpace ||
    ![1, 2].includes(receipt.colorSpace) ||
    receipt.origin !== expected.origin ||
    ![1, 2].includes(receipt.origin) ||
    !expected.resource ||
    receipt.fourcc !== expected.resource.fourcc ||
    typeof receipt.modifier !== 'bigint' ||
    receipt.modifier.toString() !== expected.resource.modifier ||
    receipt.planeCount !== expected.resource.planes.length
  )
    throw new Error('native-resource-metadata')
  const common = {
    codedSize: { width: receipt.width, height: receipt.height },
    colorSpace: {
      primaries: receipt.colorSpace === 1 ? 'bt709' : 'p3',
      transfer: 'srgb',
      matrix: 'rgb',
      range: 'full',
    },
  } as const
  if (
    receipt.kind === 1 &&
    receipt.fourcc === 0x42475241 &&
    receipt.planeCount === 0 &&
    Buffer.isBuffer(receipt.surface) &&
    receipt.surface.length === 8
  )
    return { ...common, handle: { ioSurface: receipt.surface }, pixelFormat: 'bgra' }
  if (
    receipt.kind !== 2 ||
    !Number.isInteger(receipt.fourcc) ||
    receipt.fourcc < 0 ||
    receipt.fourcc > 0xffffffff ||
    !Number.isInteger(receipt.planeCount) ||
    receipt.planeCount < 1 ||
    receipt.planeCount > 4 ||
    !Array.isArray(receipt.planes) ||
    receipt.planes.length !== receipt.planeCount ||
    typeof receipt.modifier !== 'bigint' ||
    receipt.modifier < 0n ||
    receipt.modifier > 0xffffffffffffffffn
  )
    throw new Error('native-resource-format')
  const planes = receipt.planes.map((plane, index) => {
    if (
      !Number.isInteger(plane.fd) ||
      plane.fd < 0 ||
      plane.fd > 0x7fffffff ||
      !Number.isInteger(plane.stride) ||
      plane.stride <= 0 ||
      plane.stride > 0xffffffff ||
      !Number.isInteger(plane.offset) ||
      plane.offset < 0 ||
      plane.offset > 0xffffffff ||
      typeof plane.size !== 'bigint' ||
      plane.size <= 0n ||
      plane.size > BigInt(Number.MAX_SAFE_INTEGER) ||
      BigInt(plane.offset) + BigInt(plane.stride) > plane.size
    )
      throw new Error('native-resource-plane')
    const expectedPlane = expected.resource.planes[index]
    if (
      !expectedPlane ||
      expectedPlane.stride !== plane.stride ||
      expectedPlane.offset !== plane.offset ||
      BigInt(expectedPlane.size) !== plane.size
    )
      throw new Error('native-resource-metadata')
    return {
      fd: plane.fd,
      stride: plane.stride,
      offset: plane.offset,
      size: Number(plane.size),
    }
  })
  // This decision precedes Electron's GPU entry, after every received-plane check.
  // A generic import throw or an unfamiliar modifier is not the same evidence.
  if (![0x34325241, 0x34324241].includes(receipt.fourcc))
    throw new UnsupportedNativeTextureFormat('native-resource-format-unsupported')
  return {
    ...common,
    pixelFormat: receipt.fourcc === 0x34325241 ? 'bgra' : 'rgba',
    handle: {
      nativePixmap: {
        planes,
        modifier: receipt.modifier.toString(),
        supportsZeroCopyWebGpuImport: false,
      },
    },
  }
}
