import { extensionSettingsControls } from './extension-settings-controls'
import { ZipFile } from 'yazl'
import type { BrowserWindow } from 'electron'
import { joinHostPath } from '../../shared/host-path'
import type { ProjectHost } from '../project-host/project-host'
import type { RendererResourceScopes } from '../renderer-resource-scopes'
import type { ExtensionApplicationRuntime } from '../extensions/extension-application'
import { ExtensionPackageAdditionOwner } from '../extensions/package-addition'
import { createElectronPackagePicker } from '../extensions/electron-package-picker'

/** Ordinary Settings flow with only the native-dialog return replaced by owned selections. */
export async function verifyExtensionImport(
  win: BrowserWindow,
  extensions: ExtensionApplicationRuntime,
  scopes: RendererResourceScopes,
  host: ProjectHost,
  controls: {
    click(name: string): Promise<void>
    wait(predicate: () => boolean | Promise<boolean>, label: string): Promise<void>
  },
): Promise<void> {
  const activations = extensions.activations!,
    original = extensions.additions
  const root = joinHostPath(activations.packages.root, '..', 'smoke-import-sources')
  await host.createDirectoryExclusive(root, { mode: 0o755 })
  let selection: string | undefined,
    calls = 0
  const picker = createElectronPackagePicker((owner, options) => {
    scopes.assertCurrent(owner)
    if (
      owner.id !== win.webContents.id ||
      options.buttonLabel !== 'Add extension' ||
      options.properties?.includes('multiSelections')
    )
      throw new Error(
        'Add did not reach the single native-picker boundary for its current window',
      )
    calls++
    return Promise.resolve({
      canceled: selection === undefined,
      filePaths: selection ? [selection] : [],
    })
  })
  extensions.additions = new ExtensionPackageAdditionOwner(scopes, activations, picker)
  try {
    const before = activations.snapshot().installations.length
    await controls.click('Add extension…')
    await controls.wait(() => calls === 1, 'Add reaches native picker cancellation')
    await controls.wait(() => ready(), 'Add cancellation settles')
    if (activations.snapshot().installations.length !== before)
      throw new Error('Cancelled Add changed package discovery')
    for (const kind of ['directory', 'zip'] as const) {
      const name = `imported-${kind}`,
        files = new Map([
          [
            'hvir-extension.json',
            Buffer.from(
              JSON.stringify({
                id: `hvir.smoke-import-${kind}`,
                name,
                version: '0.3.0',
                contract: '1.0',
                requiredCapabilities: [],
                optionalCapabilities: [],
                access: [],
                views: [
                  {
                    id: 'view',
                    title: name,
                    entry: 'index.html',
                    placement: 'application',
                    representations: ['view'],
                  },
                ],
              }),
            ),
          ],
          [
            'index.html',
            Buffer.from(
              '<!doctype html><script>throw new Error("Import must not execute")</script>',
            ),
          ],
          ['assets/support.txt', Buffer.from('owned support')],
        ])
      const source = joinHostPath(root, kind === 'zip' ? `${name}.zip` : name)
      if (kind === 'directory') {
        await host.createDirectoryExclusive(source, { mode: 0o755 })
        await host.createDirectoryExclusive(joinHostPath(source, 'assets'), {
          mode: 0o755,
        })
        for (const [name, bytes] of files)
          await host.writeFile(joinHostPath(source, name), bytes)
      } else await host.writeFile(source, await zip(files))
      const sourceIdentity = await host.extensionStorage!.entryIdentity(source)
      const expected = await activations.packages.captureSource(source)
      selection =
        kind === 'directory' && process.platform !== 'darwin'
          ? joinHostPath(source, 'hvir-extension.json').path
          : source.path
      const active = activations.active.size
      await controls.click('Add extension…')
      await controls.wait(
        async () =>
          (await win.webContents.executeJavaScript(`(() => {
          const entry=[...document.querySelectorAll('.extension-installation-list button')].find(e=>e.querySelector('strong')?.textContent===${JSON.stringify(name)});
          return entry?.getAttribute('aria-current')==='true'&&document.querySelector('.extension-installation h4')?.textContent===${JSON.stringify(name)};
        })()`)) === true,
        `Add ${kind} selects the imported package without a helper click`,
      )
      await extensionSettingsControls(win, name, {
        wait: (predicate, label) => controls.wait(predicate, label),
        within: (work) => work,
      }).select()
      await controls.wait(async () => {
        const entry = activations
          .snapshot()
          .installations.find(
            (entry) => entry.manifest?.id === `hvir.smoke-import-${kind}`,
          )
        return (
          !!entry &&
          !entry.error &&
          !!(await win.webContents.executeJavaScript(`(() => {
          const entry = [...document.querySelectorAll('.extension-installation')].find(item => item.querySelector('h4')?.textContent === ${JSON.stringify(name)});
          return !!entry && entry.checkVisibility() && [...entry.querySelectorAll('button')].some(button => button.textContent.trim() === 'Enable' && !button.disabled);
        })()`))
        )
      }, `Add ${kind} auto-discovers inactive candidate`)
      const entry = activations
        .snapshot()
        .installations.find(
          (entry) => entry.manifest?.id === `hvir.smoke-import-${kind}`,
        )!
      if (
        entry.enabled ||
        activations.active.size !== active ||
        (await host.extensionStorage!.entryIdentity(source)) !== sourceIdentity
      )
        throw new Error('Import enabled code or replaced the author source')
      const copy = await activations.packages.captureSource(
        joinHostPath(activations.directory, entry.source),
      )
      if (
        copy.hash !== expected.hash ||
        (await activations.packages.captureSource(source)).hash !== expected.hash
      )
        throw new Error(
          'Imported or author package bytes differ from the selected complete capture',
        )
      if (
        kind === 'zip' &&
        !(await host.readFile(source)).equals(
          await host.readFile(joinHostPath(activations.directory, entry.source)),
        )
      )
        throw new Error('ZIP import did not preserve archive bytes')
      await controls.wait(
        async () =>
          Boolean(
            await win.webContents.executeJavaScript(`(() => {
        const entry = [...document.querySelectorAll('.extension-installation')].find(item => item.querySelector('h4')?.textContent === ${JSON.stringify(name)});
        const button = entry && [...entry.querySelectorAll('button')].find(item => item.textContent.trim() === 'Remove');
        if (!button || !button.checkVisibility() || button.disabled) return false; button.click(); return true;
      })()`),
          ),
        'ordinary imported package Remove',
      )
      await controls.click('Confirm remove')
      await controls.wait(
        () =>
          !activations
            .snapshot()
            .installations.some(
              (entry) => entry.manifest?.id === `hvir.smoke-import-${kind}`,
            ),
        'imported candidate removal settles',
      )
    }
    if (calls !== 3) throw new Error('Each Add did not reach exactly one native dialog')
    console.log(
      '[smoke] single Add native-dialog-boundary cancellation/ZIP/directory import, source preservation, inactive auto-discovery OK',
    )
  } finally {
    extensions.additions = original
  }
  async function ready(): Promise<boolean> {
    return Boolean(
      await win.webContents.executeJavaScript(
        `(() => { const button = [...document.querySelectorAll('button')].find(item => item.textContent.trim() === 'Add extension…'); return !!button && button.checkVisibility() && !button.disabled; })()`,
      ),
    )
  }
}

async function zip(files: ReadonlyMap<string, Uint8Array>): Promise<Buffer> {
  const archive = new ZipFile(),
    chunks: Buffer[] = []
  const result = new Promise<Buffer>((resolve, reject) => {
    archive.outputStream.on('data', (chunk: Buffer) => chunks.push(chunk))
    archive.outputStream.once('error', reject)
    archive.outputStream.once('end', () => resolve(Buffer.concat(chunks)))
  })
  for (const [name, bytes] of files) archive.addBuffer(Buffer.from(bytes), name)
  archive.end()
  return result
}
