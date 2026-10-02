import { ZipFile } from 'yazl'
import type { BrowserWindow, WebContents } from 'electron'
import { joinHostPath } from '../../shared/host-path'
import type { ProjectHost } from '../project-host/project-host'
import type { ExtensionApplicationRuntime } from '../extensions/extension-application'
import type { RendererResourceScopes } from '../renderer-resource-scopes'
import type { ExtensionView } from '../../shared/extensions/workbench'

/** Real Settings revision controls and the existing real guest, with no alternate application root. */
export async function verifyExtensionPackages(
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
  const directory = owner.directory
  const reference = joinHostPath(directory, 'reference')
  const initial = [...owner.active.values()][0]
  if (initial) throw new Error('Package walkthrough must start after trusted Disable')
  const installation = owner
    .snapshot()
    .installations.find((entry) => entry.source === 'reference')!
  const installationId = installation.installationId!
  const index = joinHostPath(reference, 'index.html')
  const changed = `${(await host.readFile(index)).toString('utf8')}<p id="package-reloaded">Reloaded author bytes</p>`
  await host.writeFile(index, changed)
  await controls.click('Reload')
  await controls.wait(
    () =>
      owner.active.size === 1 &&
      [...owner.active.values()][0]!.revision.hash !== installation.acceptedRevision,
    'directory Reload accepts edited bytes',
  )
  await controls.click('Open Extension reference')
  const renderer = scopes.currentOwner(win.webContents.id)
  await controls.wait(
    () => extensions.guests!.snapshot(renderer).length === 1,
    'reloaded guest',
  )
  const priorView = extensions.guests!.snapshot(renderer)[0]!
  const priorGuest = await controls.guest(priorView)
  await controls.wait(
    async () =>
      (await priorGuest.executeJavaScript(
        "document.getElementById('package-reloaded')?.textContent",
      )) === 'Reloaded author bytes',
    'reloaded revision visible',
  )
  await controls.click('Open settings')
  await controls.click('Extensions')
  await remove('reference', false)
  await controls.wait(
    () => priorGuest.isDestroyed() && owner.active.size === 0,
    'Remove revokes old guest before package cleanup',
  )
  if ((await host.readdir(directory)).some((entry) => entry.name === 'reference'))
    throw new Error('Directory remained after recoverable removal')
  const zip = new ZipFile()
  const captured = await owner.packages.load(
    owner.snapshot().installations.find((entry) => entry.source === 'reference')!
      .acceptedRevision!,
  )
  for (const [name, bytes] of captured.files) zip.addBuffer(Buffer.from(bytes), name)
  zip.end()
  const chunks: Buffer[] = []
  for await (const chunk of zip.outputStream) chunks.push(chunk as Buffer)
  const zipPath = joinHostPath(directory, 'reference.zip')
  await host.writeFile(zipPath, Buffer.concat(chunks))
  await controls.click('Discover extensions')
  await controls.wait(
    () =>
      !!owner.snapshot().installations.find((entry) => entry.source === 'reference.zip'),
    'ZIP discovery',
  )
  const candidate = owner
    .snapshot()
    .installations.find((entry) => entry.source === 'reference.zip')!
  if (candidate.enabled || candidate.installationId !== installationId || candidate.error)
    throw new Error('Reappearing ZIP identity or activation was incorrect')
  await controls.click('Enable')
  await controls.wait(() => owner.active.has(installationId), 'ZIP explicit Enable')
  await controls.click('Open Extension reference')
  await controls.wait(
    () => extensions.guests!.snapshot(renderer).length === 1,
    'ZIP guest',
  )
  const zipGuest = await controls.guest(extensions.guests!.snapshot(renderer)[0]!)
  await controls.wait(
    async () =>
      (await zipGuest.executeJavaScript(
        "document.getElementById('package-reloaded')?.textContent",
      )) === 'Reloaded author bytes',
    'same ZIP content in real guest',
  )
  await controls.click('Open settings')
  await controls.click('Extensions')
  await controls.click('Replace')
  await controls.wait(
    () => zipGuest.isDestroyed() && owner.active.has(installationId),
    'Replace revokes stale ZIP guest',
  )
  await remove('reference.zip', false)
  const author = joinHostPath(directory, 'author')
  await host.createDirectoryExclusive(author, { mode: 0o755 })
  for (const [name, bytes] of captured.files)
    await host.writeFile(joinHostPath(author, name), bytes)
  // Author directory is moved outside discovery; creation uses the existing host command boundary.
  const externalAuthor = joinHostPath(owner.packages.root, '..', 'smoke-author')
  await host.fileTransfer!.renameNoReplace(author, externalAuthor)
  const link = joinHostPath(directory, 'development')
  const result = await host.exec('ln', ['-s', externalAuthor.path, link.path])
  if (result.code !== 0) throw new Error('Development-link fixture could not be prepared')
  await controls.click('Discover extensions')
  await controls.wait(
    () =>
      owner
        .snapshot()
        .installations.some(
          (entry) => entry.source === 'development' && entry.kind === 'development',
        ),
    'development discovery',
  )
  await controls.click('Enable')
  await controls.wait(() => owner.active.has(installationId), 'development Enable')
  await host.writeFile(
    joinHostPath(externalAuthor, 'index.html'),
    `${changed}<p id="development-edited">Linked author edit</p>`,
  )
  await controls.click('Reload')
  await controls.click('Open Extension reference')
  await controls.wait(
    () => extensions.guests!.snapshot(renderer).length === 1,
    'development guest',
  )
  const devGuest = await controls.guest(extensions.guests!.snapshot(renderer)[0]!)
  await controls.wait(
    async () =>
      (await devGuest.executeJavaScript(
        "document.getElementById('development-edited')?.textContent",
      )) === 'Linked author edit',
    'development edit visible',
  )
  await controls.click('Open settings')
  await controls.click('Extensions')
  await remove('development', true)
  await controls.wait(
    () => devGuest.isDestroyed() && owner.active.size === 0,
    'development removal revokes guest',
  )
  if (
    (await host.readFile(joinHostPath(externalAuthor, 'index.html')))
      .toString('utf8')
      .indexOf('Linked author edit') < 0
  )
    throw new Error('Development removal deleted author files')
  console.log(
    '[smoke] directory Reload, same ZIP Enable/Replace, durable identity and development edit/link-only Remove OK',
  )

  async function remove(source: string, forget: boolean): Promise<void> {
    await controls.wait(
      async () =>
        Boolean(
          await win.webContents.executeJavaScript(`(() => {
      const article = [...document.querySelectorAll('.extension-installation')].find((element) => element.textContent.includes(${JSON.stringify(`Source: ${source}`)}));
      const button = [...(article?.querySelectorAll('button') ?? [])].find((element) => element.textContent.trim() === 'Remove');
      if (!button || button.disabled) return false; button.click(); return true;
    })()`),
        ),
      'selected ordinary Remove control',
    )
    await controls.wait(
      async () =>
        Boolean(
          await win.webContents.executeJavaScript(
            'document.querySelector(".modal-backdrop.nested input[type=checkbox]")',
          ),
        ),
      'nested Remove decision',
    )
    if (forget)
      await win.webContents.executeJavaScript(
        'document.querySelector(".modal-backdrop.nested input[type=checkbox]").click()',
      )
    await controls.click('Confirm remove')
    await controls.wait(
      async () =>
        !(await win.webContents.executeJavaScript(
          'document.querySelector(".modal-backdrop.nested")',
        )),
      'Remove cleanup completion',
    )
  }
}
