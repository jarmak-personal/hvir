import { verifyExtensionPresentationUi } from './extension-presentation-ui'
import { verifyExtensionConnectors } from './extension-connectors'
import { join } from 'node:path'
import { app, BrowserWindow, webContents, type WebContents } from 'electron'
import { joinHostPath, localPath } from '../../shared/host-path'
import type { ProjectState } from '../../shared'
import type { PtySupervisor } from '../pty/pty-supervisor'
import type {
  TerminalSessionStore,
  TerminalSessionObservationSource,
} from '../terminal/session-registry'
import type { ExtensionView } from '../../shared/extensions/workbench'
import type { ProjectHost } from '../project-host/project-host'
import type { ElectronSmokeDependencies } from './bootstrap-contract'
import type { LiveSessionMetadataSources } from '../terminal/live-session-metadata'
import { focusSmokeWindow } from './window-focus'
import { verifyExtensionWebRtc } from './extension-webrtc'
import { verifyExtensionPackages } from './extension-packages'
import { verifyExtensionNetwork } from './extension-network'
import {
  prepareExtensionViewerFixture,
  verifyExtensionContributions,
} from './extension-contributions'
import {
  EXTENSION_LIFECYCLE_PROBE_SCRIPT,
  startExtensionTimer,
  verifyHiddenExtensionLifecycle,
  verifyInitiallyHiddenExtension,
  prepareExtensionReplacementFixtures,
  verifyExtensionDocumentReplacement,
  verifyExtensionEngineStartup,
} from './extension-lifecycle'

/** Uses ordinary Settings and public guest contracts in the production-composed window. */
export async function verifyExtensionScenario(
  win: BrowserWindow,
  ports: Pick<
    ElectronSmokeDependencies,
    'mode' | 'extensions' | 'rendererResources' | 'htmlPreviews'
  >,
  host: ProjectHost,
  sources: { readonly context: LiveSessionMetadataSources },
): Promise<boolean> {
  const { mode, extensions, rendererResources: scopes } = ports
  if (mode !== 'extensions') return false
  await verifyCombinedDocumentProtocols(ports.htmlPreviews)
  await focusSmokeWindow(win)
  await extensions.start(host, sources.context, {
    local: host,
    hostById: (id) => (id === host.hostId ? host : undefined),
    listHosts: () => [
      {
        hostId: host.hostId,
        label: 'Local',
        kind: 'local',
        connectionState: host.connectionState,
        watchTier: host.watchTier,
      },
    ],
    materializeHost: (id) => {
      if (id !== host.hostId) throw new Error('Unknown host')
      return Promise.resolve(host)
    },
    onHostStateChange: (listener) => host.onConnectionState(listener),
  })
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
  await prepareExtensionViewerFixture(host, reference)
  const referenceScript = joinHostPath(reference, 'reference.js')
  await host.writeFile(
    referenceScript,
    `${(await host.readFile(referenceScript)).toString('utf8')}\n${EXTENSION_LIFECYCLE_PROBE_SCRIPT}`,
  )
  await prepareExtensionReplacementFixtures(host, reference)
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
  console.log('[smoke] initial ordinary guest attached in foreground')
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
  await verifyExtensionPresentationUi(win, guest, waitFor)
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
  await detailGuest.executeJavaScript(`(() => {
    const frame = document.createElement('iframe'); document.body.append(frame);
    frame.contentDocument.open(); frame.contentDocument.write('<body>child only</body>'); frame.contentDocument.close(); frame.remove();
  })()`)
  if (
    detailGuest.isDestroyed() ||
    extensions.guests!.snapshot(owner).find((view) => view.id === detail.id)?.failure
  )
    throw new Error('Child document replacement revoked the main guest')
  await reportParentFocus('before-hidden-proof')
  await verifyHiddenExtensionLifecycle(win, guest, detailGuest)
  await reportParentFocus('after-hidden-proof')
  await verifyInitiallyHiddenExtension(extensions, scopes, initial.installationId)
  await reportParentFocus('after-auxiliary-window')
  await verifyExtensionEngineStartup(extensions, scopes, initial.installationId, guest)
  await verifyExtensionDocumentReplacement(
    win,
    extensions,
    scopes,
    initial.installationId,
  )
  await extensions.guests!.open(owner, initial.installationId, 'detail')
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
  await reportParentFocus('after-renderer-reload')
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
  await reportParentFocus('after-crash-hang-teardown')
  await verifyExtensionPackages(win, extensions, scopes, host, {
    click: (name) => click(win, name),
    wait: waitFor,
    guest: guestFor,
  })
  await reportParentFocus('after-package-teardown')
  await verifyExtensionContributions(win, extensions, scopes, host, source, {
    click: (name) => click(win, name),
    wait: waitFor,
    guest: guestFor,
  })
  await verifyExtensionConnectors(win, extensions, scopes, host, source, {
    click: (name) => click(win, name),
    wait: waitFor,
    guest: guestFor,
  })
  console.log(
    `[smoke] directory extension capture, public viewer, guest isolation, TCP/UDP WebRTC denial, presentation, hidden timers, crash/hang and revocation OK (Electron ${process.versions.electron}; Chromium ${process.versions.chrome})`,
  )
  console.log('HVIR_SMOKE_OK')
  return true

  async function reportParentFocus(phase: string): Promise<void> {
    console.log(
      '[smoke] extension parent focus',
      JSON.stringify({
        phase,
        window: win.isFocused(),
        visible: win.isVisible(),
        parent: (await win.webContents.executeJavaScript(
          '({focus:document.hasFocus(),active:document.activeElement?.tagName})',
        )) as { focus: boolean; active: string | undefined },
      }),
    )
  }
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
    set.call(family, 'A'.repeat(100)); family.dispatchEvent(new Event('input', { bubbles: true }));
    const scale = document.getElementById('settings-interface-scale');
    set.call(scale, '1.1'); scale.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
  await click(win, 'Save app settings')
  await waitFor(
    async () =>
      Boolean(
        (await guest.executeJavaScript(
          "document.documentElement.style.getPropertyValue('--hvir-interface-font').includes('A'.repeat(100)) && parseFloat(document.documentElement.style.getPropertyValue('--hvir-interface-scale')) > 1",
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
  try {
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
  } catch (reason) {
    throw new Error(`Extension ordinary control failed: ${name}`, { cause: reason })
  }
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

/** Both preready descriptors must survive Electron's single privileged registration. */
async function verifyCombinedDocumentProtocols(
  previews: ElectronSmokeDependencies['htmlPreviews'],
): Promise<void> {
  const preview = previews.create(
    '<!doctype html><p id="combined-preview">Preview stays isolated</p>',
  )
  const fixture = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  try {
    await fixture.loadURL(preview.url)
    const result = (await fixture.webContents.executeJavaScript(
      `({secure:isSecureContext, origin:location.origin, text:document.getElementById('combined-preview')?.textContent, node:typeof require})`,
    )) as { secure: boolean; origin: string; text?: string; node: string }
    if (
      !result.secure ||
      result.origin !== 'hvir-preview://document' ||
      result.text !== 'Preview stays isolated' ||
      result.node !== 'undefined'
    )
      throw new Error('Existing HTML preview privileged scheme or isolation regressed')
  } finally {
    fixture.destroy()
    previews.release(preview.id)
  }
}

/** Smoke composes the same read-only metadata port from its existing domain sources. */
export function extensionPtyPorts(
  ptySupervisor: PtySupervisor,
  terminalSessions: TerminalSessionStore & TerminalSessionObservationSource,
  projects: { get(): ProjectState; observe(listener: () => void): () => void },
) {
  return {
    ptySupervisor,
    terminalSessions,
    getProjectState: () => projects.get(),
  }
}
