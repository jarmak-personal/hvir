import { app, type BrowserWindow, type WebContents } from 'electron'
import { join } from 'node:path'
import { joinHostPath, localPath, type HostPath } from '../../shared/host-path'
import type { ProjectHost } from '../project-host/project-host'
import type { ExtensionApplicationRuntime } from '../extensions/extension-application'
import type { RendererResourceScopes } from '../renderer-resource-scopes'
import type { ExtensionView } from '../../shared/extensions/workbench'
import { extensionSettingsControls } from './extension-settings-controls'
import {
  skillagerManagementControls,
  withinExtensionInspection,
  type SkillagerManagementControls,
} from './skillager-management-controls'
import { reviewOwnedSkill } from './skillager-management-review'
import { verifyOwnedAdvancedExposure } from './skillager-advanced-exposure'
import { verifyOwnedManagedCopies } from './skillager-management-copies'
import { verifyOwnedApprovedSync } from './skillager-management-sync'
import { verifyOwnedOriginalReveal } from './skillager-management-reveal'
import { verifyOwnedReviewRefusals } from './skillager-management-refusals'
import { managementActionTrace } from './skillager-management-trace'

interface Controls extends SkillagerManagementControls {
  guest(view: ExtensionView): Promise<WebContents>
}

/** Owned actual installed-CLI consumer walkthrough; no benchmark or private Skillager state. */
export async function verifySkillagerManagement(
  win: BrowserWindow,
  extensions: ExtensionApplicationRuntime,
  scopes: RendererResourceScopes,
  host: ProjectHost,
  workspace: { readonly id: string; readonly root: HostPath },
  controls: Controls,
): Promise<boolean> {
  const selected = process.env.HVIR_SKILLAGER_MANAGEMENT_FIXTURE,
    executable = process.env.HVIR_SKILLAGER_MANAGEMENT_CLI,
    mode = process.env.HVIR_SKILLAGER_MANAGEMENT_HISTORY
  if (!selected && !executable && !mode) return false
  if (
    !selected ||
    !executable ||
    !['git', 'no-git'].includes(mode ?? '') ||
    app.isPackaged
  )
    throw new Error(
      'Management evidence requires an explicit owned fixture, installed CLI and Git/no-Git choice',
    )
  const owned = await host.realpath(localPath(selected)),
    library = joinHostPath(owned, 'library'),
    catalog = joinHostPath(owned, 'catalog'),
    cache = joinHostPath(owned, 'cache'),
    state = joinHostPath(owned, 'state'),
    environment = {
      SKILLAGER_CATALOG_STATE_DIR: catalog.path,
      XDG_CACHE_HOME: cache.path,
      XDG_STATE_HOME: state.path,
    },
    commandProof: Record<string, unknown>[] = []
  const settings = extensionSettingsControls(win, 'Skillager', {
    wait: (predicate, label) => controls.wait(predicate, label),
    within: withinExtensionInspection,
  })
  const directory = joinHostPath(extensions.activations!.directory, 'skillager')
  await host.createDirectoryExclusive(directory, { mode: 0o755 })
  const assets = localPath(join(app.getAppPath(), 'packages/skillager-extension'))
  for (const entry of await host.readdir(assets))
    if (entry.type === 'file')
      await host.writeFile(
        joinHostPath(directory, entry.name),
        await host.readFile(joinHostPath(assets, entry.name)),
      )
  await controls.click('Open settings')
  await controls.click('Extensions')
  await controls.click('Discover extensions')
  await controls.wait(
    () => !!installation()?.revision,
    'owned maintained package discovery',
  )
  if (installation()!.enabled || installation()!.error)
    throw new Error('Discovery silently enabled or rejected maintained package')
  await settings.click('Enable')
  await controls.wait(
    () => installation()?.enabled === true,
    'explicit maintained package Enable',
  )
  const configuration = JSON.stringify({ args: [], env: environment })
  for (const connector of ['library-cli', 'project-cli']) {
    await settings.set(`Executable for ${connector}`, executable)
    await settings.set(`Configuration for ${connector}`, configuration)
    await settings.click('Inspect native access', `Program access: ${connector}`)
    await controls.wait(
      async () =>
        Boolean(
          await withinExtensionInspection(
            win.webContents.executeJavaScript(
              "document.body.textContent.includes('Approve local:')",
            ),
          ),
        ),
      `canonical ${connector} native decision`,
    )
    await settings.click('Approve native execution', `Program access: ${connector}`)
    await controls.wait(
      () =>
        extensions
          .connectors!.approvals.status(active())
          .some(
            (item) => item.connector === connector && item.availability === 'supported',
          ),
      `${connector} canonical native approval`,
    )
  }
  await settings.set('Registered workspace for project', workspace.id)
  await settings.click('Inspect read access', 'Read-only source: project')
  await controls.wait(
    async () =>
      Boolean(
        await withinExtensionInspection(
          win.webContents.executeJavaScript(
            "document.body.textContent.includes('Grant read-only access to')",
          ),
        ),
      ),
    'exact project source decision',
  )
  await settings.click('Grant read-only access', 'Read-only source: project')
  await controls.wait(
    () =>
      extensions
        .sources!.approvals.status(active())
        .some((item) => item.source === 'project' && item.granted),
    'exact project source grant',
  )
  await controls.click('Close settings')
  await controls.click('Skills in this project')
  const owner = scopes.currentOwner(win.webContents.id)
  await controls.wait(() => !!view('project'), 'workspace project contribution')
  const projectGuest = await withinExtensionInspection(controls.guest(view('project')!)),
    projectControls = skillagerManagementControls(projectGuest, controls)
  await projectControls.click('manage')
  await controls.wait(() => !!view('management'), 'management inherits exact workspace')
  const guest = await withinExtensionInspection(controls.guest(view('management')!)),
    ui = skillagerManagementControls(guest, controls)
  await ui.ready(
    `document.getElementById('destination')?.textContent.includes(${JSON.stringify(workspace.id)})`,
    'displayed bound management destination',
  )
  await ui.click('observe-library')
  await ui.ready(
    "document.getElementById('library-identity').textContent.includes('No registered personal library')",
    'observation does not initialize',
  )
  try {
    await host.stat(library)
    throw new Error('Library was initialized before explicit choice')
  } catch (error) {
    if ((error as { code?: unknown }).code !== 'ENOENT') throw error
  }
  await ui.set('library-path', library.path)
  await ui.inspect(
    `document.getElementById('git-history').checked=${mode === 'git'}; document.getElementById('initialize').requestSubmit()`,
  )
  const initialized = await ui.result('initialize-library')
  if (initialized['outcome'] !== 'verified' || initialized['connect'] !== true)
    throw new Error('Owned selected initialization was not verified')
  const firstStatus = await cli(['library', 'status', '--json'])
  const registered = firstStatus['library'] as Record<string, unknown>
  if (
    registered['root'] !== library.path ||
    (firstStatus['git'] as Record<string, unknown>)['mode'] !==
      (mode === 'git' ? 'system' : 'disabled')
  )
    throw new Error(
      'Selected init/current registered canonical path or history mode differs',
    )
  if (mode === 'git') {
    for (const [key, value] of [
      ['user.name', 'Owned hvir fixture'],
      ['user.email', 'hvir-owned-fixture@example.invalid'],
    ]) {
      const result = await host.exec('git', ['config', '--local', key!, value!], {
        cwd: library,
      })
      if (result.code !== 0) throw new Error('Owned Git identity setup failed')
    }
  }
  await controls.click('Open settings')
  await controls.click('Extensions')
  await settings.set('Source root for library', library.path)
  await settings.click('Inspect read access', 'Read-only source: library')
  await controls.wait(
    async () =>
      Boolean(
        await withinExtensionInspection(
          win.webContents.executeJavaScript(
            "document.body.textContent.includes('Grant read-only access to')",
          ),
        ),
      ),
    'explicit initialized library source decision',
  )
  await settings.click('Grant read-only access', 'Read-only source: library')
  await controls.wait(
    () =>
      extensions
        .sources!.approvals.status(active())
        .some((item) => item.source === 'library' && item.granted),
    'initialized library read grant',
  )
  await controls.click('Close settings')
  const skillId = 'lib/owned-consumer',
    created = await cli(['library', 'new', 'owned-consumer', '--json']),
    skill = created['skill'] as Record<string, unknown>,
    source = localPath(String(skill['path'])),
    entry = joinHostPath(source, 'SKILL.md'),
    original = (await host.readFile(entry)).toString('utf8'),
    support = "#!/bin/sh\nprintf 'owned fixture support only\\n'\n"
  await host.createFileExclusive(joinHostPath(source, 'support.sh'), { mode: 0o755 })
  await host.writeFile(joinHostPath(source, 'support.sh'), support)
  await host.writeFile(
    joinHostPath(source, 'owned.png'),
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1kAAAAASUVORK5CYII=',
      'base64',
    ),
  )
  await host.writeFile(
    entry,
    `${original}\nOwned complete fixture revision one.\n\n![Owned image](owned.png)\n`,
  )
  const before = await cli(['library', 'status', skillId, '--json'])
  if ((before['skill'] as Record<string, unknown>)['accepted_hash'] !== null)
    throw new Error('First authored fixture was already accepted')
  const trace = managementActionTrace(host, owned)
  const workflow = async (): Promise<boolean> => {
    await trace.observe(guest, 'human')
    const actionView = extensions
      .guests!.snapshot(owner)
      .find(
        (item) =>
          item.contributionId === 'management' &&
          item.url !== guest.getURL() &&
          item.context?.workspace?.id === workspace.id,
      )
    if (!actionView) throw new Error('Owned initialized action handler is unavailable')
    await trace.observe(
      await withinExtensionInspection(controls.guest(actionView)),
      'action',
    )
    const firstAccepted = await reviewOwnedSkill(ui, skillId, [
      'SKILL.md',
      'support.sh',
      'owned.png',
    ])
    await host.writeFile(
      entry,
      `${original}\nOwned complete fixture revision two.\n\n![Owned image](owned.png)\n`,
    )
    const edit = await cli(['library', 'status', skillId, '--json'])
    if ((edit['skill'] as Record<string, unknown>)['acceptance'] !== 'pending')
      throw new Error('Canonical edit did not remain pending')
    const editedAccepted = await reviewOwnedSkill(ui, skillId, [
      'SKILL.md',
      'support.sh',
      'owned.png',
    ])
    if (
      (firstAccepted['source'] as Record<string, unknown>)['hash'] ===
      (editedAccepted['source'] as Record<string, unknown>)['hash']
    )
      throw new Error('Edited exact acceptance reused the first version')
    const copies = await verifyOwnedManagedCopies(
      ui,
      host,
      workspace.root,
      skillId,
      source,
      owned,
      async () => {
        await host.writeFile(
          entry,
          `${original}\nOwned pending revision deliberately remains unaccepted.\n`,
        )
        const pending = await cli(['library', 'status', skillId, '--json'])
        if ((pending['skill'] as Record<string, unknown>)['acceptance'] !== 'pending')
          throw new Error('Remove fixture canonical source was not pending')
      },
    )
    const synchronization = await verifyOwnedApprovedSync(ui, host, owned, library, cli)
    const refusals = await verifyOwnedReviewRefusals(
      ui,
      host,
      source,
      skillId,
      cli,
      catalog,
    )
    const advanced = await verifyOwnedAdvancedExposure(ui, host, workspace.root, cli)
    const reveal = await verifyOwnedOriginalReveal(
      win,
      projectGuest,
      async () => {
        await controls.wait(() => !!view('detail'), 'original detail placement')
        return withinExtensionInspection(controls.guest(view('detail')!))
      },
      host,
      workspace.root,
      controls,
    )
    await host.writeFile(
      joinHostPath(owned, 'consumer-proof.json'),
      JSON.stringify(
        {
          qualification:
            'Owned development production-composed ordinary Settings/D4 human controls/D5 installed exact CLI/D7 complete text+image review; no benchmark mutation, signed-package or OS sandbox claim.',
          mainPid: process.pid,
          mode,
          workspace,
          initialized,
          firstAccepted,
          editedAccepted,
          acceptedCanonicalSource: true,
          pinQualification:
            'Direct canonical library review.pin is unsupported; pinned protection is exercised through public upstream pin and sync derivation.',
          copies,
          advanced,
          synchronization,
          refusals,
          reveal,
          commandProof,
        },
        null,
        2,
      ),
    )
    console.log(
      `[smoke] owned Skillager management ${mode}: explicit init, first/edit complete human acceptance, both-agent Full Add/Stub Update/Remove with pending canonical source, actual approved sync create/update, Files reveal`,
    )
    console.log('HVIR_SMOKE_OK')
    return true
  }
  let result: boolean
  try {
    result = await workflow()
  } catch (error) {
    await trace.dispose().catch(() => {
      console.log('[smoke] Owned public-message observer cleanup also failed')
    })
    throw error
  }
  await trace.dispose()
  return result

  function installation() {
    return extensions
      .activations!.snapshot()
      .installations.find((item) => item.source === 'skillager')
  }
  function active() {
    return extensions.activations!.active.get(installation()!.installationId!)!
  }
  function view(id: string) {
    return extensions
      .guests!.snapshot(owner)
      .find(
        (item) =>
          item.contributionId === id &&
          item.context?.workspace?.id === workspace.id &&
          item.role !== 'updater',
      )
  }
  async function cli(args: readonly string[]): Promise<Record<string, unknown>> {
    const result = await host.exec(executable!, args, {
      cwd: workspace.root,
      env: environment,
      maxBuffer: 256 * 1024,
    })
    if (result.code !== 0)
      throw new Error(
        `Owned fixture public CLI command failed: ${args.slice(0, 2).join(' ')} (exit ${result.code})`,
      )
    const value = JSON.parse(result.stdout) as Record<string, unknown>,
      skill = value['skill'] as Record<string, unknown> | undefined,
      library = value['library'] as Record<string, unknown> | undefined
    commandProof.push({
      command: args.slice(0, 2),
      cwd: workspace.root,
      code: result.code,
      schema: value['schema'],
      status: value['status'],
      created: value['created'],
      counts: value['counts'],
      ...(library ? { libraryId: library['library_id'] } : {}),
      ...(skill
        ? {
            skillId: skill['id'],
            acceptance: skill['acceptance'],
            workingHash: skill['working_hash'],
            acceptedHash: skill['accepted_hash'],
          }
        : {}),
    })
    return value
  }
}
