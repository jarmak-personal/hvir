import { inspectSkillagerSearch, submitSkillagerSearch } from './skillager-search'
import {
  verifySkillagerNavigation,
  verifySkillagerNavigationFallback,
} from './skillager-navigation'
import {
  installSkillagerFirstUse,
  assertRetiredSkillagerReadDecision,
} from './skillager-first-use'
import { extensionSettingsControls } from './extension-settings-controls'
import { captureExtensionVisuals } from './extension-visuals'
import { createHash } from 'node:crypto'
import { app, type BrowserWindow, type WebContents } from 'electron'
import { localPath } from '../../shared/host-path'
import type { ProjectHost } from '../project-host/project-host'
import type { ExtensionApplicationRuntime } from '../extensions/extension-application'
import type { RendererResourceScopes } from '../renderer-resource-scopes'
import type { ExtensionView } from '../../shared/extensions/workbench'
interface Controls {
  click(name: string): Promise<void>
  wait(predicate: () => boolean | Promise<boolean>, label: string): Promise<void>
  guest(view: ExtensionView): Promise<WebContents>
}
/** Opt-in genuine installed-CLI walkthrough; no fake library backend or privileged body API. */
export async function verifySkillagerExtension(
  win: BrowserWindow,
  extensions: ExtensionApplicationRuntime,
  scopes: RendererResourceScopes,
  host: ProjectHost,
  controls: Controls,
): Promise<boolean> {
  const executable = process.env.HVIR_SKILLAGER_EVIDENCE_CLI,
    catalog = process.env.HVIR_SKILLAGER_EVIDENCE_CATALOG,
    root = process.env.HVIR_SKILLAGER_EVIDENCE_LIBRARY,
    archive = process.env.HVIR_SKILLAGER_EVIDENCE_PACKAGE
  if (!executable && !catalog && !root) return false
  if (!executable || !catalog || !root || app.isPackaged)
    throw new Error(
      'Skillager evidence needs an explicit checkout, CLI, catalog and library root',
    )
  const diagnostic = process.env.HVIR_SKILLAGER_EVIDENCE_READER_DIAGNOSTIC === '1'
  const owner = scopes.currentOwner(win.webContents.id)
  const settings = extensionSettingsControls(win, 'Skillager', {
    wait: (predicate, label) => controls.wait(predicate, label),
    within: bounded,
  })
  let phase = 'trusted setup'
  console.log('[smoke] Skillager evidence: trusted setup')
  const directory = await installSkillagerFirstUse(
    win,
    extensions,
    owner,
    executable,
    host,
    archive,
    controls,
  )
  const source = directory.path.slice(extensions.activations!.directory.path.length + 1)
  await controls.wait(
    () => !!view('library'),
    'Add prepared ordinary application library placement',
  )
  phase = 'ordinary library guest attachment'
  console.log(`[smoke] Skillager evidence: begin ${phase}`)
  const guest = await bounded(controls.guest(view('library')!))
  if (process.env.HVIR_SKILLAGER_EVIDENCE_UNINITIALIZED === '1') {
    await ready(
      guest,
      () =>
        inspect(
          guest,
          "document.getElementById('state')?.dataset.state==='no-personal-library'&&document.querySelectorAll('#skills [role=option]').length===0&&!document.getElementById('create-library').disabled",
        ) as Promise<boolean>,
      'automatic uninitialized state offers CLI-owned default creation without initializing',
    )
    console.log(
      '[smoke] ordinary first use: public uninitialized catalog, explicit Create personal library available, no automatic initialization OK',
    )
    console.log('HVIR_SMOKE_OK')
    return true
  }
  await inspect(
    guest,
    `(() => {
    globalThis.__hvirInitialLibrary={visible:null,results:0,outcome:null,reason:null};
    globalThis.__hvirInitialLibraryStop=window.hvirExtension.onMessage(message=>{
      const facts=globalThis.__hvirInitialLibrary;
      if(message.kind==='context')facts.visible=message.context.visible;
      const value=message.kind==='result'&&message.ok?message.value:undefined;
      if(value&&['completed','not-started','uncertain','interrupted'].includes(value.outcome)){
        facts.results++;facts.outcome=value.outcome;
        facts.reason=['unapproved','frequency','capacity','context-ended','deadline'].includes(value.reason)?value.reason:null;
      }
    });
  })()`,
  )
  let initialCleanupError: unknown
  try {
    await ready(
      guest,
      () =>
        inspect(
          guest,
          "document.querySelectorAll('#skills [role=option]').length===100 && document.getElementById('state').dataset.state==='ready'",
        ) as Promise<boolean>,
      diagnostic
        ? 'current first 100 public library observations'
        : 'current first 100 of genuine 5000',
    )
  } finally {
    try {
      await inspect(
        guest,
        'globalThis.__hvirInitialLibraryStop();delete globalThis.__hvirInitialLibraryStop;delete globalThis.__hvirInitialLibrary',
      )
    } catch (error) {
      initialCleanupError = error
    }
  }
  if (initialCleanupError)
    throw initialCleanupError instanceof Error
      ? initialCleanupError
      : new Error('Initial library observer cleanup failed')
  console.log(
    '[smoke] current library placement',
    JSON.stringify(await placementFacts(guest)),
  )
  const guestViewId = view('library')!.id
  const navigationControls = {
    ...controls,
    within: bounded,
    select: async () => {
      await controls.wait(
        () =>
          dom(
            "(() => {const button=document.querySelector('.project-tab-main');if(!button?.checkVisibility()||button.disabled)return false;button.click();return true})()",
          ),
        'ordinary project destination for navigation',
      )
      await controls.click('Skills in this project')
      await controls.wait(() => !!view('project'), 'package project navigation selected')
    },
    packageClick: (name: string) => click(name),
    disabled: () => installation()?.enabled === false,
    revision: () => installation()?.acceptedRevision,
  }
  await navigationControls.select()
  const projectGuest = await bounded(controls.guest(view('project')!))
  await ready(
    projectGuest,
    () =>
      inspect(
        projectGuest,
        "!!document.getElementById('state') && document.documentElement.style.colorScheme!==''",
      ) as Promise<boolean>,
    'actual project package document/presentation',
  )
  await verifySkillagerNavigation(win, projectGuest, host, navigationControls)
  await selectFreshLibrary()
  const searchPorts = {
    within: bounded,
    inspect: (expression: string) => inspect(guest, expression),
    wait: (predicate: () => Promise<boolean>, label: string) =>
      ready(guest, predicate, label),
    current: () => view('library')?.id === guestViewId && !view('library')?.failure,
    revokeProgram: async () => {
      await controls.click('Open settings')
      await controls.click('Extensions')
      await settings.select('Program access')
      await click('Revoke native access', 'library-cli')
      await controls.click('Close settings')
      await controls.click('Skillager library')
    },
  }
  if (process.env.HVIR_SKILLAGER_SEARCH_PROOF) {
    await inspectSkillagerSearch(win, guest, host, searchPorts)
    if (!archive)
      await verifySkillagerNavigationFallback(win, host, directory, navigationControls)
    console.log('[smoke] actual library Search button/Enter reproduction complete')
    console.log('HVIR_SMOKE_OK')
    return true
  }
  await captureExtensionVisuals(win, guest, host, 'library', {
    ...controls,
    select: () => controls.click('Skillager library'),
  })
  const observed = new Set<string>()
  let pages = 0
  for (;;) {
    const entries = (await inspect(
      guest,
      "[...document.querySelectorAll('#skills [role=option]')].map(row=>row.dataset.id)",
    )) as string[]
    entries.forEach((id) => observed.add(id))
    pages++
    if (pages === 1 || pages % 10 === 0)
      console.log(
        `[smoke] Skillager evidence: ${pages} public pages/${observed.size} identities`,
      )
    if (diagnostic) break
    if ((await inspect(guest, "document.getElementById('next').disabled")) as boolean)
      break
    const first = entries[0]
    await inspect(guest, "document.getElementById('next').click()")
    await ready(
      guest,
      () =>
        inspect(
          guest,
          `document.querySelector('#skills [role=option]')?.dataset.id !== ${JSON.stringify(first)} && document.getElementById('state').dataset.state==='ready'`,
        ) as Promise<boolean>,
      `public cursor page ${pages + 1}`,
    )
    if (pages > 50) throw new Error('Public library cursor did not terminate')
  }
  if (!diagnostic && (observed.size !== 5000 || pages !== 50))
    throw new Error(
      `Genuine library traversal yielded ${observed.size} identities on ${pages} pages`,
    )
  if (
    extensions.guests!.snapshot(owner).some((entry) => entry.contributionId === 'detail')
  )
    throw new Error('Metadata browsing prefetched a detail view')
  await inspect(
    guest,
    "document.querySelector('#skills [role=option]').focus(); document.querySelector('#skills [role=option]').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));",
  )
  if (
    extensions.guests!.snapshot(owner).some((entry) => entry.contributionId === 'detail')
  )
    throw new Error('Keyboard focus prefetched instruction bodies')
  if (extensions.sourceRequests!.snapshot(owner).length)
    throw new Error('Metadata browsing or keyboard focus requested file access')
  if (!process.env.HVIR_EXTENSION_VISUAL_DIRECTORY) {
    await inspect(guest, "document.getElementById('query').value='catalogneedle';")
    for (const mode of ['button', 'enter'] as const) {
      await submitSkillagerSearch(win, guest, searchPorts, mode)
      await ready(
        guest,
        () =>
          inspect(
            guest,
            "document.getElementById('state').dataset.state==='ready' && document.getElementById('state').textContent.includes('matches') && document.querySelectorAll('#skills [role=option]').length>0",
          ) as Promise<boolean>,
        `genuine public ranked search via ${mode}`,
      )
    }
  }
  const clicked = (await inspect(
    guest,
    "(() => {const row=document.querySelector('#skills [role=option]');return {id:row.dataset.id,source:row.dataset.source,path:row.dataset.sourcePath}})()",
  )) as { id: string; source: string; path: string }
  const canonical = await host.realpath(localPath(clicked.path))
  await inspect(guest, "document.querySelector('#skills [role=option]').click()")
  await controls.wait(() => !!view('detail'), 'explicit selected detail')
  phase = 'selected detail guest attachment'
  let detail = await bounded(controls.guest(view('detail')!))
  await controls.wait(
    () => extensions.sourceRequests!.snapshot(owner).length === 1,
    'explicit selected read proposes one canonical local root',
  )
  const readProposal = extensions.sourceRequests!.snapshot(owner)[0]!
  if (
    readProposal.root.hostId !== 'local' ||
    readProposal.root.path !== root ||
    readProposal.source !== 'library'
  )
    throw new Error('First read proposed a different library source')
  await controls.click('Close Skill instructions')
  await controls.wait(
    () => !view('detail') && !extensions.sourceRequests!.snapshot(owner).length,
    'closed reader retires its undecided root request',
  )
  await assertRetiredSkillagerReadDecision(win, readProposal.id, bounded)
  await controls.click('Skillager library')
  await ready(
    guest,
    () =>
      inspect(
        guest,
        "!!document.querySelector('#skills [role=option]') && document.getElementById('state').dataset.state==='ready' && document.getElementById('manage').disabled===false",
      ) as Promise<boolean>,
    'ordinary library restored after reader close',
  )
  await inspect(guest, "document.querySelector('#skills [role=option]').click()")
  try {
    await controls.wait(() => !!view('detail'), 'new explicit reader after close')
  } catch (error) {
    console.log(
      '[smoke] bounded reader reopen failure facts',
      JSON.stringify({
        package: await inspect(
          guest,
          `({state:document.getElementById('state')?.dataset.state??null,message:document.getElementById('state')?.textContent?.slice(0,240)??null,manageDisabled:document.getElementById('manage')?.disabled??null,rows:document.querySelectorAll('#skills [role=option]').length,firstId:document.querySelector('#skills [role=option]')?.dataset.id??null})`,
        ),
        views: extensions.guests!.snapshot(owner).map((entry) => ({
          id: entry.id,
          contribution: entry.contributionId,
          failure: entry.failure ?? null,
        })),
        decisions: extensions.sourceRequests!.snapshot(owner).length,
      }),
    )
    throw error
  }
  detail = await bounded(controls.guest(view('detail')!))
  await controls.wait(
    () => extensions.sourceRequests!.snapshot(owner).length === 1,
    'new reader has a distinct root request',
  )
  await inspect(
    detail,
    `window.skillagerEvidenceVisible = undefined;
    window.skillagerEvidenceStop = window.hvirExtension.onMessage(message => {
      if (message.kind === 'context') window.skillagerEvidenceVisible = message.context.visible;
      if (message.kind === 'result' && message.id === 'skillager-evidence-context' && message.ok) window.skillagerEvidenceVisible = message.value.visible;
    }); window.hvirExtension.send({kind:'request',id:'skillager-evidence-context',capability:'context.read'}); void 0;`,
  )
  await ready(
    detail,
    () => inspect(detail, 'window.skillagerEvidenceVisible===true') as Promise<boolean>,
    'selected reader current public visibility',
  )
  const hiddenProposal = extensions.sourceRequests!.snapshot(owner)[0]!
  await controls.click('Open settings')
  await controls.wait(
    () => !extensions.sourceRequests!.snapshot(owner).length,
    'hidden reader promptly retires root decision',
  )
  await assertRetiredSkillagerReadDecision(win, hiddenProposal.id, bounded)
  await controls.click('Close settings')
  await restoreSelectedReader(detail)
  await inspect(detail, "document.getElementById('read-current').click()")
  try {
    await controls.wait(
      () => extensions.sourceRequests!.snapshot(owner).length === 1,
      'explicit retry after hiding asks again',
    )
  } catch (error) {
    console.log(
      '[smoke] bounded reader retry failure facts',
      JSON.stringify({
        package: await inspect(
          detail,
          "({visible:window.skillagerEvidenceVisible??null,state:document.getElementById('state')?.dataset.state??null,manageDisabled:document.getElementById('manage')?.disabled??null,readVisible:document.getElementById('read-current')?.checkVisibility()??null})",
        ),
        placement: await placementFacts(detail),
        decisions: extensions.sourceRequests!.snapshot(owner).length,
      }),
    )
    throw error
  }
  await controls.click('Not now')
  await ready(
    detail,
    () =>
      inspect(
        detail,
        "document.getElementById('state').dataset.state==='unapproved'&&!document.getElementById('instructions').textContent",
      ) as Promise<boolean>,
    'declined first read exposes no instruction bytes',
  )
  if (
    extensions
      .sources!.approvals.status(
        extensions.activations!.active.get(installation()!.installationId!)!,
      )
      .some((entry) => entry.granted)
  )
    throw new Error('Declined read persisted access')
  await inspect(detail, "document.getElementById('read-current').click()")
  await controls.wait(
    () => extensions.sourceRequests!.snapshot(owner).length === 1,
    'new explicit Read current decision',
  )
  await controls.click('Allow read-only access')
  console.log(
    '[smoke] Skillager evidence: attached detail readiness',
    JSON.stringify({
      url: detail.getURL(),
      loading: detail.isLoading(),
      document: await inspect(
        detail,
        "({ready:document.readyState,instructions:!!document.getElementById('instructions'),details:!!document.getElementById('details'),label:!!document.getElementById('source-label')})",
      ),
    }),
  )
  await ready(
    detail,
    () =>
      inspect(
        detail,
        `document.getElementById('instructions')?.textContent?.length>0 && /^[a-f0-9]{64}$/.test(document.getElementById('details')?.dataset.sha256??'') && document.getElementById('source-label')?.textContent?.endsWith(${JSON.stringify(`local: ${canonical.path}`)})`,
      ) as Promise<boolean>,
    'selected current instructions through grant and guest transport',
  )
  const label = (await inspect(
    detail,
    "document.getElementById('source-label').textContent",
  )) as string
  if (
    clicked.source !== 'library' ||
    !canonical.path.startsWith(root + '/') ||
    !label.endsWith(`local: ${canonical.path}`)
  )
    throw new Error('Instruction source changed to another root')
  const documentWorker = app
    .getAppMetrics()
    .find((entry) => entry.name === 'hvir-document')
  if (
    !documentWorker ||
    documentWorker.pid === process.pid ||
    documentWorker.pid === detail.getOSProcessId()
  )
    throw new Error('Markdown parsing did not execute in the document utility process')
  await inspect(detail, "document.getElementById('source-mode').click()")
  const text = (await inspect(
    detail,
    "document.getElementById('instructions').textContent",
  )) as string
  const expected = await host.readTextFilePrefix(canonical, 2 * 1024 * 1024, {
    pollingInterest: false,
  })
  const expectedHash = createHash('sha256').update(expected.content, 'utf8').digest('hex')
  const readHash = (await inspect(
    detail,
    "document.getElementById('details').dataset.sha256",
  )) as string
  if (!expected.complete || text !== expected.content || readHash !== expectedHash)
    throw new Error(
      'Selected current bytes/hash do not match the exact clicked public occurrence',
    )
  await inspect(detail, "document.getElementById('read-current').click()")
  await ready(
    detail,
    () =>
      inspect(
        detail,
        "document.getElementById('state').dataset.state==='ready' && document.getElementById('instructions').textContent.length>0",
      ) as Promise<boolean>,
    'unchanged canonical grant supports another explicit current read without a prompt',
  )
  if (extensions.sourceRequests!.snapshot(owner).length)
    throw new Error('Unchanged canonical source grant repeated its trusted decision')
  const isolation = (await inspect(
    detail,
    '({node:typeof process,require:typeof require,workbench:typeof window.hvir,worker:typeof window.hvirExtension})',
  )) as Record<string, string>
  if (
    isolation['node'] !== 'undefined' ||
    isolation['require'] !== 'undefined' ||
    isolation['workbench'] !== 'undefined' ||
    isolation['worker'] !== 'object'
  )
    throw new Error('Selected reader escaped ordinary guest isolation')
  await inspect(detail, "document.getElementById('rendered-mode').click()")
  await captureExtensionVisuals(win, detail, host, 'instructions', {
    ...controls,
    select: async () => {
      await controls.wait(
        () =>
          dom(
            "(() => {const button=document.querySelector('.project-tab-main');if(!button?.checkVisibility()||button.disabled)return false;button.click();return true})()",
          ),
        'visual project destination',
      )
      await controls.wait(
        () =>
          dom(
            "(() => {const button=[...document.querySelectorAll('.viewer-tab .tab-main')].find(e=>e.title==='Skillager · Skill instructions');if(!button?.checkVisibility()||button.disabled)return false;button.click();return true})()",
          ),
        'visual selected instructions',
      )
    },
  })
  await inspect(detail, "document.getElementById('source-mode').click()")
  const before = text
  await controls.click('Open settings')
  await controls.click('Extensions')
  await ready(
    detail,
    () => inspect(detail, 'window.skillagerEvidenceVisible===false') as Promise<boolean>,
    'Settings obscures selected reader',
  )
  await settings.select('File access')
  await click('Revoke read access', 'library')
  await controls.click('Close settings')
  await restoreSelectedReader(detail)
  if (
    !(await inspect(
      detail,
      "(() => {const button=document.getElementById('read-current');if(!button?.checkVisibility())return false;button.click();return true})()",
    ))
  )
    throw new Error('Read current control is hidden')

  await controls.wait(
    () => extensions.sourceRequests!.snapshot(owner).length === 1,
    'revoked source requires another explicit read decision',
  )
  await controls.click('Not now')
  await ready(
    detail,
    () =>
      inspect(
        detail,
        "document.getElementById('state').dataset.state==='unapproved'",
      ) as Promise<boolean>,
    'revoked selected-source read declined',
  )
  if (
    (await inspect(detail, "document.getElementById('instructions').textContent")) !==
    before
  )
    throw new Error('Revocation lost already-read current bytes')
  await inspect(detail, 'window.skillagerEvidenceStop(); void 0;')
  if (!archive)
    await verifySkillagerNavigationFallback(win, host, directory, navigationControls)
  console.log(
    `[smoke] Skillager ${diagnostic ? 'reader diagnostic (full traversal skipped)' : 'full installed-CLI walkthrough'} public schemas, ${observed.size} genuine library identities/${pages} cursor pages, metadata-only focus, ${process.env.HVIR_EXTENSION_VISUAL_DIRECTORY ? 'visual-only pending-list selection (ranked search skipped)' : 'ranked search'}, explicit current read, utility-process Markdown, ordinary guest isolation and revoke OK`,
  )
  console.log('HVIR_SMOKE_OK')
  return true
  function installation() {
    return extensions
      .activations!.snapshot()
      .installations.find((entry) => entry.source === source)
  }
  function view(contribution: string) {
    return extensions
      .guests!.snapshot(owner)
      .find(
        (entry) =>
          entry.installationId === installation()!.installationId &&
          entry.contributionId === contribution,
      )
  }
  async function inspect(guest: WebContents, expression: string): Promise<unknown> {
    const result = (await bounded(
      guest.debugger.sendCommand('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      }),
    )) as {
      result?: { value?: unknown }
      exceptionDetails?: {
        exception?: { className?: string; description?: string }
        text?: string
      }
    }
    if (result.exceptionDetails) {
      const error = result.exceptionDetails.exception
      console.log(
        '[smoke] Skillager evidence: inspection exception',
        JSON.stringify({
          phase,
          url: guest.getURL(),
          loading: guest.isLoading(),
          class: error?.className?.slice(0, 80),
          description: (
            error?.description ??
            result.exceptionDetails.text ??
            'Unknown exception'
          )
            .split('\n')[0]!
            .slice(0, 240),
        }),
      )
      throw new Error(`Skillager guest inspection failed: ${phase}`)
    }
    return result.result?.value
  }
  async function bounded<T>(work: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Skillager inspection did not settle: ${phase}`)),
            5000,
          )
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }
  async function dom(expression: string): Promise<boolean> {
    return bounded(
      win.webContents.executeJavaScript(`Boolean(${expression})`),
    ) as Promise<boolean>
  }
  async function click(name: string, section?: string): Promise<void> {
    const legend =
      section === 'library'
        ? 'Read-only source: library'
        : section
          ? `Program access: ${section}`
          : ''
    await settings.click(name, legend)
  }
  async function ready(
    guest: WebContents,
    predicate: () => Promise<boolean>,
    label: string,
  ): Promise<void> {
    phase = label
    console.log(`[smoke] Skillager evidence: begin ${label}`)
    const deadline = Date.now() + 60_000
    try {
      while (!(await bounded(predicate()))) {
        if (Date.now() >= deadline)
          throw new Error(`Skillager evidence timed out: ${label}`)
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    } catch (error) {
      console.log(
        '[smoke] readiness failure facts',
        JSON.stringify({
          native: {
            visible: win.isVisible(),
            focused: win.isFocused(),
            minimized: win.isMinimized(),
          },
          parent: await placementFacts(guest).catch(() => ({ unavailable: true })),
          foreground: await bounded<unknown>(
            win.webContents.executeJavaScript(
              "window.hvir.invoke('extensions:foreground',undefined)",
            ),
          ).catch(() => null),
          guest: await inspect(
            guest,
            `(() => {
          const state=document.getElementById('state'),text=state?.textContent??'';
          return {state:['loading','stale','ready','empty','error'].includes(state?.dataset.state)?state.dataset.state:null,
            rows:document.querySelectorAll('#skills [role=option]').length,nextDisabled:document.getElementById('next')?.disabled??null,
            approval:text.includes('Approve your Skillager CLI'),frequency:text.includes('frequency'),capacity:text.includes('capacity'),contract:text.includes('contract'),
            initial:globalThis.__hvirInitialLibrary??null};
        })()`,
          ).catch(() => ({ unavailable: true })),
        }),
      )
      throw error
    }
    console.log(`[smoke] Skillager evidence: ready ${label}`)
  }
  async function restoreSelectedReader(detail: WebContents): Promise<void> {
    const visibleAfterSettings = await inspect(detail, 'window.skillagerEvidenceVisible')
    console.log(
      `[smoke] Skillager evidence: selected reader visible after Settings=${visibleAfterSettings === true}`,
    )
    if (visibleAfterSettings !== true) {
      await controls.wait(
        () =>
          dom(
            `(() => { const button=document.querySelector('.project-tab-main'); if(!button?.checkVisibility()||button.disabled)return false; button.click(); return true })()`,
          ),
        'ordinary project destination',
      )
      await controls.wait(
        () =>
          dom(
            `(() => { const button=[...document.querySelectorAll('.viewer-tab .tab-main')].find(e=>e.title==='Skillager · Skill instructions'); if(!button?.checkVisibility()||button.disabled)return false; button.click(); return true })()`,
          ),
        'ordinary selected instructions tab',
      )
    }
    await ready(
      detail,
      () => inspect(detail, 'window.skillagerEvidenceVisible===true') as Promise<boolean>,
      'ordinary selected reader restored',
    )
  }
  async function placementFacts(guest: WebContents): Promise<unknown> {
    return bounded<unknown>(
      win.webContents.executeJavaScript(`(() => {
      const pane=[...document.querySelectorAll('webview')].find(item=>item.src===${JSON.stringify(guest.getURL())})?.closest('.extension-view');
      const destination=document.querySelector('.extension-top-destination');
      const library=[...document.querySelectorAll('.sessions-destination')].find(item=>item.textContent.trim()==='Skillager library');
      return {librarySelected:library?.getAttribute('aria-current')==='page',topHidden:destination?.hidden??null,paneHidden:pane?.hidden??null};
    })()`),
    )
  }
  async function selectFreshLibrary(): Promise<void> {
    await inspect(
      guest,
      `(() => {
      let page='';
      globalThis.__hvirFreshLibrary={received:false,overflow:false,count:0,first:null};
      globalThis.__hvirFreshLibraryStop=window.hvirExtension.onMessage(message=>{
        if(message.kind==='context'&&!message.context.visible)page='';
        const value=message.kind==='result'&&message.ok?message.value:undefined;
        if(!value||typeof value.data!=='string')return;
        if(page.length+value.data.length>4194304){page='';globalThis.__hvirFreshLibrary.overflow=true;return;}
        page+=value.data;
        if(value.nextOffset!==null)return;
        try{
          const result=JSON.parse(page);
          if(result.schema==='skillager.list.v1'&&result.scope==='library'&&Array.isArray(result.skills))
            globalThis.__hvirFreshLibrary={received:true,overflow:false,count:result.skills.length,first:result.skills[0]?.id??null};
        }catch{ /* Other public output is not a completed library list. */ }
        page='';
      });
    })()`,
    )
    let cleanupError: unknown
    try {
      await controls.click('Skillager library')
      await ready(
        guest,
        async () =>
          (await inspect(
            guest,
            `(() => {
          const receipt=globalThis.__hvirFreshLibrary, rows=[...document.querySelectorAll('#skills [role=option]')];
          return receipt.received&&!receipt.overflow&&receipt.count===rows.length&&receipt.first===rows[0]?.dataset.id&&document.getElementById('state').dataset.state==='ready';
        })()`,
          )) === true,
        'fresh complete public library result after project navigation',
      )
    } catch (error) {
      console.log(
        '[smoke] library return facts',
        JSON.stringify(
          await inspect(
            guest,
            "({receipt:globalThis.__hvirFreshLibrary?.received===true,overflow:globalThis.__hvirFreshLibrary?.overflow===true,rows:document.querySelectorAll('#skills [role=option]').length,state:document.getElementById('state')?.dataset.state,nextDisabled:document.getElementById('next')?.disabled})",
          ).catch(() => ({ unavailable: true })),
        ),
      )
      throw error
    } finally {
      try {
        await inspect(
          guest,
          'globalThis.__hvirFreshLibraryStop();delete globalThis.__hvirFreshLibraryStop;delete globalThis.__hvirFreshLibrary',
        )
      } catch (error) {
        cleanupError = error
      }
    }
    if (cleanupError)
      throw cleanupError instanceof Error
        ? cleanupError
        : new Error('Library return observer cleanup failed')
  }
}
