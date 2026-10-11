import { app, dialog, type BrowserWindow, type OpenDialogOptions } from 'electron'
import { join } from 'node:path'
import { localPath, type HostPath } from '../../shared/host-path'
import type { ProjectHost } from '../project-host/project-host'
import type { RendererOwner } from '../renderer-resource-scopes'
import type { ExtensionApplicationRuntime } from '../extensions/extension-application'
import { verifyInstalledLanding } from './extension-installation-landing'
import { trustedRendererControl } from './trusted-renderer-control'

interface FirstUseControls {
  click(name: string): Promise<void>
  wait(predicate: () => boolean | Promise<boolean>, label: string): Promise<void>
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
  host: Pick<ProjectHost, 'realpath'>,
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
    const approval = extensions.connectors!.approvals.get(activation, 'library-cli')
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
    return localPath(join(extensions.activations!.directory.path, installation()!.source))
  } finally {
    Object.defineProperty(dialog, 'showOpenDialog', descriptor)
  }
}
