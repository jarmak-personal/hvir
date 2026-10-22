import { verifySkillagerSourceBrowsing } from './skillager-source-browsing'
import { skillagerManagementControls } from './skillager-management-controls'
import { captureExtensionDecision } from './extension-decision-visuals'
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
import { verifySkillagerLibraryConnection } from './skillager-library-connection'
import { verifySkillagerProjectConnection } from './skillager-project-connection'
import { createHash } from 'node:crypto'
import { app, type BrowserWindow, type WebContents } from 'electron'
import { localPath, type HostPath } from '../../shared/host-path'
import type { ProjectHost } from '../project-host/project-host'
import type { ExtensionApplicationRuntime } from '../extensions/extension-application'
import type { RendererResourceScopes } from '../renderer-resource-scopes'
import type { ExtensionView } from '../../shared/extensions/workbench'
interface Controls {
  readonly projectRoot: HostPath
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
          "document.getElementById('state')?.dataset.state==='no-personal-library'&&document.querySelectorAll('#skills [data-skill-select]').length===0&&!document.getElementById('create-library').disabled",
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
          "document.querySelectorAll('#skills [data-source-toggle]').length>0 && document.querySelectorAll('#skills [data-skill-select]').length===0 && document.getElementById('state').dataset.state==='ready'",
        ) as Promise<boolean>,
      diagnostic
        ? 'current public library source summaries'
        : 'collapsed source groups for genuine 5000',
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
  let projectGuest = await bounded(controls.guest(view('project')!))
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
  await verifySkillagerProjectConnection(
    win,
    projectGuest,
    host,
    controls.projectRoot,
    executable,
    {
      wait: (predicate, label) => controls.wait(predicate, label),
      ready: (predicate, label) => ready(projectGuest, predicate, label),
      within: bounded,
      hasReadDecision: () => extensions.sourceRequests!.snapshot(owner).length > 0,
      reader: async () => {
        await controls.wait(() => !!view('detail'), 'project instruction reader opens')
        return bounded(controls.guest(view('detail')!))
      },
      reopen: async () => {
        await controls.click('Close Skills in this project')
        await controls.wait(
          () => !view('project') && projectGuest.isDestroyed(),
          'ordinary project Close releases the old guest',
        )
        await navigationControls.select()
        projectGuest = await bounded(controls.guest(view('project')!))
        return projectGuest
      },
    },
  )
  await verifySkillagerLibraryConnection(
    win,
    guest,
    extensions,
    owner,
    host,
    controls.projectRoot,
    executable,
    {
      ...controls,
      within: bounded,
    },
  )
  if (process.env.HVIR_SKILLAGER_PROJECT_PROOF === '1') {
    console.log('[smoke] focused genuine project inventory walkthrough complete')
    console.log('HVIR_SMOKE_OK')
    return true
  }
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
      await click('Revoke access on Local', 'library-cli')
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
  const detailIds = () =>
    extensions
      .guests!.snapshot(owner)
      .filter(
        (entry) =>
          entry.installationId === installation()!.installationId &&
          entry.contributionId === 'detail',
      )
      .map((entry) => entry.id)
      .sort()
  const priorDetails = detailIds()
  const readers = [
    guest,
    ...(await Promise.all(
      priorDetails.map((id) => {
        const retained = extensions
          .guests!.snapshot(owner)
          .find((entry) => entry.id === id)!
        return bounded(controls.guest(retained))
      }),
    )),
  ]
  const observing: WebContents[] = []
  const readerFacts = (reader: WebContents) =>
    inspect(
      reader,
      `(() => ({
    sourceSelections: globalThis.__hvirMetadataReads.selections,
    renderedSources: globalThis.__hvirMetadataReads.rendered,
    source: document.getElementById('source-label').textContent,
    sha256: document.getElementById('details').dataset.sha256 ?? null,
    bodyCharacters: document.getElementById('instructions').textContent.length,
    hidden: document.getElementById('reader-content').hidden,
  }))()`,
    )
  let baseline: unknown[]
  let metadataFailure: Error | undefined
  let cleanupFailures: unknown[]
  async function metadataOnly(stage: string) {
    const current = await Promise.all(readers.map(readerFacts))
    if (
      JSON.stringify(detailIds()) !== JSON.stringify(priorDetails) ||
      JSON.stringify(current) !== JSON.stringify(baseline)
    ) {
      console.log(
        '[smoke] metadata-only reader boundary',
        JSON.stringify({
          stage,
          priorDetails,
          currentDetails: detailIds(),
          baseline,
          current,
        }),
      )
      throw new Error(
        `Library ${stage} changed selected bodies or performed a new source read`,
      )
    }
  }
  try {
    for (const reader of readers) {
      await inspect(
        reader,
        `(() => {
        const counts={selections:0,rendered:0};
        const stop=window.hvirExtension.onMessage(message=>{
          if(message.kind!=='result'||message.ok!==true)return;
          const value=message.value;
          if(value?.currentFile===true)counts.selections++;
          if(typeof value?.sourceFallback==='boolean')counts.rendered++;
        });
        globalThis.__hvirMetadataReads=counts;globalThis.__hvirMetadataReadsStop=stop;
      })()`,
      )
      observing.push(reader)
    }
    baseline = await Promise.all(readers.map(readerFacts))
    await verifySkillagerSourceBrowsing(
      guest,
      {
        inspect: (expression) => inspect(guest, expression),
        ready: (predicate, label) => ready(guest, predicate, label),
        metadataOnly,
        capture: (expanded) =>
          captureExtensionVisuals(
            win,
            guest,
            host,
            expanded ? 'library-source-expanded' : 'library-sources',
            {
              ...controls,
              select: () => controls.click('Skillager library'),
              narrowScale: '1.5',
              painted: async () => {
                await ready(
                  guest,
                  async () =>
                    (await inspect(
                      guest,
                      "document.getElementById('state').dataset.state==='ready' && !document.querySelector('#skills [aria-busy=true]')",
                    )) === true,
                  'source metadata settled for appearance capture',
                )
                return { sourceMetadataReady: true }
              },
            },
          ),
      },
      diagnostic ? Number(process.env.HVIR_SKILLAGER_EVIDENCE_SKILLS ?? '5000') : 5000,
    )
    await metadataOnly('metadata traversal')
    await inspect(
      guest,
      "document.querySelector('#skills [data-skill-select]').focus(); document.querySelector('#skills [data-skill-select]').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));",
    )
    await metadataOnly('keyboard focus')
    if (extensions.sourceRequests!.snapshot(owner).length)
      throw new Error('Metadata browsing or keyboard focus requested file access')
  } catch (error) {
    metadataFailure =
      error instanceof Error
        ? error
        : new Error('Metadata reader verification failed', { cause: error })
  } finally {
    const cleanup = await Promise.allSettled(
      observing
        .filter((reader) => !reader.isDestroyed())
        .map((reader) =>
          inspect(
            reader,
            'globalThis.__hvirMetadataReadsStop();delete globalThis.__hvirMetadataReadsStop;delete globalThis.__hvirMetadataReads',
          ),
        ),
    )
    cleanupFailures = cleanup.flatMap((result) =>
      result.status === 'rejected' ? [result.reason as unknown] : [],
    )
  }
  if (cleanupFailures.length)
    throw new AggregateError(
      [...(metadataFailure ? [metadataFailure] : []), ...cleanupFailures],
      'Metadata reader observation cleanup failed',
    )
  if (metadataFailure) throw metadataFailure
  {
    await inspect(guest, "document.getElementById('query').value='catalogneedle';")
    for (const mode of ['button', 'enter'] as const) {
      await submitSkillagerSearch(win, guest, searchPorts, mode)
      await ready(
        guest,
        () =>
          inspect(
            guest,
            "document.getElementById('state').dataset.state==='ready' && document.getElementById('state').textContent.includes('matches') && document.querySelectorAll('#skills [data-skill-select]').length>0",
          ) as Promise<boolean>,
        `genuine public ranked search via ${mode}`,
      )
    }
  }
  const clicked = (await inspect(
    guest,
    "(() => {const row=document.querySelector('#skills [data-skill-select]');return {id:row.dataset.id,source:row.dataset.source,path:row.dataset.sourcePath}})()",
  )) as { id: string; source: string; path: string }
  const canonical = await host.realpath(localPath(clicked.path))
  await inspect(guest, "document.querySelector('#skills [data-skill-select]').click()")
  const detail = guest
  phase = 'selected inline reader'
  await controls.wait(
    () => extensions.sourceRequests!.snapshot(owner)[0]?.state === 'ready',
    'explicit selected read proposes one canonical local root',
  )
  const readProposal = extensions.sourceRequests!.snapshot(owner)[0]!
  if (
    readProposal.state !== 'ready' ||
    readProposal.root.hostId !== 'local' ||
    readProposal.root.path !== root ||
    readProposal.source !== 'library'
  )
    throw new Error('First read proposed a different library source')
  await inspect(guest, "document.getElementById('close-instructions').click()")
  await controls.wait(
    () => !extensions.sourceRequests!.snapshot(owner).length,
    'closed reader retires its undecided root request',
  )
  await assertRetiredSkillagerReadDecision(win, readProposal.id, bounded)
  await controls.click('Skillager library')
  await ready(
    guest,
    () =>
      inspect(
        guest,
        "!!document.querySelector('#skills [data-skill-select]') && document.getElementById('state').dataset.state==='ready' && document.getElementById('manage').disabled===false",
      ) as Promise<boolean>,
    'ordinary library restored after reader close',
  )
  await inspect(guest, "document.querySelector('#skills [data-skill-select]').click()")
  await controls.wait(
    () => extensions.sourceRequests!.snapshot(owner)[0]?.state === 'ready',
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
  await inspect(
    detail,
    "document.getElementById('read-current').closest('details').open=true;document.getElementById('read-current').click()",
  )
  try {
    await controls.wait(
      () => extensions.sourceRequests!.snapshot(owner)[0]?.state === 'ready',
      'explicit retry after hiding asks again',
    )
  } catch (error) {
    console.log(
      '[smoke] bounded reader retry failure facts',
      JSON.stringify({
        package: await inspect(
          detail,
          "({visible:window.skillagerEvidenceVisible??null,state:document.getElementById('reader-state')?.dataset.state??null,manageDisabled:document.getElementById('manage')?.disabled??null,readVisible:document.getElementById('read-current')?.checkVisibility()??null})",
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
        "document.getElementById('reader-state').dataset.state==='unapproved'&&!document.getElementById('instructions').textContent",
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
  await inspect(
    detail,
    "document.getElementById('read-current').closest('details').open=true;document.getElementById('read-current').click()",
  )
  await controls.wait(
    () => extensions.sourceRequests!.snapshot(owner)[0]?.state === 'ready',
    'new explicit Read current decision',
  )
  if (
    await inspect(
      detail,
      "document.getElementById('read-current').closest('details').open",
    )
  )
    throw new Error('Instruction refresh left its command menu open behind consent')
  await captureExtensionDecision(win, host, 'read', (predicate, label) =>
    controls.wait(predicate, label),
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
  await inspect(
    detail,
    "document.getElementById('read-current').closest('details').open=true;document.getElementById('read-current').click()",
  )
  await ready(
    detail,
    () =>
      inspect(
        detail,
        "document.getElementById('reader-state').dataset.state==='ready' && document.getElementById('instructions').textContent.length>0",
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
  await ready(
    detail,
    () =>
      inspect(
        detail,
        "document.getElementById('instructions').dataset.mode==='rendered' && !!document.getElementById('instructions').firstElementChild",
      ) as Promise<boolean>,
    'rendered instructions before appearance capture obscures the reader',
  )
  if (!diagnostic) {
    const members = skillagerManagementControls(detail, controls)
    try {
      // Selected-task metadata settles independently from instruction reading.
      await members.ready(
        "!document.getElementById('task-mode').disabled && !document.getElementById('task-options').hidden && !document.getElementById('exposure-group').hidden && !document.getElementById('exposure-group').disabled",
        'selected task controls and Group action',
      )
      await members.click('exposure-group')
      await members.ready(
        "!document.getElementById('exposure-member-search-button').disabled && document.querySelectorAll('#exposure-member-results input').length===50",
        'first bounded member page from genuine 5000',
      )
      const firstMember = (await members.inspect(
        "document.querySelector('#exposure-member-results input').dataset.skillId",
      )) as string
      const selected = (await members.inspect(
        "[...document.querySelectorAll('#exposure-selected-members button')].map(e=>e.title)",
      )) as string[]
      if (selected.length !== 1)
        throw new Error('Group did not start from exactly the selected skill')
      for (const page of [1, 2]) {
        const identity = (await members.inspect(`(() => {
        const input=[...document.querySelectorAll('#exposure-member-results input')].find(e=>!e.checked);
        if(!input)throw new Error('No distinct member on the bounded page');
        const identity=input.closest('label').title.split('\\n')[0];input.click();return identity;
      })()`)) as string
        selected.push(identity)
        if (page === 1) {
          await members.click('exposure-member-next')
          await members.ready(
            "!document.getElementById('exposure-member-search-button').disabled && document.getElementById('exposure-member-page').textContent==='Page 2' && document.querySelectorAll('#exposure-member-results input').length===50",
            'second bounded member page',
          )
        }
      }
      await members.click('exposure-member-previous')
      await members.ready(
        `!document.getElementById('exposure-member-search-button').disabled && document.getElementById('exposure-member-page').textContent==='Page 1' && document.querySelector('#exposure-member-results input').dataset.skillId===${JSON.stringify(firstMember)}`,
        'Previous returns the exact first member page',
      )
      await members.click('exposure-member-next')
      await members.ready(
        "!document.getElementById('exposure-member-search-button').disabled && document.getElementById('exposure-member-page').textContent==='Page 2'",
        'second member page before a new search',
      )
      await members.set('exposure-member-query', 'catalogneedle')
      await members.inspect(
        "document.getElementById('exposure-member-search').requestSubmit()",
      )
      await members.ready(
        "!document.getElementById('exposure-member-search-button').disabled && document.getElementById('exposure-member-page').textContent==='Page 1'",
        'member search retains off-page selection',
      )
      const retained = (await members.inspect(
        "[...document.querySelectorAll('#exposure-selected-members button')].map(e=>e.title)",
      )) as string[]
      const resultCount = (await members.inspect(
        "document.querySelectorAll('#exposure-member-results input').length",
      )) as number
      if (
        retained.length !== 3 ||
        new Set(selected).size !== 3 ||
        selected.some((identity) => !retained.includes(identity)) ||
        resultCount < 1 ||
        resultCount > 50
      )
        throw new Error(
          'Large-library member search lost exact off-page identities or rendered an unbounded catalog',
        )
      await members.click('exposure-cancel')
      await members.ready(
        "document.getElementById('exposure-task').hidden && document.getElementById('instructions').textContent.length>0",
        'cancelled membership preserves ordinary reading',
      )
      console.log(
        '[smoke] genuine 5000 membership: two 50-row public pages, ranked search, three exact retained identities, cancelled without mutation',
      )
    } catch (error) {
      console.log(
        '[smoke] capacity membership boundary',
        JSON.stringify(
          await members
            .inspect(
              `(() => {
        const text=document.getElementById('exposure-state').textContent;
        return {page:document.getElementById('exposure-member-page').textContent,
          query:document.getElementById('exposure-member-query').value,
          busy:document.getElementById('exposure-member-search-button').disabled,
          rows:[...document.querySelectorAll('#exposure-member-results input')].slice(0,50).map(input=>({id:input.dataset.skillId,checked:input.checked})),
          selected:[...document.querySelectorAll('#exposure-selected-members button')].slice(0,16).map(item=>item.title),
          failureClasses:['invalid_cursor','different request','frequency','capacity','exact library','cancelled','exceeds'].filter(value=>text.includes(value))};
      })()`,
            )
            .catch(() => ({ inspectionUnavailable: true })),
        ),
      )
      throw error
    }
  }
  await captureExtensionVisuals(
    win,
    detail,
    host,
    diagnostic ? 'source-search' : 'instructions',
    {
      ...controls,
      painted: async () => {
        await ready(
          detail,
          async () =>
            (await inspect(
              detail,
              "document.getElementById('state').dataset.state==='ready' && document.getElementById('task-options').checkVisibility()",
            )) === true,
          'current selected task settled for appearance capture',
        )
        return { selectedTaskReady: true }
      },
      select: async () => {
        await controls.click('Skillager library')
      },
    },
  )
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
      "(() => {const button=document.getElementById('read-current');button.closest('details').open=true;if(!button?.checkVisibility())return false;button.click();return true})()",
    ))
  )
    throw new Error('Read current control is hidden')

  await controls.wait(
    () => extensions.sourceRequests!.snapshot(owner)[0]?.state === 'ready',
    'revoked source requires another explicit read decision',
  )
  await controls.click('Not now')
  await ready(
    detail,
    () =>
      inspect(
        detail,
        "document.getElementById('reader-state').dataset.state==='unapproved'",
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
    `[smoke] Skillager ${diagnostic ? 'diagnostic' : '5000-skill installed-CLI walkthrough'} public source groups, bounded source paging, metadata-only focus, ranked search, explicit current read, utility-process Markdown, ordinary guest isolation and revoke OK`,
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
            rows:document.querySelectorAll('#skills [data-skill-select]').length,nextDisabled:document.getElementById('next')?.disabled??null,
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
    if (visibleAfterSettings !== true) await controls.click('Skillager library')
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
          if(result.schema==='skillager.library-groups.v1'&&result.scope==='library'&&Array.isArray(result.groups))
            globalThis.__hvirFreshLibrary={received:true,overflow:false,count:result.groups.length,first:result.groups[0]?.id??null};
        }catch{ /* Other public output is not a completed library list. */ }
        page='';
      });
    })()`,
    )
    let cleanupError: unknown
    try {
      await controls.click('Skillager library')
      await inspect(guest, "document.getElementById('refresh').click()")
      await ready(
        guest,
        async () =>
          (await inspect(
            guest,
            `(() => {
          const receipt=globalThis.__hvirFreshLibrary, rows=[...document.querySelectorAll('#skills [data-source-toggle]')];
          return receipt.received&&!receipt.overflow&&receipt.count===rows.length&&receipt.first===rows[0]?.dataset.sourceToggle&&document.getElementById('state').dataset.state==='ready';
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
            "({receipt:globalThis.__hvirFreshLibrary?.received===true,overflow:globalThis.__hvirFreshLibrary?.overflow===true,rows:document.querySelectorAll('#skills [data-skill-select]').length,state:document.getElementById('state')?.dataset.state,nextDisabled:document.getElementById('next')?.disabled})",
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
