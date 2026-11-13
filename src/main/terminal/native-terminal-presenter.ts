import { randomUUID } from 'node:crypto'
import type { WebFrameMain } from 'electron'
import {
  NATIVE_TERMINAL_PRESENTATION as limits,
  validNativeTerminalScale,
  sameNativeTerminalView,
  type NativeTerminalPixelFrame,
  type NativeTerminalPresentationStatus,
  type NativeTerminalViewGrant,
} from '../../shared/native-terminal-presentation'
import {
  NativeTerminalAdmissionError,
  validNativeTerminalExtent,
  type NativeTerminalSession,
} from '../../shared/native-terminal'
import type { NativeTerminalHost } from './native-terminal-host'
import type { NativeTerminalExportMode } from '../../shared/native-terminal-linux'
import { NATIVE_TERMINAL_LIMITS } from '../../shared/native-terminal'
import {
  NativeTerminalGpuImportUnavailable,
  NativeTerminalImportQuarantined,
  type NativeTerminalFrameImports,
} from './native-terminal-import'

export interface NativeTerminalPresentationTarget {
  readonly frame: WebFrameMain
  readonly ready: boolean
  isCurrent(): boolean
  onUnavailable(listener: (grant: NativeTerminalViewGrant) => void): () => void
  publishGrant(grant: NativeTerminalViewGrant | undefined): void
  publishStatus(status: NativeTerminalPresentationStatus): void
  sendPixels(frame: NativeTerminalPixelFrame): Promise<void>
}
interface Layout {
  width: number
  height: number
  backingScale: number
  visible: boolean
}
interface View {
  id: string
  handle: string
  session: NativeTerminalSession
  target: NativeTerminalPresentationTarget
  attachment: number
  epoch: string
  serial: number
  revision: number
  closed: boolean
  visible: boolean
  pixelMode: boolean
  pixelsRequested: boolean
  pixelsApplied: boolean
  pixelDeadline?: number
  failed: boolean
  lastPixels: number
  layout?: Layout
  desired?: Layout & { serial: number; revision: number }
  grant?: NativeTerminalViewGrant
  active?: Promise<boolean>
  updating?: Promise<NativeTerminalViewGrant | undefined>
  abort: AbortController
  unbindUnavailable?: () => void
}
type PresentationHost = Pick<
  NativeTerminalHost,
  | 'attach'
  | 'detach'
  | 'inspect'
  | 'nativeEpoch'
  | 'resize'
  | 'setVisible'
  | 'takeFrame'
  | 'presentationMode'
>

/** One app-owned presenter shares the existing host and import limit. Renderer
 * requests name an existing main grant; they cannot create terminal authority. */
export class NativeTerminalPresenter {
  private readonly views = new Map<string, View>()
  private readonly preparing = new Set<string>()
  private readonly detaching = new Map<string, Promise<void>>()
  // Each blocked handle still owns one of the shared importer's three credits.
  private readonly blockedHandles = new Map<string, Set<string>>()
  constructor(
    private readonly host: PresentationHost,
    private readonly imports: Pick<NativeTerminalFrameImports, 'acquire'>,
    private readonly linuxMode?: NativeTerminalExportMode,
  ) {}
  isInputCurrent(viewId: string): boolean {
    const view = this.views.get(viewId)
    return !!view?.grant && this.currentGrant(view, view.grant)
  }
  /** Producer failure revokes presentation without inventing a second parser. */
  async suspend(viewId: string): Promise<void> {
    const view = this.views.get(viewId)
    if (view && !view.closed) await this.unavailable(view, 'native-lost')
  }
  async attach(
    handle: string,
    session: NativeTerminalSession,
    target: NativeTerminalPresentationTarget,
  ): Promise<string> {
    if (!target.ready || !target.isCurrent() || target.frame.isDestroyed())
      throw new Error('native-presentation-target-stale')
    if (this.preparing.has(handle)) throw new Error('native-presentation-bound')
    const replacing = [...this.views.values()].some((view) => view.handle === handle)
    if (this.views.size + this.preparing.size - Number(replacing) >= limits.maximumViews)
      throw new Error('native-presentation-bound')
    this.preparing.add(handle)
    try {
      await this.detaching.get(handle)
      for (const old of [...this.views.values()]) {
        if (old.handle === handle) await this.detach(old.id)
      }
      if (!target.ready || !target.isCurrent() || target.frame.isDestroyed())
        throw new Error('native-presentation-target-stale')
      const attachment = this.host.attach(handle, session)
      const view: View = {
        id: randomUUID(),
        handle,
        session,
        target,
        attachment,
        epoch: this.host.nativeEpoch(
          handle,
          session.ownerId,
          session.ownerGeneration,
          attachment,
        ),
        serial: 0,
        revision: 0,
        closed: false,
        visible: false,
        pixelMode: this.linuxMode === 'pixels',
        pixelsRequested: this.linuxMode === 'pixels',
        pixelsApplied: false,
        failed: false,
        lastPixels: -Infinity,
        abort: new AbortController(),
      }
      view.failed = this.isBlocked(view)
      this.views.set(view.id, view)
      try {
        view.unbindUnavailable = target.onUnavailable((grant) =>
          this.receiverUnavailable(view, grant),
        )
        const status = await this.host.inspect(
          handle,
          session.ownerId,
          session.ownerGeneration,
        )
        this.assertCurrent(view)
        view.serial = status.geometry.serial
        if (this.linuxMode && !view.failed) {
          await this.host.presentationMode(
            handle,
            session.ownerId,
            session.ownerGeneration,
            attachment,
            this.linuxMode,
          )
          this.assertCurrent(view)
        }
        await this.host.setVisible(
          handle,
          session.ownerId,
          session.ownerGeneration,
          attachment,
          false,
        )
        this.assertCurrent(view)
        return view.id
      } catch (error) {
        await this.detach(view.id)
        throw error
      }
    } finally {
      this.preparing.delete(handle)
    }
  }
  update(viewId: string, layout: Layout): Promise<NativeTerminalViewGrant | undefined> {
    const view = this.require(viewId)
    const width = Math.round(layout.width * layout.backingScale)
    const height = Math.round(layout.height * layout.backingScale)
    if (
      !Number.isFinite(layout.width) ||
      !Number.isFinite(layout.height) ||
      !validNativeTerminalScale(layout.backingScale) ||
      !validNativeTerminalExtent(width, height) ||
      typeof layout.visible !== 'boolean'
    )
      throw new Error('native-presentation-geometry-invalid')
    const serial = view.serial + 1
    if (!Number.isSafeInteger(serial)) throw new Error('native-presentation-serial-bound')
    view.serial = serial
    if (!this.isBlocked(view)) view.failed = false
    view.revision++
    view.pixelDeadline = undefined
    view.visible = layout.visible
    view.layout = { ...layout }
    view.desired = { ...layout, serial, revision: view.revision }
    view.grant = undefined
    view.target.publishGrant(undefined)
    if (view.updating) return view.updating
    const work = this.apply(view)
    view.updating = work
    void work
      .finally(() => {
        if (view.updating === work) view.updating = undefined
      })
      .catch(() => undefined)
    return work
  }
  demand(viewId: string): Promise<boolean> {
    const known = this.views.get(viewId)
    if (known && (known.failed || this.isBlocked(known))) return Promise.resolve(false)
    const view = this.require(viewId)
    if (!view.visible || !view.grant || view.updating) return Promise.resolve(false)
    if (view.active) return view.active
    if (view.failed) return Promise.reject(new Error('native-presentation-unavailable'))
    if (
      view.pixelMode &&
      performance.now() - view.lastPixels < limits.compatibilityIntervalMs
    )
      return Promise.resolve(false)
    const work = this.present(view)
    view.active = work
    void work
      .finally(() => {
        if (view.active === work) view.active = undefined
      })
      .catch(() => undefined)
    return work
  }
  detach(viewId: string): Promise<void> {
    const view = this.views.get(viewId)
    if (!view) return Promise.resolve()
    view.closed = true
    view.pixelDeadline = undefined
    view.visible = false
    view.grant = undefined
    view.abort.abort()
    try {
      view.unbindUnavailable?.()
    } catch {
      /* Unbinding cannot prevent native cleanup. */
    }
    view.unbindUnavailable = undefined
    this.views.delete(viewId)
    try {
      view.target.publishGrant(undefined)
    } catch {
      /* Local revocation does not depend on a surviving receiver. */
    }
    const work = (async () => {
      let failure: unknown
      try {
        await this.host.setVisible(
          view.handle,
          view.session.ownerId,
          view.session.ownerGeneration,
          view.attachment,
          false,
        )
      } catch (error) {
        if (!revoked(error)) failure = error
      } finally {
        // Never detach native authority before its exact old-attachment hide.
        // Replacement attach waits this bounded operation, not GPU consumers.
        try {
          this.host.detach(
            view.handle,
            view.session.ownerId,
            view.session.ownerGeneration,
            view.attachment,
          )
        } catch (error) {
          if (!revoked(error)) failure ??= error
        }
      }
      if (failure)
        throw failure instanceof Error
          ? failure
          : new Error('native-presentation-hide-failed', { cause: failure })
    })()
    this.detaching.set(view.handle, work)
    void work
      .finally(() => {
        if (this.detaching.get(view.handle) === work) this.detaching.delete(view.handle)
      })
      .catch(() => undefined)
    return work
  }
  private async apply(view: View): Promise<NativeTerminalViewGrant | undefined> {
    while (view.desired && !view.closed) {
      const desired = view.desired
      view.desired = undefined
      try {
        this.assertCurrent(view)
        const status = await this.host.resize(
          view.handle,
          view.session.ownerId,
          view.session.ownerGeneration,
          view.attachment,
          desired.serial,
          Math.round(desired.width * desired.backingScale),
          Math.round(desired.height * desired.backingScale),
          desired.backingScale,
        )
        if (view.revision !== desired.revision) continue
        this.assertCurrent(view)
        await this.host.setVisible(
          view.handle,
          view.session.ownerId,
          view.session.ownerGeneration,
          view.attachment,
          desired.visible && !view.failed,
        )
        if (view.revision !== desired.revision) continue
        this.assertCurrent(view)
        if (Math.abs(status.geometry.backingScale - desired.backingScale) > 0.00001)
          throw new Error('native-scale-unacknowledged')
        if (this.isBlocked(view)) view.failed = true
        if (desired.visible && !view.failed) {
          view.grant = Object.freeze({
            viewId: view.id,
            attachment: view.attachment,
            nativeEpoch: view.epoch,
            geometrySerial: status.geometry.serial,
            width: status.geometry.width,
            height: status.geometry.height,
            backingScale: status.geometry.backingScale,
          })
          view.target.publishGrant(view.grant)
        } else if (desired.visible && view.failed) {
          this.status(view, 'unavailable', 'import-unavailable')
        }
      } catch (error) {
        if (view.closed) return undefined
        if (view.revision !== desired.revision) continue
        this.status(view, 'unavailable', 'geometry-failed')
        throw error
      }
    }
    return view.grant
  }
  private async present(view: View): Promise<boolean> {
    const grant = view.grant!
    const revision = view.revision
    let source: Awaited<ReturnType<PresentationHost['takeFrame']>>
    let handedOff = false
    let ownsSource = true
    try {
      this.assertGrant(view, grant)
      if (view.pixelMode) this.assertPixelBound(grant)
      if (view.pixelMode && !view.pixelsApplied && !view.pixelDeadline)
        view.pixelDeadline = Date.now() + NATIVE_TERMINAL_LIMITS.requestMs
      source = await this.host.takeFrame(
        view.handle,
        view.session.ownerId,
        view.session.ownerGeneration,
        view.attachment,
        view.abort.signal,
      )
      if (!source) {
        this.assertPixelDeadline(view)
        return false
      }
      this.assertGrant(view, grant)
      source.assertCurrent()
      if (
        source.metadata.geometrySerial !== grant.geometrySerial ||
        source.metadata.width !== grant.width ||
        source.metadata.height !== grant.height ||
        !source.metadata.premultiplied
      )
        throw new Error('native-presentation-frame-stale')
      const presentation = {
        nativeTerminal: grant,
        origin: source.metadata.origin,
        colorSpace: source.metadata.colorSpace,
      }
      if (source.metadata.kind === 2 && view.pixelMode) {
        this.assertPixelDeadline(view)
        return false // The enqueued mode is not an applied-frame acknowledgement.
      }
      if (!view.pixelMode && source.metadata.kind !== 3) {
        try {
          ownsSource = false
          const imported = await this.imports.acquire(
            source,
            {
              frame: view.target.frame,
              ready: view.target.ready,
              presentation,
              isCurrent: () => this.currentGrant(view, grant),
            },
            { allowPixelFallback: true },
          )
          handedOff = true
          try {
            await imported.send()
          } catch (error) {
            imported.release()
            // The import owner retains physical credit/quarantine until its real
            // fences settle. Local view revocation cannot fabricate their release.
            void imported.released.catch(() => undefined)
            throw error
          }
          imported.release()
          await imported.released
          if (this.currentGrant(view, grant)) this.status(view, 'native-gpu')
          return true
        } catch (error) {
          if (!(error instanceof NativeTerminalGpuImportUnavailable) || handedOff)
            throw error
          ownsSource = true
          this.assertGrant(view, grant)
          source.assertCurrent()
          this.assertPixelBound(grant)
          if (source.metadata.kind === 2) {
            await this.selectPixels(view, grant)
            return false // Release the old DMA lease before requesting a new kind3 frame.
          }
          view.pixelMode = true
        }
      }
      this.assertPixelBound(grant)
      if (source.metadata.kind === 3 && !view.pixelsRequested) {
        await this.selectPixels(view, grant)
        return false
      }
      view.pixelMode = true
      view.pixelsApplied = true
      view.pixelDeadline = undefined
      const pixels = await source.copyPixels()
      this.assertGrant(view, grant)
      source.assertCurrent()
      if (pixels.bytes.byteLength > limits.maximumPixelBytes)
        throw new Error('native-pixel-bound')
      view.lastPixels = performance.now()
      await view.target.sendPixels({
        ...presentation,
        ...pixels,
        origin: 1,
        premultiplied: false,
      })
      if (this.currentGrant(view, grant))
        this.status(view, 'native-pixels', 'import-unavailable')
      return true
    } catch (error) {
      if (
        error instanceof NativeTerminalAdmissionError ||
        (error instanceof Error && error.message === 'native-frame-bound')
      )
        return false
      if (
        view.revision !== revision &&
        error instanceof Error &&
        [
          'native-frame-stale',
          'native-presentation-grant-stale',
          'native-import-target-stale',
        ].includes(error.message)
      )
        return false
      if (error instanceof NativeTerminalImportQuarantined) {
        let epochs = this.blockedHandles.get(view.handle)
        if (!epochs) this.blockedHandles.set(view.handle, (epochs = new Set()))
        epochs.add(view.epoch)
        // The failure can settle after this view detached. Block every CURRENT
        // view of that exact retained state/generation before further demand.
        const affected = [...this.views.values()].filter(
          (current) => current.handle === view.handle && current.epoch === view.epoch,
        )
        await Promise.all(
          affected.map((current) => this.unavailable(current, 'import-unavailable')),
        )
      } else if (this.currentGrant(view, grant)) {
        view.failed = true
        view.grant = undefined
        try {
          view.target.publishGrant(undefined)
        } catch {
          /* Local revocation is authoritative. */
        }
        this.status(
          view,
          'unavailable',
          error instanceof Error && error.message === 'native-pixel-bound'
            ? 'pixel-bound'
            : 'native-lost',
        )
        await this.occlude(view)
      }
      if (!view.closed) throw error
      return false
    } finally {
      if (source && ownsSource) await source.release()
    }
  }
  private assertPixelBound(grant: NativeTerminalViewGrant): void {
    if (grant.width * grant.height * 4 > limits.maximumPixelBytes)
      throw new Error('native-pixel-bound')
  }
  private assertPixelDeadline(view: View): void {
    if (view.pixelDeadline && Date.now() >= view.pixelDeadline)
      throw new Error('native-presentation-unavailable')
  }
  private async selectPixels(view: View, grant: NativeTerminalViewGrant): Promise<void> {
    this.assertGrant(view, grant)
    await this.host.presentationMode(
      view.handle,
      view.session.ownerId,
      view.session.ownerGeneration,
      view.attachment,
      'pixels',
    )
    this.assertGrant(view, grant)
    view.pixelsRequested = true
    view.pixelsApplied = false
    view.pixelMode = true
    view.pixelDeadline = Date.now() + NATIVE_TERMINAL_LIMITS.requestMs
  }
  private isBlocked(view: Pick<View, 'handle' | 'epoch'>): boolean {
    return this.blockedHandles.get(view.handle)?.has(view.epoch) ?? false
  }
  private receiverUnavailable(view: View, grant: NativeTerminalViewGrant): void {
    // Target has already latched isCurrent=false. The issued grant, not renewed
    // renderer authority, qualifies this cleanup notification.
    if (
      view.closed ||
      this.views.get(view.id) !== view ||
      !view.grant ||
      !sameNativeTerminalView(view.grant, grant)
    )
      return
    void this.unavailable(view, 'renderer-lost')
  }
  private async unavailable(
    view: View,
    reason: NativeTerminalPresentationStatus['reason'],
  ): Promise<void> {
    view.failed = true
    view.grant = undefined
    try {
      view.target.publishGrant(undefined)
    } catch {
      /* Local revocation is authoritative. */
    }
    try {
      this.status(view, 'unavailable', reason)
    } catch {
      /* A lost receiver cannot prevent hide cleanup. */
    }
    await this.occlude(view)
  }
  private status(
    view: View,
    mode: NativeTerminalPresentationStatus['mode'],
    reason?: NativeTerminalPresentationStatus['reason'],
  ): void {
    if (!view.closed)
      view.target.publishStatus({ viewId: view.id, mode, ...(reason ? { reason } : {}) })
  }
  private async occlude(view: View): Promise<void> {
    try {
      await this.host.setVisible(
        view.handle,
        view.session.ownerId,
        view.session.ownerGeneration,
        view.attachment,
        false,
      )
    } catch {
      // A revoked attachment or unavailable native host cannot regain drawing
      // authority. Notification failure never proves a physical lease released.
    }
  }
  private require(id: string): View {
    const view = this.views.get(id)
    if (!view) throw new Error('native-presentation-view-stale')
    this.assertCurrent(view)
    return view
  }
  private assertCurrent(view: View): void {
    if (
      view.closed ||
      this.views.get(view.id) !== view ||
      !view.target.ready ||
      !view.target.isCurrent() ||
      view.target.frame.isDestroyed() ||
      this.host.nativeEpoch(
        view.handle,
        view.session.ownerId,
        view.session.ownerGeneration,
        view.attachment,
      ) !== view.epoch
    )
      throw new Error('native-presentation-view-stale')
  }
  private currentGrant(view: View, grant: NativeTerminalViewGrant): boolean {
    try {
      this.assertGrant(view, grant)
      return true
    } catch {
      return false
    }
  }
  private assertGrant(view: View, grant: NativeTerminalViewGrant): void {
    this.assertCurrent(view)
    if (!view.visible || view.grant !== grant)
      throw new Error('native-presentation-grant-stale')
  }
}

function revoked(error: unknown): boolean {
  return (
    error instanceof Error &&
    [
      'native-session-revoked',
      'native-state-foreign',
      'native-attachment-stale',
      'native-host-lost',
      'native-host-closed',
    ].includes(error.message)
  )
}
