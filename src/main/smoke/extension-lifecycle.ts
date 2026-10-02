import { BrowserWindow, type WebContents } from 'electron'
import type { ExtensionApplicationRuntime } from '../extensions/extension-application'
import {
  EXTENSION_LIMITS,
  type ExtensionManifest,
} from '../../shared/extensions/contract'
import { DEFAULT_EXTENSION_PRESENTATION } from '../extensions/guest-owner'
import type { RendererResourceScopes } from '../renderer-resource-scopes'
import type { ProjectHost } from '../project-host/project-host'
import { joinHostPath, type HostPath } from '../../shared/host-path'

/** Observer-loss fixtures are captured with the ordinary package, never shipped. */
export async function prepareExtensionReplacementFixtures(
  host: ProjectHost,
  root: HostPath,
): Promise<void> {
  const path = joinHostPath(root, 'hvir-extension.json')
  const manifest = JSON.parse(
    (await host.readFile(path)).toString('utf8'),
  ) as ExtensionManifest
  const views = [...manifest.views]
  for (const mode of ['open', 'close']) {
    views.push({
      id: `replace-${mode}`,
      title: `Replace document ${mode}`,
      entry: `replace-${mode}.html`,
      placement: 'application',
      representations: ['view'],
    })
    await host.writeFile(
      joinHostPath(root, `replace-${mode}.html`),
      `<script src="replace-${mode}.js"></script>`,
    )
    await host.writeFile(
      joinHostPath(root, `replace-${mode}.js`),
      `setTimeout(() => { document.open(); document.write('<body>replacement</body>'); ${mode === 'close' ? 'document.close();' : ''} }, 0);`,
    )
  }
  await host.writeFile(path, JSON.stringify({ ...manifest, views }))
}

export async function verifyExtensionDocumentReplacement(
  win: BrowserWindow,
  extensions: ExtensionApplicationRuntime,
  scopes: RendererResourceScopes,
  installationId: string,
): Promise<void> {
  const owner = scopes.currentOwner(win.webContents.id)
  for (const mode of ['open', 'close']) {
    const view = await extensions.guests!.open(owner, installationId, `replace-${mode}`)
    const deadline = Date.now() + EXTENSION_LIMITS.requestTimeoutMs
    while (
      Date.now() < deadline &&
      !extensions.guests!.snapshot(owner).find((entry) => entry.id === view.id)?.failure
    )
      await pause(20)
    if (
      !extensions
        .guests!.snapshot(owner)
        .find((entry) => entry.id === view.id)
        ?.failure?.includes('replaced its page')
    )
      throw new Error(
        `Initial document.${mode} did not fail only the affected view closed`,
      )
    if (
      !(await win.webContents.executeJavaScript(
        'Boolean(document.querySelector(".app-shell"))',
      ))
    )
      throw new Error('Document replacement blocked the trusted workbench')
    extensions.guests!.close(owner, view.id)
  }
}

const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/** Appended only to the owned smoke copy, never the shipped reference package. */
export const EXTENSION_LIFECYCLE_PROBE_SCRIPT = `
  window.extensionInitialTicks = 0;
  window.extensionLifecycleEvents = [];
  document.addEventListener('freeze', () => {
    window.extensionLifecycleEvents.push({ kind: 'freeze', at: performance.now(), ticks: window.extensionInitialTicks });
    if (window.extensionLifecycleEvents.length > 16) window.extensionLifecycleEvents.shift();
  });
  document.addEventListener('resume', () => {
    window.extensionLifecycleEvents.push({ kind: 'resume', at: performance.now(), ticks: window.extensionInitialTicks });
    if (window.extensionLifecycleEvents.length > 16) window.extensionLifecycleEvents.shift();
  });
  const nativeVisibility = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState').get;
  window.addEventListener('visibilitychange', event => {
    if (!event.isTrusted || nativeVisibility.call(document) !== 'visible') return;
    window.extensionLifecycleEvents.push({ kind: 'native-visible', at: performance.now(), ticks: window.extensionInitialTicks });
    if (window.extensionLifecycleEvents.length > 16) window.extensionLifecycleEvents.shift();
  }, true);
  window.addEventListener('visibilitychange', event => {
    if (!event.isTrusted || !window.extensionHostileVisibility) return;
    event.stopImmediatePropagation();
    const until = performance.now() + 200;
    while (performance.now() < until) {}
  }, true);
  setInterval(() => window.extensionInitialTicks++, 20);
`

interface LifecycleEvent {
  kind: string
  at: number
  ticks: number
}
interface LifecycleObservation {
  ticks: number
  events: LifecycleEvent[]
}
const engineCommands = new WeakMap<WebContents, string[]>()

function observeEngineCommands(guest: WebContents): void {
  if (engineCommands.has(guest)) return
  const commands: string[] = []
  engineCommands.set(guest, commands)
  const send = guest.debugger.sendCommand.bind(guest.debugger)
  // Test-owned observation of the existing fixed production transport, no changed commands.
  guest.debugger.sendCommand = async (...args: Parameters<typeof send>) => {
    const result: unknown = await send(...args)
    if (args[0] === 'Page.setWebLifecycleState') {
      commands.push(`${Date.now()} ACK ${JSON.stringify(args[1])}`)
      if (commands.length > 16) commands.shift()
    }
    return result
  }
}

async function observation(guest: WebContents): Promise<LifecycleObservation> {
  const result = (await guest.debugger.sendCommand('Runtime.evaluate', {
    expression:
      '({ticks:window.extensionInitialTicks,events:window.extensionLifecycleEvents})',
    returnByValue: true,
  })) as { result: { value: LifecycleObservation } }
  return result.result.value
}

async function waitForFreeze(
  guest: WebContents,
  requireInvalidation = false,
): Promise<LifecycleObservation> {
  const deadline = Date.now() + EXTENSION_LIMITS.requestTimeoutMs
  while (Date.now() < deadline) {
    const value = await observation(guest)
    const visible = value.events.findLastIndex((event) => event.kind === 'native-visible')
    if (
      (!requireInvalidation || visible >= 0) &&
      value.events.some((event, index) => index > visible && event.kind === 'freeze')
    )
      return value
    await pause(50)
  }
  throw new Error(
    `Guest never observed native freeze: ${JSON.stringify({ observation: await observation(guest), commands: engineCommands.get(guest) })}`,
  )
}

export async function startExtensionTimer(guest: WebContents): Promise<void> {
  observeEngineCommands(guest)
  await guest.executeJavaScript(
    'window.extensionLifecycleEvents = []; window.extensionSmokeTicks = 0; setInterval(() => window.extensionSmokeTicks++, 20)',
  )
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if ((await ticks(guest)) >= 2) return
    await pause(100)
  }
  throw new Error('Visible guest timer positive control did not run')
}

/** Privileged observations use the existing private engine transport: frozen page tasks cannot run. */
export async function verifyHiddenExtensionLifecycle(
  win: BrowserWindow,
  guest: WebContents,
  sibling: WebContents,
): Promise<void> {
  await startExtensionTimer(sibling)
  await win.webContents.executeJavaScript(
    'window.extensionSmokeTicks = 0; setInterval(() => window.extensionSmokeTicks++, 20)',
  )
  const siblingBefore = await ticks(sibling)
  const parentBefore = (await win.webContents.executeJavaScript(
    'window.extensionSmokeTicks',
  )) as number
  const native = await waitForFreeze(guest)
  const frozen = await ticks(guest)
  await pause(2200)
  if (
    (await ticks(sibling)) <= siblingBefore ||
    (await win.webContents.executeJavaScript('window.extensionSmokeTicks')) <=
      parentBefore
  )
    throw new Error('Hidden lifecycle froze an active sibling or trusted workbench')
  if ((await ticks(guest)) !== frozen)
    throw new Error(
      `Inactive guest timer continued running: ${JSON.stringify({ before: native, after: await observation(guest), commands: engineCommands.get(guest) })}`,
    )
  if (!guest.getBackgroundThrottling())
    throw new Error('Guest disabled engine background throttling')
  const bounds = win.getBounds()
  await guest.debugger.sendCommand('Runtime.evaluate', {
    expression:
      'window.extensionLifecycleEvents = []; window.extensionHostileVisibility = true; window.extensionRetainedOneShot = 0; setTimeout(() => window.extensionRetainedOneShot++, 500)',
  })
  win.hide()
  await pause(50)
  win.show()
  win.setSize(bounds.width + 20, bounds.height + 20)
  win.focus()
  const invalidated = await waitForFreeze(guest, true)
  const restored = await ticks(guest)
  await pause(2200)
  if ((await ticks(guest)) !== restored)
    throw new Error(
      `Window restore or sizing resumed an inactive guest: ${JSON.stringify({ before: invalidated, ticks: restored, after: await observation(guest), commands: engineCommands.get(guest) })}`,
    )
  console.log(
    `[smoke] hidden native invalidation re-freeze ${JSON.stringify({ events: invalidated.events, ticksBefore: restored, ticksAfter: await ticks(guest), commands: engineCommands.get(guest) })}`,
  )
  win.setBounds(bounds)
  await pause(150)
  await guest.debugger.sendCommand('Runtime.evaluate', {
    expression: `
    window.hvirExtension.onMessage(m => { if(m.kind === 'result' && m.id === 'hidden-refresh') window.extensionHiddenReply = m });
    window.hvirExtension.send({kind:'request',id:'hidden-refresh',capability:'presentation.read'});
  `,
  })
  for (const appearance of ['light', 'dark', 'light']) {
    await win.webContents.executeJavaScript(
      `document.querySelector('[aria-label="Use ${appearance} theme"]').click()`,
    )
    await pause(50)
  }
  // Selection resumes the same guest; its latest hvir presentation is delivered once active.
  await win.webContents.executeJavaScript(
    `document.querySelector('.tab-main[title="hvir Reference · Extension reference"]').click()`,
  )
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const result = (await guest.debugger.sendCommand('Runtime.evaluate', {
      expression: `({ticks:window.extensionSmokeTicks, appearance:document.documentElement.style.colorScheme, hidden:window.extensionHiddenReply, oneShot:window.extensionRetainedOneShot})`,
      returnByValue: true,
    })) as {
      result: {
        value: {
          ticks: number
          appearance: string
          hidden?: { ok: boolean; error?: string }
          oneShot: number
        }
      }
    }
    if (
      result.result.value.ticks > frozen &&
      result.result.value.appearance === 'light' &&
      result.result.value.oneShot === 1
    ) {
      if (
        result.result.value.hidden?.ok !== false ||
        !result.result.value.hidden.error?.includes('Hidden')
      )
        throw new Error('Hidden guest obtained refresh work')
      await win.webContents.executeJavaScript(
        `document.querySelector('.tab-main[title="hvir Reference · Reference detail"]').click()`,
      )
      return
    }
    await pause(100)
  }
  throw new Error('Guest did not resume with its latest presentation')
}

async function ticks(guest: WebContents): Promise<number> {
  const result = (await guest.debugger.sendCommand('Runtime.evaluate', {
    expression: 'window.extensionSmokeTicks',
    returnByValue: true,
  })) as { result: { value: number } }
  return result.result.value
}

/** Same production owner, surface, preload and IPC; only trusted embedding differs. */
function createExtensionGuestFixture(
  extensions: ExtensionApplicationRuntime,
  scopes: RendererResourceScopes,
) {
  const fixture = new BrowserWindow({
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  })
  const owner = scopes.activateOwner(fixture.webContents.id)
  let guest: WebContents | undefined
  extensions.surface.installWindowLifecycle(fixture, () => owner)
  fixture.webContents.on('will-attach-webview', (event, preferences, params) => {
    if (!extensions.surface.claim(owner, preferences, params)) event.preventDefault()
  })
  fixture.webContents.on('did-attach-webview', (_event, contents) => {
    if (!extensions.surface.attached(owner, contents, () => undefined))
      contents.close({ waitForBeforeUnload: false })
    else guest = contents
  })
  return { fixture, owner, guest: () => guest }
}

export async function verifyInitiallyHiddenExtension(
  extensions: ExtensionApplicationRuntime,
  scopes: RendererResourceScopes,
  installationId: string,
): Promise<void> {
  const captured = createExtensionGuestFixture(extensions, scopes)
  const { fixture, owner } = captured
  let disposeReadiness = (): void => undefined
  try {
    const view = await extensions.guests!.open(owner, installationId, 'reference')
    // Attachment can still have the initial about:blank context. Observe the exact
    // captured document's completed navigation before any privileged evaluation.
    const loaded = new Promise<WebContents>((resolve, reject) => {
      const timer = setTimeout(() => {
        disposeReadiness()
        reject(new Error('Initially hidden captured document did not finish loading'))
      }, EXTENSION_LIMITS.requestTimeoutMs)
      const attached = (_event: Electron.Event, guest: WebContents): void => {
        const ready = (): void => {
          if (guest.getURL() !== view.url) return
          disposeReadiness()
          resolve(guest)
        }
        const closed = (): void => {
          disposeReadiness()
          reject(
            new Error(
              'Initially hidden guest closed before its captured document loaded',
            ),
          )
        }
        disposeReadiness = (): void => {
          clearTimeout(timer)
          fixture.webContents.removeListener('did-attach-webview', attached)
          guest.removeListener('did-finish-load', ready)
          guest.removeListener('destroyed', closed)
        }
        guest.on('did-finish-load', ready)
        guest.once('destroyed', closed)
      }
      disposeReadiness = (): void => {
        clearTimeout(timer)
        fixture.webContents.removeListener('did-attach-webview', attached)
      }
      fixture.webContents.once('did-attach-webview', attached)
    })
    void loaded.catch(() => undefined)
    await fixture.loadURL(
      `data:text/html,${encodeURIComponent(`<webview style="display:flex;width:300px;height:300px" src="${view.url}" name="${view.id}" partition="${view.partition}"></webview>`)}`,
    )
    const guest = await loaded
    const read = async (): Promise<{
      state: string
      ticks?: number
      status?: string
    }> => {
      const result = (await guest.debugger.sendCommand('Runtime.evaluate', {
        expression:
          "({state:document.readyState,ticks:window.extensionInitialTicks,status:document.getElementById('status')?.textContent})",
        returnByValue: true,
      })) as { result: { value: { state: string; ticks?: number; status?: string } } }
      return result.result.value
    }
    observeEngineCommands(guest)
    await waitForFreeze(guest)
    const initial = await read()
    if (initial.state !== 'complete' || typeof initial.ticks !== 'number')
      throw new Error('Initially hidden guest did not finish its captured document')
    await pause(2200)
    if ((await read()).ticks !== initial.ticks)
      throw new Error('Initially hidden document ran timers after loading')
    extensions.guests!.presentation(owner, view.id, DEFAULT_EXTENSION_PRESENTATION, true)
    fixture.show()
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      const next = await read()
      if (next.ticks! > initial.ticks && next.status === 'Connected · contract 1.0')
        return
      await pause(100)
    }
    throw new Error('Initially hidden guest could not resume public negotiation')
  } finally {
    disposeReadiness()
    await scopes.revokeOwner(owner.id)
    if (!fixture.isDestroyed()) fixture.destroy()
  }
}

/** Fault only the fixed Page.enable operation on a real guest; preserve every other engine operation. */
export async function verifyExtensionEngineStartup(
  extensions: ExtensionApplicationRuntime,
  scopes: RendererResourceScopes,
  installationId: string,
  control: WebContents,
): Promise<void> {
  const admitted = await control.session.fetch(control.getURL())
  const admittedBytes = await admitted.text()
  if (!admitted.ok || !admittedBytes.includes('reference.js'))
    throw new Error('Engine startup Session.fetch positive asset control failed')
  for (const mode of ['refuse', 'close']) {
    const captured = createExtensionGuestFixture(extensions, scopes)
    const { fixture, owner } = captured
    let settle: (() => void) | undefined
    let setupStarted = false
    let observedAsset: Promise<string> | undefined
    let viewUrl = ''
    fixture.webContents.prependOnceListener(
      'did-attach-webview',
      (_event: Electron.Event, guest: WebContents) => {
        const send = guest.debugger.sendCommand.bind(guest.debugger)
        guest.debugger.sendCommand = (method, ...args) => {
          if (method !== 'Page.enable') return send(method, ...args)
          setupStarted = true
          if (mode === 'refuse') return Promise.reject(new Error('Owned setup refusal'))
          return new Promise((resolve) => {
            settle = () => resolve({})
          })
        }
        observedAsset = guest.session.fetch(viewUrl).then(
          (response) => response.text(),
          () => 'unavailable',
        )
      },
    )
    try {
      const view = await extensions.guests!.open(owner, installationId, 'reference')
      viewUrl = view.url
      await fixture.loadURL(
        `data:text/html,${encodeURIComponent(`<webview style="display:flex;width:300px;height:300px" src="${view.url}" name="${view.id}" partition="${view.partition}"></webview>`)}`,
      )
      const deadline = Date.now() + EXTENSION_LIMITS.requestTimeoutMs
      while (!setupStarted && Date.now() < deadline) await pause(20)
      if (!setupStarted) throw new Error('Guest engine setup never began')
      if (mode === 'close') {
        extensions.guests!.close(owner, view.id)
        settle!() // A late fixed setup success cannot reopen captured asset authority.
      }
      while (
        Date.now() < deadline &&
        captured.guest() &&
        !captured.guest()!.isDestroyed()
      )
        await pause(20)
      if (captured.guest() && !captured.guest()!.isDestroyed())
        throw new Error('Failed or canceled engine setup retained a guest')
      if (
        mode === 'refuse' &&
        !extensions.guests!.snapshot(owner).find((entry) => entry.id === view.id)?.failure
      )
        throw new Error('Engine setup refusal lacked an actionable failed view')
      let timer: ReturnType<typeof setTimeout> | undefined
      const asset = await Promise.race([
        observedAsset!,
        new Promise<string>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('Canceled captured response did not settle')),
            EXTENSION_LIMITS.requestTimeoutMs,
          )
        }),
      ]).finally(() => clearTimeout(timer))
      if (asset === admittedBytes || asset.includes('reference.js'))
        throw new Error('Revoked engine setup served captured package bytes')
      console.log(`[smoke] fixed engine setup ${mode} released no captured bytes`)
    } finally {
      settle?.()
      await scopes.revokeOwner(owner.id)
      if (!fixture.isDestroyed()) fixture.destroy()
    }
  }
}
