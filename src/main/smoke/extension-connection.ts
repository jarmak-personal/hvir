import {
  app,
  dialog,
  BrowserWindow,
  type WebContents,
  type OpenDialogOptions,
} from 'electron'
import { joinHostPath, localPath } from '../../shared/host-path'
import { join } from 'node:path'
import type { ProjectHost } from '../project-host/project-host'
import type { ExtensionApplicationRuntime } from '../extensions/extension-application'
import type { ExtensionView } from '../../shared/extensions/workbench'
import type { ExtensionConnectionProposal } from '../../shared/extensions/connectors'
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
          navigation: 'top',
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
        {
          id: 'missing-tool',
          description: 'Read owned demonstration metadata',
          context: 'application',
          timeoutMs: 5000,
          outputBytes: 1024,
          environment: [],
          setup: { executable: 'hvir-owned-missing-tool-853' },
        },
      ],
    }),
  )
  await host.writeFile(
    joinHostPath(source, 'index.html'),
    '<!doctype html><button id="connect" disabled>Connect installed program</button><button id="locate" disabled>Locate another program</button><button id="read" disabled>Read metadata</button><p id="state"></p><pre id="output"></pre><script type="module" src="page.js"></script>',
  )
  // The authored package consumes the real maintained client in its own sandbox.
  // This checkout smoke proves SDK/lifecycle, not Skillager domain compatibility.
  await host.writeFile(
    joinHostPath(source, 'client.mjs'),
    await host.readFile(
      localPath(join(app.getAppPath(), 'packages/skillager-extension/src/bridge.mjs')),
    ),
  )
  const command = `printf x >> '${marker.path.replaceAll("'", "'\\''")}' ; printf 'owned connection output\\n'`
  await host.writeFile(
    joinHostPath(source, 'page.js'),
    `
    import {guestClient} from './client.mjs';
    const bridge=window.hvirExtension, client=guestClient(bridge), request=(capability,input)=>client.request(capability,input);
    let hiddenContexts=0;
    bridge.onMessage(message=>{
      if(message.kind==='context'){
        if(!message.context.visible)hiddenContexts++;
        document.body.dataset.hiddenContexts=String(hiddenContexts);
        for(const id of ['connect','locate','read'])document.getElementById(id).disabled=!message.context.visible;
      }
    });
    window.addEventListener('pagehide',()=>client.dispose());
    function connect(connector){document.getElementById('state').textContent='pending';request('connector.connect',{connector}).then(result=>{document.getElementById('state').textContent=result.connections[0]?.outcome},()=>{document.getElementById('state').textContent='refused'})}
    document.getElementById('connect').onclick=()=>connect('tool');
    document.getElementById('locate').onclick=()=>connect('missing-tool');
    document.getElementById('read').onclick=async()=>{try{const result=await request('connector.execute',{connector:'tool',host:'local',args:['-c',${JSON.stringify(command)}]});if(result.outcome!=='completed'||result.code!==0)throw new Error('execution failed');const page=await request('connector.output',{receipt:result.receipt,stream:'stdout',offset:0});document.getElementById('output').textContent=page.data;await request('connector.output',{receipt:result.receipt,release:true})}catch(error){document.getElementById('output').textContent='refused'}};
    client.hello();
  `,
  )
  const expected = await activations.packages.captureSource(source)
  const originalOpen = dialog.showOpenDialog.bind(dialog)
  const originalDescriptor = Object.getOwnPropertyDescriptor(dialog, 'showOpenDialog')
  if (!originalDescriptor) throw new Error('Native picker property is unavailable')
  let decisions = 0,
    selections = 0
  let focusWindow: BrowserWindow | undefined
  let allowManual = false
  dialog.showOpenDialog = async (
    parent: BrowserWindow | OpenDialogOptions,
    options?: OpenDialogOptions,
  ) => {
    if (parent !== win)
      return options
        ? originalOpen(parent as BrowserWindow, options)
        : originalOpen(parent as OpenDialogOptions)
    if (options?.buttonLabel === 'Use program' && allowManual) {
      selections++
      focusWindow = new BrowserWindow({
        show: false,
        width: 240,
        height: 140,
        webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true },
      })
      await focusWindow.loadURL('data:text/html,<p>Owned passive choice</p>')
      focusWindow.show()
      focusWindow.focus()
      await controls.wait(
        () => !win.isFocused() && win.isVisible() && !win.isMinimized(),
        'actual non-key parent during passive program selection',
      )
      if (
        (await proposals()).length ||
        approvals.get(
          [...activations.active.values()].find(
            (entry) => entry.revision.manifest.id === 'hvir.connection-smoke',
          )!,
          'missing-tool',
        )
      )
        throw new Error('Passive selection prepared a decision or grant')
      focusWindow.destroy()
      focusWindow = undefined
      await focusSmokeWindow(win, 'window')
      return { canceled: false, filePaths: ['/bin/sh'] }
    }
    if (!options || options.buttonLabel !== 'Add extension')
      throw new Error('Unexpected native chooser during connection scenario')
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
    await controls.click('Close settings')
    await controls.click('Connection example')
    await controls.wait(
      async () =>
        (await views()).some(
          (view: ExtensionView) =>
            view.installationId === installed.installationId &&
            view.context?.surface === 'top',
        ),
      'ordinary installed view',
    )
    const view = (await views()).find(
        (entry: ExtensionView) => entry.installationId === installed.installationId,
      )!,
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
    const hiddenBefore = (await guest.executeJavaScript(
      'Number(document.body.dataset.hiddenContexts)',
    )) as number
    allowManual = true
    await guestClick('locate')
    await decide(true)
    await controls.wait(
      () =>
        guest.executeJavaScript(
          "document.getElementById('state')?.textContent==='connected'",
        ),
      'missing-name manual retry survives actual native focus withdrawal and returns through SDK',
    )
    if (
      (await guest.executeJavaScript('Number(document.body.dataset.hiddenContexts)')) <=
        hiddenBefore ||
      !(await views()).some((entry) => entry.id === view.id)
    )
      throw new Error(
        'SDK intent did not survive actual top-view withdrawal on the same guest',
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
      selections !== 2 ||
      decisions !== 4
    )
      throw new Error('Discovery/consent executed a tool or repeated installation')
    await controls.click('Open settings')
    await controls.click('Extensions')
    await settings.click('Remove')
    await controls.click('Confirm remove')
    let cleanupFacts:
      { active: boolean; manifestPresent: boolean; ordinarySettled: boolean } | undefined
    try {
      await controls.wait(async () => {
        cleanupFacts = {
          active: activations.active.has(installed.installationId),
          manifestPresent: activations
            .snapshot()
            .installations.some(
              (entry) => entry.manifest?.id === installed.revision.manifest.id,
            ),
          ordinarySettled: await settings.settled(),
        }
        return (
          !cleanupFacts.active &&
          !cleanupFacts.manifestPresent &&
          cleanupFacts.ordinarySettled
        )
      }, 'connection fixture removal')
    } catch (reason) {
      console.log(
        '[smoke:connection-cleanup-facts]',
        JSON.stringify(cleanupFacts ?? { observationUnavailable: true }),
      )
      throw reason
    }
    console.log(
      '[smoke] actual Add/passive metadata/default trusted connection/top current SDK focus to trusted decline and allow/manual retry after native focus withdrawal/public finite output OK (OS Add/program selection substituted; authored metadata, no Skillager compatibility claim)',
    )
  } finally {
    Object.defineProperty(dialog, 'showOpenDialog', originalDescriptor)
    if (focusWindow && !focusWindow.isDestroyed()) focusWindow.destroy()
  }
  function views(): Promise<readonly ExtensionView[]> {
    return win.webContents.executeJavaScript(
      "window.hvir.invoke('extensions:views', undefined)",
    )
  }
  function proposals(): Promise<readonly ExtensionConnectionProposal[]> {
    return win.webContents.executeJavaScript(
      "window.hvir.invoke('extensions:connection-proposals', undefined)",
    )
  }
  async function decide(accepted: boolean): Promise<void> {
    await controls.wait(async () => {
      const proposal = (await proposals())[0]
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
    const facts = {
      decision: decisions + 1,
      focused: win.isFocused(),
      visible: win.isVisible(),
      minimized: win.isMinimized(),
      currentProposal: (await proposals()).length === 1,
      markerPresent: await exists(),
    }
    if (
      !facts.focused ||
      !facts.visible ||
      facts.minimized ||
      !facts.currentProposal ||
      facts.markerPresent
    ) {
      console.log('[smoke:connection-consent-facts]', JSON.stringify(facts))
      throw new Error(
        'Trusted consent lost native foreground/current proposal or a program ran before consent',
      )
    }
    await controls.click(accepted ? 'Connect' : 'Not now')
    decisions++
    await controls.wait(
      async () => (await proposals()).length === 0,
      'exact trusted proposal retired',
    )
  }
  async function guestClick(id: string): Promise<void> {
    const view = (await views()).find(
      (entry: ExtensionView) =>
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
