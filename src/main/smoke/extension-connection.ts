import {
  dialog,
  type BrowserWindow,
  type WebContents,
  type OpenDialogOptions,
} from 'electron'
import { joinHostPath } from '../../shared/host-path'
import type { ProjectHost } from '../project-host/project-host'
import type { ExtensionApplicationRuntime } from '../extensions/extension-application'
import type { ExtensionView } from '../../shared/extensions/workbench'
import { extensionSettingsControls } from './extension-settings-controls'
import { focusSmokeWindow } from './window-focus'

/** Real import, metadata, trusted consent and guest execution; only Add selection is substituted. */
export async function verifyExtensionConnection(
  win: BrowserWindow,
  runtime: ExtensionApplicationRuntime,
  host: ProjectHost,
  controls: {
    click(name: string): Promise<void>
    wait(predicate: () => boolean | Promise<boolean>, label: string): Promise<void>
    guest(view: ExtensionView): Promise<WebContents>
  },
): Promise<void> {
  const activations = runtime.activations!,
    approvals = runtime.connectors!.approvals
  const source = joinHostPath(activations.packages.root, '..', 'connection-source')
  const marker = joinHostPath(source, '..', 'connection-executed')
  await host.createDirectoryExclusive(source, { mode: 0o755 })
  await host.writeFile(
    joinHostPath(source, 'hvir-extension.json'),
    JSON.stringify({
      id: 'hvir.connection-smoke',
      name: 'Connection example',
      version: '0.3.0',
      contract: '1.0',
      requiredCapabilities: [
        'connector.execute',
        'connector.output',
        'connector.connect',
      ],
      optionalCapabilities: [],
      access: [],
      views: [
        {
          id: 'main',
          title: 'Connection example',
          entry: 'index.html',
          placement: 'application',
          representations: ['view'],
        },
      ],
      connectors: [
        {
          id: 'tool',
          description: 'Read owned demonstration metadata',
          context: 'application',
          timeoutMs: 5000,
          outputBytes: 1024,
          environment: [],
          setup: { executable: 'sh' },
        },
      ],
    }),
  )
  await host.writeFile(
    joinHostPath(source, 'index.html'),
    '<!doctype html><button id="connect" disabled>Connect installed program</button><button id="read" disabled>Read metadata</button><p id="state"></p><pre id="output"></pre><script src="page.js"></script>',
  )
  const command = `printf x >> '${marker.path.replaceAll("'", "'\\''")}' ; printf 'owned connection output\\n'`
  await host.writeFile(
    joinHostPath(source, 'page.js'),
    `
    const bridge=window.hvirExtension, requests=new Map();let serial=0;
    function request(capability,input){return new Promise((resolve,reject)=>{const id='request-'+(++serial);requests.set(id,{resolve,reject});bridge.send({kind:'request',id,capability,input})})}
    bridge.onMessage(message=>{
      if(message.kind==='result'){const item=requests.get(message.id);if(item){requests.delete(message.id);message.ok?item.resolve(message.value):item.reject(new Error(message.error))}}
      if(message.kind==='context'){document.getElementById('connect').disabled=!message.context.visible;document.getElementById('read').disabled=!message.context.visible}
    });
    document.getElementById('connect').onclick=async()=>{try{const result=await request('connector.connect',{connector:'tool'});document.getElementById('state').textContent=result.connections[0]?.outcome}catch(error){document.getElementById('state').textContent='refused'}};
    document.getElementById('read').onclick=async()=>{try{const result=await request('connector.execute',{connector:'tool',host:'local',args:['-c',${JSON.stringify(command)}]});if(result.outcome!=='completed'||result.code!==0)throw new Error('execution failed');const page=await request('connector.output',{receipt:result.receipt,stream:'stdout',offset:0});document.getElementById('output').textContent=page.data;await request('connector.output',{receipt:result.receipt,release:true})}catch(error){document.getElementById('output').textContent='refused'}};
    bridge.send({kind:'hello',contract:'1.0'});
  `,
  )
  const expected = await activations.packages.captureSource(source)
  const originalOpen = dialog.showOpenDialog.bind(dialog)
  const originalDescriptor = Object.getOwnPropertyDescriptor(dialog, 'showOpenDialog')
  if (!originalDescriptor) throw new Error('Native picker property is unavailable')
  let decisions = 0,
    selections = 0
  dialog.showOpenDialog = async (
    parent: BrowserWindow | OpenDialogOptions,
    options?: OpenDialogOptions,
  ) => {
    if (parent !== win)
      return options
        ? originalOpen(parent as BrowserWindow, options)
        : originalOpen(parent as OpenDialogOptions)
    if (!options || options.buttonLabel !== 'Add extension')
      throw new Error('Unnecessary program picker during unique conventional discovery')
    selections++
    return {
      canceled: false,
      filePaths: [
        process.platform === 'darwin'
          ? source.path
          : joinHostPath(source, 'hvir-extension.json').path,
      ],
    }
  }
  try {
    await controls.click('Add extension…')
    await decide(true)
    const installed = [...activations.active.values()].find(
      (entry) => entry.revision.manifest.id === 'hvir.connection-smoke',
    )!
    await controls.wait(
      () => !!approvals.get(installed, 'tool'),
      'exact default native connection saved',
    )
    const approval = approvals.get(installed, 'tool')!
    if (
      installed.revision.hash !== expected.hash ||
      approval.declaration.setup?.executable !== 'sh' ||
      approval.configuration.args.length ||
      Object.keys(approval.configuration.env).length ||
      (await host.realpath(joinHostPath(source, 'index.html'))).path !==
        joinHostPath(source, 'index.html').path
    )
      throw new Error(
        'Connection changed exact accepted declaration/default binding or author source',
      )
    const settings = extensionSettingsControls(win, 'Connection example', {
      wait: (predicate, label) => controls.wait(predicate, label),
      within: (work) => work,
    })
    await settings.select('Extension actions')
    await settings.click('Open Connection example')
    await controls.click('Close settings')
    const owner = runtime.scopes.currentOwner(win.webContents.id)
    await controls.wait(
      () =>
        runtime
          .guests!.snapshot(owner)
          .some((view) => view.installationId === installed.installationId),
      'ordinary installed view',
    )
    const view = runtime
        .guests!.snapshot(owner)
        .find((entry) => entry.installationId === installed.installationId)!,
      guest = await controls.guest(view)
    await approvals.revoke(installed.installationId, 'tool')
    await guestClick('connect')
    await decide(false)
    await controls.wait(
      () =>
        guest.executeJavaScript(
          "document.getElementById('state')?.textContent==='declined'",
        ),
      'ordinary guest decline is delivered without a grant',
    )
    if (approvals.get(installed, 'tool') || (await exists()))
      throw new Error('Declining granted access or executed a program')
    await guestClick('connect')
    await decide(true)
    await controls.wait(
      () =>
        guest.executeJavaScript(
          "document.getElementById('state')?.textContent==='connected'",
        ),
      'guest connection uses the same trusted consent',
    )
    await controls.wait(
      () =>
        guest.executeJavaScript(
          `(() => {const button=document.getElementById('read');if(!button?.checkVisibility()||button.disabled)return false;button.click();return true})()`,
        ),
      'ordinary approved metadata command',
    )
    await controls.wait(
      async () =>
        (await guest.executeJavaScript(
          "document.getElementById('output')?.textContent==='owned connection output\\n'",
        )) === true,
      'public connector output after approved execution',
    )
    if (
      (await host.readFile(marker)).toString() !== 'x' ||
      selections !== 1 ||
      decisions !== 3
    )
      throw new Error('Discovery/consent executed a tool or repeated installation')
    await controls.click('Open settings')
    await controls.click('Extensions')
    await settings.click('Remove')
    await controls.click('Confirm remove')
    await controls.wait(
      () => !activations.active.has(installed.installationId),
      'connection fixture removal',
    )
    console.log(
      '[smoke] actual Add/passive metadata/default trusted connection/guest focus to trusted decline and allow/public finite output OK (only native Add selection substituted)',
    )
  } finally {
    Object.defineProperty(dialog, 'showOpenDialog', originalDescriptor)
  }
  async function decide(accepted: boolean): Promise<void> {
    const owner = runtime.scopes.currentOwner(win.webContents.id)
    await controls.wait(async () => {
      const proposal = runtime.connections!.snapshot(owner)[0]
      return (
        !!proposal &&
        proposal.name === 'Connection example' &&
        (await win.webContents.executeJavaScript(`(() => {
            const modal = document.querySelector('[aria-labelledby="connection-confirmation-title"]');
            return !!modal?.checkVisibility() && modal.contains(document.activeElement) &&
              modal.textContent.includes('Programs run with your account’s access') &&
              modal.textContent.includes('No extra arguments or environment overrides') &&
              modal.querySelector('pre')?.textContent.includes('local: /') &&
              [...modal.querySelectorAll('button')].some(button=>button.textContent==='Not now' && document.activeElement===button);
          })()`)) === true
      )
    }, 'live trusted confirmation and safe focus with exact default program')
    if (!win.isFocused() || !win.isVisible() || (await exists()))
      throw new Error(
        'Trusted consent lost native foreground or a program ran before consent',
      )
    await controls.click(accepted ? 'Connect' : 'Not now')
    decisions++
    await controls.wait(
      () => runtime.connections!.snapshot(owner).length === 0,
      'exact trusted proposal retired',
    )
  }
  async function guestClick(id: string): Promise<void> {
    const owner = runtime.scopes.currentOwner(win.webContents.id)
    const view = runtime
      .guests!.snapshot(owner)
      .find(
        (entry) =>
          entry.installationId ===
          [...activations.active.values()].find(
            (entry) => entry.revision.manifest.id === 'hvir.connection-smoke',
          )?.installationId,
      )!
    const guest = await controls.guest(view)
    await focusSmokeWindow(win, 'window')
    await controls.wait(
      () =>
        win.webContents.executeJavaScript(`(() => {
      const element=[...document.querySelectorAll('webview')].find(item=>item.getWebContentsId()===${guest.id});
      const rect=element?.getBoundingClientRect();
      return !!element?.checkVisibility() && !!rect?.width && !!rect.height && !document.querySelector('.settings-dialog');
    })()`),
      'ordinary unobscured connection view',
    )
    const point = (await guest.executeJavaScript(`(() => {
      const button=document.getElementById(${JSON.stringify(id)});
      if (!button?.checkVisibility() || button.disabled) throw new Error('Guest control unavailable');
      const rect=button.getBoundingClientRect();
      return {x:Math.round(rect.x+rect.width/2),y:Math.round(rect.y+rect.height/2)};
    })()`)) as { x: number; y: number }
    guest.focus()
    guest.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point })
    try {
      try {
        await controls.wait(
          () =>
            guest.executeJavaScript(
              `document.hasFocus() && document.activeElement===document.getElementById(${JSON.stringify(id)})`,
            ),
          'actual visible guest native input focus',
        )
      } catch (reason) {
        const parent: unknown = await win.webContents.executeJavaScript(
          "({focused:document.hasFocus(),active:document.activeElement?.tagName,settings:!!document.querySelector('.settings-dialog')})",
        )
        const child: unknown = await guest.executeJavaScript(
          '({focused:document.hasFocus(),active:document.activeElement?.tagName})',
        )
        console.log(
          '[smoke] connection guest focus facts',
          JSON.stringify({
            focused: win.isFocused(),
            visible: win.isVisible(),
            minimized: win.isMinimized(),
            parent,
            guest: child,
          }),
        )
        throw reason
      }
    } finally {
      guest.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point })
    }
  }
  async function exists(): Promise<boolean> {
    try {
      await host.stat(marker)
      return true
    } catch (reason) {
      if ((reason as { code?: string }).code === 'ENOENT') return false
      throw reason
    }
  }
}
