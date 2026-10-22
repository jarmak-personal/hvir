import {
  app,
  dialog,
  type BrowserWindow,
  type OpenDialogOptions,
  type WebContents,
} from 'electron'
import { join } from 'node:path'
import { localPath, type HostPath } from '../../shared/host-path'
import type { ProjectHost } from '../project-host/project-host'
import type { RendererOwner } from '../renderer-resource-scopes'
import type { ExtensionApplicationRuntime } from '../extensions/extension-application'
import type { ExtensionView } from '../../shared/extensions/workbench'
import { verifyInstalledLanding } from './extension-installation-landing'
import { captureExtensionDecision } from './extension-decision-visuals'
import { trustedRendererControl } from './trusted-renderer-control'
import { extensionSettingsControls } from './extension-settings-controls'

interface FirstUseControls {
  click(name: string): Promise<void>
  wait(predicate: () => boolean | Promise<boolean>, label: string): Promise<void>
  guest(view: ExtensionView): Promise<WebContents>
}
/** Exercise the trusted decision transport after its visible request has ended. */
export async function assertRetiredSkillagerReadDecision(
  win: BrowserWindow,
  id: string,
  within: <T>(work: Promise<T>) => Promise<T>,
): Promise<void> {
  if (
    !(await trustedRendererControl(
      win,
      `async function(id) {
    try { await window.hvir.invoke('extensions:source-decide', { id, accepted: true }); return false }
    catch { return true }
  }`,
      [id],
      within,
    ))
  )
    throw new Error('A retired selected-read decision was accepted')
}
/** Production Add/connection/landing wiring; only successful OS chooser returns are substituted. */
export async function installSkillagerFirstUse(
  win: BrowserWindow,
  extensions: ExtensionApplicationRuntime,
  owner: RendererOwner,
  executable: string,
  host: ProjectHost,
  archive: string | undefined,
  controls: FirstUseControls,
): Promise<HostPath> {
  const source = archive ?? join(app.getAppPath(), 'packages/skillager-extension')
  if (!source.startsWith('/') || !executable.startsWith('/'))
    throw new Error('First-use evidence needs exact owned absolute package and CLI paths')
  const canonicalExecutable = (await host.realpath(localPath(executable))).path
  const originalOpen = dialog.showOpenDialog.bind(dialog)
  const descriptor = Object.getOwnPropertyDescriptor(dialog, 'showOpenDialog')
  if (!descriptor) throw new Error('Native chooser property is unavailable')
  let packageSelections = 0,
    programSelections = 0
  dialog.showOpenDialog = async (
    parent: BrowserWindow | OpenDialogOptions,
    options?: OpenDialogOptions,
  ) => {
    if (parent !== win)
      return options
        ? originalOpen(parent as BrowserWindow, options)
        : originalOpen(parent as OpenDialogOptions)
    if (options?.buttonLabel === 'Add extension') {
      packageSelections++
      return {
        canceled: false,
        filePaths: [
          process.platform === 'darwin' || archive
            ? source
            : join(source, 'hvir-extension.json'),
        ],
      }
    }
    if (options?.buttonLabel === 'Use program') {
      programSelections++
      return { canceled: false, filePaths: [executable] }
    }
    throw new Error('Unexpected chooser during Skillager first use')
  }
  try {
    await controls.click('Open settings')
    await controls.click('Extensions')
    await controls.click('Add extension…')
    await controls.wait(() => {
      const proposals = extensions.connections!.snapshot(owner)
      return proposals.length === 1
    }, 'one trusted Skillager program connection')
    await captureExtensionDecision(win, host, 'program', (predicate, label) =>
      controls.wait(predicate, label),
    )
    await controls.wait(
      () =>
        trustedRendererControl(
          win,
          `function(expected) {
      const dialog = document.querySelector('[aria-labelledby="connection-confirmation-title"]');
      if (!dialog?.checkVisibility() || !dialog.textContent.includes(expected)) return false;
      const button = [...dialog.querySelectorAll('button')].find(entry => entry.textContent.trim() === 'Connect');
      if (!button?.checkVisibility() || button.disabled) return false;
      button.click(); return true;
    }`,
          [canonicalExecutable],
          (work) => work,
        ),
      'trusted Connect control',
    )
    const installation = () =>
      extensions
        .snapshot()
        .installations.find(
          (entry) => entry.manifest?.id === 'skillager' && entry.enabled,
        )
    await controls.wait(
      () => !!installation()?.installationId,
      'Add accepts the exact Skillager package',
    )
    await verifyInstalledLanding(
      win,
      installation()!.installationId!,
      'top',
      (predicate, label) => controls.wait(predicate, label),
    )
    const activation = extensions.activations!.active.get(
      installation()!.installationId!,
    )!
    const approval = extensions.connectors!.approvals.get(
      activation,
      'library-cli',
      host.hostId,
    )
    if (
      !approval ||
      approval.canonicalExecutable !== canonicalExecutable ||
      approval.configuration.args.length ||
      Object.keys(approval.configuration.env).length
    )
      throw new Error(
        'Ordinary first-use program decision did not preserve the exact default CLI configuration',
      )
    if (extensions.sources!.approvals.status(activation).some((entry) => entry.granted))
      throw new Error('Program connection implicitly granted file access')
    if (packageSelections !== 1 || programSelections > 1)
      throw new Error(
        'First use did not use one package selection and at most one executable choice',
      )
    console.log(
      '[smoke] Skillager ordinary Add → one trusted program decision → declared focused landing, no setup forms/navigation/file grant OK',
    )
    await controls.click('Open settings')
    await controls.click('Extensions')
    await extensionSettingsControls(win, 'Skillager', {
      wait: (predicate, label) => controls.wait(predicate, label),
      within: (work) => work,
    }).select('Extension actions')
    await controls.wait(
      () =>
        trustedRendererControl(
          win,
          `function() {
      const article=document.querySelector('.extension-installation'), buttons=[...article.querySelectorAll('button')];
      const library=buttons.filter(button=>button.textContent.trim()==='Open Skillager library');
      if(article.querySelector('[aria-label="Extension view"]')||buttons.some(button=>button.textContent.trim()==='Open Skill instructions'))throw new Error('Settings offers an input-dependent secondary view');
      if(library.length!==1||buttons.filter(button=>button.textContent.trim()==='Open Manage skills').length!==1)return false;
      const button=library[0];if(!button.checkVisibility()||button.disabled)return false;
      button.scrollIntoView({block:'nearest'});const r=button.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;
      if(x<0||x>=innerWidth||y<0||y>=innerHeight||!button.contains(document.elementFromPoint(x,y)))return false;
      button.focus();return document.activeElement===button;
    }`,
          [],
          (work) => work,
        ),
      'one reachable declared library entry alongside the existing parameterized task route',
    )
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
    win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
    const manualLibrary = () =>
      extensions
        .guests!.snapshot(owner)
        .find(
          (view) =>
            view.installationId === installation()!.installationId &&
            view.contributionId === 'library' &&
            view.context?.surface === 'viewer',
        )
    await controls.wait(() => !!manualLibrary(), 'native Settings Enter opens library')
    const manual = manualLibrary()!
    const guest = await controls.guest(manual)
    await controls.wait(async () => {
      return (
        (await trustedRendererControl(
          win,
          `function(id) {
        return !document.querySelector('.settings-dialog') && document.querySelector('[data-extension-view="'+id+'"]')?.checkVisibility()===true;
      }`,
          [manual.id],
          (work) => work,
        )) &&
        (await guest.executeJavaScript(
          "document.getElementById('query')?.checkVisibility()===true",
        )) === true
      )
    }, 'Settings opens usable library search without a selected-skill input')
    await extensions.guests!.close(owner, manual.id)
    await controls.click('Skillager library')
    console.log(
      '[smoke] Settings declared Skillager library entry, native Enter and usable search; no blank detail route; parameterized Manage route retained OK',
    )
    return localPath(join(extensions.activations!.directory.path, installation()!.source))
  } finally {
    Object.defineProperty(dialog, 'showOpenDialog', descriptor)
  }
}
