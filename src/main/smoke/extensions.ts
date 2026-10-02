import { join } from 'node:path'
import { app, webContents, type BrowserWindow, type WebContents } from 'electron'
import { joinHostPath, localPath } from '../../shared/host-path'
import type { ExtensionView } from '../../shared/extensions/workbench'
import type { ProjectHost } from '../project-host/project-host'
import type { ElectronSmokeDependencies } from './bootstrap-contract'
import { verifyExtensionWebRtc } from './extension-webrtc'
import { verifyExtensionNetwork } from './extension-network'
import {
  startExtensionTimer,
  verifyHiddenExtensionLifecycle,
  verifyInitiallyHiddenExtension,
} from './extension-lifecycle'

/** Uses ordinary Settings and public guest contracts in the production-composed window. */
export async function verifyExtensionScenario(
  win: BrowserWindow,
  ports: Pick<ElectronSmokeDependencies, 'mode' | 'extensions' | 'rendererResources'>,
  host: ProjectHost,
): Promise<boolean> {
  const { mode, extensions, rendererResources: scopes } = ports
  if (mode !== 'extensions') return false
  await extensions.start(host)
  const directory = extensions.activations?.directory
  if (!directory) throw new Error('Extension application did not start')
  const reference = joinHostPath(directory, 'reference')
  await host.createDirectoryExclusive(reference, { mode: 0o755 })
  const source = localPath(
    app.isPackaged
      ? join(process.resourcesPath, 'extension-reference')
      : join(app.getAppPath(), 'packages/extension-reference'),
  )
  for (const entry of await host.readdir(source)) {
    await host.writeFile(
      joinHostPath(reference, entry.name),
      await host.readFile(joinHostPath(source, entry.name)),
    )
  }
  const referenceScript = joinHostPath(reference, 'reference.js')
  await host.writeFile(
    referenceScript,
    `${(await host.readFile(referenceScript)).toString('utf8')}\nwindow.extensionInitialTicks = 0; setInterval(() => window.extensionInitialTicks++, 20);`,
  )
  // A malformed neighboring package must not break the ordinary walkthrough.
  const bad = joinHostPath(directory, 'bad')
  await host.createDirectoryExclusive(bad, { mode: 0o755 })
  await host.writeFile(joinHostPath(bad, 'hvir-extension.json'), '{invalid')
  await click(win, 'Open settings')
  await click(win, 'Extensions')
  await click(win, 'Discover extensions')
  await waitFor(
    () => extensions.activations!.snapshot().installations.length === 2,
    'directory discovery',
  )
  const installed = extensions
    .activations!.snapshot()
    .installations.find((entry) => entry.source === 'reference')
  if (!installed?.revision || installed.error)
    throw new Error('Ordinary reference package failed discovery')
  if (
    !extensions
      .activations!.snapshot()
      .installations.find((entry) => entry.source === 'bad')?.error
  )
    throw new Error('Malformed package had no visible refusal')
  await click(win, 'Enable')
  await waitFor(() => extensions.activations!.active.size === 1, 'trusted Enable')
  await click(win, 'Open Extension reference')
  const owner = scopes.currentOwner(win.webContents.id)
  await waitFor(() => extensions.guests!.snapshot(owner).length === 1, 'viewer placement')
  const initial = extensions.guests!.snapshot(owner)[0]!
  const guest = await guestFor(initial)
  await waitFor(
    async () =>
      (await guest.executeJavaScript(
        "document.getElementById('status')?.textContent",
      )) === 'Connected · contract 1.0',
    'public handshake',
  )
  const isolation = (await guest.executeJavaScript(
    `({ node: typeof process, require: typeof require, electron: typeof window.electron, workbench: typeof window.hvir, guestBridge: typeof window.hvirExtension, rtc: typeof RTCPeerConnection })`,
  )) as Record<string, string>
  if (
    isolation['node'] !== 'undefined' ||
    isolation['require'] !== 'undefined' ||
    isolation['electron'] !== 'undefined' ||
    isolation['workbench'] !== 'undefined' ||
    isolation['guestBridge'] !== 'object' ||
    isolation['rtc'] !== 'undefined'
  )
    throw new Error('Guest obtained an unexpected authority surface')
  if (guest.session === win.webContents.session)
    throw new Error('Guest isolation preferences or session were not independent')
  const permissions = (await guest.executeJavaScript(`(async () => ({
    notification: await Notification.requestPermission(),
    camera: (await navigator.permissions.query({name:'camera'})).state,
    microphone: (await navigator.permissions.query({name:'microphone'})).state,
    mediaPolicy: !document.featurePolicy.allowsFeature('camera') && !document.featurePolicy.allowsFeature('microphone'),
    popup: window.open('https://example.invalid') === null,
    parent: window.parent === window && typeof window.top.hvir === 'undefined',
  }))()`)) as {
    notification: string
    camera: string
    microphone: string
    mediaPolicy: boolean
    popup: boolean
    parent: boolean
  }
  if (
    permissions.notification !== 'denied' ||
    permissions.camera !== 'denied' ||
    permissions.microphone !== 'denied' ||
    !permissions.mediaPolicy ||
    !permissions.popup ||
    !permissions.parent
  )
    throw new Error(
      'Guest obtained browser permission, popup or parent workbench authority',
    )
  const unavailable = await publicRequest(guest, 'unavailable-host', 'host.read')
  if (unavailable.ok !== false || !unavailable.error?.includes('Extension contract 1.0'))
    throw new Error('Guest obtained an undeclared host capability')
  await verifyExtensionWebRtc(guest)
  await verifyExtensionNetwork(guest)
  await verifyPresentation(win, guest)
  guest.focus()
  guest.sendInputEvent({
    type: 'keyDown',
    keyCode: 'P',
    modifiers: [process.platform === 'darwin' ? 'meta' : 'control'],
  })
  await waitFor(
    async () =>
      Boolean(
        (await win.webContents.executeJavaScript(
          "document.activeElement?.hasAttribute('data-filename-search')",
        )) as unknown,
      ),
    'reserved workbench find-file stroke',
  )
  guest.sendInputEvent({
    type: 'keyUp',
    keyCode: 'P',
    modifiers: [process.platform === 'darwin' ? 'meta' : 'control'],
  })
  const origins = (await guest.executeJavaScript(
    `Promise.all(['file:///etc/passwd', 'hvir-extension://forged/index.html'].map((url) => fetch(url).then(() => false, () => true)))`,
  )) as boolean[]
  if (origins.some((denied) => !denied))
    throw new Error('Guest fetched an ungranted origin')
  await startExtensionTimer(guest)
  await guest.executeJavaScript(`document.getElementById('open-detail').click()`)
  await waitFor(
    () => extensions.guests!.snapshot(owner).length === 2,
    'own detail capability',
  )
  const detail = extensions
    .guests!.snapshot(owner)
    .find((view) => view.contributionId === 'detail')!
  const detailGuest = await guestFor(detail)
  await verifyHiddenExtensionLifecycle(win, guest, detailGuest)
  await verifyInitiallyHiddenExtension(extensions, scopes, initial.installationId)
  if (detailGuest.session === guest.session)
    throw new Error('Two guest views shared an Electron session')
  const crossExtension: unknown = await detailGuest.executeJavaScript(
    `fetch(${JSON.stringify(initial.url)}).then(() => false, () => true)`,
  )
  if (crossExtension !== true)
    throw new Error('Guest obtained another view revision origin')
  await host.writeFile(
    joinHostPath(reference, 'detail.html'),
    '<h1>External source changed</h1>',
  )
  const served: unknown = await detailGuest.executeJavaScript(
    `fetch('detail.html').then((response) => response.text()).then((text) => text.includes('A small public contract'))`,
  )
  if (served !== true) throw new Error('Activation served mutable source bytes')
  await win.webContents.executeJavaScript(
    `window.hvir.invoke('extensions:close-view', { viewId: ${JSON.stringify(initial.id)} })`,
  )
  await waitFor(() => guest.isDestroyed(), 'trusted close revocation')
  // Renderer rollover must revoke the surviving descendant without React cleanup.
  const loaded = new Promise<void>((resolve) =>
    win.webContents.once('did-finish-load', resolve),
  )
  win.webContents.reload()
  await loaded
  await waitFor(() => detailGuest.isDestroyed(), 'renderer replacement guest revocation')
  if (extensions.guests!.snapshot(owner).length)
    throw new Error('Old renderer retained views')
  const nextOwner = scopes.currentOwner(win.webContents.id)
  await waitFor(
    async () =>
      !!(await win.webContents.executeJavaScript(
        'window.hvir && document.querySelector(".app-shell")',
      )),
    'replacement workbench',
  )
  await click(win, 'Open settings')
  await click(win, 'Extensions')
  await click(win, 'Open Extension reference')
  await waitFor(
    () => extensions.guests!.snapshot(nextOwner).length === 1,
    'fresh view after renderer replacement',
  )
  const reopened = await guestFor(extensions.guests!.snapshot(nextOwner)[0]!)
  await waitFor(
    async () =>
      (await reopened.executeJavaScript(
        "document.getElementById('status')?.textContent",
      )) === 'Connected · contract 1.0',
    'reopened public handshake',
  )
  reopened.forcefullyCrashRenderer()
  await waitFor(
    () => !!extensions.guests!.snapshot(nextOwner)[0]?.failure,
    'contained guest crash',
  )
  await click(win, 'Close Extension reference')
  await waitFor(
    () => extensions.guests!.snapshot(nextOwner).length === 0,
    'closable failed guest chrome',
  )
  await click(win, 'Open settings')
  await click(win, 'Extensions')
  await click(win, 'Open Extension reference')
  await waitFor(
    () => extensions.guests!.snapshot(nextOwner).length === 1,
    'open after guest crash',
  )
  const hung = await guestFor(extensions.guests!.snapshot(nextOwner)[0]!)
  await waitFor(
    async () =>
      (await hung.executeJavaScript("document.getElementById('status')?.textContent")) ===
      'Connected · contract 1.0',
    'guest before deliberate hang',
  )
  if (hung.getOSProcessId() === win.webContents.getOSProcessId())
    throw new Error('Guest shares the trusted workbench process')
  void hung.executeJavaScript('while (true) {}').catch(() => undefined)
  await click(win, 'Open settings')
  await click(win, 'Extensions')
  await click(win, 'Disable')
  await waitFor(
    () => hung.isDestroyed() && extensions.activations!.active.size === 0,
    'trusted Disable',
  )
  console.log(
    `[smoke] directory extension capture, public viewer, guest isolation, TCP/UDP WebRTC denial, presentation, hidden timers, crash/hang and revocation OK (Electron ${process.versions.electron}; Chromium ${process.versions.chrome})`,
  )
  console.log('HVIR_SMOKE_OK')
  return true
}

async function publicRequest(
  guest: WebContents,
  id: string,
  capability: string,
): Promise<{ ok?: boolean; error?: string; value?: unknown }> {
  return guest.executeJavaScript(`new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Public extension request timed out')), 2000);
    const unsubscribe = window.hvirExtension.onMessage(message => {
      if (message.kind === 'result' && message.id === ${JSON.stringify(id)}) { clearTimeout(timer); unsubscribe(); resolve(message) }
    });
    window.hvirExtension.send({kind:'request',id:${JSON.stringify(id)},capability:${JSON.stringify(capability)}});
  })`) as Promise<{ ok?: boolean; error?: string; value?: unknown }>
}

async function verifyPresentation(win: BrowserWindow, guest: WebContents): Promise<void> {
  const initial = await publicRequest(guest, 'presentation-initial', 'presentation.read')
  const value = initial.value as {
    width?: number
    height?: number
    fontFamily?: string
    fontSize?: number
  }
  if (
    !initial.ok ||
    !value.width ||
    !value.height ||
    !value.fontFamily ||
    !value.fontSize
  )
    throw new Error('Public guest presentation lacked geometry or typography')
  await click(win, 'Use light theme')
  await waitFor(
    async () =>
      (await guest.executeJavaScript('document.documentElement.style.colorScheme')) ===
      'light',
    'live light presentation',
  )
  await click(win, 'Use dark theme')
  await waitFor(
    async () =>
      (await guest.executeJavaScript('document.documentElement.style.colorScheme')) ===
      'dark',
    'live dark presentation',
  )
  await click(win, 'Open settings')
  await win.webContents.executeJavaScript(`(() => {
    const mode = document.getElementById('settings-interface-font-mode');
    mode.value = 'custom'; mode.dispatchEvent(new Event('change', { bubbles: true }));
  })()`)
  await waitFor(
    async () =>
      Boolean(
        (await win.webContents.executeJavaScript(
          "document.getElementById('settings-interface-font') !== null",
        )) as unknown,
      ),
    'ordinary interface typography field',
  )
  await win.webContents.executeJavaScript(`(() => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    const family = document.getElementById('settings-interface-font');
    set.call(family, 'Arial'); family.dispatchEvent(new Event('input', { bubbles: true }));
    const scale = document.getElementById('settings-interface-scale');
    set.call(scale, '1.1'); scale.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
  await click(win, 'Save app settings')
  await waitFor(
    async () =>
      Boolean(
        (await guest.executeJavaScript(
          "document.documentElement.style.getPropertyValue('--extension-font').includes('Arial') && parseFloat(document.documentElement.style.getPropertyValue('--extension-font-size')) > 13",
        )) as unknown,
      ),
    'live hvir typography presentation',
  )
  const bounds = win.getBounds()
  win.setSize(bounds.width + 80, bounds.height + 60)
  await waitFor(async () => {
    await new Promise((resolve) => setTimeout(resolve, 100))
    const updated = await publicRequest(
      guest,
      'presentation-resized',
      'presentation.read',
    )
    const geometry = updated.value as { width?: number; height?: number }
    return geometry.width !== value.width || geometry.height !== value.height
  }, 'live viewer geometry')
}

async function guestFor(view: ExtensionView): Promise<WebContents> {
  let found: WebContents | undefined
  await waitFor(() => {
    found = webContents
      .getAllWebContents()
      .find((contents) => !contents.isDestroyed() && contents.getURL() === view.url)
    return !!found
  }, 'guest attachment')
  return found!
}

async function click(win: BrowserWindow, name: string): Promise<void> {
  await waitFor(
    async () =>
      Boolean(
        (await win.webContents.executeJavaScript(`(() => {
    const button = [...document.querySelectorAll('button')].find((element) => element.getAttribute('aria-label') === ${JSON.stringify(name)} || element.textContent.trim() === ${JSON.stringify(name)});
    if (!button || button.disabled) return false; button.click(); return true;
  })()`)) as unknown,
      ),
    `ordinary ${name} control`,
  )
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  label: string,
): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(`Extension smoke timed out: ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}
