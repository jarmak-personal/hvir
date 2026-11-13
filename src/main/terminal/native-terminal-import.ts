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
export interface ImportTarget {
  readonly presentation?: NativeTerminalPresentedFrame
  readonly frame: WebFrameMain
  readonly ready: boolean
  isCurrent(): boolean
}
/** Only an unsent Electron import failure can retain its source for compatibility. */
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
    if (this.outstanding >= 3) {
      await source.release()
      throw new Error('native-import-bound')
    }
    this.outstanding++
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
        this.edge.release(receipt)
        receiptReleased = true
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
      const received = this.edge.receive(ticket).then((value) => {
        receipt = value
      })
      const results = await Promise.allSettled([
        received,
        Promise.resolve().then(() => source.transfer(ticket)),
      ])
      const failed = results.find((result) => result.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
      assertCurrent(source, target)
      if (!receipt || receipt.ticket !== ticket) throw new Error('native-resource-ticket')
      const textureInfo = texture(receipt, source.metadata)
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
          .then(() => source.release())
          .then(
            () => {
              if (releaseError) rejectReleased(releaseError)
              else {
                this.outstanding--
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
        imported = this.textures.importSharedTexture({
          textureInfo,
          allReferencesReleased: finish,
        })
        importDecision = 'imported'
        if (releasePending) finish()
      } catch (error) {
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
        imported.release()
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
          try {
            await this.textures.sendSharedTexture(
              { frame: target.frame, importedSharedTexture: imported },
              presentation ?? { ...source.metadata, ticket },
            )
            state = 'sent'
            releaseMain()
          } catch (error) {
            state = 'quarantine'
            // Electron's timeout can precede late consumer acquisition without
            // recording its sync token. Neither target death nor an old callback
            // proves that late GPU work gone. Keep all owners and bounded credit
            // for this app lifetime; the parser itself remains live.
            this.quarantined.add({ source, receipt: ownedReceipt, imported })
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
        // Keep the immutable renderer lease, not a parser retirement. PTY feed
        // and readback stay live while this presentation remains unavailable.
        throw new NativeTerminalImportQuarantined(error)
      }
      try {
        releaseReceipt()
      } catch (cleanupError) {
        await source.release()
        throw cleanupError
      }
      if (error instanceof NativeTerminalGpuImportUnavailable) {
        try {
          assertCurrent(source, target)
        } catch (staleError) {
          await source.release()
          throw staleError
        }
        // No send occurred; the caller now retains the same immutable source lease.
        throw error
      }
      await source.release()
      throw error
    } finally {
      if (!transferred && !indeterminateImport) this.outstanding--
      next()
    }
  }
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
    ![1, 2].includes(receipt.origin)
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
    ![0x34325241, 0x34324241].includes(receipt.fourcc) ||
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
  const planes = receipt.planes.map((plane) => {
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
    return {
      fd: plane.fd,
      stride: plane.stride,
      offset: plane.offset,
      size: Number(plane.size),
    }
  })
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
