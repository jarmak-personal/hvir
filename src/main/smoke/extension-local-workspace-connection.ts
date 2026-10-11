import type { BrowserWindow, WebContents } from 'electron'
import { joinHostPath, type HostPath } from '../../shared/host-path'
import type { ExtensionView } from '../../shared/extensions/workbench'
import type { ExtensionConnectionProposal } from '../../shared/extensions/connectors'
import type { ProjectHost } from '../project-host/project-host'
import type { ExtensionApplicationRuntime } from '../extensions/extension-application'
import { extensionSettingsControls } from './extension-settings-controls'
import { focusSmokeWindow } from './window-focus'

/** Authored public bridge fixture: registered local view, trusted consent and real finite command. */
export async function verifyLocalWorkspaceConnection(
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
  const activations = runtime.activations!,
    approvals = runtime.connectors!.approvals
  const source = joinHostPath(activations.directory, 'local-project-connection')
  const marker = joinHostPath(activations.directory, '..', 'local-project-command')
  await host.createDirectoryExclusive(source, { mode: 0o755 })
  await host.writeFile(
    joinHostPath(source, 'hvir-extension.json'),
    JSON.stringify({
      id: 'hvir.local-project-connection',
      name: 'Local project connection',
      version: '0.3.0',
      contract: '1.0',
      requiredCapabilities: [
        'context.read',
        'connector.connect',
        'connector.execute',
        'connector.output',
      ],
      optionalCapabilities: [],
      access: [],
      views: [
        {
          id: 'project',
          title: 'Local connection',
          entry: 'index.html',
          placement: 'workspace',
          navigation: 'left',
          representations: ['view'],
        },
      ],
      connectors: [
        {
          id: 'project-tool',
          description: 'Read owned local project observations',
          context: 'workspace',
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
    '<!doctype html><button id="connect" disabled>Connect project program</button><button id="run" disabled>Read project observation</button><p id="state"></p><script type="module" src="page.js"></script>',
  )
  const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
  const command = `pwd -P > ${quote(marker.path)}; printf 'workspace connected\\n'`
  await host.writeFile(
    joinHostPath(source, 'page.js'),
    `
    const bridge=window.hvirExtension, pending=new Map();let serial=0,context;
    function action(){document.body.dataset.actions=String(Number(document.body.dataset.actions||0)+1)}
    function request(capability,input){const id='fixture-'+(++serial);return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});bridge.send({kind:'request',id,capability,input})})}
    bridge.onMessage(message=>{
      if(message.kind==='context'){context=message.context;for(const id of ['connect','run'])document.getElementById(id).disabled=!context.visible}
      if(message.kind==='result'){const request=pending.get(message.id);if(!request)return;pending.delete(message.id);message.ok?request.resolve(message.value):request.reject()}
    });
    document.getElementById('connect').onclick=async()=>{action();document.getElementById('state').textContent='pending';try{const result=await request('connector.connect',{connector:'project-tool'});document.getElementById('state').textContent=result.connections[0]?.outcome}catch{document.getElementById('state').textContent='refused'}};
    document.getElementById('run').onclick=async()=>{action();document.getElementById('state').textContent='running';document.body.dataset.phase='execute';try{const result=await request('connector.execute',{connector:'project-tool',host:context.workspace.host,workspace:context.workspace.id,args:['-c',${JSON.stringify(command)}]});Object.assign(document.body.dataset,{outcome:result.outcome,reason:result.reason||'none',code:String(result.code),truncated:String(result.truncated),receipt:String(!!result.receipt)});if(result.outcome!=='completed'||result.code!==0||result.truncated)throw 0;document.body.dataset.phase='output';const page=await request('connector.output',{receipt:result.receipt,stream:'stdout',offset:0});document.body.dataset.phase='release';document.body.dataset.matched=String(page.data==='workspace connected\\n');await request('connector.output',{receipt:result.receipt,release:true});document.body.dataset.phase='done';document.getElementById('state').textContent=page.data==='workspace connected\\n'?'completed':'refused'}catch{document.getElementById('state').textContent='refused'}};
    bridge.send({kind:'hello',contract:'1.0'});
  `,
  )
  const settings = extensionSettingsControls(win, 'Local project connection', {
    wait: (predicate, label) => controls.wait(predicate, label),
    within: (work) => work,
  })
  await controls.click('Discover extensions')
  await settings.click('Enable')
  await controls.wait(
    async () =>
      [...activations.active.values()].some(
        (entry) => entry.revision.manifest.id === 'hvir.local-project-connection',
      ) && (await settings.settled()),
    'explicit project package activation and Settings completion',
  )
  const installed = [...activations.active.values()].find(
    (entry) => entry.revision.manifest.id === 'hvir.local-project-connection',
  )!
  if (approvals.get(installed, 'project-tool'))
    throw new Error('Settled installation implicitly approved the workspace program')
  if (await exists())
    throw new Error('Settled installation executed the workspace program')
  console.log(
    '[smoke] local project package activation settled without native approval or execution marker OK',
  )
  const first = await open()
  await guestClick(first.guest, 'connect')
  const withdrawn = await proposal()
  await win.webContents.executeJavaScript(
    `window.hvir.invoke('extensions:close-view',{viewId:${JSON.stringify(first.view.id)}})`,
  )
  await controls.wait(
    async () => !(await proposals()).length && first.guest.isDestroyed(),
    'closed project view retires native decision',
  )
  const lateDenied = (await win.webContents.executeJavaScript(
    `window.hvir.invoke('extensions:connection-decide',{id:${JSON.stringify(withdrawn.id)},accepted:true}).then(()=>false,()=>true)`,
  )) as boolean
  if (!lateDenied || approvals.get(installed, 'project-tool') || (await exists()))
    throw new Error('Late closed-view response created native authority')
  await controls.click('Open settings')
  await controls.click('Extensions')
  const current = await open()
  await guestClick(current.guest, 'connect')
  const decision = await proposal()
  if (
    decision.programs.length !== 1 ||
    decision.programs[0]?.context !== 'workspace' ||
    decision.programs[0]?.host !== host.hostId ||
    approvals.get(installed, 'project-tool') ||
    (await exists())
  )
    throw new Error('Local project proposal changed host scope or ran before consent')
  await controls.wait(
    () =>
      win.webContents.executeJavaScript(`(() => {
    const modal=document.querySelector('[aria-labelledby="connection-confirmation-title"]');
    return !!modal?.checkVisibility() && modal.contains(document.activeElement) && modal.textContent.includes('projects on this computer') && modal.textContent.includes('folder does not limit access to your account');
  })()`),
    'trusted project native scope and safe focus',
  )
  await controls.click('Connect')
  await controls.wait(
    () =>
      current.guest.executeJavaScript(
        "document.getElementById('state')?.textContent==='connected'",
      ),
    'ordinary local project connection result',
  )
  await guestClick(current.guest, 'connect')
  await controls.wait(
    () =>
      current.guest.executeJavaScript(
        "document.getElementById('state')?.textContent==='connected'",
      ),
    'unchanged project approval reused without another decision',
  )
  if ((await proposals()).length)
    throw new Error('Unchanged local project approval prompted again')
  await guestClick(current.guest, 'run')
  try {
    await controls.wait(
      () =>
        current.guest.executeJavaScript(
          "document.getElementById('state')?.textContent==='completed'",
        ),
      'public native project observation and complete output',
    )
  } catch (reason) {
    const evidence: unknown = await current.guest.executeJavaScript(`(() => {
      const data=document.body.dataset;
      const known=(value,values)=>values.includes(value)?value:'unknown';
      return {phase:known(data.phase,['execute','output','release','done']),outcome:known(data.outcome,['not-started','completed','interrupted-uncertain']),reason:known(data.reason,['none','unavailable','unapproved','disconnected','capacity','frequency','context-ended','interrupted','deadline','output-limit','transport']),code:/^(?:null|-?\\d{1,3})$/.test(data.code)?data.code:'unknown',truncated:data.truncated==='true',receipt:data.receipt==='true',matched:data.matched==='true'};
    })()`)
    console.log('[smoke] bounded local project native result', JSON.stringify(evidence))
    throw reason
  }
  if (
    (await host.readFile(marker)).toString().trim() !==
    (await host.realpath(workspace.root)).path
  )
    throw new Error('Native project command did not use its admitted registered root')
  await controls.click('Open settings')
  await controls.click('Extensions')
  await settings.click('Remove')
  await controls.click('Confirm remove')
  await controls.wait(
    async () =>
      !activations.active.has(installed.installationId) && (await settings.settled()),
    'local connection fixture removed',
  )
  console.log(
    '[smoke] ordinary local left project connection, host-scoped native consent, closed-view late denial, unchanged reuse and exact registered native cwd OK',
  )

  async function open(): Promise<{ view: ExtensionView; guest: WebContents }> {
    await controls.click('Close settings')
    await controls.wait(
      async () =>
        !(await win.webContents.executeJavaScript(
          "!!document.querySelector('.settings-dialog')",
        )),
      'ordinary Settings closed before selecting project view',
    )
    await controls.click('Local connection')
    await controls.wait(
      async () =>
        (
          (await win.webContents.executeJavaScript(
            "window.hvir.invoke('extensions:views',undefined)",
          )) as readonly ExtensionView[]
        ).some(
          (view) =>
            view.installationId === installed.installationId &&
            view.context?.surface === 'left',
        ),
      'ordinary local project view admission',
    )
    const views = (await win.webContents.executeJavaScript(
      "window.hvir.invoke('extensions:views',undefined)",
    )) as readonly ExtensionView[]
    const view = views.find((entry) => entry.installationId === installed.installationId)!
    if (
      view?.context?.workspace?.id !== workspace.id ||
      view.context.workspace.host !== host.hostId ||
      view.context.surface !== 'left'
    )
      throw new Error(
        'Workspace setup view was not admitted to the current local project',
      )
    return { view, guest: await controls.guest(view) }
  }
  function proposals(): Promise<readonly ExtensionConnectionProposal[]> {
    return win.webContents.executeJavaScript(
      "window.hvir.invoke('extensions:connection-proposals',undefined)",
    )
  }
  async function proposal(): Promise<ExtensionConnectionProposal> {
    await controls.wait(
      async () =>
        (await proposals()).some(
          (entry) => entry.installationId === installed.installationId,
        ),
      'current local project connection proposal',
    )
    return (await proposals()).find(
      (entry) => entry.installationId === installed.installationId,
    )!
  }
  async function guestClick(guest: WebContents, id: string): Promise<void> {
    await focusSmokeWindow(win, 'window')
    await controls.wait(
      () =>
        guest.executeJavaScript(
          `!!document.getElementById(${JSON.stringify(id)})?.checkVisibility() && !document.getElementById(${JSON.stringify(id)}).disabled`,
        ),
      'current visible project guest control',
    )
    const point = (await guest.executeJavaScript(
      `(() => {const rect=document.getElementById(${JSON.stringify(id)}).getBoundingClientRect();return {x:Math.round(rect.x+rect.width/2),y:Math.round(rect.y+rect.height/2)}})()`,
    )) as { x: number; y: number }
    const before = (await guest.executeJavaScript(
      'Number(document.body.dataset.actions||0)',
    )) as number
    guest.focus()
    guest.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point })
    guest.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point })
    await controls.wait(
      () =>
        guest.executeJavaScript(`Number(document.body.dataset.actions)===${before + 1}`),
      'fresh project guest action reached its public request handler',
    )
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
