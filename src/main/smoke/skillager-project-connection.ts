import {
  dialog,
  type BrowserWindow,
  type WebContents,
  type OpenDialogOptions,
} from 'electron'
import { joinHostPath, localPath, type HostPath } from '../../shared/host-path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import type { ProjectHost } from '../project-host/project-host'
import { trustedRendererControl } from './trusted-renderer-control'

/** Maintained project document, actual public bridge and trusted decision; only OS choice is substituted. */
export async function verifySkillagerProjectConnection(
  win: BrowserWindow,
  guest: WebContents,
  host: ProjectHost,
  root: HostPath,
  executable: string,
  controls: {
    wait(predicate: () => boolean | Promise<boolean>, label: string): Promise<void>
    ready(predicate: () => Promise<boolean>, label: string): Promise<void>
    within<T>(work: Promise<T>): Promise<T>
    reopen(): Promise<WebContents>
    reader(): Promise<WebContents>
    hasReadDecision(): boolean
  },
): Promise<void> {
  const skill = joinHostPath(root, '.agents', 'skills', 'project-connection-proof')
  for (const folder of [
    joinHostPath(root, '.agents'),
    joinHostPath(root, '.agents', 'skills'),
  ])
    await host
      .createDirectoryExclusive(folder, { mode: 0o755 })
      .catch((reason: unknown) => {
        if ((reason as { code?: string }).code !== 'EEXIST') throw reason
      })
  await host.createDirectoryExclusive(skill, { mode: 0o755 })
  const instruction =
    '---\nname: project-connection-proof\ndescription: Use catalogneedle and the recorded project examples to verify ordinary project discovery.\n---\n\n# Project connection proof\n\nRead only after an explicit current selection.\n'
  await host.writeFile(joinHostPath(skill, 'SKILL.md'), instruction)
  // Real editable discovery reproduces the provenance collision without installing
  // anything or changing the user's environment. The package copy is unrelated.
  const packages = joinHostPath(root, '.venv', 'lib', 'python3.13', 'site-packages')
  for (const relative of [
    '.venv',
    '.venv/lib',
    '.venv/lib/python3.13',
    '.venv/lib/python3.13/site-packages',
    '.venv/lib/python3.13/site-packages/example-1.0.dist-info',
    '.venv/lib/python3.13/site-packages/example',
    '.venv/lib/python3.13/site-packages/example/skills',
    '.venv/lib/python3.13/site-packages/example/skills/package-only',
  ])
    await host.createDirectoryExclusive(joinHostPath(root, ...relative.split('/')), {
      mode: 0o755,
    })
  await host.writeFile(
    joinHostPath(packages, 'example-1.0.dist-info', 'METADATA'),
    'Metadata-Version: 2.1\nName: example\nVersion: 1.0\n',
  )
  await host.writeFile(
    joinHostPath(packages, 'example-1.0.dist-info', 'direct_url.json'),
    JSON.stringify({ url: pathToFileURL(root.path).href, dir_info: { editable: true } }),
  )
  await host.writeFile(
    joinHostPath(packages, 'example-1.0.dist-info', 'RECORD'),
    'example/skills/package-only/SKILL.md,,\n',
  )
  await host.writeFile(
    joinHostPath(packages, 'example', 'skills', 'package-only', 'SKILL.md'),
    '---\nname: project-connection-proof\ndescription: Unrelated package copy.\n---\n\n# Package copy\n',
  )
  const currentInventory = `(() => {
    const rows=[...document.querySelectorAll('#skills [data-skill-select]')];
    return rows.filter(row=>row.dataset.sourcePath===${JSON.stringify(joinHostPath(skill, 'SKILL.md').path)}).length===1 &&
      rows.every(row=>row.dataset.sourcePath!==${JSON.stringify(joinHostPath(packages, 'example', 'skills', 'package-only', 'SKILL.md').path)});
  })()`
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
        : original(parent as Electron.OpenDialogOptions)
    if (options?.buttonLabel !== 'Use program')
      throw new Error('Project connection unexpectedly requested another native setup')
    programSelections++
    return { canceled: false, filePaths: [executable] }
  }
  const inspect = (expression: string): Promise<unknown> =>
    controls.within(guest.executeJavaScript(expression))
  try {
    await observe()
    await controls.wait(
      async () =>
        (await inspect(
          "document.getElementById('state')?.dataset.state==='missing-program' && document.getElementById('connect-program')?.checkVisibility() && !document.getElementById('connect-program').disabled",
        )) === true,
      'maintained local project offers in-context Connect without Settings',
    )
    // Retain the project filter through both decisions; this form has no Library options.
    await inspect(`(() => {
      document.getElementById('query').value='catalogneedle';
      document.getElementById('search-form').requestSubmit();
    })()`)
    await controls.wait(
      async () =>
        (await inspect(
          "document.getElementById('state')?.dataset.state==='missing-program'",
        )) === true,
      'unapproved project query remains actionable',
    )
    await connect()
    await captureWorking()
    await decide(false)
    await controls.wait(
      async () =>
        (await inspect(
          "document.getElementById('state')?.dataset.state==='unapproved' && !document.getElementById('connect-program').disabled && document.getElementById('query').value==='catalogneedle'",
        )) === true,
      'project decline preserves query and a usable Connect action',
    )
    await connect()
    await decide(true)
    if (process.env.HVIR_EXTENSION_VISUAL_DIRECTORY) {
      await controls.wait(
        async () =>
          (await inspect(
            "document.getElementById('connection-status')?.textContent==='Loading skills…' && !document.getElementById('connect-program').hidden",
          )) === true,
        'first useful observation remains visibly pending',
      )
      await captureWorking('Loading skills…', 'loading')
    }
    await controls.ready(
      async () =>
        (await inspect(`(() => {
          const state=document.getElementById('state'), query=document.getElementById('query');
          return state?.dataset.state==='ready' && document.querySelectorAll('#skills [data-skill-select]').length===1 && ${currentInventory} &&
            query.value==='catalogneedle' && !document.querySelector('.search-options') &&
            document.getElementById('connect-program').hidden && document.getElementById('connection-status').hidden && document.getElementById('connect-program').getAttribute('aria-busy')==='false' &&
            globalThis.__hvirProjectConnectionProof.connecting && globalThis.__hvirProjectConnectionProof.observing;
        })()`)) === true,
      'current project connection automatically filters exact project metadata while retaining the submitted query',
    )
    await inspect("document.getElementById('browse').click()")
    await controls.ready(
      async () =>
        (await inspect(
          `document.getElementById('state')?.dataset.state==='ready' && ${currentInventory}`,
        )) === true,
      'public project inventory includes the pending editable-classified native file once and excludes its package copy',
    )
    if (programSelections > 2)
      throw new Error('Project connection repeatedly requested native program selection')
    console.log(
      '[smoke] maintained left project Connect → trusted decline/retry/allow → automatic genuine metadata; preserved public project query and actual owned project discovery, no Settings/path/JSON/Inspect/init OK (successful OS program choice substituted)',
    )
    console.log(
      '[smoke] bounded project public replies',
      JSON.stringify(await inspect('globalThis.__hvirProjectConnectionProof')),
    )
    guest = await controls.reopen()
    await controls.ready(
      async () =>
        (await inspect(
          `document.getElementById('state')?.dataset.state==='ready' && document.getElementById('connect-program').hidden && document.getElementById('query').value==='' && ${currentInventory}`,
        )) === true,
      'a fresh already-connected project document automatically lists its current native skill with no interaction',
    )
    console.log(
      '[smoke] project inventory: editable overlap, unrelated package exclusion and automatic connected document reuse OK',
    )
    await inspect(
      `([...document.querySelectorAll('#skills [data-skill-select]')].find(row=>row.dataset.sourcePath===${JSON.stringify(joinHostPath(skill, 'SKILL.md').path)})).click()`,
    )
    const reader = await controls.reader()
    const readerReady = () =>
      controls.within(
        reader.executeJavaScript(
          `document.getElementById('reader-state')?.dataset.state==='ready' && document.getElementById('source-label')?.textContent?.endsWith(${JSON.stringify(`local: ${joinHostPath(skill, 'SKILL.md').path}`)}) && document.getElementById('details')?.dataset.sha256===${JSON.stringify(createHash('sha256').update(instruction).digest('hex'))} && document.getElementById('instructions')?.textContent?.includes('Project connection proof')`,
        ),
      ) as Promise<boolean>
    await controls.wait(
      readerReady,
      'exact selected project file reads after combined consent',
    )
    await controls.within(
      reader.executeJavaScript(
        "document.getElementById('read-current').closest('details').open=true;document.getElementById('read-current').click()",
      ),
    )
    await controls.wait(readerReady, 'approved project source reuses its exact grant')
    if (controls.hasReadDecision())
      throw new Error('Unchanged project read repeated its consent')
    await captureBrowser('connected-project')
    await inspect("document.getElementById('scope-library').focus()")
    guest.focus()
    guest.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
    guest.sendInputEvent({ type: 'char', keyCode: '\r' })
    guest.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
    await controls.ready(
      async () =>
        (await inspect(
          "document.getElementById('scope-library').getAttribute('aria-pressed')==='true' && document.getElementById('state').dataset.state==='ready' && document.querySelectorAll('#skills [data-source-toggle]').length>0 && document.querySelectorAll('#skills [data-skill-select]').length===0",
        )) === true,
      'keyboard changes the project sidebar to its Library scope',
    )
    await captureBrowser('connected-library')
    await inspect("document.querySelector('#skills [data-source-toggle]').click()")
    await controls.ready(
      async () =>
        (await inspect(
          "document.querySelector('#skills [data-source-toggle]').getAttribute('aria-expanded')==='true' && document.querySelectorAll('#skills [data-skill-select]').length>0",
        )) === true,
      'project Library scope expands one source without changing the reader',
    )
    if (controls.hasReadDecision())
      throw new Error('Source expansion requested file access')
    await controls.wait(
      readerReady,
      'project Library source expansion preserves current reading',
    )
    await captureBrowser('connected-library-expanded')
    await inspect("document.getElementById('scope-project').focus()")
    guest.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
    guest.sendInputEvent({ type: 'char', keyCode: '\r' })
    guest.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
    await controls.ready(
      async () =>
        (await inspect(
          `document.getElementById('scope-project').getAttribute('aria-pressed')==='true' && ${currentInventory} && !!document.querySelector('#skills [aria-current=true]')`,
        )) === true,
      'keyboard returns to the exact Project selection in the same list',
    )
    if ((await controls.reader()).id !== reader.id)
      throw new Error('Project scope switching created a second instruction reader')
    await controls.wait(
      readerReady,
      'Project scope return retains exact selected instructions',
    )

    console.log(
      '[smoke] combined project consent and exact selected read/reuse without another decision OK',
    )
  } catch (error) {
    console.log(
      '[smoke] bounded maintained project connection facts',
      JSON.stringify(
        await inspect(`(() => {
        const state=document.getElementById('state'), connect=document.getElementById('connect-program');
        return {state:state?.dataset.state, connectVisible:!!connect?.checkVisibility(), connectDisabled:connect?.disabled,
          rows:document.querySelectorAll('#skills [data-skill-select]').length, nativeFocus:document.hasFocus(),
          queryRetained:document.getElementById('query')?.value==='catalogneedle', publicReplies:globalThis.__hvirProjectConnectionProof??null};
      })()`).catch(() => ({ inspectionUnavailable: true })),
      ),
    )
    throw error
  } finally {
    Object.defineProperty(dialog, 'showOpenDialog', descriptor)
    if (!guest.isDestroyed())
      await inspect(
        'globalThis.__hvirProjectConnectionProofStop?.(); delete globalThis.__hvirProjectConnectionProofStop; delete globalThis.__hvirProjectConnectionProof',
      ).catch(() => console.log('[smoke] project proof observer cleanup unavailable'))
  }
  async function observe(): Promise<void> {
    const debuggerPort = guest.debugger,
      owned = !debuggerPort.isAttached()
    let objectId: string | undefined
    try {
      if (owned) debuggerPort.attach('1.3')
      const global = (await controls.within(
        debuggerPort.sendCommand('Runtime.evaluate', { expression: 'globalThis' }),
      )) as { result?: { objectId?: string } }
      objectId = global.result?.objectId
      if (!objectId) throw new Error('Project public observer document unavailable')
      const observed = (await controls.within(
        debuggerPort.sendCommand('Runtime.callFunctionOn', {
          objectId,
          functionDeclaration: `function(expectedHost, expectedRoot) {
          const facts={contexts:0,visible:null,workspaceRootMatches:null,connections:0,connection:null,executeReplies:0,execution:null,reason:null,completed:0,outputPages:0,errorReplies:0,saturated:false,connecting:false,observing:false};
          globalThis.__hvirProjectConnectionProof=facts;
          const count=key=>{if(facts[key]<64)facts[key]++;else facts.saturated=true};
          const closed=(value,values)=>values.includes(value)?value:'unknown';
          const progress=new MutationObserver(()=>{
            const button=document.getElementById('connect-program'), status=document.getElementById('connection-status');
            if(button.disabled&&button.getAttribute('aria-busy')==='true'&&status.checkVisibility()){
              if(status.textContent==='Connecting…')facts.connecting=true;
              if(status.textContent==='Loading skills…')facts.observing=true;
            }
          });
          progress.observe(document.getElementById('connection-status'),{childList:true,subtree:true,characterData:true});
          const stop=window.hvirExtension.onMessage(message=>{
            if(message.kind==='context'){
              count('contexts');facts.visible=message.context.visible===true;
              const workspace=message.context.workspace;
              facts.workspaceRootMatches=workspace?.host===expectedHost&&workspace.root?.hostId===expectedHost&&workspace.root.path===expectedRoot;
            }
            if(message.kind!=='result')return;
            if(!message.ok){count('errorReplies');return}
            const value=message.value, connection=value?.connections?.find(item=>item.connector==='project-cli');
            if(connection){count('connections');facts.connection=closed(connection.outcome,['connected','declined','unavailable','interrupted-uncertain'])}
            if(value&&['completed','not-started','interrupted-uncertain'].includes(value.outcome)){
              count('executeReplies');facts.execution=value.outcome;
              facts.reason=closed(value.reason??'none',['none','unavailable','unapproved','disconnected','capacity','frequency','context-ended','interrupted','deadline','output-limit','transport']);
              if(value.outcome==='completed'&&value.code===0&&!value.truncated)count('completed');
            }
            if(typeof value?.data==='string')count('outputPages');
          });
          globalThis.__hvirProjectConnectionProofStop=()=>{stop();progress.disconnect()};return true;
        }`,
          arguments: [{ value: root.hostId }, { value: root.path }],
          returnByValue: true,
        }),
      )) as { result?: { value?: unknown }; exceptionDetails?: unknown }
      if (observed.exceptionDetails || observed.result?.value !== true)
        throw new Error('Project public observer could not subscribe')
    } finally {
      if (objectId && debuggerPort.isAttached())
        await controls
          .within(debuggerPort.sendCommand('Runtime.releaseObject', { objectId }))
          .catch(() => {})
      if (owned && debuggerPort.isAttached()) debuggerPort.detach()
    }
  }
  async function connect(): Promise<void> {
    await controls.wait(
      async () =>
        (await inspect(`(() => {
          const button=document.getElementById('connect-program');
          if(!button?.checkVisibility()||button.disabled)return false;
          button.click();
          const status=document.getElementById('connection-status');
          if(!button.disabled||button.getAttribute('aria-busy')!=='true'||!status.checkVisibility()||status.textContent!=='Connecting…')throw new Error('Connect lacks immediate adjacent busy feedback');
          return true;
        })()`)) === true,
      'actual enabled maintained project Connect control',
    )
  }
  async function captureBrowser(name: string): Promise<void> {
    const directory = process.env.HVIR_EXTENSION_VISUAL_DIRECTORY
    if (!directory) return
    await inspect(
      'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',
    )
    const facts = await inspect(`(() => {
      const scope=document.querySelector('.browser-scopes [aria-pressed=true]');
      const rows=[...document.querySelectorAll('#skills [data-skill-select]')];
      const menu=document.querySelector('.library-options > summary');
      const groups=document.querySelectorAll('#skills [data-source-toggle]').length;
      if(!scope?.checkVisibility()||!(scope.id==='scope-library'?groups:rows.length)||!menu?.getAttribute('aria-label')||!menu.title)throw new Error('Connected browser lacks visible scope, results or discoverable options');
      return {scope:scope.id,rows:rows.length,groups,selected:rows.find(row=>row.getAttribute('aria-current')==='true')?.dataset.id??null,menu:menu.title,readerId:${(await controls.reader()).id}};
    })()`)
    await host.writeFile(
      joinHostPath(localPath(directory), `${name}.png`),
      (await win.webContents.capturePage()).toPNG(),
    )
    await host.writeFile(
      joinHostPath(localPath(directory), `${name}-guest.png`),
      (await guest.capturePage()).toPNG(),
    )
    await host.writeFile(
      joinHostPath(localPath(directory), `${name}.json`),
      JSON.stringify(facts, null, 2),
    )
  }
  async function captureWorking(
    message = 'Connecting…',
    name = 'connecting',
  ): Promise<void> {
    const directory = process.env.HVIR_EXTENSION_VISUAL_DIRECTORY
    if (!directory) return
    if (!directory.startsWith('/') || directory === '/')
      throw new Error('Select an owned connection visual directory')
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
    await inspect(
      'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',
    )
    const facts = await inspect(`(() => {
      const button=document.getElementById('connect-program'),status=document.getElementById('connection-status');
      const a=button.getBoundingClientRect(),b=status.getBoundingClientRect(),fits=r=>r.width>0&&r.height>0&&r.left>=0&&r.right<=innerWidth+1&&r.top>=0&&r.bottom<=innerHeight+1;
      if(!button.checkVisibility()||!status.checkVisibility()||!fits(a)||!fits(b)||!button.disabled||status.textContent!==${JSON.stringify(message)})throw new Error('Connect progress is not visible beside its initiating control');
      return {working:status.textContent,busy:button.getAttribute('aria-busy'),adjacent:button.parentElement===status.parentElement,contained:true};
    })()`)
    await host.writeFile(
      joinHostPath(localPath(directory), `project-${name}.png`),
      (await win.webContents.capturePage()).toPNG(),
    )
    await host.writeFile(
      joinHostPath(localPath(directory), `project-${name}.json`),
      JSON.stringify(facts, null, 2),
    )
  }
  async function decide(accepted: boolean): Promise<void> {
    await controls.wait(
      () =>
        trustedRendererControl(
          win,
          `function(expected, expectedRoot, accepted) {
            const modal=document.querySelector('[aria-labelledby="connection-confirmation-title"]');
            if(!modal?.checkVisibility()||!modal.contains(document.activeElement)||!modal.textContent.includes(expected)||
              !modal.textContent.includes('The program runs with your account’s access.')||!modal.textContent.includes('Read selected files in this project')||!modal.textContent.includes(expectedRoot))return false;
            const button=[...modal.querySelectorAll('button')].find(item=>item.textContent.trim()===(accepted?'Connect':'Not now'));
            if(!button?.checkVisibility()||button.disabled)return false;
            button.click();return true;
          }`,
          [canonical, root.path, accepted],
          (work) => controls.within(work),
        ),
      accepted ? 'trusted project native consent' : 'trusted project native decline',
    )
  }
}
