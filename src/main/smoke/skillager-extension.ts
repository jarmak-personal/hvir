import {
  inspectSkillagerCaret,
  inspectSkillagerSearch,
  submitSkillagerSearch,
} from './skillager-search'
import {
  verifySkillagerNavigation,
  verifySkillagerNavigationFallback,
} from './skillager-navigation'
import { extensionSettingsControls } from './extension-settings-controls'
import { captureExtensionVisuals } from './extension-visuals'
import { createHash } from 'node:crypto'
import { app, type BrowserWindow, type WebContents } from 'electron'
import { join } from 'node:path'
import { joinHostPath, localPath } from '../../shared/host-path'
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
  const source = archive ? 'skillager.zip' : 'skillager'
  const directory = joinHostPath(extensions.activations!.directory, source)
  if (archive) {
    if (!archive.startsWith('/'))
      throw new Error('Select an absolute owned extension ZIP')
    await host.writeFile(directory, await host.readFile(localPath(archive)))
  } else {
    await host.createDirectoryExclusive(directory, { mode: 0o755 })
    const assets = localPath(join(app.getAppPath(), 'packages/skillager-extension'))
    for (const entry of await host.readdir(assets))
      if (entry.type === 'file')
        await host.writeFile(
          joinHostPath(directory, entry.name),
          await host.readFile(joinHostPath(assets, entry.name)),
        )
  }
  await controls.click('Open settings')
  await controls.click('Extensions')
  await controls.click('Discover extensions')
  await controls.wait(() => !!installation(), 'ordinary Skillager discovery')
  if (installation()!.enabled || installation()!.error)
    throw new Error('Discovery enabled or rejected Skillager')
  await click('Enable')
  await controls.wait(() => installation()?.enabled === true, 'trusted Skillager Enable')
  if (
    process.env.HVIR_EXTENSION_VISUAL_DIRECTORY ||
    process.env.HVIR_SKILLAGER_SEARCH_PROOF
  ) {
    await controls.click('Close settings')
    await controls.click('Skillager library')
    await controls.wait(() => !!view('library'), 'unapproved library placement')
    const unapproved = await bounded(controls.guest(view('library')!))
    await ready(
      unapproved,
      () =>
        inspect(
          unapproved,
          "document.getElementById('state')?.dataset.state==='error'",
        ) as Promise<boolean>,
      'actual unapproved CLI state',
    )
    if (process.env.HVIR_SKILLAGER_SEARCH_PROOF) {
      const id = view('library')!.id
      await inspectSkillagerCaret(
        win,
        unapproved,
        host,
        {
          within: bounded,
          inspect: (expression) => inspect(unapproved, expression),
          wait: (predicate, label) => ready(unapproved, predicate, label),
          current: () => view('library')?.id === id && !view('library')?.failure,
        },
        'unapproved',
      )
    }
    await captureExtensionVisuals(win, unapproved, host, 'unapproved', {
      ...controls,
      select: () => controls.click('Skillager library'),
    })
    await controls.click('Open settings')
    await controls.click('Extensions')
  }
  const configuration = JSON.stringify({
    args: [],
    env: {
      SKILLAGER_CATALOG_STATE_DIR: catalog,
      XDG_CACHE_HOME: join(directory.path, '..', '..', 'skillager-cache'),
      XDG_STATE_HOME: join(directory.path, '..', '..', 'skillager-state'),
    },
  })
  await set('Executable for library-cli', executable)
  await set('Configuration for library-cli', configuration)
  await click('Inspect native access', 'library-cli')
  await controls.wait(
    () => dom("document.body.textContent.includes('Approve local:')"),
    'canonical installed CLI decision',
  )
  await win.webContents.executeJavaScript(`(() => {
    const pre=[...document.querySelectorAll('.extension-installation pre')].find(e=>e.textContent===${JSON.stringify(JSON.stringify(JSON.parse(configuration), null, 2))});
    pre.scrollIntoView({block:'center'});
  })()`)
  await controls.wait(
    () =>
      dom(`(() => {
    const pre=[...document.querySelectorAll('.extension-installation pre')].find(e=>e.textContent===${JSON.stringify(JSON.stringify(JSON.parse(configuration), null, 2))});
    if(!pre?.checkVisibility())return false;
    const box=pre.getBoundingClientRect(), scroll=pre.closest('.settings-section-scroll').getBoundingClientRect();
    return box.top>=scroll.top && box.bottom<=scroll.bottom;
  })()`),
    'complete approved configuration remains visible at the trusted decision',
  )
  await win.webContents.executeJavaScript(
    'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',
  )
  if (process.env.HVIR_EXTENSION_VISUAL_DIRECTORY)
    await host.writeFile(
      joinHostPath(
        localPath(process.env.HVIR_EXTENSION_VISUAL_DIRECTORY),
        'native-approval.png',
      ),
      (await win.webContents.capturePage()).toPNG(),
    )
  await click('Approve native execution', 'library-cli')
  await controls.wait(
    () =>
      extensions
        .connectors!.approvals.status(
          extensions.activations!.active.get(installation()!.installationId!)!,
        )
        .some(
          (entry) =>
            entry.connector === 'library-cli' && entry.availability === 'supported',
        ),
    'trusted CLI approval',
  )
  if (process.env.HVIR_SKILLAGER_EVIDENCE_UNINITIALIZED === '1') {
    if (!diagnostic || !process.env.HVIR_SKILLAGER_SEARCH_PROOF)
      throw new Error('Uninitialized caret proof requires the owned diagnostic route')
    const priorView = view('library')!.id
    await controls.click('Close settings')
    await controls.click('Close Skillager library')
    await controls.wait(
      () => !view('library'),
      'prior unapproved library closes before recreation',
    )
    await controls.click('Skillager library')
    await controls.wait(
      () => !!view('library') && view('library')!.id !== priorView,
      'fresh uninitialized library placement',
    )
    const uninitialized = await bounded(controls.guest(view('library')!)),
      id = view('library')!.id
    await ready(
      uninitialized,
      () =>
        inspect(
          uninitialized,
          "document.getElementById('state')?.dataset.state==='empty'&&document.querySelectorAll('#skills [role=option]').length===0",
        ) as Promise<boolean>,
      'fresh uninitialized public catalog is empty without initialization',
    )
    await inspectSkillagerCaret(
      win,
      uninitialized,
      host,
      {
        within: bounded,
        inspect: (expression) => inspect(uninitialized, expression),
        wait: (predicate, label) => ready(uninitialized, predicate, label),
        current: () => view('library')?.id === id && !view('library')?.failure,
      },
      'uninitialized',
    )
    console.log(
      '[smoke] actual caret first interaction/unapproved and never-initialized catalog; setup controls retained, no initialization OK',
    )
    console.log('HVIR_SMOKE_OK')
    return true
  }
  await set('Source root for library', root)
  await click('Inspect read access', 'library')
  await controls.wait(
    () => dom("document.body.textContent.includes('Grant read-only access to')"),
    'canonical library source decision',
  )
  await click('Grant read-only access', 'library')
  await controls.wait(
    () =>
      extensions
        .sources!.approvals.status(
          extensions.activations!.active.get(installation()!.installationId!)!,
        )
        .some((entry) => entry.source === 'library' && entry.granted),
    'trusted source grant',
  )
  await controls.click('Close settings')
  await controls.click('Skillager library')
  await controls.wait(() => !!view('library'), 'ordinary application library placement')
  phase = 'ordinary library guest attachment'
  console.log(`[smoke] Skillager evidence: begin ${phase}`)
  const guest = await bounded(controls.guest(view('library')!))
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
          "document.querySelectorAll('#skills [role=option]').length===100 && !['loading','stale','error'].includes(document.getElementById('state').dataset.state)",
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
          `document.querySelector('#skills [role=option]')?.dataset.id !== ${JSON.stringify(first)} && !['loading','stale','error'].includes(document.getElementById('state').dataset.state)`,
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
  const detail = await bounded(controls.guest(view('detail')!))
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
  const before = text
  await controls.click('Open settings')
  await controls.click('Extensions')
  await ready(
    detail,
    () => inspect(detail, 'window.skillagerEvidenceVisible===false') as Promise<boolean>,
    'Settings obscures selected reader',
  )
  await click('Revoke read access', 'library')
  await controls.click('Close settings')
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
  if (
    !(await inspect(
      detail,
      "(() => {const button=document.getElementById('read-current');if(!button?.checkVisibility())return false;button.click();return true})()",
    ))
  )
    throw new Error('Read current control is hidden')

  await ready(
    detail,
    () =>
      inspect(
        detail,
        "document.getElementById('state').dataset.state==='error'",
      ) as Promise<boolean>,
    'revoked selected-source refusal',
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
  async function set(label: string, value: string): Promise<void> {
    await settings.set(label, value)
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
