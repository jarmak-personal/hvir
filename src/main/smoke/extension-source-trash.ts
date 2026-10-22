import type { BrowserWindow, WebContents } from 'electron'
import { joinHostPath, type HostPath } from '../../shared/host-path'
import type { ExtensionView } from '../../shared/extensions/workbench'
import type { ProjectHost } from '../project-host/project-host'
import type { ExtensionApplicationRuntime } from '../extensions/extension-application'
import { extensionSettingsControls } from './extension-settings-controls'
import { focusSmokeWindow } from './window-focus'

/** Actual isolated guest → trusted Files dialog → recoverable ProjectHost operation. */
export async function verifyExtensionSourceTrash(
  win: BrowserWindow,
  runtime: ExtensionApplicationRuntime,
  host: ProjectHost,
  workspace: { readonly id: string; readonly root: HostPath },
  controls: {
    click(name: string): Promise<void>
    wait(predicate: () => boolean | Promise<boolean>, label: string): Promise<void>
    guest(view: ExtensionView): Promise<WebContents>
  },
): Promise<void> {
  const packageRoot = joinHostPath(runtime.activations!.directory, 'source-trash'),
    target = joinHostPath(workspace.root, 'owned-trash-source'),
    original = joinHostPath(target, 'SKILL.md'),
    unrelated = joinHostPath(workspace.root, 'unrelated-trash-source.txt')
  await host.createDirectoryExclusive(packageRoot, { mode: 0o755 })
  await host.createDirectoryExclusive(target, { mode: 0o755 })
  await host.writeFile(original, 'Owned original')
  await host.writeFile(unrelated, 'Preserved unrelated file')
  await host.writeFile(
    joinHostPath(packageRoot, 'hvir-extension.json'),
    JSON.stringify({
      id: 'hvir.source-trash',
      name: 'Source trash fixture',
      version: '0.3.0',
      contract: '1.0',
      requiredCapabilities: ['context.read', 'source.request', 'source.request-trash'],
      optionalCapabilities: [],
      access: [
        {
          id: 'project',
          description: 'Read the owned project',
          context: 'workspace',
          mode: 'read-only',
        },
      ],
      views: [
        {
          id: 'project',
          title: 'Source trash fixture',
          entry: 'index.html',
          placement: 'workspace',
          navigation: 'left',
          representations: ['view'],
        },
      ],
    }),
  )
  await host.writeFile(
    joinHostPath(packageRoot, 'index.html'),
    '<!doctype html><button id="read" disabled>Read access</button><button id="trash" disabled>Remove original</button><p id="state"></p><script src="page.js"></script>',
  )
  await host.writeFile(
    joinHostPath(packageRoot, 'page.js'),
    `
    const bridge=window.hvirExtension,pending=new Map();let serial=0,context;
    function request(capability,input){const id='trash-'+(++serial);return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});bridge.send({kind:'request',id,capability,input})})}
    bridge.onMessage(message=>{
      if(message.kind==='context'){context=message.context;for(const button of document.querySelectorAll('button'))button.disabled=!context.visible}
      if(message.kind==='result'){const task=pending.get(message.id);if(!task)return;pending.delete(message.id);message.ok?task.resolve(message.value):task.reject(new Error(message.error))}
    });
    async function run(capability,input){document.getElementById('state').textContent='pending';try{const result=await request(capability,input);document.getElementById('state').textContent=result.granted?'granted':result.outcome}catch{document.getElementById('state').textContent='error'}}
    document.getElementById('read').onclick=()=>run('source.request',{source:'project'});
    document.getElementById('trash').onclick=()=>run('source.request-trash',{source:'project',workspaceId:context.workspace.id,path:${JSON.stringify(target)}});
    bridge.send({kind:'hello',contract:'1.0'});
  `,
  )
  const settings = extensionSettingsControls(win, 'Source trash fixture', {
    wait: (predicate, label) => controls.wait(predicate, label),
    within: (work) => work,
  })
  await controls.click('Discover extensions')
  await settings.click('Enable')
  await controls.wait(() => settings.settled(), 'source Trash fixture enabled')
  await controls.click('Close settings')
  await controls.click('Source trash fixture')
  let view: ExtensionView | undefined
  await controls.wait(async () => {
    const views = (await win.webContents.executeJavaScript(
      "window.hvir.invoke('extensions:views',undefined)",
    )) as readonly ExtensionView[]
    view = views.find(
      (entry) =>
        entry.contributionId === 'project' &&
        entry.context?.surface === 'left' &&
        runtime.activations!.active.get(entry.installationId)?.revision.manifest.id ===
          'hvir.source-trash',
    )
    return Boolean(view)
  }, 'source Trash guest admitted')
  const guest = await controls.guest(view!)
  await guestClick('read')
  await controls.click('Allow read-only access')
  await state('granted')
  await guestClick('trash')
  await dialog()
  if ((await host.readFile(original)).toString() !== 'Owned original')
    throw new Error('Requesting Trash review mutated the original')
  await controls.click('Cancel')
  await state('cancelled')
  if ((await host.readFile(original)).toString() !== 'Owned original')
    throw new Error('Cancelling Trash review mutated the original')
  await guestClick('trash')
  await dialog()
  await controls.click('Move to Trash')
  await state('completed')
  try {
    await host.stat(target)
    throw new Error('Verified Trash retained the original')
  } catch (reason) {
    if ((reason as { code?: string }).code !== 'ENOENT') throw reason
  }
  if ((await host.readFile(unrelated)).toString() !== 'Preserved unrelated file')
    throw new Error('Trash changed an unrelated file')
  await controls.click('Open settings')
  await controls.click('Extensions')
  await settings.click('Remove')
  await controls.click('Confirm remove')
  await controls.wait(() => settings.settled(), 'source Trash fixture retired')
  console.log(
    '[smoke] isolated source request, one existing Files Trash confirmation, cancel preservation and verified exact original removal OK',
  )

  async function state(value: string): Promise<void> {
    await controls.wait(
      () =>
        guest.executeJavaScript(
          `document.getElementById('state').textContent===${JSON.stringify(value)}`,
        ),
      `source Trash guest ${value}`,
    )
  }
  async function dialog(): Promise<void> {
    await controls.wait(
      () =>
        win.webContents.executeJavaScript(`(() => {
      const dialog=document.querySelector('.file-deletion-dialog');
      return !!dialog?.checkVisibility() && dialog.textContent.includes(${JSON.stringify(target.path)}) &&
        document.querySelectorAll('.file-deletion-dialog').length===1 && document.activeElement?.textContent==='Cancel';
    })()`),
      'exact existing Files Trash dialog and safe initial focus',
    )
    if (
      (await guest.executeJavaScript("document.getElementById('state').textContent")) !==
      'pending'
    )
      throw new Error('Trusted Trash dialog invalidated its own guest request')
  }
  async function guestClick(id: string): Promise<void> {
    await focusSmokeWindow(win, 'window')
    await controls.wait(
      () =>
        guest.executeJavaScript(
          `!!document.getElementById(${JSON.stringify(id)})?.checkVisibility() && !document.getElementById(${JSON.stringify(id)}).disabled`,
        ),
      'visible source Trash guest action',
    )
    const point = (await guest.executeJavaScript(`(() => {
      const rect=document.getElementById(${JSON.stringify(id)}).getBoundingClientRect();
      return {x:Math.round(rect.x+rect.width/2),y:Math.round(rect.y+rect.height/2)};
    })()`)) as { x: number; y: number }
    guest.focus()
    guest.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point })
    guest.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point })
  }
}
