import type { BrowserWindow, WebContents } from 'electron'
import { joinHostPath, type HostPath } from '../../shared/host-path'
import type { ExtensionManifest } from '../../shared/extensions/contract'
import type { ExtensionView } from '../../shared/extensions/workbench'
import type { ProjectHost } from '../project-host/project-host'
import type { RendererResourceScopes } from '../renderer-resource-scopes'
import type { ExtensionApplicationRuntime } from '../extensions/extension-application'
import { focusSmokeWindow } from './window-focus'

interface ConnectorControls {
  click(name: string): Promise<void>
  wait(predicate: () => boolean | Promise<boolean>, label: string): Promise<void>
  guest(view: ExtensionView): Promise<WebContents>
}

/** Real process, trusted native decision, ordinary directory package and public guest operation. */
export async function verifyExtensionConnectors(
  win: BrowserWindow,
  extensions: ExtensionApplicationRuntime,
  scopes: RendererResourceScopes,
  host: ProjectHost,
  source: HostPath,
  controls: ConnectorControls,
): Promise<void> {
  const activation = extensions.activations!,
    guests = extensions.guests!
  const directory = joinHostPath(activation.directory, 'connector-reference')
  await host.createDirectoryExclusive(directory, { mode: 0o755 })
  for (const entry of await host.readdir(source))
    await host.writeFile(
      joinHostPath(directory, entry.name),
      await host.readFile(joinHostPath(source, entry.name)),
    )
  // Distinct ordinary package identity avoids ambiguity with the earlier reference fixtures.
  const manifestPath = joinHostPath(directory, 'hvir-extension.json')
  const manifest = JSON.parse(
    (await host.readFile(manifestPath)).toString('utf8'),
  ) as ExtensionManifest
  await host.writeFile(
    manifestPath,
    JSON.stringify({
      ...manifest,
      id: 'hvir.connector-reference',
      name: 'Connector reference',
      actions: [],
    }),
  )
  const tool = joinHostPath(directory, '..', '..', 'connector-evidence-tool')
  const marker = joinHostPath(directory, '..', '..', 'connector-evidence-count')
  await host.createFileExclusive(tool, { mode: 0o755 })
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  await host.writeFile(
    tool,
    `#!/bin/sh\nprintf x >> ${quote(marker.path)}\nprintf 'connector evidence\\n'\n`,
  )
  await controls.click('Discover extensions')
  await controls.wait(
    () =>
      activation
        .snapshot()
        .installations.some((entry) => entry.source === 'connector-reference'),
    'connector reference discovery',
  )
  if (await exists(marker)) throw new Error('Discovery executed the declared connector')
  await clickInInstallation('Enable')
  await controls.wait(
    () =>
      [...activation.active.values()].some(
        (entry) => entry.revision.manifest.id === 'hvir.connector-reference',
      ),
    'connector reference Enable',
  )
  const current = [...activation.active.values()].find(
    (entry) => entry.revision.manifest.id === 'hvir.connector-reference',
  )!
  await clickInInstallation('Open Extension reference')
  await controls.click('Close settings')
  const owner = scopes.currentOwner(win.webContents.id)
  await controls.wait(
    () =>
      guests
        .snapshot(owner)
        .some(
          (view) =>
            view.installationId === current.installationId &&
            view.contributionId === 'reference',
        ),
    'connector guest placement',
  )
  const view = guests
    .snapshot(owner)
    .find(
      (entry) =>
        entry.installationId === current.installationId &&
        entry.contributionId === 'reference',
    )!
  const guest = await controls.guest(view)
  await controls.wait(
    async () =>
      guest.executeJavaScript(
        "document.getElementById('native-run')?.disabled === false",
      ) as Promise<boolean>,
    'native public capability negotiation',
  )
  await controls.wait(
    () =>
      guest.executeJavaScript(
        "document.getElementById('native-run')?.disabled === false",
      ) as Promise<boolean>,
    'native run control ready',
  )
  await guest.executeJavaScript("document.getElementById('native-run').click()")
  await controls.wait(
    async () =>
      (
        (await guest.executeJavaScript(
          "document.getElementById('native-status')?.textContent",
        )) as string | undefined
      )?.includes('not-started') === true,
    'unapproved native refusal',
  )
  if (await exists(marker))
    throw new Error('Unapproved guest request executed native code')
  await controls.click('Open settings')
  await controls.click('Extensions')
  console.log('[smoke] native connector unapproved refusal OK; opening trusted setup')
  await setValue('Executable for installed-tool', tool.path)
  console.log('[smoke] native connector executable configured')
  await clickInInstallation('Inspect native access')
  await controls.wait(
    () =>
      dom(
        "[...document.querySelectorAll('.extension-installation')].find(e=>e.querySelector('h4')?.textContent==='Connector reference')?.textContent.includes('Approve local:')",
      ),
    'canonical native trust decision',
  )
  if (await exists(marker)) throw new Error('Native inspection probed the executable')
  console.log('[smoke] native connector canonical decision ready')
  await clickInInstallation('Approve native execution')
  await controls.wait(
    () =>
      extensions.connectors!.approvals.status(current)[0]?.availability === 'supported',
    'native approval persisted',
  )
  await controls.click('Close settings')
  await focusSmokeWindow(win)
  await controls.wait(
    () =>
      guest.executeJavaScript(
        "document.getElementById('native-run')?.disabled === false",
      ) as Promise<boolean>,
    'native run control ready',
  )
  await guest.executeJavaScript("document.getElementById('native-run').click()")
  await controls.wait(
    async () =>
      (
        (await guest.executeJavaScript(
          "document.getElementById('native-status')?.textContent",
        )) as string | undefined
      )?.includes('completed') === true,
    'approved native public result',
  )
  const output = (await guest.executeJavaScript(
    "document.getElementById('native-output')?.textContent",
  )) as string | undefined
  if (output !== 'connector evidence\n')
    throw new Error('Connector result was not displayed through ordinary public controls')
  await controls.wait(
    () =>
      extensions
        .contributions!.snapshot()
        .find((entry) => entry.installationId === current.installationId)
        ?.values.some(
          (entry) => entry.item === 'pulse' && entry.label === 'Tool exit 0',
        ) === true,
    'approved updater observation without popup',
  )
  if (
    guests
      .snapshot(owner)
      .filter(
        (entry) =>
          entry.installationId === current.installationId && entry.role === 'updater',
      ).length !== 1 ||
    guests
      .snapshot(owner)
      .some(
        (entry) =>
          entry.installationId === current.installationId &&
          entry.context?.surface === 'popup',
      )
  )
    throw new Error('Connector observation required a popup or duplicate updater')
  await controls.click('Open settings')
  await controls.click('Extensions')
  await clickInInstallation('Revoke native access')
  await controls.wait(
    () =>
      extensions.connectors!.approvals.status(current)[0]?.availability === 'unavailable',
    'native approval revoked',
  )
  const count = (await host.readFile(marker)).length
  await controls.click('Close settings')
  await controls.wait(
    () =>
      guest.executeJavaScript(
        "document.getElementById('native-run')?.disabled === false",
      ) as Promise<boolean>,
    'native run control ready',
  )
  await guest.executeJavaScript("document.getElementById('native-run').click()")
  await controls.wait(
    async () =>
      (
        (await guest.executeJavaScript(
          "document.getElementById('native-status')?.textContent",
        )) as string | undefined
      )?.includes('not-started') === true,
    'revoked native refusal',
  )
  if ((await host.readFile(marker)).length !== count)
    throw new Error('Revoked connector started new native work')
  await controls.click('Open settings')
  await controls.click('Extensions')
  await clickInInstallation('Disable')
  await controls.wait(
    () => !activation.active.has(current.installationId),
    'connector reference Disable',
  )
  console.log(
    '[smoke] native connector discovery/unapproved/probe denial, canonical Settings decision, public result, shared updater without popup and revocation OK',
  )

  async function exists(path: HostPath): Promise<boolean> {
    try {
      await host.stat(path)
      return true
    } catch {
      return false
    }
  }
  async function dom(expression: string): Promise<boolean> {
    return win.webContents.executeJavaScript(`Boolean(${expression})`) as Promise<boolean>
  }
  async function clickInInstallation(name: string): Promise<void> {
    await controls.wait(
      () =>
        dom(
          `(() => { const article=[...document.querySelectorAll('.extension-installation')].find(e=>e.querySelector('h4')?.textContent==='Connector reference'); const button=[...(article?.querySelectorAll('button')??[])].find(e=>e.textContent.trim()===${JSON.stringify(name)}); if(!button || button.disabled)return false;button.click();return true })()`,
        ),
      `connector control ${name}`,
    )
  }
  async function setValue(label: string, value: string): Promise<void> {
    const selector = JSON.stringify(`[aria-label="${label}"]`)
    await controls.wait(
      () =>
        dom(
          `(() => { const article=[...document.querySelectorAll('.extension-installation')].find(e=>e.querySelector('h4')?.textContent==='Connector reference'); return !!article?.querySelector(${selector}) })()`,
        ),
      'native connector input readiness',
    )
    const result = (await win.webContents.executeJavaScript(`(() => {
      const article=[...document.querySelectorAll('.extension-installation')].find(e=>e.querySelector('h4')?.textContent==='Connector reference');
      const input=article?.querySelector(${selector});
      const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')?.set;
      if(!input || !setter) return {ready:false};
      setter.call(input,${JSON.stringify(value)});
      input.dispatchEvent(new Event('input',{bubbles:true}));
      return {ready:true};
    })()`)) as { ready: boolean }
    if (!result.ready)
      throw new Error('Native connector input readiness ended before interaction')
  }
}
