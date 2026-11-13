import { randomUUID } from 'node:crypto'
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
interface ImportTarget {
  readonly frame: WebFrameMain
  readonly ready: boolean
  isCurrent(): boolean
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
    try {
      assertCurrent(source, target)
      if (source.metadata.kind !== 1 && source.metadata.kind !== 2)
        throw new Error('native-resource-kind')
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
      let retired = false
      let physical = false
      let mainReleased = false
      let state: 'unsent' | 'sending' | 'sent' | 'quarantine' = 'unsent'
      let polling: ReturnType<typeof setInterval> | undefined
      let resolveReleased!: () => void
      let rejectReleased!: (reason: unknown) => void
      const released = new Promise<void>((resolve, reject) => {
        resolveReleased = resolve
        rejectReleased = reject
      })
      void released.catch(() => undefined)
      const owned = receipt
      const finish = (): void => {
        if (physical) return
        physical = true
        if (polling) clearInterval(polling)
        let releaseError: unknown
        try {
          this.edge.release(owned)
        } catch (error) {
          releaseError = error
        }
        void Promise.resolve()
          .then(() => source.release())
          .then(
            () => {
              this.outstanding--
              if (releaseError) rejectReleased(releaseError)
              else resolveReleased()
            },
            (error: unknown) => {
              this.outstanding--
              rejectReleased(error)
            },
          )
      }
      const imported = this.textures.importSharedTexture({
        textureInfo,
        allReferencesReleased: finish,
      })
      const releaseMain = (): void => {
        if (mainReleased) return
        mainReleased = true
        imported.release()
      }
      const releaseQuarantine = (): void => {
        if (retired && destroyed(target.frame)) {
          if (polling) {
            clearInterval(polling)
            polling = undefined
          }
          releaseMain()
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
          try {
            await this.textures.sendSharedTexture(
              { frame: target.frame, importedSharedTexture: imported },
              { ...source.metadata, ticket },
            )
            state = 'sent'
            releaseMain()
          } catch (error) {
            state = 'quarantine'
            // A timed-out transfer can still materialize a late consumer. Stop
            // source reuse now; logical release never proves that consumer gone.
            let retirement: Promise<void>
            try {
              retirement = source.retire()
            } catch (error) {
              retirement = Promise.reject(
                error instanceof Error
                  ? error
                  : new Error('native-source-retirement-failed'),
              )
            }
            polling = setInterval(releaseQuarantine, 50)
            polling.unref()
            void retirement.then(() => {
              retired = true
              releaseQuarantine()
            }, rejectReleased)
            throw error
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
          if (state === 'quarantine') releaseQuarantine()
          else if (state !== 'sending') releaseMain()
        },
      }
    } catch (error) {
      try {
        if (receipt) this.edge.release(receipt)
      } finally {
        await source.release()
      }
      throw error
    } finally {
      if (!transferred) this.outstanding--
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
