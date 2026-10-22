import { app, nativeImage, type BrowserWindow, type WebContents } from 'electron'
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
import { verifySelectedSkillTasks } from './skillager-selected-task'
import { reviewOwnedSkill } from './skillager-management-review'
import { verifyOwnedAdvancedExposure } from './skillager-advanced-exposure'
import { verifyOwnedManagedCopies } from './skillager-management-copies'
import { verifyOwnedApprovedSync } from './skillager-management-sync'
import { verifyOwnedSaveUse } from './skillager-save-use'
import { verifyOwnedSkillRowActions } from './skillager-row-actions'
import { verifyOwnedProjectSave } from './skillager-project-save'
import { verifyOwnedImport } from './skillager-import'
import { verifyOwnedOriginalReveal } from './skillager-management-reveal'
import { verifyOwnedReviewRefusals } from './skillager-management-refusals'
import { captureExtensionVisuals } from './extension-visuals'
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
    mode = process.env.HVIR_SKILLAGER_MANAGEMENT_HISTORY,
    browserOnly = process.env.HVIR_SKILLAGER_MANAGEMENT_BROWSER_ONLY === '1'
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
  await settings.select('Program access')
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
          .connectors!.approvals.status(active(), workspace.root.hostId)
          .some(
            (item) => item.connector === connector && item.availability === 'supported',
          ),
      `${connector} canonical native approval`,
    )
  }
  await settings.select('File access')
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
        .sources!.approvals.settings(active())
        .some(
          (item) =>
            item.source === 'project' &&
            item.granted &&
            item.workspaceId === workspace.id &&
            item.root?.hostId === workspace.root.hostId &&
            item.root.path === workspace.root.path,
        ),
    'exact project source grant',
  )
  await controls.click('Close settings')
  await controls.click('Skills in this project')
  const owner = scopes.currentOwner(win.webContents.id)
  await controls.wait(() => !!view('project'), 'workspace project contribution')
  const projectGuest = await withinExtensionInspection(controls.guest(view('project')!)),
    projectControls = skillagerManagementControls(projectGuest, controls)
  const saveUse = () =>
    verifyOwnedSaveUse(
      projectGuest,
      async () => {
        await controls.wait(() => !!view('detail'), 'Save and use detail placement')
        return withinExtensionInspection(controls.guest(view('detail')!))
      },
      host,
      workspace.root,
      owned,
      cli,
      controls,
    )
  if (process.env.HVIR_SKILLAGER_MANAGEMENT_BATCH_ONLY === '1') {
    const trace = managementActionTrace(host, owned)
    await trace.observe(projectGuest, 'human')
    let proof: Record<string, unknown>
    try {
      proof = await verifyOwnedProjectSave(
        win,
        projectGuest,
        async () => {
          await controls.wait(() => !!view('detail'), 'independent skill reader')
          return withinExtensionInspection(controls.guest(view('detail')!))
        },
        host,
        workspace.root,
        owned,
        cli,
        controls,
      )
    } finally {
      await trace.dispose()
    }
    await host.writeFile(
      joinHostPath(owned, 'batch-save-proof.json'),
      JSON.stringify(
        {
          qualification:
            'Owned source-built CLI and isolated guest; no signed-package claim.',
          ...proof,
          commandProof,
        },
        null,
        2,
      ),
    )
    console.log('[smoke] owned Skillager project save: PASS')
    console.log('HVIR_SMOKE_OK')
    return true
  }
  if (process.env.HVIR_SKILLAGER_MANAGEMENT_ROW_ACTIONS_ONLY === '1') {
    const proof = await verifyOwnedSkillRowActions(
      win,
      projectGuest,
      async () => {
        await controls.wait(() => !!view('detail'), 'independent skill reader')
        return withinExtensionInspection(controls.guest(view('detail')!))
      },
      host,
      workspace.root,
      owned,
      cli,
      controls,
    )
    await host.writeFile(
      joinHostPath(owned, 'row-actions-proof.json'),
      JSON.stringify(
        {
          qualification:
            'Owned installed-CLI isolated-guest contextual actions; no signed-package claim.',
          ...proof,
          commandProof,
        },
        null,
        2,
      ),
    )
    console.log('[smoke] owned Skillager row actions: PASS')
    console.log('HVIR_SMOKE_OK')
    return true
  }
  if (process.env.HVIR_SKILLAGER_MANAGEMENT_PLACEMENT_ONLY === '1') {
    const proof = await saveUse()
    await host.writeFile(
      joinHostPath(owned, 'save-use-proof.json'),
      JSON.stringify(
        {
          qualification:
            'Owned installed-CLI isolated-guest Save and use partition; no full management or signed-package claim.',
          ...proof,
          commandProof,
        },
        null,
        2,
      ),
    )
    console.log('[smoke] owned Skillager Save and use: PASS')
    console.log('HVIR_SMOKE_OK')
    return true
  }
  await projectControls.click('manage')
  await controls.wait(() => !!view('management'), 'management inherits exact workspace')
  const guest = await withinExtensionInspection(controls.guest(view('management')!)),
    ui = skillagerManagementControls(guest, controls)
  await ui.ready(
    `document.getElementById('destination-identity')?.textContent.includes(${JSON.stringify(workspace.id)})`,
    'displayed bound management destination',
  )
  await ui.ready(
    "document.getElementById('state').textContent.includes('No personal library yet')",
    'observation does not initialize',
  )
  try {
    await host.stat(library)
    throw new Error('Library was initialized before explicit choice')
  } catch (error) {
    if ((error as { code?: unknown }).code !== 'ENOENT') throw error
  }
  await ui.inspect(
    "document.querySelector('.library-creation > summary').click();document.querySelector('#custom-initialization summary').click()",
  )
  await ui.ready(
    "document.getElementById('custom-initialization').open",
    'ordinary advanced custom location controls',
  )
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
  await ui.inspect("document.getElementById('result').textContent=''")
  await ui.click('create-library')
  const preserved = await ui.result('initialize-library')
  if (
    preserved['outcome'] !== 'verified' ||
    preserved['created'] !== false ||
    preserved['connect'] !== true ||
    JSON.stringify(preserved['observed']) !== JSON.stringify(initialized['observed'])
  )
    throw new Error(
      'Default public initialization changed the owned existing registration',
    )
  console.log(
    '[smoke] Skillager management: default init preserved owned registration; fresh HOME creation not exercised',
  )
  if (process.env.HVIR_SKILLAGER_MANAGEMENT_INITIALIZATION_ONLY === '1') {
    await host.writeFile(
      joinHostPath(owned, 'initialization-proof.json'),
      JSON.stringify({
        qualification:
          'Initialization-only diagnostic: ordinary Settings/native approval/D4 action with the actual installed CLI. Custom creation and default existing-registration preservation only; no full management/sync or fresh default HOME creation claim.',
        mode,
        initialized,
        defaultPreserved: preserved,
        publicStatus: {
          schema: firstStatus['schema'],
          libraryId: registered['library_id'],
          root: registered['root'],
          gitMode: (firstStatus['git'] as Record<string, unknown>)['mode'],
        },
      }),
    )
    console.log(`[smoke] owned Skillager initialization-only ${mode}: PASS`)
    console.log('HVIR_SMOKE_OK')
    return true
  }
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
  await settings.select('File access')
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
    nativeImage
      .createFromBitmap(Buffer.alloc(1280 * 120 * 4, Buffer.from([165, 135, 92, 255])), {
        width: 1280,
        height: 120,
      })
      .toPNG(),
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
    await captureExtensionVisuals(win, guest, host, 'management', {
      ...controls,
      select: async () => {
        await win.webContents.executeJavaScript(
          "document.querySelector('.project-tab-main').click()",
        )
        await controls.wait(
          async () =>
            (await win.webContents.executeJavaScript(`(() => {
          const tab=[...document.querySelectorAll('.viewer-tab .tab-main')].find(item=>item.title==='Skillager · Manage skills');
          if(!tab?.checkVisibility())return false;tab.click();
          return [...document.querySelectorAll('webview')].some(frame=>frame.checkVisibility()&&frame.getWebContentsId()===${guest.id});
        })()`)) === true,
          'actual management view selected',
        )
        await ui.inspect(
          "document.querySelector('.library-creation').open=false;document.querySelector('main').scrollTop=0",
        )
      },
      painted: async () => {
        const menu = await projectControls.inspect(`(() => {
          const options=document.querySelector('.library-options');options.open=true;
          const menu=options.querySelector('.skill-menu'), rect=menu.getBoundingClientRect();
          if(!menu.checkVisibility()||rect.left<0||rect.right>innerWidth+1||menu.scrollWidth>menu.clientWidth+1)throw new Error('Project options menu escapes its rail');
          return {width:rect.width,viewport:innerWidth,contained:true};
        })()`)
        const management = await ui.inspect(`(() => {
        const main=document.querySelector('main'), fields=[...document.querySelectorAll('label input,label select,label textarea')].filter(e=>e.checkVisibility());
        if(document.documentElement.scrollWidth>innerWidth||getComputedStyle(main).overflowY!=='auto')throw new Error('Management page is not bounded');
        for(const field of fields){const r=field.getBoundingClientRect();if(r.left<0||r.right>innerWidth+1)throw new Error('Management field escapes viewport')}
        return {fieldCount:fields.length,scrolls:main.scrollHeight>main.clientHeight,width:innerWidth};
      })()`)
        return { menu, management }
      },
    })
    const firstAccepted = await reviewOwnedSkill(ui, skillId, [
      'SKILL.md',
      'support.sh',
      'owned.png',
    ])
    await host.writeFile(
      entry,
      `${original}
Owned complete fixture revision two.

## Read the current project

Review the selected skill in the context of the project you are working on. Start with its purpose and the constraints that govern a change, then inspect the files and examples that explain the workflow. Reading does not approve a version or run its instructions; those are separate, explicit decisions.

Keep the code viewer and project history nearby while you compare the proposed work with the repository. A useful handoff names the owner of the behavior, describes the smallest coherent change, and gives enough evidence for another contributor to understand what was verified. Preserve the user's local work and report any environment that could not be exercised.

### A representative command

\`\`\`sh
# Review the exact selected project before making changes.
skillager project review --project /owned/example/with/a/deliberately/long/path/for/horizontal/reading/without/resizing/the/workbench --json
\`\`\`

| Step | Expected result | Evidence to retain |
| --- | --- | --- |
| Browse the library | Choose the intended skill and read its current instructions | Exact library identity and the visible source name |
| Review the version | Inspect the complete file inventory before accepting the current version | Acceptance belongs to the current bytes, independently of reading |
| Add to the project | Select the visible destination and keep the current copy mode | The project result remains independently verifiable after the action |

![Owned image](owned.png)

### Preserve the reading position

${'Follow the existing product boundaries and inspect neighboring consumers before changing a shared owner. Keep authority checks explicit, verify the meaningful lifecycle transitions, and leave the project in a state that another contributor can review without reconstructing the conversation.\n\n'.repeat(24)}`,
    )
    const edit = await cli(['library', 'status', skillId, '--json'])
    if ((edit['skill'] as Record<string, unknown>)['acceptance'] !== 'pending')
      throw new Error('Canonical edit did not remain pending')
    const editedAccepted = await verifySelectedSkillTasks(win, host, workspace, skillId, {
      ...controls,
      project: () => view('project'),
      reader: () => view('detail'),
      library: () =>
        extensions
          .guests!.snapshot(owner)
          .find(
            (item) =>
              item.installationId === installation()!.installationId &&
              item.contributionId === 'library' &&
              item.role === 'view',
          ),
    })
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
    ).catch(async (error: unknown) => {
      console.log(
        '[smoke] owned management failure state',
        await ui.inspect("document.getElementById('state').textContent.slice(0,512)"),
      )
      throw error
    })
    const synchronization = browserOnly
      ? {
          status: 'not-exercised',
          reason:
            'Explicit browser-only partition excludes approved-source sync; the full management workflow remains required for sync acceptance.',
        }
      : await verifyOwnedApprovedSync(ui, host, owned, library, cli)
    const refusals = await verifyOwnedReviewRefusals(
      ui,
      host,
      source,
      skillId,
      cli,
      catalog,
    )
    const advanced = await verifyOwnedAdvancedExposure(
      win,
      projectGuest,
      async () => {
        await controls.wait(() => !!view('detail'), 'selected exposure detail placement')
        return withinExtensionInspection(controls.guest(view('detail')!))
      },
      async () => {
        const libraryView = () =>
          extensions
            .guests!.snapshot(owner)
            .find(
              (item) =>
                item.installationId === installation()!.installationId &&
                item.contributionId === 'library' &&
                item.role === 'view',
            )
        await controls.wait(() => !!libraryView(), 'selected exposure library placement')
        return withinExtensionInspection(controls.guest(libraryView()!))
      },
      host,
      workspace.root,
      cli,
      controls,
    )
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
    const imported = browserOnly
      ? {
          status: 'not-exercised',
          reason: 'Browser-only evidence does not prove Save and accept.',
        }
      : await verifyOwnedImport(
          win,
          projectGuest,
          async () => {
            await controls.wait(() => !!view('detail'), 'import detail placement')
            return withinExtensionInspection(controls.guest(view('detail')!))
          },
          host,
          workspace.root,
          library,
          mode!,
          controls,
        )
    const saveAndUse = browserOnly ? { status: 'not-exercised' } : await saveUse()
    await host.writeFile(
      joinHostPath(owned, 'consumer-proof.json'),
      JSON.stringify(
        {
          qualification:
            'Owned development production-composed ordinary Settings/D4 human controls/D5 installed exact CLI/D7 complete text+image review; no benchmark mutation, signed-package or OS sandbox claim.',
          mainPid: process.pid,
          mode,
          scope: browserOnly ? 'browser-only' : 'full-management',
          workspace,
          initialized,
          defaultPreserved: preserved,
          firstAccepted,
          editedAccepted,
          acceptedCanonicalSource: true,
          pinQualification: browserOnly
            ? 'Upstream pin and sync-derived protection are not exercised in browser-only mode.'
            : 'Direct canonical library review.pin is unsupported; pinned protection is exercised through public upstream pin and sync derivation.',
          copies,
          advanced,
          synchronization,
          imported,
          saveAndUse,
          refusals,
          reveal,
          commandProof,
        },
        null,
        2,
      ),
    )
    console.log(
      `[smoke] owned Skillager ${browserOnly ? 'browser-only' : 'full management'} ${mode}: explicit init, first/edit complete human acceptance, both-agent Full Add/Stub Update/Remove with pending canonical source, ${browserOnly ? 'approved sync not exercised; ' : 'actual approved sync create/update, '}unsupported/blocked review, advanced exposure, Files reveal`,
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
  async function cli(
    args: readonly string[],
    expectedExit = 0,
  ): Promise<Record<string, unknown>> {
    const result = await host.exec(executable!, args, {
      cwd: workspace.root,
      env: environment,
      maxBuffer: 256 * 1024,
    })
    if (result.code !== expectedExit)
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
