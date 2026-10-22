import {
  dialog,
  type BrowserWindow,
  type WebContents,
  type OpenDialogOptions,
} from 'electron'
import { localPath, type HostPath } from '../../shared/host-path'
import type { ProjectState } from '../../shared/workspace-types'
import type { ExtensionApplicationRuntime } from '../extensions/extension-application'
import type { RendererOwner } from '../renderer-resource-scopes'
import type { ProjectHost } from '../project-host/project-host'
import { chooseExtensionWorkspace } from './extension-project-picker'
import { focusSmokeWindow } from './window-focus'
import { captureExtensionDecision } from './extension-decision-visuals'

/** Actual maintained Library Connect, native input/consent and an explicit non-active destination. */
export async function verifySkillagerLibraryConnection(
  win: BrowserWindow,
  guest: WebContents,
  runtime: ExtensionApplicationRuntime,
  owner: RendererOwner,
  host: ProjectHost,
  root: HostPath,
  executable: string,
  controls: {
    click(name: string): Promise<void>
    wait(predicate: () => boolean | Promise<boolean>, label: string): Promise<void>
    within<T>(work: Promise<T>): Promise<T>
  },
): Promise<void> {
  const inspect = (expression: string): Promise<unknown> =>
    controls.within(guest.executeJavaScript(expression))
  const trusted = <T>(expression: string): Promise<T> =>
    controls.within(win.webContents.executeJavaScript(expression))
  const state = await trusted<ProjectState>('window.hvir.invoke("project:root")')
  const project = state.projects.find((project) =>
    project.workspaces.some(
      (workspace) =>
        workspace.root.hostId === root.hostId && workspace.root.path === root.path,
    ),
  )!
  const workspace = project.workspaces.find(
    (workspace) => workspace.root.path === root.path,
  )!
  const activation = [...runtime.activations!.active.values()].find(
    (entry) => entry.revision.manifest.id === 'skillager',
  )!
  const ambient = state.projects.find(
    (entry) => entry.id !== project.id && entry.registeredRoot.hostId === host.hostId,
  )
  if (!ambient) throw new Error('Registered ambient project fixture is unavailable')
  const switched = await trusted<{ ok: boolean }>(
    `window.hvir.invoke('project:switch',${JSON.stringify({ projectId: ambient.id, workspaceId: ambient.activeWorkspaceId })})`,
  )
  if (!switched.ok) throw new Error('Owned ambient project was not admitted')
  // Existing lifecycle owners withdraw the fixture's prior project setup. This is
  // revocation coverage, not an assertion about the Settings revocation controls.
  await runtime.connectors!.approvals.revoke(
    activation.installationId,
    'project-cli',
    host.hostId,
  )
  await runtime.sources!.approvals.revoke(activation.installationId, 'project')
  const canonical = (await host.realpath(localPath(executable))).path
  const descriptor = Object.getOwnPropertyDescriptor(dialog, 'showOpenDialog')
  if (!descriptor) throw new Error('Native program chooser is unavailable')
  const original = dialog.showOpenDialog.bind(dialog)
  let programSelections = 0
  dialog.showOpenDialog = async (
    parent: BrowserWindow | OpenDialogOptions,
    options?: OpenDialogOptions,
  ) => {
    if (parent !== win)
      return options
        ? original(parent as BrowserWindow, options)
        : original(parent as OpenDialogOptions)
    if (options?.buttonLabel !== 'Use program')
      throw new Error('Library connection requested an unexpected native choice')
    programSelections++
    return { canceled: false, filePaths: [executable] }
  }
  try {
    await controls.click('Skillager library')
    const view = runtime
      .guests!.snapshot(owner)
      .find(
        (entry) =>
          entry.contributionId === 'library' &&
          entry.installationId === activation.installationId,
      )!
    await inspect(`(() => {
      globalThis.__hvirLibraryStage={contexts:0,visible:null,target:false,errors:0,contextEnded:0};
      globalThis.__hvirLibraryStageStop=window.hvirExtension.onMessage(message=>{
        const facts=globalThis.__hvirLibraryStage;
        if(message.kind==='context'){facts.contexts=Math.min(64,facts.contexts+1);facts.visible=message.context.visible;facts.target=message.context.workspace?.id===${JSON.stringify(workspace.id)}}
        if(message.kind==='result'&&!message.ok){facts.errors=Math.min(64,facts.errors+1);if(message.error==='Project context changed; the previous request ended')facts.contextEnded=Math.min(64,facts.contextEnded+1)}
      });
    })()`)
    await chooseExtensionWorkspace(
      win,
      workspace.id,
      `[data-extension-view="${view.id}"]`,
      (predicate, label) => controls.wait(predicate, label),
    )
    await controls.wait(
      async () =>
        (await inspect(
          "globalThis.__hvirLibraryStage.target && document.getElementById('state')?.dataset.state==='ready' && !!document.querySelector('#skills [data-source-toggle]')",
        )) === true,
      'Library metadata ready for selected Connect',
    )
    console.log(
      '[smoke] Library metadata after trusted target',
      JSON.stringify(
        await inspect(
          "({stage:globalThis.__hvirLibraryStage,state:document.getElementById('state')?.dataset.state,rows:Math.min(100,document.querySelectorAll('#skills [data-skill-select]').length)})",
        ),
      ),
    )
    await assertAmbient()
    await inspect(`(() => {
      globalThis.__hvirLibraryConnect={replies:0,outcome:null,programReady:null,sourceReady:null};
      globalThis.__hvirLibraryConnectStop=window.hvirExtension.onMessage(message=>{
        const value=message.kind==='result'&&message.ok?message.value:undefined;
        const connection=value?.connections?.find(entry=>entry.connector==='project-cli');
        if(!connection)return;
        const facts=globalThis.__hvirLibraryConnect;
        facts.replies=Math.min(16,facts.replies+1);
        facts.outcome=['connected','declined','unavailable','interrupted-uncertain'].includes(connection.outcome)?connection.outcome:'unknown';
        facts.programReady=value.readiness?.program===true;facts.sourceReady=value.readiness?.source===true;
      });
    })()`)
    await pointer('#skills [data-source-toggle]')
    await controls.wait(
      async () =>
        (await inspect("!!document.querySelector('#skills [data-skill-select]')")) ===
        true,
      'explicit source expansion before selected Connect',
    )
    await pointer('#skills [data-skill-select]')
    await controls.wait(
      () => runtime.sourceRequests!.snapshot(owner)[0]?.state === 'ready',
      'separate selected library-root read decision',
    )
    await controls.click('Not now')
    await controls.wait(
      () => runtime.sourceRequests!.snapshot(owner).length === 0,
      'library-root decline settled',
    )
    await connect()
    await decision(true, false)
    await settled()
    if (
      runtime.sources!.approvals.get(
        activation,
        'project',
        runtime.contexts!.admit(owner, { surface: 'top', workspaceId: workspace.id }),
      )
    )
      throw new Error('Declined Library Connect granted project reads')
    await connect()
    await decision(true, true)
    await controls.wait(
      async () =>
        (await inspect(
          "document.getElementById('task-connect').hidden && !document.getElementById('task-refresh').disabled",
        )) === true,
      'Library combined setup settles with both scopes ready',
    )
    const saved = runtime.connectors!.approvals.get(
      activation,
      'project-cli',
      host.hostId,
    )
    if (!saved) throw new Error('Combined Library connection did not save its program')
    await runtime.sources!.approvals.revoke(activation.installationId, 'project')
    await pointer('#task-options summary')
    await pointer('#task-refresh')
    await pointer('#task-options summary')
    await connect()
    await decision(false, false)
    await settled()
    if (
      runtime.connectors!.approvals.get(activation, 'project-cli', host.hostId) !== saved
    )
      throw new Error('Read-only decline replaced independent program access')
    await connect()
    await decision(false, true)
    await controls.wait(
      async () =>
        (await inspect(
          "document.getElementById('task-connect').hidden && !document.getElementById('task-refresh').disabled",
        )) === true,
      'saved program reused with only missing exact read scope',
    )
    await assertAmbient()
    if (runtime.sourceRequests!.snapshot(owner).length)
      throw new Error('Combined Connect replayed a separate source prompt')
    if (programSelections > 2)
      throw new Error('Reused Library program requested another native selection')
    console.log(
      '[smoke] actual standalone Library non-active explicit destination, combined native decision/decline/retry, saved-program read-only consent and no second prompt OK (real native pointer/consent; successful OS choice and registered-project metadata supplied by fixture; revocation through existing owners)',
    )
  } catch (error) {
    console.log(
      '[smoke] bounded Library connection facts',
      JSON.stringify({
        proposals: runtime.connections!.snapshot(owner).length,
        programSelections,
        nativeFocus: win.isFocused(),
        guest: await inspect(
          `(() => {const button=document.getElementById('task-connect'), state=document.getElementById('task-state');return {stage:globalThis.__hvirLibraryStage,listState:document.getElementById('state')?.dataset.state,rows:Math.min(100,document.querySelectorAll('#skills [data-skill-select]').length),replies:globalThis.__hvirLibraryConnect,focused:document.hasFocus(),connectFocused:document.activeElement===button,connectVisible:!!button?.checkVisibility(),connectDisabled:button?.disabled,connecting:state?.textContent.includes('Connecting'),notCompleted:state?.textContent.includes('not completed'),readNotConfirmed:state?.textContent.includes('read access was not confirmed')}})()`,
        ).catch(() => ({ unavailable: true })),
        modal: await trusted(
          `(() => {const modal=document.querySelector('[aria-labelledby="connection-confirmation-title"]');return {present:!!modal,visible:!!modal?.checkVisibility(),focused:!!modal?.contains(document.activeElement),safe:document.activeElement?.textContent==='Not now'}})()`,
        ),
      }),
    )
    throw error
  } finally {
    Object.defineProperty(dialog, 'showOpenDialog', descriptor)
    await inspect(
      'globalThis.__hvirLibraryConnectStop?.(); delete globalThis.__hvirLibraryConnectStop; delete globalThis.__hvirLibraryConnect; globalThis.__hvirLibraryStageStop?.(); delete globalThis.__hvirLibraryStageStop; delete globalThis.__hvirLibraryStage',
    ).catch(() => {})
    await trusted(
      `window.hvir.invoke('project:switch',${JSON.stringify({ projectId: project.id, workspaceId: workspace.id })})`,
    )
    await controls.click('Skillager library')
    await inspect("document.getElementById('close-instructions')?.click()")
  }
  async function assertAmbient(): Promise<void> {
    const current = await trusted<ProjectState>('window.hvir.invoke("project:root")')
    if (
      current.activeProjectId !== ambient!.id ||
      current.activeWorkspaceId !== ambient!.activeWorkspaceId ||
      current.activeProjectId === project.id ||
      current.activeWorkspaceId === workspace.id
    )
      throw new Error('Library setup requires the unchanged other active project')
  }
  async function connect(): Promise<void> {
    await assertAmbient()
    await controls.wait(
      async () =>
        (await inspect(
          "document.getElementById('task-connect')?.checkVisibility() && !document.getElementById('task-connect').disabled",
        )) === true,
      'actual Library Connect control',
    )
    await pointer('#task-connect')
  }
  async function settled(): Promise<void> {
    await controls.wait(
      async () =>
        (await inspect(
          "!document.getElementById('task-connect').disabled && !document.getElementById('task-state').textContent.includes('Connecting')",
        )) === true,
      'declined Library Connect visibly settles',
    )
    if (
      runtime.sourceRequests!.snapshot(owner).length ||
      runtime.connections!.snapshot(owner).length
    )
      throw new Error('Declined combined attempt opened another consent')
  }
  async function decision(program: boolean, accepted: boolean): Promise<void> {
    await controls.wait(async () => {
      const proposal = runtime.connections!.snapshot(owner)[0]
      if (!proposal) return false
      if (
        proposal.source?.root.path !== root.path ||
        proposal.source.root.hostId !== root.hostId ||
        proposal.source.source !== 'project' ||
        proposal.programs.length !== (program ? 1 : 0) ||
        (program &&
          (proposal.programs[0]?.canonicalExecutable !== canonical ||
            proposal.programs[0]?.host !== host.hostId))
      )
        throw new Error('Library Connect proposed a different program/read scope')
      return trusted<boolean>(`(() => {
        const modal=document.querySelector('[aria-labelledby="connection-confirmation-title"]'), safe=modal&&[...modal.querySelectorAll('button')].find(button=>button.textContent==='Not now');
        return !!modal?.checkVisibility() && modal.contains(document.activeElement) && document.activeElement===safe && modal.textContent.includes('Read selected files in this project') && !modal.querySelector('details').open;
      })()`)
    }, 'exact combined Library consent with native safe focus')
    if (!win.isFocused() || !win.isVisible() || win.isMinimized())
      throw new Error('Library consent lost native foreground')
    if (accepted)
      await captureExtensionDecision(
        win,
        host,
        program ? 'combined' : 'project-read',
        (predicate, label) => controls.wait(predicate, label),
      )
    await controls.click(accepted ? 'Connect' : 'Not now')
  }
  async function pointer(selector: string): Promise<void> {
    await focusSmokeWindow(win, 'window')
    await inspect(
      `document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'center'})`,
    )
    const point = (await inspect(`(() => {
      const button=document.querySelector(${JSON.stringify(selector)}), rect=button?.getBoundingClientRect();
      if(!button?.checkVisibility()||button.disabled||!rect?.width||!rect.height||rect.top<0||rect.bottom>innerHeight)throw new Error('Library control unavailable');
      return {x:Math.round(rect.left+rect.width/2),y:Math.round(rect.top+rect.height/2)};
    })()`)) as { x: number; y: number }
    guest.focus()
    guest.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point })
    try {
      await controls.wait(
        async () =>
          (await inspect(
            `document.hasFocus() && document.activeElement===document.querySelector(${JSON.stringify(selector)})`,
          )) === true,
        'actual Library guest native input focus',
      )
    } finally {
      guest.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point })
    }
  }
}
