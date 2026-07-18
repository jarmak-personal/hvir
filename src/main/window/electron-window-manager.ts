import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  app,
  BrowserWindow,
  dialog,
  session,
  shell,
  webContents,
  type Session,
  type WebContents,
} from 'electron'

import type { HtmlPreviewProtocol } from '../html-preview-protocol'
import { isSafeExternalUrl, isWorkbenchDocument } from '../navigation-policy'
import type { RendererOwner } from '../renderer-resource-scopes'
import { workbenchWindowOptions } from './window-policy'
import {
  WEB_PANE_PARTITION_PREFIX,
  WebPaneRouteRegistry,
} from '../web-pane/web-pane-route-registry'
import {
  DEFAULT_KEYBINDINGS,
  matchesKeybinding,
  type KeybindingAction,
  type KeybindingMap,
  type WebPaneCommandAction,
} from '../../shared'

export interface ElectronWindowManagerDependencies {
  readonly htmlPreviews: HtmlPreviewProtocol
  readonly activateRenderer: (ownerId: number) => RendererOwner
  readonly rolloverRenderer: (owner: RendererOwner) => RendererOwner
  readonly revokeRenderer: (owner: RendererOwner) => void
  readonly isRendererCurrent: (owner: RendererOwner) => boolean
  readonly setOwnerFocused: (owner: RendererOwner, focused: boolean) => void
  readonly onLastWindowClosed: () => void
  readonly isShuttingDown: () => boolean
}

export interface ElectronWindowManager {
  readonly routes: WebPaneRouteRegistry
  readonly createWindow: (
    discardRendererResources?: (ownerId: number) => void,
  ) => BrowserWindow
  readonly updateWebPaneBindings: (ownerId: number, bindings: KeybindingMap) => void
  readonly updateWebPaneFullPage: (ownerId: number, paneId?: string) => void
  readonly dispose: () => Promise<void>
}

export function createElectronWindowManager(
  dependencies: ElectronWindowManagerDependencies,
): ElectronWindowManager {
  const { htmlPreviews } = dependencies
  const webPaneSessionPartitions = new WeakMap<Session, string>()
  const webPaneBindings = new Map<number, KeybindingMap>()
  const fullPageWebPanes = new Map<number, string>()
  const webPaneRoutes = new WebPaneRouteRegistry({
    prepareSession: prepareWebPaneSession,
    destroyGuest: (guestId) => {
      const guest = webContents.fromId(guestId)
      if (guest && !guest.isDestroyed()) guest.close({ waitForBeforeUnload: false })
    },
    emitDiagnostic: (ownerId, ownerGeneration, paneId, event) => {
      const rendererOwner = { id: ownerId, generation: ownerGeneration }
      if (!dependencies.isRendererCurrent(rendererOwner)) return
      const owner = webContents.fromId(ownerId)
      if (owner && !owner.isDestroyed()) {
        owner.send('web-pane:diagnostic', { paneId, event })
      }
    },
  })

  async function prepareWebPaneSession({
    partition,
    proxyPort,
    primaryUrl,
  }: {
    readonly partition: string
    readonly proxyPort: number
    readonly primaryUrl: string
  }): Promise<() => Promise<void>> {
    const paneSession = session.fromPartition(partition, { cache: true })
    webPaneSessionPartitions.set(paneSession, partition)
    paneSession.setPermissionCheckHandler(() => false)
    paneSession.setPermissionRequestHandler((_contents, _permission, callback) => {
      callback(false)
    })
    paneSession.setDevicePermissionHandler(() => false)
    paneSession.setDisplayMediaRequestHandler((_request, callback) => callback({}))
    const denyDownload = (event: Electron.Event): void => event.preventDefault()
    paneSession.on('will-download', denyDownload)
    await paneSession.setProxy({
      mode: 'fixed_servers',
      proxyRules: `http://127.0.0.1:${proxyPort}`,
      proxyBypassRules: '<-loopback>',
    })
    await paneSession.forceReloadProxyConfig()
    const resolvedProxy = await paneSession.resolveProxy(primaryUrl)
    if (
      !resolvedProxy
        .split(';')
        .some((rule) => rule.trim() === `PROXY 127.0.0.1:${proxyPort}`)
    ) {
      paneSession.off('will-download', denyDownload)
      await paneSession.setProxy({ mode: 'direct' })
      throw new Error(`Chromium did not select the pane proxy (${resolvedProxy})`)
    }
    return async () => {
      paneSession.off('will-download', denyDownload)
      paneSession.setPermissionCheckHandler(null)
      paneSession.setPermissionRequestHandler(null)
      paneSession.setDevicePermissionHandler(null)
      paneSession.setDisplayMediaRequestHandler(null)
      await paneSession.closeAllConnections()
      await paneSession.clearStorageData()
      await paneSession.clearCache()
      await paneSession.setProxy({ mode: 'direct' })
    }
  }

  const handleLogin = (
    event: Electron.Event,
    contents: WebContents,
    _details: Electron.AuthenticationResponseDetails,
    authInfo: Electron.AuthInfo,
    callback: (username?: string, password?: string) => void,
  ): void => {
    const credentials = webPaneRoutes.proxyCredentials(contents.id, authInfo)
    if (credentials) {
      event.preventDefault()
      callback(credentials.username, credentials.password)
      return
    }
    if (authInfo.isProxy && webPaneRoutes.paneIdForGuest(contents.id)) {
      event.preventDefault()
      callback()
    }
  }

  function configureWebPaneGuest(
    rendererOwner: RendererOwner,
    paneId: string,
    guest: WebContents,
  ): void {
    const ownerId = rendererOwner.id
    const notifyBlocked = (kind: 'loopback' | 'external', url: string): void => {
      if (!dependencies.isRendererCurrent(rendererOwner)) return
      const owner = webContents.fromId(ownerId)
      if (!owner || owner.isDestroyed()) return
      owner.send('web-pane:navigation-blocked', { paneId, kind, url })
    }
    const enforceNavigation = (event: Electron.Event, url: string): void => {
      const decision = webPaneRoutes.navigation(guest.id, url)
      if (decision.kind === 'allow') return
      event.preventDefault()
      if (decision.kind === 'loopback' || decision.kind === 'external') {
        notifyBlocked(decision.kind, decision.url)
      }
    }

    guest.setWindowOpenHandler(({ url }) => {
      const decision = webPaneRoutes.navigation(guest.id, url)
      if (decision.kind === 'allow') {
        void guest
          .loadURL(decision.url)
          .catch((error) =>
            console.warn('[web-pane] same-origin window navigation failed', error),
          )
      } else if (decision.kind === 'loopback' || decision.kind === 'external') {
        notifyBlocked(decision.kind, decision.url)
      }
      return { action: 'deny' }
    })
    guest.on('will-navigate', enforceNavigation)
    guest.on('will-redirect', enforceNavigation)
    guest.on('will-prevent-unload', (event) => event.preventDefault())
    guest.on('devtools-opened', () => guest.closeDevTools())
    guest.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || input.isAutoRepeat) return
      const bindings = webPaneBindings.get(ownerId) ?? DEFAULT_KEYBINDINGS
      const primaryModifier = process.platform === 'darwin' ? input.meta : input.control
      let action: WebPaneCommandAction | undefined
      if (
        input.key.toLowerCase() === 'w' &&
        primaryModifier &&
        !input.alt &&
        !input.shift
      ) {
        action = 'closeWebPane'
      } else if (input.key === 'Escape' && fullPageWebPanes.get(ownerId) === paneId) {
        action = 'escapeWebPaneFocus'
      } else {
        action = (Object.entries(bindings) as [KeybindingAction, string][]).find(
          ([, binding]) =>
            matchesKeybinding(
              {
                key: input.key,
                code: input.code,
                ctrlKey: input.control,
                metaKey: input.meta,
                altKey: input.alt,
                shiftKey: input.shift,
              },
              binding,
              process.platform === 'darwin',
            ),
        )?.[0]
      }
      if (!action) return
      event.preventDefault()
      if (!dependencies.isRendererCurrent(rendererOwner)) return
      const owner = webContents.fromId(ownerId)
      if (owner && !owner.isDestroyed()) {
        owner.send('web-pane:command', { paneId, action })
      }
    })
  }

  function createWindow(
    // Electron smoke injects an observer for resources outside the production scopes.
    discardExternalResources: (ownerId: number) => void = () => undefined,
  ): BrowserWindow {
    const win = new BrowserWindow(
      workbenchWindowOptions(join(__dirname, '../preload/index.js')),
    )
    const rendererUrl = process.env['ELECTRON_RENDERER_URL']
    const packagedEntry = join(__dirname, '../renderer/index.html')
    const entryUrl = rendererUrl ?? pathToFileURL(packagedEntry).href
    const ownerId = win.webContents.id
    let rendererOwner = dependencies.activateRenderer(ownerId)
    let rendererRevoked = false
    let committedDocument = false

    win.on('focus', () => dependencies.setOwnerFocused(rendererOwner, true))
    win.on('blur', () => dependencies.setOwnerFocused(rendererOwner, false))

    win.on('ready-to-show', () => win.show())
    win.webContents.on('did-finish-load', () => {
      committedDocument = true
    })
    const revokeRendererResources = (reopen: boolean): void => {
      if (rendererRevoked) return
      discardExternalResources(ownerId)
      htmlPreviews.releaseOwner(rendererOwner)
      webPaneBindings.delete(ownerId)
      fullPageWebPanes.delete(ownerId)
      void webPaneRoutes
        .closeOwner(rendererOwner.id, rendererOwner.generation)
        .catch((error) => console.error('[web-pane] renderer cleanup failed', error))
      if (reopen) {
        rendererOwner = dependencies.rolloverRenderer(rendererOwner)
        committedDocument = false
      } else {
        rendererRevoked = true
        dependencies.revokeRenderer(rendererOwner)
      }
    }
    // Renderer reload/crash cannot run React cleanup for its main-owned resources.
    win.webContents.on('did-start-navigation', (_event, url, isInPlace, isMainFrame) => {
      if (
        committedDocument &&
        isMainFrame &&
        !isInPlace &&
        isWorkbenchDocument(url, entryUrl)
      ) {
        revokeRendererResources(true)
      }
    })
    win.webContents.on('will-navigate', (event, url) => {
      if (isWorkbenchDocument(url, entryUrl)) return
      event.preventDefault()
      console.warn(`[navigation] blocked workbench replacement: ${url}`)
      if (isSafeExternalUrl(url)) void shell.openExternal(url)
    })
    win.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      if (isMainFrame) {
        console.error(
          `[window] main document failed to load (${code}): ${description} ${url}`,
        )
      }
    })
    let rendererRecoveryRequested = false
    win.webContents.on('render-process-gone', (_event, details) => {
      revokeRendererResources(true)
      console.error(`[window] renderer process gone: ${JSON.stringify(details)}`)
      if (rendererRecoveryRequested) {
        rendererRecoveryRequested = false
      } else if (!win.isDestroyed() && details.reason !== 'clean-exit') {
        // Reload into a fresh renderer that can restore persisted tabs.
        win.webContents.reload()
      }
    })
    win.webContents.once('destroyed', () => revokeRendererResources(false))
    let handlingUnresponsive = false
    win.webContents.on('unresponsive', () => {
      if (handlingUnresponsive || win.isDestroyed()) return
      handlingUnresponsive = true
      console.error('[window] renderer became unresponsive')
      void dialog
        .showMessageBox(win, {
          type: 'warning',
          title: 'hvir is not responding',
          message: 'The hvir window stopped responding.',
          detail:
            'Reloading will recover the window but may discard unsaved source edits.',
          buttons: ['Wait', 'Reload hvir'],
          defaultId: 0,
          cancelId: 0,
        })
        .then(({ response }) => {
          if (response === 1 && !win.isDestroyed()) {
            rendererRecoveryRequested = true
            win.webContents.forcefullyCrashRenderer()
            win.webContents.reload()
          }
        })
        .finally(() => {
          handlingUnresponsive = false
        })
    })
    win.on('closed', () => {
      revokeRendererResources(false)
      if (
        process.platform === 'darwin' &&
        BrowserWindow.getAllWindows().length === 0 &&
        !dependencies.isShuttingDown()
      ) {
        dependencies.onLastWindowClosed()
      }
    })

    // Open external links in the OS browser, never in-app (security posture).
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (isSafeExternalUrl(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })

    // A one-use main-owned route controls each guest and its security preferences.
    win.webContents.on('will-attach-webview', (event, webPreferences, params) => {
      const partition = params['partition'] ?? ''
      const paneId =
        params['name'] ||
        (partition.startsWith(WEB_PANE_PARTITION_PREFIX)
          ? partition.slice(WEB_PANE_PARTITION_PREFIX.length)
          : '')
      const route = webPaneRoutes.claimAttachment({
        ownerId,
        ownerGeneration: rendererOwner.generation,
        paneId,
        partition,
        initialUrl: params['src'] ?? '',
      })
      if (!route) {
        console.warn('[web-pane] blocked unregistered or duplicate guest attachment')
        event.preventDefault()
        return
      }
      delete webPreferences.preload
      webPreferences.nodeIntegration = false
      webPreferences.contextIsolation = true
      webPreferences.sandbox = true
      webPreferences.webSecurity = true
      webPreferences.devTools = false
      webPreferences.safeDialogs = true
      webPreferences.safeDialogsMessage =
        'hvir stopped this page from opening additional dialogs.'
      params['src'] = route.url
      params['partition'] = route.partition
    })
    win.webContents.on('did-attach-webview', (_event, guest) => {
      const partition = webPaneSessionPartitions.get(guest.session)
      const paneId = partition
        ? webPaneRoutes.bindGuestForPartition(
            ownerId,
            partition,
            guest.id,
            rendererOwner.generation,
          )
        : undefined
      if (!paneId) {
        console.warn('[web-pane] destroying a guest without an authorized route')
        guest.close({ waitForBeforeUnload: false })
        return
      }
      configureWebPaneGuest(rendererOwner, paneId, guest)
    })

    if (rendererUrl) {
      void win
        .loadURL(rendererUrl)
        .catch((error) => console.error('[window] failed to load renderer URL', error))
    } else {
      void win
        .loadFile(packagedEntry)
        .catch((error) => console.error('[window] failed to load renderer file', error))
    }

    return win
  }

  app.on('login', handleLogin)
  return {
    routes: webPaneRoutes,
    createWindow,
    updateWebPaneBindings: (ownerId, bindings) => webPaneBindings.set(ownerId, bindings),
    updateWebPaneFullPage: (ownerId, paneId) => {
      if (paneId) fullPageWebPanes.set(ownerId, paneId)
      else fullPageWebPanes.delete(ownerId)
    },
    dispose: async () => {
      app.off('login', handleLogin)
      webPaneBindings.clear()
      fullPageWebPanes.clear()
      await webPaneRoutes.closeAll()
    },
  }
}
