import { dialog, type BrowserWindow, type OpenDialogOptions } from 'electron'
import { joinHostPath, localPath } from '../../shared/host-path'
import type { ExtensionManifest } from '../../shared/extensions/contract'
import type { ProjectHost } from '../project-host/project-host'
import type { RendererResourceScopes } from '../renderer-resource-scopes'
import type { ExtensionApplicationRuntime } from '../extensions/extension-application'
import { extensionSettingsControls } from './extension-settings-controls'
import { trustedRendererControl } from './trusted-renderer-control'
import { focusSmokeWindow } from './window-focus'

interface SetupControls {
  click(name: string): Promise<void>
  wait(predicate: () => boolean | Promise<boolean>, label: string): Promise<void>
}

/** Actual Settings, writers and local metadata; only the native picker return is substituted. */
export async function verifyExtensionSetup(
  win: BrowserWindow,
  extensions: ExtensionApplicationRuntime,
  scopes: RendererResourceScopes,
  host: ProjectHost,
  controls: SetupControls,
): Promise<boolean> {
  if (process.env.HVIR_EXTENSION_SETUP_SMOKE !== '1') return false
  const activations = extensions.activations!
  const directory = joinHostPath(activations.directory, 'setup-reference'),
    owned = joinHostPath(activations.directory, '..', 'setup-evidence'),
    library = joinHostPath(owned, 'library'),
    executable = joinHostPath(owned, 'tool-v1'),
    launcher = joinHostPath(owned, 'tool'),
    marker = joinHostPath(owned, 'executed'),
    proposalFile = joinHostPath(owned, 'setup.json')
  for (const path of [directory, owned, library])
    await host.createDirectoryExclusive(path, { mode: 0o755 })
  const manifest: ExtensionManifest = {
    id: 'hvir.setup-reference',
    name: 'Setup reference',
    version: '1.0.0',
    contract: '1.0',
    requiredCapabilities: [],
    optionalCapabilities: ['connector.execute', 'source.read'],
    access: [
      {
        id: 'library',
        description: 'Library files',
        context: 'application',
        mode: 'read-only',
      },
    ],
    views: [
      {
        id: 'main',
        title: 'Setup reference',
        entry: 'index.html',
        placement: 'application',
        representations: ['view'],
      },
    ],
    connectors: ['library-cli', 'project-cli'].map((id) => ({
      id,
      description: id,
      context: 'application',
      environment: ['TOOL_HOME'],
      timeoutMs: 1000,
      outputBytes: 1024,
    })),
  }
  await host.writeFile(
    joinHostPath(directory, 'hvir-extension.json'),
    JSON.stringify(manifest),
  )
  await host.writeFile(
    joinHostPath(directory, 'index.html'),
    '<!doctype html><p>Setup reference</p>',
  )
  await host.createFileExclusive(executable, { mode: 0o755 })
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  await host.writeFile(executable, `#!/bin/sh\nprintf executed > ${quote(marker.path)}\n`)
  const linked = await host.exec('/bin/ln', ['-s', executable.path, launcher.path])
  if (linked.code !== 0) throw new Error('Owned setup symlink fixture failed')
  const canonical = await host.realpath(executable),
    canonicalLibrary = await host.realpath(library)
  const proposal = {
    schema: 1,
    extension: manifest.id,
    connectors: ['library-cli', 'project-cli'].map((connector) => ({
      connector,
      host: 'local',
      executable: launcher.path,
      configuration: { args: ['--json'], env: { TOOL_HOME: 'owned-fixture-value' } },
    })),
    sources: [{ source: 'library', root: { host: 'local', path: library.path } }],
    requestAgentAccess: true,
  }
  await host.writeFile(proposalFile, JSON.stringify(proposal))
  const settings = extensionSettingsControls(win, manifest.name, {
    wait: (predicate, label) => controls.wait(predicate, label),
    within: (work) => work,
  })
  const originalOpen = dialog.showOpenDialog.bind(dialog),
    descriptor = Object.getOwnPropertyDescriptor(dialog, 'showOpenDialog')!
  let calls = 0,
    dismissNext = false
  dialog.showOpenDialog = (
    parent: BrowserWindow | OpenDialogOptions,
    options?: OpenDialogOptions,
  ) => {
    if (parent !== win)
      return options
        ? originalOpen(parent as BrowserWindow, options)
        : originalOpen(parent as OpenDialogOptions)
    scopes.assertCurrent(scopes.currentOwner(win.webContents.id))
    if (
      options?.buttonLabel !== 'Review setup' ||
      options.properties?.join() !== 'openFile'
    )
      throw new Error('Setup did not reach the current single-file native picker')
    calls++
    if (dismissNext) {
      dismissNext = false
      return Promise.resolve({ canceled: true, filePaths: [] })
    }
    if (calls === 1 && process.env.HVIR_EXTENSION_SETUP_PICKER === 'native') {
      console.log(
        '[smoke] select the owned setup JSON in the native picker:',
        proposalFile.path,
      )
      return originalOpen(win, options)
    }
    return Promise.resolve({ canceled: false, filePaths: [proposalFile.path] })
  }
  try {
    await controls.click('Open settings')
    await controls.click('Extensions')
    await controls.click('Discover extensions')
    await controls.wait(
      () =>
        activations
          .snapshot()
          .installations.some((entry) => entry.manifest?.id === manifest.id),
      'setup package discovery',
    )
    await settings.click('Enable')
    await controls.wait(
      () =>
        [...activations.active.values()].some(
          (entry) => entry.revision.manifest.id === manifest.id,
        ),
      'setup package Enable',
    )
    const active = [...activations.active.values()].find(
      (entry) => entry.revision.manifest.id === manifest.id,
    )!
    await settings.click('Review setup…')
    await controls.wait(
      () =>
        rendered(
          `function(program, folder) {
      const dialog=document.querySelector('.extension-setup-dialog');
      return !!dialog?.checkVisibility() && dialog.textContent.includes(program) && dialog.textContent.includes(folder) && [...dialog.querySelectorAll('button')].some(e=>e.textContent.trim()==='Apply 4 changes'&&!e.disabled);
    }`,
          [canonical.path, canonicalLibrary.path],
        ),
      'canonical multi-tool setup review',
    )
    if (
      extensions.connectors!.approvals.settings(active).connectors.length ||
      extensions.sources!.approvals.settings(active).some((entry) => entry.granted)
    )
      throw new Error('Preview granted authority before Apply')
    if (
      !(await rendered(
        `function() {
      const dialog=document.querySelector('.extension-setup-dialog');
      return dialog.textContent.includes('App-wide Agent access is off') && !dialog.textContent.includes('owned-fixture-value') && [...dialog.querySelectorAll('.extension-setup-row details')].every(e=>!e.open);
    }`,
        [],
      ))
    )
      throw new Error('Setup details, masked values or global-off explanation changed')
    await visual('review')
    // Editing the file cannot change the main-owned review already displayed.
    await host.writeFile(
      proposalFile,
      JSON.stringify({ schema: 1, extension: manifest.id }),
    )
    await controls.click('Apply 4 changes')
    await controls.wait(
      () =>
        rendered(
          `function() {
      const dialog=document.querySelector('.extension-setup-dialog');
      return !!dialog && [...dialog.querySelectorAll('.extension-setup-row')].filter(e=>e.textContent.includes('Saved')).length===4;
    }`,
          [],
        ),
      'four independent setup saves',
    )
    const programs = extensions.connectors!.approvals.settings(active).connectors
    if (
      programs.length !== 2 ||
      programs.some(
        (entry) =>
          entry.executable !== canonical.path ||
          entry.selectedExecutable !== launcher.path ||
          entry.trustUpdates,
      )
    )
      throw new Error(
        'Setup lost canonical identity, independent tool bindings or normal target trust',
      )
    if (
      !extensions
        .sources!.approvals.settings(active)
        .some((entry) => entry.granted && entry.root?.path === canonicalLibrary.path) ||
      !activations.agentAccess().includes(active.installationId)
    )
      throw new Error(
        'Setup did not save the selected source and per-extension agent setting',
      )
    await visual('saved')
    await controls.click('Close')
    await host.writeFile(proposalFile, JSON.stringify(proposal))
    await settings.click('Review setup…')
    await controls.wait(
      () =>
        rendered(
          `function() {
      const dialog=document.querySelector('.extension-setup-dialog');
      return !!dialog?.checkVisibility() && dialog.textContent.includes('4 settings already configured') && !dialog.querySelector('.extension-setup-existing').open;
    }`,
          [],
        ),
      'unchanged setup reused and collapsed',
    )
    await controls.click('Cancel')
    const changed = {
      ...proposal,
      connectors: proposal.connectors.map((entry, index) =>
        index
          ? entry
          : {
              ...entry,
              configuration: {
                args: ['--compact'],
                env: { TOOL_HOME: 'changed-owned-value' },
              },
            },
      ),
    }
    await host.writeFile(proposalFile, JSON.stringify(changed))
    await settings.click('Review setup…')
    await controls.wait(
      () =>
        rendered(
          `function() {
      const dialog=document.querySelector('.extension-setup-dialog');
      return !!dialog?.checkVisibility() && dialog.textContent.includes('Replaces saved access') && [...dialog.querySelectorAll('button')].some(e=>e.textContent.trim()==='Apply 1 change'&&!e.disabled);
    }`,
          [],
        ),
      'configuration-only replacement is one changed row',
    )
    if (
      !(await rendered(
        `function() {
      const row=document.querySelector('.extension-setup-row');
      row.querySelector('summary').click();
      return row.textContent.includes('--compact') && row.textContent.includes('--json') && row.textContent.includes('Environment overrides changed') && !row.textContent.includes('owned-fixture-value') && !row.textContent.includes('changed-owned-value');
    }`,
        [],
      ))
    )
      throw new Error(
        'Replacement did not expose prior/new configuration with masked values',
      )
    await visual('replacement')
    await controls.click('Cancel')
    await controls.wait(
      () =>
        rendered(
          'function() { return !document.querySelector(".extension-setup-dialog") }',
          [],
        ),
      'cancel retires setup review',
    )
    await focusSmokeWindow(win)
    if (
      extensions
        .connectors!.approvals.settings(active)
        .connectors.some((entry) => entry.configuration.args[0] !== '--json')
    )
      throw new Error('Cancelled replacement changed a saved binding')
    let ran = false
    try {
      await host.stat(marker)
      ran = true
    } catch {
      /* absent owned execution marker */
    }
    if (ran || calls !== 3)
      throw new Error(
        'Setup executed a program or did not use one file selection per review',
      )
    if (process.env.HVIR_EXTENSION_SETUP_VISUAL_DIRECTORY) {
      const originalTheme = (await win.webContents.executeJavaScript(
        'document.documentElement.dataset.theme',
      )) as string
      try {
        await theme('light')
        await settings.click('Review setup…')
        await controls.wait(
          () =>
            rendered(
              `function() {
          const dialog=document.querySelector('.extension-setup-dialog');
          return !!dialog?.checkVisibility() && [...dialog.querySelectorAll('button')].some(e=>e.textContent.trim()==='Apply 1 change'&&!e.disabled);
        }`,
              [],
            ),
          'light-theme setup review',
        )
        await visual('review-light', [760])
        await controls.click('Cancel')
      } finally {
        if (
          await rendered(
            'function() { return !!document.querySelector(".extension-setup-dialog") }',
            [],
          )
        )
          await controls.click('Cancel')
        await theme(originalTheme)
      }
    }
    dismissNext = true
    const previousCalls = calls
    await settings.click('Review setup…')
    await controls.wait(
      () => calls === previousCalls + 1,
      'dismissed native chooser return',
    )
    await controls.wait(
      () =>
        rendered(
          `function() {
      return !document.querySelector('.extension-setup-dialog') && !document.querySelector('.extension-setup-controls').textContent.includes('Checking setup');
    }`,
          [],
        ),
      'chooser dismissal returns quietly to Settings',
    )
    await host.writeFile(
      proposalFile,
      JSON.stringify({
        ...proposal,
        connectors: proposal.connectors.map((entry) => ({
          ...entry,
          configuration: { ...entry.configuration, args: ['--cancel-proof'] },
        })),
        requestAgentAccess: false,
      }),
    )
    await settings.click('Review setup…')
    await controls.wait(
      () =>
        rendered(
          `function() {
      return [...document.querySelectorAll('.extension-setup-dialog button')].some(e=>e.textContent.trim()==='Apply 3 changes'&&!e.disabled);
    }`,
          [],
        ),
      'cancellation review with two changed programs and agent access',
    )
    const originalSave = activations.saveConnectorApprovals.bind(activations)
    let writes = 0,
      held = false,
      release!: () => void
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    activations.saveConnectorApprovals = async (value, current) => {
      if (++writes === 2) {
        held = true
        await barrier
      }
      await originalSave(value, current)
    }
    try {
      await controls.click('Apply 3 changes')
      await controls.wait(() => held, 'second submitted save held at existing writer')
      await controls.click('Cancel')
      await controls.wait(
        () =>
          rendered(
            `function() {
        const dialog=document.querySelector('.extension-setup-dialog');
        return !!dialog && dialog.textContent.includes('Stopping…') && dialog.textContent.includes('Saved') && [...dialog.querySelectorAll('button')].some(e=>e.textContent.trim()==='Close');
      }`,
            [],
          ),
        'cancel keeps saved result and truthful pending state',
      )
      release()
      await controls.wait(
        () =>
          rendered(
            `function() {
        const dialog=document.querySelector('.extension-setup-dialog');
        return !!dialog && !dialog.textContent.includes('Stopping…') && dialog.textContent.includes('Saved') && dialog.textContent.includes('Check current access') && dialog.textContent.includes('Not applied');
      }`,
            [],
          ),
        'cancel retains saved, uncertain and unapplied outcomes',
      )
      const retained = extensions.connectors!.approvals.settings(active).connectors
      if (
        writes !== 2 ||
        retained.find((e) => e.connector === 'library-cli')?.configuration.args[0] !==
          '--cancel-proof' ||
        retained.some((e) => e.connector === 'project-cli') ||
        !activations.agentAccess().includes(active.installationId)
      )
        throw new Error(
          'Cancellation lost an independent save or started remaining changes',
        )
      await visual('cancelled', [760])
      await controls.click('Close')
      await controls.wait(
        () =>
          rendered(
            'function() { return !document.querySelector(".extension-setup-dialog") }',
            [],
          ),
        'explicit Close retires settled cancellation review',
      )
    } finally {
      release()
      activations.saveConnectorApprovals = originalSave
    }
    console.log(
      '[smoke] multi-tool setup: actual Settings/IPC/ProjectHost symlink metadata, immutable snapshot, native/source/agent writers, unchanged reuse, masked replacement, quiet chooser dismissal and submitted-write cancellation outcomes OK; picker boundary substituted except explicit native first-selection mode',
    )
    console.log('HVIR_SMOKE_OK')
    return true
  } finally {
    Object.defineProperty(dialog, 'showOpenDialog', descriptor)
  }
  function rendered(declaration: string, values: readonly string[]): Promise<boolean> {
    return trustedRendererControl(win, declaration, values, (work) => work)
  }
  async function theme(value: string): Promise<void> {
    if (
      !(await rendered(
        'function() { return !!document.querySelector(".settings-dialog") }',
        [],
      ))
    )
      await controls.click('Open settings')
    await section('Appearance', 'appearance')
    if (
      !(await rendered(
        `function(value) {
      const input=document.getElementById('settings-app-theme');
      if(!input?.checkVisibility()||input.disabled)return false;
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(input,value);
      input.dispatchEvent(new Event('change',{bubbles:true}));return true;
    }`,
        [value],
      ))
    )
      throw new Error('Ordinary app theme control is unavailable')
    await controls.click('Save app settings')
    await controls.wait(
      () =>
        rendered(
          'function(value) { return document.documentElement.dataset.theme===value && !document.querySelector(".settings-dialog") }',
          [value],
        ),
      'saved app theme and Settings close publication',
    )
    await controls.click('Open settings')
    await section('Extensions', 'extensions')
    await settings.select()
  }
  async function section(name: string, id: string): Promise<void> {
    const responsive = await rendered(
      `function(id) {
      const selector=document.querySelector('.settings-section-selector select');
      if(!selector?.checkVisibility()||selector.disabled)return false;
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(selector,id);
      selector.dispatchEvent(new Event('change',{bubbles:true}));return true;
    }`,
      [id],
    )
    if (!responsive) await controls.click(name)
    await controls.wait(
      () =>
        rendered(
          'function(id) { return !!document.getElementById("settings-"+id+"-title") }',
          [id],
        ),
      `actual ${name} section selected`,
    )
  }
  async function visual(
    phase: string,
    widths: readonly number[] = [1280, 760],
  ): Promise<void> {
    const directory = process.env.HVIR_EXTENSION_SETUP_VISUAL_DIRECTORY
    if (!directory) return
    if (!directory.startsWith('/') || directory === '/')
      throw new Error('Choose an owned setup visual directory')
    const output = localPath(directory)
    await host
      .createDirectoryExclusive(output, { mode: 0o755 })
      .catch(async (error: unknown) => {
        if (
          (error as NodeJS.ErrnoException).code !== 'EEXIST' ||
          (await host.stat(output)).type !== 'dir'
        )
          throw error
      })
    const size = win.getContentSize()
    try {
      for (const width of widths) {
        win.setContentSize(width, 800)
        await win.webContents.executeJavaScript(
          'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
        )
        const geometry: unknown = await win.webContents.executeJavaScript(`(() => {
          const dialog=document.querySelector('.extension-setup-dialog'), bounds=dialog.getBoundingClientRect();
          const checks=[...dialog.querySelectorAll('input[type=checkbox]')].map(input=>{const box=input.getBoundingClientRect(), label=input.nextElementSibling.querySelector('strong').getBoundingClientRect();return {width:box.width,beside:box.right<=label.left&&box.top<label.bottom&&label.top<box.bottom}});
          if(bounds.left<0||bounds.right>innerWidth||bounds.top<0||bounds.bottom>innerHeight||checks.some(e=>e.width>20||!e.beside))throw new Error('Setup dialog or checkboxes overflow or lose alignment');
          return {width:innerWidth,dialogWidth:bounds.width,checkboxes:checks,theme:document.documentElement.dataset.theme};
        })()`)
        await host.writeFile(
          joinHostPath(output, `${phase}-${width}.png`),
          (await win.webContents.capturePage()).toPNG(),
        )
        await host.writeFile(
          joinHostPath(output, `${phase}-${width}.json`),
          JSON.stringify(geometry, null, 2),
        )
      }
    } finally {
      win.setContentSize(size[0]!, size[1]!)
    }
  }
}
