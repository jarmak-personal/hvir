import { extensionSettingsControls } from './extension-settings-controls'
import { ZipFile } from 'yazl'
import type { BrowserWindow } from 'electron'
import { joinHostPath } from '../../shared/host-path'
import type { ProjectHost } from '../project-host/project-host'
import type { RendererResourceScopes } from '../renderer-resource-scopes'
import type { ExtensionApplicationRuntime } from '../extensions/extension-application'
import { ExtensionPackageAdditionOwner } from '../extensions/package-addition'
import { createElectronPackagePicker } from '../extensions/electron-package-picker'
import { prepareInstallationLanding } from '../extensions/installation-landing'
import { verifyInstalledLanding } from './extension-installation-landing'

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
  extensions.additions = new ExtensionPackageAdditionOwner(
    scopes,
    activations,
    picker,
    undefined,
    (activation, source, owner, current, signal) =>
      prepareInstallationLanding(
        activations,
        extensions.guests!,
        activation,
        source,
        owner,
        current,
        signal,
      ),
    (owner) => extensions.surface.foreground(owner),
  )
  const addition = extensions.additions,
    add = addition.add.bind(addition),
    cancel = addition.cancelSetup.bind(addition)
  addition.add = (...args) => {
    const pending = add(...args)
    // Observe the original promise; preserve the exact handler's result/delivery path.
    void pending.then(
      (result) => {
        console.log(
          '[smoke] actual Add return facts',
          JSON.stringify({
            request: args[1],
            rendererCurrent: scopes.isCurrent(args[0]),
            installed: result.installed?.installationId,
            landing: result.installed?.landing?.id,
            active:
              !!result.installed &&
              activations.active.has(result.installed.installationId),
            rows: result.installations
              .slice(0, 32)
              .map((entry) => ({
                source: entry.source,
                id: entry.installationId,
                identity: entry.sourceIdentity,
                enabled: entry.enabled,
              })),
          }),
        )
      },
      () => console.log('[smoke] actual Add return refused'),
    )
    return pending
  }
  addition.cancelSetup = (owner, request) => {
    console.log(
      '[smoke] actual Add cancellation facts',
      JSON.stringify({ request, rendererCurrent: scopes.isCurrent(owner) }),
    )
    cancel(owner, request)
  }
  try {
    const before = activations.snapshot().installations.length
    await controls.click('Add extension…')
    await controls.wait(() => calls === 1, 'Add reaches native picker cancellation')
    await controls.wait(() => ready(), 'Add cancellation settles')
    if (activations.snapshot().installations.length !== before)
      throw new Error('Cancelled Add changed package discovery')
    for (const { kind, landing } of [
      { kind: 'directory', landing: false },
      { kind: 'zip', landing: false },
      { kind: 'zip', landing: true },
    ] as const) {
      const name = `imported-${kind}${landing ? '-landing' : ''}`,
        files = new Map([
          [
            'hvir-extension.json',
            Buffer.from(
              JSON.stringify({
                id: `hvir.smoke-${name}`,
                name,
                version: '0.3.0',
                contract: '1.0',
                requiredCapabilities: [],
                optionalCapabilities: [],
                access: [],
                ...(landing ? { landing: 'view' } : {}),
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
              landing
                ? '<!doctype html><button>Ordinary landing</button>'
                : '<!doctype html><script>throw new Error("Capture must not execute")</script>',
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
      if (landing) {
        await controls.wait(
          () =>
            activations
              .snapshot()
              .installations.some(
                (entry) => entry.manifest?.id === `hvir.smoke-${name}` && entry.enabled,
              ),
          'exact ZIP landing installation commits',
        )
        const installed = activations
          .snapshot()
          .installations.find((entry) => entry.manifest?.id === `hvir.smoke-${name}`)!
        await verifyInstalledLanding(
          win,
          installed.installationId!,
          'viewer',
          (predicate, label) => controls.wait(predicate, label),
        )
        await controls.click('Open settings')
        await controls.click('Extensions')
      } else {
        try {
          await controls.wait(
            async () =>
              (await win.webContents.executeJavaScript(`(() => {
          const entry=[...document.querySelectorAll('.extension-installation-list button')].find(e=>e.querySelector('strong')?.textContent===${JSON.stringify(name)});
          return entry?.getAttribute('aria-current')==='true'&&document.querySelector('.extension-installation h4')?.textContent===${JSON.stringify(name)};
        })()`)) === true,
            `Add ${kind} selects the imported package without a helper click`,
          )
        } catch (reason) {
          const controls: unknown = await win.webContents.executeJavaScript(`(() => ({
            rows: [...document.querySelectorAll('.extension-installation-list button')].slice(0,32).map(entry=>({source:entry.dataset.source, name:entry.querySelector('strong')?.textContent?.slice(0,80), selected:entry.getAttribute('aria-current'), disabled:entry.disabled})),
            title:document.querySelector('.extension-installation h4')?.textContent?.slice(0,80),
            alerts:[...document.querySelectorAll('[role="alert"]')].slice(0,4).map(entry=>entry.textContent?.slice(0,240)),
            addDisabled:[...document.querySelectorAll('.extension-settings button')].find(entry=>entry.textContent.trim()==='Add extension…')?.disabled,
          }))()`)
          const installed = activations.snapshot().installations.map((entry) => ({
            id: entry.installationId,
            package: entry.manifest?.id,
            enabled: entry.enabled,
            error: entry.error?.slice(0, 240),
          }))
          console.log(
            '[smoke] exact Add row failure facts',
            JSON.stringify({ controls, installed }),
          )
          throw reason
        }
      }
      await extensionSettingsControls(win, name, {
        wait: (predicate, label) => controls.wait(predicate, label),
        within: (work) => work,
      }).select()
      await controls.wait(async () => {
        const entry = activations
          .snapshot()
          .installations.find((entry) => entry.manifest?.id === `hvir.smoke-${name}`)
        return (
          !!entry &&
          !entry.error &&
          !!(await win.webContents.executeJavaScript(`(() => {
          const entry = [...document.querySelectorAll('.extension-installation')].find(item => item.querySelector('h4')?.textContent === ${JSON.stringify(name)});
          return !!entry && entry.checkVisibility() && [...entry.querySelectorAll('button')].some(button => button.textContent.trim() === 'Disable' && !button.disabled);
        })()`))
        )
      }, `Add ${kind} enables the imported revision without Enable`)
      const entry = activations
        .snapshot()
        .installations.find((entry) => entry.manifest?.id === `hvir.smoke-${name}`)!
      if (
        !entry.enabled ||
        activations.active.size !== active + 1 ||
        activations.active.get(entry.installationId!)?.revision.hash !== expected.hash ||
        activations.agentAccess().includes(entry.installationId!) ||
        (await host.extensionStorage!.entryIdentity(source)) !== sourceIdentity
      )
        throw new Error('Import failed exact activation or replaced the author source')
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
            .installations.some((entry) => entry.manifest?.id === `hvir.smoke-${name}`),
        'imported candidate removal settles',
      )
    }
    if (calls !== 4) throw new Error('Each Add did not reach exactly one native dialog')
    console.log(
      '[smoke] single Add native-dialog-boundary cancellation/ZIP/directory import, source preservation, exact activation without Enable OK',
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
