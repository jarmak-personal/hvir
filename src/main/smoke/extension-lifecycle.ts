import { BrowserWindow, type WebContents } from 'electron'
import type { ExtensionApplicationRuntime } from '../extensions/extension-application'
import { EXTENSION_LIMITS } from '../../shared/extensions/contract'
import { DEFAULT_EXTENSION_PRESENTATION } from '../extensions/guest-owner'
import type { RendererResourceScopes } from '../renderer-resource-scopes'

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

async function waitForFreeze(guest: WebContents): Promise<LifecycleObservation> {
  const deadline = Date.now() + EXTENSION_LIMITS.requestTimeoutMs
  while (Date.now() < deadline) {
    const value = await observation(guest)
    if (value.events.some((event) => event.kind === 'freeze')) return value
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
  win.hide()
  await pause(50)
  win.show()
  win.setSize(bounds.width + 20, bounds.height + 20)
  win.focus()
  await pause(250)
  const restored = await ticks(guest)
  await pause(2200)
  if ((await ticks(guest)) !== restored)
    throw new Error(
      `Window restore or sizing resumed an inactive guest: ${JSON.stringify({ before: restored, after: await observation(guest), commands: engineCommands.get(guest) })}`,
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
      expression: `({ticks:window.extensionSmokeTicks, appearance:document.documentElement.style.colorScheme, hidden:window.extensionHiddenReply})`,
      returnByValue: true,
    })) as {
      result: {
        value: {
          ticks: number
          appearance: string
          hidden?: { ok: boolean; error?: string }
        }
      }
    }
    if (
      result.result.value.ticks > frozen &&
      result.result.value.appearance === 'light'
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

/** Same production storage, owner, surface, preload and IPC; only the trusted embedding fixture differs. */
export async function verifyInitiallyHiddenExtension(
  extensions: ExtensionApplicationRuntime,
  scopes: RendererResourceScopes,
  installationId: string,
): Promise<void> {
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
  try {
    const view = await extensions.guests!.open(owner, installationId, 'reference')
    await fixture.loadURL(
      `data:text/html,${encodeURIComponent(`<webview style="display:flex;width:300px;height:300px" src="${view.url}" name="${view.id}" partition="${view.partition}"></webview>`)}`,
    )
    let deadline = Date.now() + 10_000
    while (!guest && Date.now() < deadline) await pause(20)
    if (!guest) throw new Error('Initially hidden guest did not bind')
    const read = async (): Promise<{
      state: string
      ticks?: number
      status?: string
    }> => {
      try {
        const result = (await guest!.debugger.sendCommand('Runtime.evaluate', {
          expression:
            "({state:document.readyState,ticks:window.extensionInitialTicks,status:document.getElementById('status')?.textContent})",
          returnByValue: true,
        })) as { result: { value: { state: string; ticks?: number; status?: string } } }
        return result.result.value
      } catch (reason) {
        if (
          reason instanceof Error &&
          reason.message.includes('Cannot find default execution context')
        )
          return { state: 'loading' }
        throw reason
      }
    }
    while (Date.now() < deadline && (await read()).state !== 'complete') await pause(50)
    observeEngineCommands(guest)
    await waitForFreeze(guest)
    const loaded = await read()
    if (loaded.state !== 'complete' || typeof loaded.ticks !== 'number')
      throw new Error('Initially hidden guest did not finish its captured document')
    await pause(2200)
    if ((await read()).ticks !== loaded.ticks)
      throw new Error('Initially hidden document ran timers after loading')
    extensions.guests!.presentation(owner, view.id, DEFAULT_EXTENSION_PRESENTATION, true)
    fixture.show()
    deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      const next = await read()
      if (next.ticks! > loaded.ticks && next.status === 'Connected · contract 1.0') return
      await pause(100)
    }
    throw new Error('Initially hidden guest could not resume public negotiation')
  } finally {
    await scopes.revokeOwner(owner.id)
    if (!fixture.isDestroyed()) fixture.destroy()
  }
}
