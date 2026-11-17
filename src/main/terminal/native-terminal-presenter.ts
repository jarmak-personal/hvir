import {
  nativeTerminalTypographyChanged,
  type NativeTerminalAppearance,
} from '../../shared/native-terminal-appearance'
import { randomUUID } from 'node:crypto'
import type { WebFrameMain } from 'electron'
import {
  NATIVE_TERMINAL_PRESENTATION as limits,
  nativeTerminalPackedPixelLayout,
  validNativeTerminalScale,
  sameNativeTerminalView,
  type NativeTerminalCanvasRefit,
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

/** The exact CPU upload was discarded after local presentation authority withdrew.
 * This is neither a draw receipt nor a failed native state or receiver. */
export class NativeTerminalPixelLocallyIneligibleError extends Error {
  constructor() {
    super('native-pixel-locally-ineligible')
    this.name = 'NativeTerminalPixelLocallyIneligibleError'
  }
}

export interface NativeTerminalPixelReservation {
  send(frame: NativeTerminalPixelFrame): Promise<void>
  cancel(): void
}
export interface NativeTerminalPresentationTarget {
  readonly frame: WebFrameMain
  readonly ready: boolean
  isCurrent(): boolean
  onUnavailable(listener: (grant: NativeTerminalViewGrant) => void): () => void
  publishGrant(
    grant: NativeTerminalViewGrant | undefined,
    refit?: NativeTerminalCanvasRefit,
  ): void
  publishStatus(status: NativeTerminalPresentationStatus): void
  reservePixels(grant: NativeTerminalViewGrant): NativeTerminalPixelReservation
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
  producerFault?: NativeTerminalImportQuarantined
  lastPixels: number
  appearance?: NativeTerminalAppearance
  appearanceApplied?: NativeTerminalAppearance
  typographyPending?: boolean
  appearanceRevision?: number
  appearanceWork?: Promise<void>
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
  | 'geometryIssuanceFloor'
  | 'resize'
  | 'appearance'
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
  private readonly blockedHandles = new Map<
    string,
    Map<string, Set<NativeTerminalImportQuarantined>>
  >()
  constructor(
    private readonly host: PresentationHost,
    private readonly imports: Pick<NativeTerminalFrameImports, 'acquire'>,
    private readonly linuxMode?: NativeTerminalExportMode,
    private readonly resumeView?: (viewId: string) => Promise<boolean>,
  ) {}
  isInputCurrent(viewId: string): boolean {
    const view = this.views.get(viewId)
    return !!view?.grant && !view.producerFault && this.currentGrant(view, view.grant)
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
        view.serial = Math.max(
          status.geometry.serial,
          this.host.geometryIssuanceFloor(
            handle,
            session.ownerId,
            session.ownerGeneration,
            attachment,
          ),
        )
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
  /** Palette changes retain the grant; typography revokes it before native mutation. */
  async appearance(
    viewId: string,
    appearance: NativeTerminalAppearance,
  ): Promise<boolean> {
    const view = this.require(viewId)
    const geometryChanged = nativeTerminalTypographyChanged(view.appearance, appearance)
    const revision = (view.appearanceRevision ?? 0) + 1
    view.appearanceRevision = revision
    view.appearance = appearance
    try {
      if (geometryChanged) {
        view.typographyPending = true
        view.revision++
        view.grant = undefined
        const refit = this.visibleRefit(view, true)
        if (refit) view.target.publishGrant(undefined, refit)
        else view.target.publishGrant(undefined)
      }
      await this.applyAppearance(view)
      this.assertCurrent(view)
      if (view.appearanceRevision !== revision)
        throw new Error('native-appearance-superseded')
      return view.typographyPending === true
    } catch (error) {
      if (
        !view.closed &&
        this.views.get(view.id) === view &&
        view.appearanceRevision === revision
      )
        await this.unavailable(view, 'native-lost')
      throw error
    }
  }
  private applyAppearance(view: View): Promise<void> {
    if (view.appearanceWork) return view.appearanceWork
    if (!view.appearance || view.appearance === view.appearanceApplied)
      return Promise.resolve()
    const applying = (async () => {
      while (view.appearance && view.appearance !== view.appearanceApplied) {
        this.assertCurrent(view)
        const appearance = view.appearance
        await this.host.appearance(
          view.handle,
          view.session.ownerId,
          view.session.ownerGeneration,
          view.attachment,
          appearance,
        )
        this.assertCurrent(view)
        view.appearanceApplied = appearance
      }
    })()
    const work: Promise<void> = applying.then(
      () => {
        if (view.appearanceWork === work) view.appearanceWork = undefined
        if (!view.closed && view.appearance !== view.appearanceApplied)
          return this.applyAppearance(view)
      },
      (error: unknown) => {
        if (view.appearanceWork === work) view.appearanceWork = undefined
        throw error
      },
    )
    view.appearanceWork = work
    return work
  }
  /** Withdraw logical presentation immediately; physical input cleanup keeps its lifetime. */
  withdraw(viewId: string): void {
    const view = this.views.get(viewId)
    if (!view || view.closed) return
    view.revision++
    view.visible = false
    view.desired = undefined
    view.pixelDeadline = undefined
    view.grant = undefined
    view.target.publishGrant(undefined)
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
    const refit = this.visibleRefit(view, layout.visible)
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
    try {
      if (refit) view.target.publishGrant(undefined, refit)
      else view.target.publishGrant(undefined)
    } catch (error) {
      view.desired = undefined
      const failure =
        error instanceof Error
          ? error
          : new Error('native-refit-revocation-failed', { cause: error })
      return this.unavailable(view, 'geometry-failed').then(() => {
        throw failure
      })
    }
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
        if (view.appearanceWork) await view.appearanceWork
        this.assertCurrent(view)
        if (view.revision !== desired.revision) continue
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
        view.typographyPending = false
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
        await this.unavailable(view, 'geometry-failed')
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
    let pixelsReservation: NativeTerminalPixelReservation | undefined
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
        screen: source.metadata.screen,
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
          if (this.currentGrant(view, grant) && !this.isBlocked(view)) {
            view.producerFault = undefined
            this.status(view, 'native-gpu')
          }
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
      // Reserve one of the existing three uploads before allocating a copy.
      pixelsReservation = view.target.reservePixels(grant)
      const pixels = await source.copyPixels()
      this.assertGrant(view, grant)
      source.assertCurrent()
      const layout = nativeTerminalPackedPixelLayout(grant.width, grant.height)
      if (
        !layout ||
        pixels.stride !== layout.stride ||
        pixels.bytes.byteLength !== layout.byteLength ||
        pixels.bytes.buffer instanceof SharedArrayBuffer
      )
        throw new Error('native-pixel-bound')
      view.lastPixels = performance.now()
      await pixelsReservation.send({
        ...presentation,
        ...pixels,
        origin: 1,
        premultiplied: false,
      })
      if (this.currentGrant(view, grant) && !this.isBlocked(view)) {
        view.producerFault = undefined
        this.status(view, 'native-pixels', 'import-unavailable')
      }
      return true
    } catch (error) {
      if (error instanceof NativeTerminalPixelLocallyIneligibleError) return false
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
        if (!epochs)
          this.blockedHandles.set(
            view.handle,
            (epochs = new Map<string, Set<NativeTerminalImportQuarantined>>()),
          )
        let faults = epochs.get(view.epoch)
        if (!faults)
          epochs.set(view.epoch, (faults = new Set<NativeTerminalImportQuarantined>()))
        faults.add(error)
        // The failure can settle after this view detached. Block every CURRENT
        // view of that exact retained state/generation before further demand.
        const affected = [...this.views.values()].filter(
          (current) => current.handle === view.handle && current.epoch === view.epoch,
        )
        await Promise.all(
          affected.map((current) =>
            this.unavailable(current, 'import-unavailable', error),
          ),
        )
        // This continuation must not be awaited by the active task it joins.
        void this.recoverProducer(view.handle, view.epoch, error, view.active).catch(
          () => undefined,
        )
      } else if (this.currentGrant(view, grant)) {
        view.producerFault = undefined
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
      try {
        pixelsReservation?.cancel()
      } finally {
        if (source && ownsSource) await source.release()
      }
    }
  }
  private assertPixelBound(grant: NativeTerminalViewGrant): void {
    if (
      !validNativeTerminalExtent(grant.width, grant.height) ||
      !nativeTerminalPackedPixelLayout(grant.width, grant.height)
    )
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
    return !!this.blockedHandles.get(view.handle)?.get(view.epoch)?.size
  }
  private async recoverProducer(
    handle: string,
    epoch: string,
    fault: NativeTerminalImportQuarantined,
    active: Promise<boolean> | undefined,
  ): Promise<void> {
    await active?.catch(() => undefined)
    const resumeView = this.resumeView
    if (!resumeView || !fault.retireProducer || !(await fault.retireProducer())) return
    const epochs = this.blockedHandles.get(handle)
    const faults = epochs?.get(epoch)
    if (!faults?.delete(fault) || faults.size) return
    epochs!.delete(epoch)
    if (!epochs!.size) this.blockedHandles.delete(handle)
    for (const view of [...this.views.values()]) {
      if (view.handle !== handle || view.epoch !== epoch || !view.producerFault) continue
      const reason = view.producerFault
      const current = (): boolean => {
        try {
          this.assertCurrent(view)
          return (
            view.visible &&
            !!view.layout?.visible &&
            view.producerFault === reason &&
            !this.isBlocked(view)
          )
        } catch {
          return false
        }
      }
      if (!current()) continue
      try {
        await view.active?.catch(() => undefined)
        if (!current()) continue
        if (!(await resumeView(view.id))) continue
        if (!current()) continue
        const deadline = Date.now() + NATIVE_TERMINAL_LIMITS.requestMs
        while (current()) {
          const drawn = await this.demand(view.id)
          if (!current()) break
          if (drawn) break
          if (Date.now() >= deadline)
            throw new Error('native-presentation-recovery-timeout')
          await new Promise<void>((resolve) => setTimeout(resolve, 16))
        }
      } catch {
        if (current()) await this.unavailable(view, 'import-unavailable')
      }
    }
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
    producerFault?: NativeTerminalImportQuarantined,
  ): Promise<void> {
    view.producerFault = producerFault
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
  private visibleRefit(
    view: View,
    visible: boolean,
  ): NativeTerminalCanvasRefit | undefined {
    if (!view.visible || !visible || view.failed || this.isBlocked(view)) return
    return { attachment: view.attachment, nativeEpoch: view.epoch }
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
