import { app, type BrowserWindow, type WebContents } from 'electron'
import { join } from 'node:path'
import { localPath, joinHostPath } from '../../shared/host-path'
import type { ExtensionView } from '../../shared/extensions/workbench'
import type { ProjectHost } from '../project-host/project-host'
import type { ExtensionApplicationRuntime } from '../extensions/extension-application'
import type { RendererResourceScopes } from '../renderer-resource-scopes'
import { ExtensionAuthoring } from '../extensions/extension-authoring'
import { parseAgentCommand } from '../../shared/agent/commands'

/** Real shipped starter through ordinary development-link Settings and native guest lifetimes. */
export async function verifyExtensionAuthoring(
  win: BrowserWindow,
  extensions: ExtensionApplicationRuntime,
  scopes: RendererResourceScopes,
  host: ProjectHost,
  controls: {
    click(name: string): Promise<void>
    wait(predicate: () => boolean | Promise<boolean>, label: string): Promise<void>
    guest(view: ExtensionView): Promise<WebContents>
  },
): Promise<void> {
  const owner = extensions.activations!
  const assets = localPath(
    app.isPackaged
      ? join(process.resourcesPath, 'extension-authoring')
      : join(app.getAppPath(), 'packages/extension-authoring'),
  )
  const author = joinHostPath(owner.packages.root, '..', 'smoke-clock')
  const authoring = new ExtensionAuthoring(host, assets)
  if (
    (await authoring.command(parseAgentCommand(['scaffold', '--output', author.path])))
      .exitStatus !== 0
  )
    throw new Error('Shipped starter scaffold failed')
  if (
    (await authoring.command(parseAgentCommand(['validate', '--path', author.path])))
      .exitStatus !== 0
  )
    throw new Error('Shipped starter validation failed')
  const link = joinHostPath(owner.directory, 'clock-development')
  if ((await host.exec('ln', ['-s', author.path, link.path])).code !== 0)
    throw new Error('Clock development link failed')
  await controls.click('Discover extensions')
  await controls.wait(() => !!candidate(), 'clock development discovery')
  if (candidate()!.enabled || candidate()!.error || candidate()!.kind !== 'development')
    throw new Error('Discovery implicitly enabled or rejected clock')
  await selected('Enable')
  await controls.wait(
    () =>
      [...owner.active.values()].some(
        (entry) => entry.revision.manifest.id === 'hvir.clock',
      ),
    'explicit clock Enable',
  )
  await controls.click('Open Clock')
  const renderer = scopes.currentOwner(win.webContents.id)
  await controls.wait(() => !!clockView(), 'clock guest placement')
  const guest = await controls.guest(clockView()!)
  await controls.wait(
    async () =>
      (await guest.executeJavaScript(
        "document.getElementById('status')?.textContent",
      )) === 'Connected · contract 1.0',
    'starter public handshake',
  )
  const time = async (): Promise<string> => {
    const result = (await guest.debugger.sendCommand('Runtime.evaluate', {
      expression: "document.getElementById('clock')?.dateTime",
      returnByValue: true,
    })) as { result: { value?: string } }
    return result.result.value ?? ''
  }
  await controls.wait(async () => !!(await time()), 'visible starter time')
  await guest.executeJavaScript(`window.clockSmokeVisible = undefined;
    window.clockSmokeStop = window.hvirExtension.onMessage(message => { if (message.kind === 'context') window.clockSmokeVisible = message.context.visible; }); void 0;`)
  const observedVisible = async (): Promise<boolean | undefined> => {
    const result = (await guest.debugger.sendCommand('Runtime.evaluate', {
      expression: 'window.clockSmokeVisible',
      returnByValue: true,
    })) as { result: { value?: boolean } }
    return result.result.value
  }
  const first = await time()
  await controls.wait(
    async () => (await time()) !== first,
    'ordinary visible starter timer',
  )
  await controls.click('Open settings')
  await controls.click('Extensions')
  await controls.wait(
    async () => (await observedVisible()) === false,
    'hidden starter context',
  )
  const hidden = await time()
  // The observation window spans a real ordinary tick; it is not used as startup readiness.
  await new Promise((resolve) => setTimeout(resolve, 1250))
  if ((await time()) !== hidden)
    throw new Error('Hidden starter continued ordinary refresh')
  await controls.click('Close settings')
  await controls.wait(
    async () => (await observedVisible()) === true && (await time()) !== hidden,
    'starter current time on resume',
  )
  await controls.click('Open settings')
  await controls.click('Extensions')
  await guest.debugger.sendCommand('Runtime.evaluate', {
    expression:
      'window.clockSmokeStop(); delete window.clockSmokeStop; delete window.clockSmokeVisible; void 0',
  })
  const original = (await host.readFile(joinHostPath(author, 'index.html'))).toString(
    'utf8',
  )
  await host.writeFile(
    joinHostPath(author, 'index.html'),
    original.replace('<h1>Clock</h1>', '<h1>Edited clock</h1>'),
  )
  await selected('Reload')
  await controls.wait(() => guest.isDestroyed(), 'Reload revokes old starter')
  await controls.click('Open Clock')
  await controls.wait(() => !!clockView(), 'reloaded starter placement')
  const reloaded = await controls.guest(clockView()!)
  await controls.wait(
    async () =>
      (await reloaded.executeJavaScript("document.querySelector('h1')?.textContent")) ===
      'Edited clock',
    'author edit in actual guest',
  )
  await controls.click('Open settings')
  await controls.click('Extensions')
  await selected('Remove')
  await controls.wait(
    async () =>
      !!(await win.webContents.executeJavaScript(
        'document.querySelector(".modal-backdrop.nested")',
      )),
    'clock removal decision',
  )
  await controls.click('Confirm remove')
  await controls.wait(
    () =>
      reloaded.isDestroyed() &&
      ![...owner.active.values()].some(
        (entry) => entry.revision.manifest.id === 'hvir.clock',
      ),
    'clock Remove revocation',
  )
  await controls.wait(
    async () =>
      !(await host.readdir(owner.directory)).some(
        (entry) => entry.name === 'clock-development',
      ),
    'clock link-only removal',
  )
  if (
    !(await host.readFile(joinHostPath(author, 'index.html')))
      .toString('utf8')
      .includes('Edited clock')
  )
    throw new Error('Clock Remove deleted author files')
  console.log(
    '[smoke] shipped clock scaffold/validate, explicit development Enable, visible/hidden/resume, edited Reload and link-only Remove OK',
  )
  function candidate() {
    return owner
      .snapshot()
      .installations.find((entry) => entry.source === 'clock-development')
  }
  function clockView() {
    return extensions.guests!.snapshot(renderer).find((entry) => entry.title === 'Clock')
  }
  async function selected(name: string): Promise<void> {
    await controls.wait(
      async () =>
        Boolean(
          await win.webContents.executeJavaScript(`(() => {
      const article = [...document.querySelectorAll('.extension-installation')].find(element => element.textContent.includes('Source: clock-development'));
      const button = [...(article?.querySelectorAll('button') ?? [])].find(element => element.textContent.trim() === ${JSON.stringify(name)});
      if (!button || button.disabled) return false; button.click(); return true;
    })()`),
        ),
      `selected clock ${name}`,
    )
  }
}
