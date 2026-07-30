import { net, type BrowserWindow } from 'electron'

import type { HostPath } from '../../shared'
import type { HtmlPreviewProtocol } from '../html-preview-protocol'
import type { ProjectHost } from '../project-host'
import type { RendererOwner, RendererResourceScopes } from '../renderer-resource-scopes'
import type { WebPaneRouteRegistry } from '../web-pane/web-pane-route-registry'

/** Exercise real Electron document rollover and destruction for renderer-owned resources. */
export async function verifyRendererAuthorityLifecycle(options: {
  readonly win: BrowserWindow
  readonly resources: RendererResourceScopes
  readonly routes: WebPaneRouteRegistry
  readonly htmlPreviews: HtmlPreviewProtocol
  readonly root: HostPath
  readonly host: ProjectHost
}): Promise<string> {
  const { win, resources, routes, htmlPreviews, root, host } = options
  const ownerId = win.webContents.id
  let previous: RendererOwner | undefined
  let current: RendererOwner | undefined
  let rolloverPaneId: string | undefined
  let destructionPaneId: string | undefined
  let rolloverPreviewUrl: string | undefined
  let destructionPreviewUrl: string | undefined
  try {
    previous = resources.currentOwner(ownerId)
    const rolloverRoute = await routes.open({
      ownerId,
      ownerGeneration: previous.generation,
      sourceTerminalId: 'renderer-authority-rollover',
      workspaceRoot: root,
      host,
      url: 'http://localhost:61337/renderer-rollover',
    })
    rolloverPaneId = rolloverRoute.paneId
    const rolloverPreview = htmlPreviews.create(
      '<p>renderer rollover authority</p>',
      previous,
      root,
    )
    rolloverPreviewUrl = rolloverPreview.url
    await assertPreviewStatus(rolloverPreview.url, 200, 'rollover preview did not open')

    const loaded = new Promise<void>((resolve) =>
      win.webContents.once('did-finish-load', () => resolve()),
    )
    win.webContents.reload()
    await withTimeout(loaded, 'renderer authority reload timed out')
    await waitFor(async () => {
      try {
        current = resources.currentOwner(ownerId)
        if (current.generation <= previous!.generation) return false
        const version = (await win.webContents.executeJavaScript(
          `window.hvir.invoke('app:info', undefined).then((info) => info.electronVersion)`,
        )) as string
        return Boolean(version)
      } catch {
        return false
      }
    }, 'replacement renderer did not regain IPC authority')
    await waitFor(
      () => !routes.has(rolloverRoute.paneId, previous!.id, previous!.generation),
      'renderer rollover retained its old web route',
    )
    await waitFor(
      () => previewStatus(rolloverPreview.url).then((status) => status === 404),
      'renderer rollover retained its old HTML preview',
    )

    const destructionRoute = await routes.open({
      ownerId,
      ownerGeneration: current!.generation,
      sourceTerminalId: 'renderer-authority-destruction',
      workspaceRoot: root,
      host,
      url: 'http://localhost:61338/renderer-destruction',
    })
    destructionPaneId = destructionRoute.paneId
    const destructionPreview = htmlPreviews.create(
      '<p>renderer destruction authority</p>',
      current,
      root,
    )
    destructionPreviewUrl = destructionPreview.url
    await assertPreviewStatus(
      destructionPreview.url,
      200,
      'destruction preview did not open',
    )

    const destroyed = new Promise<void>((resolve) =>
      win.webContents.once('destroyed', () => resolve()),
    )
    win.destroy()
    await withTimeout(destroyed, 'renderer authority window was not destroyed')
    await waitFor(
      () => !routes.has(destructionRoute.paneId, current!.id, current!.generation),
      'webContents destruction retained its web route',
    )
    await waitFor(
      () => previewRevokedAfterRuntimeSuspend(destructionPreview.url),
      'webContents destruction retained its HTML preview',
    )

    return `generation ${previous.generation}→${current!.generation} · routes revoked · previews expired · destruction revoked`
  } catch (error) {
    const state = {
      destroyed: win.isDestroyed(),
      ownerId,
      previousGeneration: previous?.generation,
      currentGeneration: current?.generation,
      previousCurrent: previous ? resources.isCurrent(previous) : undefined,
      currentCurrent: current ? resources.isCurrent(current) : undefined,
      rolloverRoute: routeState(routes, rolloverPaneId, previous),
      destructionRoute: routeState(routes, destructionPaneId, current),
      rolloverPreview: await safePreviewStatus(rolloverPreviewUrl),
      destructionPreview: await safePreviewStatus(destructionPreviewUrl),
    }
    throw new Error(
      `Renderer authority lifecycle failed: ${
        error instanceof Error ? error.message : String(error)
      }; state=${JSON.stringify(state)}`,
      { cause: error },
    )
  }
}

function routeState(
  routes: WebPaneRouteRegistry,
  paneId: string | undefined,
  owner: RendererOwner | undefined,
): boolean | undefined {
  return paneId && owner ? routes.has(paneId, owner.id, owner.generation) : undefined
}

async function assertPreviewStatus(
  url: string,
  expected: number,
  message: string,
): Promise<void> {
  const status = await previewStatus(url)
  if (status !== expected) throw new Error(`${message}: status ${status}`)
}

function previewStatus(url: string): Promise<number> {
  return net.fetch(url).then((response) => response.status)
}

async function previewRevokedAfterRuntimeSuspend(url: string): Promise<boolean> {
  try {
    return (await previewStatus(url)) === 404
  } catch (error) {
    // Destroying the last window suspends the workbench and unregisters the
    // entire preview protocol. Electron reports that fail-closed result as an
    // unknown scheme on some platforms instead of routing one final 404.
    return error instanceof Error && error.message.includes('ERR_UNKNOWN_URL_SCHEME')
  }
}

async function safePreviewStatus(url: string | undefined): Promise<number | string> {
  if (!url) return 'not-created'
  try {
    return await previewStatus(url)
  } catch (error) {
    return error instanceof Error
      ? error.message.slice(0, 160)
      : String(error).slice(0, 160)
  }
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  message: string,
): Promise<void> {
  const deadline = Date.now() + 10_000
  for (;;) {
    if (await predicate()) return
    if (Date.now() >= deadline) throw new Error(message)
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  message: string,
  timeoutMs = 15_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
