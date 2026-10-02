import { join } from 'node:path'
import {
  app,
  session,
  webContents,
  type Session,
  type WebContents,
  type BrowserWindow,
} from 'electron'
import { EXTENSION_LIMITS, type ExtensionReply } from '../../shared/extensions/contract'
import type { ExtensionView } from '../../shared/extensions/workbench'
import type { RendererOwner } from '../renderer-resource-scopes'
import type { ExtensionGuestOwner, ExtensionGuestSurfacePort } from './guest-owner'
import type { ExtensionRevision } from './package-store'
import { ExtensionGuestLifecycle } from './guest-lifecycle'

export const EXTENSION_GUEST_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; media-src 'self'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

interface SurfaceRecord {
  readonly view: ExtensionView
  readonly session: Session
  readonly revision: ExtensionRevision
  readonly denyDownload: (event: Electron.Event) => void
  readonly engineReady: Promise<void>
  readonly settleEngine: (error?: Error) => void
  readonly revoked: Promise<never>
  readonly revoke: () => void
  guest?: WebContents
  visible: boolean
  admittedWork: boolean
  owner?: RendererOwner
  lifecycle?: ExtensionGuestLifecycle
  presentation?: Extract<ExtensionReply, { kind: 'presentation' }>
}

/** Replaceable Electron webview edge. Sessions and URLs are never borrowed from loopback panes. */
export class ElectronExtensionGuestSurface implements ExtensionGuestSurfacePort {
  private readonly surfaces = new Map<string, SurfaceRecord>()
  private readonly partitions = new WeakMap<Session, string>()
  private readonly cleanups = new Map<string, Promise<void>>()
  private owner?: ExtensionGuestOwner

  static configureEngine(): void {
    // Chromium 150 requires its browser-side origin-trial override; enabling
    // only Blink does not activate policy-container enforcement.
    const features = new Set(
      app.commandLine.getSwitchValue('enable-features').split(',').filter(Boolean),
    )
    features.add('ConnectionAllowlists')
    features.add('OverrideConnectionAllowlistOriginTrial')
    app.commandLine.appendSwitch('enable-features', [...features].join(','))
  }

  static readonly privilegedScheme: Electron.CustomScheme = {
    scheme: 'hvir-extension',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  }

  connect(owner: ExtensionGuestOwner): void {
    this.owner = owner
  }

  prepare(view: ExtensionView, revision: ExtensionRevision): Promise<void> {
    if (this.surfaces.size + this.cleanups.size >= EXTENSION_LIMITS.views)
      return Promise.reject(
        new Error(
          'Extension views are still closing or cleanup failed. If this continues, restart hvir.',
        ),
      )
    const guestSession = session.fromPartition(view.partition, { cache: false })
    const denyDownload = (event: Electron.Event): void => event.preventDefault()
    let settleEngine!: SurfaceRecord['settleEngine']
    const engineReady = new Promise<void>((resolve, reject) => {
      settleEngine = (error) => (error ? reject(error) : resolve())
    })
    void engineReady.catch(() => undefined)
    let revoke!: () => void
    const revoked = new Promise<never>((_resolve, reject) => {
      revoke = () => reject(new Error('Extension view was closed'))
    })
    void revoked.catch(() => undefined)
    const record: SurfaceRecord = {
      view,
      session: guestSession,
      revision,
      denyDownload,
      engineReady,
      settleEngine,
      revoked,
      revoke,
      visible: false,
      admittedWork: false,
    }
    this.surfaces.set(view.id, record)
    this.partitions.set(guestSession, view.partition)
    guestSession.setPermissionCheckHandler(() => false)
    guestSession.setPermissionRequestHandler((_contents, _permission, callback) =>
      callback(false),
    )
    guestSession.setDevicePermissionHandler(() => false)
    guestSession.setDisplayMediaRequestHandler((_request, callback) => callback({}))
    guestSession.on('will-download', denyDownload)
    guestSession.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: !this.assetName(record, details.url) })
    })
    guestSession.protocol.handle('hvir-extension', async (request) => {
      const name = this.assetName(record, request.url)
      const bytes = name && record.revision.files.get(name)
      if (!bytes || request.method !== 'GET') return new Response(null, { status: 404 })
      try {
        await record.engineReady
      } catch {
        return new Response(null, { status: 404 })
      }
      if (
        this.surfaces.get(view.id) !== record ||
        !record.guest ||
        record.guest.isDestroyed()
      )
        return new Response(null, { status: 404 })
      return new Response(new Uint8Array(bytes), {
        headers: {
          'Content-Type': contentType(name),
          'Content-Security-Policy': EXTENSION_GUEST_CSP,
          'Connection-Allowlist': '(response-origin);webrtc=block',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'no-referrer',
          'Permissions-Policy':
            'camera=(), microphone=(), geolocation=(), display-capture=(), usb=(), serial=(), bluetooth=()',
        },
      })
    })
    return Promise.resolve()
  }

  /** Invoked only by the workbench window attachment adapter with main-derived provenance. */
  claim(
    owner: RendererOwner,
    preferences: Electron.WebPreferences,
    params: Record<string, string>,
  ): boolean {
    const view = this.owner?.claim(
      owner,
      params['partition'] ?? '',
      params['src'] ?? '',
      params['name'] || (params['partition'] ?? '').slice('hvir-extension-'.length),
    )
    if (!view) return false
    // The renderer cannot select a different preload or widen preferences.
    delete preferences.preload
    Object.assign(preferences, {
      preload: join(app.getAppPath(), 'out/preload/extension-guest.js'),
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      devTools: false,
      webviewTag: false,
      safeDialogs: true,
      disableDialogs: true,
      navigateOnDragDrop: false,
      backgroundThrottling: true,
    })
    const record = this.surfaces.get(view.id)
    if (record) record.owner = owner
    params['src'] = view.url
    params['partition'] = view.partition
    return true
  }

  attached(
    owner: RendererOwner,
    guest: WebContents,
    reserveKeys: (close: () => void) => void,
  ): boolean {
    const partition = this.partitions.get(guest.session)
    const record = [...this.surfaces.values()].find(
      (entry) => entry.view.partition === partition,
    )
    if (!record) return false
    record.guest = guest
    const view = partition && this.owner?.bind(owner, partition, guest.id)
    if (!view) {
      record.guest = undefined
      return false
    }
    try {
      guest.debugger.attach('1.3')
      guest.debugger.on(
        'message',
        (_event, method, params: { frame?: { id?: string; parentId?: string } }) => {
          if (
            method === 'Page.documentOpened' &&
            typeof params['frame']?.id === 'string' &&
            params['frame'].parentId === undefined &&
            this.surfaces.get(view.id) === record
          )
            this.owner?.failed(
              guest.id,
              'This extension replaced its page. Close it and use an updated extension that preserves its original document.',
            )
        },
      )
      // The captured response cannot release package code until this exact guest
      // has native observer-loss monitoring. This does not await document load.
      void (async () => {
        await this.assertEngineTarget(record, guest)
        this.assertLiveGuest(record, guest)
        await this.sendEngineCommand(record, guest, 'Page.enable')
        this.assertLiveGuest(record, guest)
        record.settleEngine()
      })().catch((error: unknown) => {
        record.settleEngine(error instanceof Error ? error : new Error(String(error)))
      })
      // Bootstrap may negotiate, but hidden capability admission remains denied.
      // Freezing before navigation can prevent the initial context from loading.
      const loaded = new Promise<void>((resolve, reject) => {
        const cleanup = (): void => {
          guest.removeListener('did-finish-load', ready)
          guest.removeListener('destroyed', closed)
        }
        const ready = (): void => {
          if (guest.getURL() !== view.url) return
          cleanup()
          resolve()
        }
        const closed = (): void => {
          cleanup()
          reject(new Error('Guest closed during bootstrap'))
        }
        guest.on('did-finish-load', ready)
        guest.once('destroyed', closed)
        if (guest.getURL() === view.url && !guest.isLoading()) ready()
      })
      // A visible bootstrap need not await loaded in its first transition.
      void loaded.catch(() => undefined)
      record.lifecycle = new ExtensionGuestLifecycle(
        async (state) => {
          await record.engineReady
          if (state === 'frozen') await Promise.race([loaded, record.revoked])
          await this.assertEngineTarget(record, guest)
          this.assertLiveGuest(record, guest)
          await this.sendEngineCommand(record, guest, 'Page.setWebLifecycleState', {
            state,
          })
          this.assertLiveGuest(record, guest)
        },
        () => this.flushPresentation(record),
        () =>
          this.owner?.failed(
            guest.id,
            'Extension engine lifecycle control is unavailable. Close and reopen the view.',
          ),
      )
      guest.debugger.on('detach', () => {
        if (this.surfaces.get(view.id) === record && !guest.isDestroyed())
          this.owner?.failed(
            guest.id,
            'Extension engine lifecycle control was lost. Close and reopen the view.',
          )
      })
      if (record.admittedWork) record.lifecycle.setAdmittedWork(true)
      record.lifecycle.setVisible(record.visible)
    } catch {
      this.owner?.failed(
        guest.id,
        'Extension engine lifecycle control is unavailable. Close and reopen the view.',
      )
      return true
    }
    guest.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
    guest.setWindowOpenHandler(() => ({ action: 'deny' }))
    const denyNavigation = (event: Electron.Event): void => event.preventDefault()
    guest.on('will-navigate', denyNavigation)
    guest.on('will-frame-navigate', denyNavigation)
    guest.on('will-redirect', denyNavigation)
    guest.on('will-prevent-unload', (event) => event.preventDefault())
    guest.on('devtools-opened', () => guest.closeDevTools())
    guest.on('render-process-gone', () => this.owner?.failed(guest.id))
    guest.on('preload-error', () =>
      this.owner?.failed(
        guest.id,
        'Extension isolated lifecycle observation is unavailable. Close and reopen the view.',
      ),
    )
    guest.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
      if (isMainFrame && code !== -3) this.owner?.failed(guest.id)
    })
    guest.on('did-finish-load', () => this.reapplyWindow(owner))
    guest.once('destroyed', () => this.owner?.failed(guest.id))
    if (view.context?.surface === 'popup')
      guest.on('before-input-event', (event, input) => {
        if (input.type === 'keyDown' && input.key === 'Escape') {
          event.preventDefault()
          void this.owner?.close(owner, view.id)
        }
      })
    reserveKeys(() => {
      void this.owner?.close(owner, view.id)
    })
    return true
  }

  /** Native window/guest visibility propagation invalidates earlier engine state. */
  installWindowLifecycle(win: BrowserWindow, owner: () => RendererOwner): void {
    let pending: ReturnType<typeof setImmediate> | undefined
    const reapply = (): void => {
      if (pending) return
      pending = setImmediate(() => {
        pending = undefined
        this.reapplyWindow(owner())
      })
    }
    win.on('show', reapply)
    win.on('restore', reapply)
    win.on('focus', reapply)
    win.on('resize', reapply)
    win.once('closed', () => {
      if (pending) clearImmediate(pending)
      win.removeListener('show', reapply)
      win.removeListener('restore', reapply)
      win.removeListener('focus', reapply)
      win.removeListener('resize', reapply)
    })
  }

  private reapplyWindow(owner: RendererOwner): void {
    for (const record of this.surfaces.values())
      if (record.owner?.id === owner.id && record.owner.generation === owner.generation)
        record.lifecycle?.setVisible(record.visible)
  }

  private assertLiveGuest(record: SurfaceRecord, guest: WebContents): void {
    if (
      this.surfaces.get(record.view.id) !== record ||
      record.guest !== guest ||
      guest.isDestroyed()
    )
      throw new Error('Extension view was closed')
  }

  private sendEngineCommand(
    record: SurfaceRecord,
    guest: WebContents,
    method: 'Target.getTargetInfo' | 'Page.enable' | 'Page.setWebLifecycleState',
    parameters?: { state: 'active' | 'frozen' },
  ): Promise<unknown> {
    this.assertLiveGuest(record, guest)
    return Promise.race([guest.debugger.sendCommand(method, parameters), record.revoked])
  }

  private async assertEngineTarget(
    record: SurfaceRecord,
    guest: WebContents,
  ): Promise<void> {
    this.assertLiveGuest(record, guest)
    const { targetInfo } = (await this.sendEngineCommand(
      record,
      guest,
      'Target.getTargetInfo',
    )) as {
      targetInfo: { targetId: string; type: string }
    }
    this.assertLiveGuest(record, guest)
    if (
      targetInfo.type !== 'webview' ||
      webContents.fromDevToolsTargetId(targetInfo.targetId)?.id !== guest.id
    )
      throw new Error('Extension engine target ownership changed')
  }

  send(guestId: number, reply: ExtensionReply): void {
    const guest = webContents.fromId(guestId)
    if (!guest || guest.isDestroyed()) return
    if (reply.kind === 'presentation') {
      const record = [...this.surfaces.values()].find((entry) => entry.guest === guest)
      if (!record) return
      record.presentation = reply
      this.flushPresentation(record)
    } else guest.send('extension-guest:reply', reply)
  }

  visibility(guestId: number, visible: boolean): void {
    const record = [...this.surfaces.values()].find(
      (entry) => entry.guest?.id === guestId,
    )
    if (!record || record.guest?.isDestroyed()) return
    record.visible = visible
    record.lifecycle?.setVisible(visible)
  }

  runnable(guestId: number, admitted: boolean): void {
    const record = [...this.surfaces.values()].find(
      (record) => record.guest?.id === guestId,
    )
    if (!record || record.guest?.isDestroyed()) return
    record.admittedWork = admitted
    record.lifecycle?.setAdmittedWork(admitted)
  }

  private flushPresentation(record: SurfaceRecord): void {
    if (
      this.surfaces.get(record.view.id) !== record ||
      !record.lifecycle?.isActive ||
      !record.presentation ||
      record.guest?.isDestroyed()
    )
      return
    record.guest?.send('extension-guest:reply', record.presentation)
    record.presentation = undefined
  }

  destroy(viewId: string): Promise<void> {
    const pending = this.cleanups.get(viewId)
    if (pending) return pending
    const record = this.surfaces.get(viewId)
    if (!record) return Promise.resolve()
    this.surfaces.delete(viewId)
    record.revoke()
    record.settleEngine(new Error('Extension view was closed'))
    record.lifecycle?.dispose()
    record.presentation = undefined
    const guest = record.guest
    // Revocation above is synchronous. Native guest destruction must not reenter
    // the debugger/Chromium notification stack that reported a failed document.
    const destroyed = new Promise<void>((resolve, reject) => {
      setImmediate(() => {
        if (!guest || guest.isDestroyed()) {
          resolve()
          return
        }
        const closed = (): void => resolve()
        guest.once('destroyed', closed)
        try {
          try {
            if (guest.debugger.isAttached()) guest.debugger.detach()
          } catch {
            // Detach refusal cannot veto closing a revoked guest.
          }
          if (!guest.isDestroyed()) guest.close({ waitForBeforeUnload: false })
        } catch (reason) {
          guest.removeListener('destroyed', closed)
          reject(
            reason instanceof Error
              ? reason
              : new Error('Native extension guest close failed', { cause: reason }),
          )
        }
      })
    })
    const cleanup = destroyed.then(async () => {
      record.session.protocol.unhandle('hvir-extension')
      record.session.off('will-download', record.denyDownload)
      await record.session.closeAllConnections()
      await record.session.clearStorageData()
      await record.session.clearCache()
      record.session.webRequest.onBeforeRequest(null)
    })
    this.cleanups.set(viewId, cleanup)
    void cleanup.then(
      () => this.cleanups.delete(viewId),
      () => undefined, // Uncertain teardown keeps its slot and rejected receipt.
    )
    return cleanup
  }

  async dispose(): Promise<void> {
    for (const id of [...this.surfaces.keys()]) void this.destroy(id)
    const settled = await Promise.allSettled([...this.cleanups.values()])
    const failures: unknown[] = []
    for (const result of settled)
      if (result.status === 'rejected') failures.push(result.reason as unknown)
    if (failures.length)
      throw new AggregateError(failures, 'Extension guest cleanup failed; restart hvir.')
  }

  private assetName(record: SurfaceRecord, url: string): string | undefined {
    if (this.surfaces.get(record.view.id) !== record) return undefined
    try {
      const parsed = new URL(url)
      if (
        parsed.protocol !== 'hvir-extension:' ||
        parsed.hostname !== record.view.id ||
        parsed.username ||
        parsed.password ||
        parsed.port ||
        parsed.search
      )
        return undefined
      const name = decodeURIComponent(parsed.pathname.slice(1))
      return record.revision.files.has(name) ? name : undefined
    } catch {
      return undefined
    }
  }
}

function contentType(name: string): string {
  const extension = name.split('.').at(-1)?.toLowerCase()
  return (
    (
      {
        html: 'text/html; charset=utf-8',
        js: 'text/javascript; charset=utf-8',
        mjs: 'text/javascript; charset=utf-8',
        css: 'text/css; charset=utf-8',
        json: 'application/json',
        svg: 'image/svg+xml',
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        webp: 'image/webp',
        woff2: 'font/woff2',
      } as Record<string, string>
    )[extension ?? ''] ?? 'application/octet-stream'
  )
}
