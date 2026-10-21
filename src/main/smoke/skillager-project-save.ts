import type { BrowserWindow, WebContents } from 'electron'
import { joinHostPath, localPath, type HostPath } from '../../shared/host-path'
import type { ProjectHost } from '../project-host/project-host'
import { captureExtensionVisuals } from './extension-visuals'
import { focusSmokeWindow } from './window-focus'
import {
  skillagerManagementControls,
  type SkillagerManagementControls,
} from './skillager-management-controls'

/** Actual guest batch decision against the source-built CLI, with owned originals only. */
export async function verifyOwnedProjectSave(
  win: BrowserWindow,
  guest: WebContents,
  detail: () => Promise<WebContents>,
  host: ProjectHost,
  workspace: HostPath,
  owned: HostPath,
  cli: (args: readonly string[]) => Promise<Record<string, unknown>>,
  controls: SkillagerManagementControls,
): Promise<Record<string, unknown>> {
  const ui = skillagerManagementControls(guest, controls),
    root = joinHostPath(joinHostPath(workspace, '.agents'), 'skills'),
    sources = new Map<string, { path: HostPath; body: string }>()
  for (const path of [joinHostPath(workspace, '.agents'), root])
    await host.createDirectoryExclusive(path, { mode: 0o755 }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    })
  for (const [index, name] of [
    'code-review',
    'test-design',
    'release-notes',
    'schema-migrations',
  ].entries()) {
    const folder = joinHostPath(root, name),
      path = joinHostPath(folder, 'SKILL.md'),
      body = `---\nname: ${name}\ndescription: Owned bulk-save fixture ${index}.\n---\n\n# ${name}\n\nReview the selected task with clear, focused guidance.\n\n${index === 0 ? 'Keep this instruction reader in place while saving other skills.\n\n'.repeat(30) : `Unique owned instruction ${index}.\n`}`
    await host.createDirectoryExclusive(folder, { mode: 0o755 })
    await host.writeFile(path, body)
    sources.set(name, { path, body })
  }
  const inventory = await cli(['import-project', '--json', '--limit', '100']),
    eligible = (inventory['summary'] as { eligible: number }).eligible
  if (eligible < 4 || eligible > 32)
    throw new Error('Owned native batch fixture exceeds a single complete review')
  await ui.click('refresh')
  try {
    await ui.ready(
      `document.getElementById('project-save-count').textContent===${JSON.stringify(`${eligible} skills ready to save`)} && !document.getElementById('project-save-open').disabled`,
      'whole-project eligible count',
    )
  } catch (error) {
    console.log(
      '[smoke] batch eligibility boundary',
      JSON.stringify(
        await ui.inspect(`({
      count:document.getElementById('project-save-count').textContent,
      disabled:document.getElementById('project-save-open').disabled,
      state:document.getElementById('state').textContent,
      rows:document.querySelectorAll('[data-skill-select]').length
    })`),
      ),
    )
    throw error
  }
  await ui.inspect(`(() => {
    const row=[...document.querySelectorAll('[data-skill-select]')].find(node=>node.dataset.sourcePath===${JSON.stringify(sources.get('code-review')!.path.path)});
    if(!row)throw new Error('Owned original row unavailable');row.click();
  })()`)
  const reader = await detail(),
    reading = skillagerManagementControls(reader, controls)
  await reading.ready(
    "!!document.getElementById('instructions').firstElementChild",
    'independent original reading',
  )
  const readerBefore = await reading.inspect(
    "document.getElementById('instructions').innerHTML",
  )
  await controls.click('Skills in this project')
  await ui.set('query', 'release-notes')
  await ui.inspect("document.getElementById('search-form').requestSubmit()")
  await ui.ready(
    "document.querySelectorAll('[data-skill-select]').length===1",
    'filtered project row',
  )
  if (
    (await ui.inspect("document.getElementById('project-save-count').textContent")) !==
    `${eligible} skills ready to save`
  )
    throw new Error('Search changed whole-project save eligibility')
  await ui.click('project-save-open')
  await ui.ready(
    `document.querySelectorAll('#project-import-choices input:checked').length===${eligible} && !document.getElementById('project-import-save').disabled`,
    'all eligible project skills preselected across search',
  )
  await chooseOwned()
  await readyDecision()
  if (
    (await ui.inspect(
      "document.querySelectorAll('#project-import-choices input:checked').length",
    )) !== 4
  )
    throw new Error('Bulk review omitted filtered-out originals')
  await captureExtensionVisuals(win, guest, host, 'project-save', {
    ...controls,
    narrowScale: '1.5',
    select: async () => {
      await controls.click('Skills in this project')
      await readyDecision()
    },
    painted: geometry,
  })
  await focusSmokeWindow(win)
  await ui.inspect("document.querySelector('#project-import-location summary').focus()")
  key('Space')
  await ui.ready(
    "document.getElementById('project-import-location').open && document.getElementById('project-import-location-path').checkVisibility() && document.getElementById('project-import-location-path').textContent.startsWith('local: /')",
    'keyboard exact library location disclosure',
  )
  key('Space')
  await ui.ready(
    "!document.getElementById('project-import-location').open && !document.getElementById('project-import-location-path').checkVisibility()",
    'library location collapses fully',
  )
  await ui.inspect(
    `([...document.querySelectorAll('#project-import-choices label')].find(label=>label.textContent==='code-review')).querySelector('input').focus()`,
  )
  key('Space')
  await ui.ready(
    "document.getElementById('project-import-save').textContent==='Save 3 skills' && !document.getElementById('project-import-save').disabled",
    'keyboard exact subset preparation',
  )
  key('Space')
  await readyDecision()
  key('Tab')
  await ui.ready(
    "document.activeElement.matches('#project-import-choices button')",
    'keyboard optional file inspection',
  )
  key('Space')
  await ui.ready(
    "!document.getElementById('project-import-inspection').hidden",
    'optional files open',
  )
  await ui.inspect("document.querySelector('#project-import-files button').click()")
  await ui.ready(
    "document.getElementById('project-import-file-body').textContent.includes('Owned bulk-save fixture')",
    'confined optional file read',
  )
  await ui.click('project-import-close-files')
  key('Escape')
  await ui.ready(
    "document.getElementById('skill-task-sheet').hidden && document.activeElement===document.getElementById('project-save-open')",
    'Escape returns quiet entry focus',
  )
  key('Enter')
  await ui.ready(
    `document.querySelectorAll('#project-import-choices input:checked').length===${eligible} && !document.getElementById('project-import-save').disabled`,
    'fresh default selection after reopen',
  )
  await chooseOwned()
  await readyDecision()
  // Fresh action preflight must refuse the obsolete decision without creating a library copy.
  const changed = sources.get('release-notes')!
  changed.body += '\nA new explicitly reviewed revision.\n'
  await host.writeFile(changed.path, changed.body)
  await ui.click('project-import-save')
  await ui.ready(
    "!document.getElementById('project-import-refresh').hidden && !document.getElementById('project-import-refresh').disabled && document.getElementById('project-import-state').textContent.includes('changed')",
    'stale source requires fresh review',
  )
  const beforeSave = await cli(['library', 'status', '--json'])
  if (
    beforeSave['initialized'] === true &&
    (beforeSave['counts'] as { skills: number }).skills !== 0
  )
    throw new Error('Stale batch decision created library copies')
  await ui.click('project-import-refresh')
  await readyDecision()
  await ui.click('project-import-save')
  await ui.ready(
    "document.getElementById('project-import-state').textContent==='Saved 4 skills.'",
    'single decision saves and accepts all four originals',
  )
  const result = (await ui.inspect(
    "JSON.parse(document.getElementById('project-import-report').textContent)",
  )) as { outcome: string; counts: { accepted: number }; originals: string }
  if (
    result.outcome !== 'verified' ||
    result.counts.accepted !== 4 ||
    result.originals !== 'unchanged'
  )
    throw new Error('Bulk task did not retain the complete verified public result')
  const status = await cli(['library', 'status', '--json']),
    library = status['library'] as { root: string }
  if (!library.root.startsWith(`${owned.path}/`))
    throw new Error('Bulk save escaped owned library')
  const accepted: string[] = []
  for (const [name, source] of sources) {
    const state = await cli(['library', 'status', `lib/${name}`, '--json']),
      skill = state['skill'] as {
        acceptance: string
        accepted_hash: string
        working_hash: string
        path: string
      }
    if (
      skill.acceptance !== 'accepted' ||
      skill.accepted_hash !== skill.working_hash ||
      (await host.readFile(source.path)).toString() !== source.body ||
      (
        await host.readFile(joinHostPath(localPath(skill.path), 'SKILL.md'))
      ).toString() !== source.body
    )
      throw new Error(
        'Batch save changed an original or failed exact canonical acceptance',
      )
    accepted.push(name)
  }
  await ui.ready(
    eligible === 4
      ? "document.getElementById('project-save-entry').hidden"
      : `document.getElementById('project-save-count').textContent===${JSON.stringify(`${eligible - 4} skills ready to save`)} && !document.getElementById('project-save-open').disabled`,
    'successful subset immediately refreshes remaining whole-project count',
  )
  await controls.click('Open settings')
  await controls.click('Close settings')
  await controls.click('Skills in this project')
  await ui.ready(
    "window.__hvirOwnedManagementTrace.counts.visible===true && document.getElementById('project-import-state').textContent==='Saved 4 skills.' && document.getElementById('project-import-save').hidden",
    'same-context return retains completed batch',
  )
  if (
    (await reading.inspect("document.getElementById('instructions').innerHTML")) !==
    readerBefore
  )
    throw new Error('Bulk review replaced the independent reader')
  return {
    accepted,
    eligible,
    remaining: eligible - 4,
    defaultAllSelected: true,
    originalsUnchanged: true,
    oneDecision: true,
    filterIndependent: true,
    staleRefused: true,
    keyboard: true,
    readerPreserved: true,
    sameContextResult: true,
    immediateTruthfulRefresh: true,
  }

  async function chooseOwned() {
    await ui.inspect(`(() => {
      const names=${JSON.stringify([...sources.keys()])};
      for(const label of document.querySelectorAll('#project-import-choices label')){
        const checkbox=label.querySelector('input');
        if(checkbox.checked!==names.includes(label.textContent))checkbox.click();
      }
    })()`)
  }
  async function readyDecision() {
    try {
      await ui.ready(
        "!document.getElementById('project-import-save').disabled && document.getElementById('project-import-save').textContent==='Save 4 skills'",
        'complete four-skill save review',
      )
    } catch (error) {
      console.log(
        '[smoke] batch review boundary',
        JSON.stringify(
          await ui.inspect(`({
        title:document.getElementById('project-import-save').textContent,
        disabled:document.getElementById('project-import-save').disabled,
        state:document.getElementById('project-import-state').textContent,
        selected:document.querySelectorAll('#project-import-choices input:checked').length,
        sheetHidden:document.getElementById('skill-task-sheet').hidden,
        sectionHidden:document.getElementById('project-import').hidden,
        busy:document.getElementById('project-import').getAttribute('aria-busy'),
        checkboxDisabled:document.querySelector('#project-import-choices input')?.disabled,
        trace:window.__hvirOwnedManagementTrace?.counts
      })`),
        ),
      )
      throw error
    }
  }
  function key(keyCode: string) {
    guest.sendInputEvent({ type: 'keyDown', keyCode })
    if (keyCode === 'Enter') guest.sendInputEvent({ type: 'char', keyCode: '\r' })
    guest.sendInputEvent({ type: 'keyUp', keyCode })
  }
  async function geometry() {
    return ui.inspect(`(() => {
      const sheet=document.getElementById('skill-task-sheet'), inspect=document.getElementById('project-import-inspection'),location=document.getElementById('project-import-location');
      const rows=[...document.querySelectorAll('.project-import-choice')].map(row=>{
        const box=row.getBoundingClientRect(),label=row.querySelector('label').getBoundingClientRect(),check=row.querySelector('input').getBoundingClientRect(),button=row.querySelector('button').getBoundingClientRect();
        return {contained:check.left>=box.left&&button.right<=box.right+1&&label.right<=button.left+1,checkbox:check.width>0&&check.height>0};
      });
      if(!sheet.checkVisibility()||sheet.scrollWidth>sheet.clientWidth||!inspect.hidden||location.open||document.getElementById('project-import-location-path').checkVisibility()||rows.some(row=>!row.contained||!row.checkbox))throw new Error('Bulk review geometry escaped or optional files were exposed');
      return {viewport:innerWidth,scale:document.documentElement.style.getPropertyValue('--hvir-interface-scale'),rows,optionalFilesHidden:true,contained:true};
    })()`)
  }
}
