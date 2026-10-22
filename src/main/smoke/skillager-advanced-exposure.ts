import type { BrowserWindow, WebContents } from 'electron'
import { joinHostPath, localPath, type HostPath } from '../../shared/host-path'
import type { ProjectHost } from '../project-host/project-host'
import { captureExtensionVisuals } from './extension-visuals'
import {
  skillagerManagementControls,
  withinExtensionInspection,
  type SkillagerManagementControls,
} from './skillager-management-controls'
import { focusSmokeWindow } from './window-focus'

type Ui = ReturnType<typeof skillagerManagementControls>
interface Preservation {
  status: string
  candidates: Array<{
    source: { library_id: string; skill_id: string }
    basis: string
    status: string
  }>
}
interface Original {
  original: HostPath
  skillId: string
  canonical: HostPath
  bytes: string
}

/** Installed CLI, selected public occurrences and ordinary human controls own this journey. */
export async function verifyOwnedAdvancedExposure(
  win: BrowserWindow,
  projectGuest: WebContents,
  detail: () => Promise<WebContents>,
  libraryGuest: () => Promise<WebContents>,
  host: ProjectHost,
  workspace: HostPath,
  cli: (args: readonly string[]) => Promise<Record<string, unknown>>,
  controls: SkillagerManagementControls,
): Promise<readonly Record<string, unknown>[]> {
  const proof: Record<string, unknown>[] = [],
    project = skillagerManagementControls(projectGuest, controls)
  const libraryControls = skillagerManagementControls(await libraryGuest(), controls)
  const choices = (await libraryControls.inspect(
    "[...document.getElementById('task-agent').options].map(option=>({id:option.value,label:option.textContent}))",
  )) as Array<{ id: string; label: string }>
  if (
    JSON.stringify(choices.map((item) => item.label)) !==
    JSON.stringify(['Codex', 'Claude'])
  )
    throw new Error(
      'Selected exposure walkthrough requires both displayed provider choices',
    )
  for (const { id: agent, label } of choices) {
    const base = joinHostPath(
        workspace,
        label === 'Codex' ? '.agents/skills' : '.claude/skills',
      ),
      sources: Original[] = []
    for (const suffix of ['one', 'two', 'three', 'four']) {
      const name = `advanced-${agent}-${suffix}`,
        original = joinHostPath(base, name),
        bytes = `---\nname: ${name}\ndescription: Use only for an owned selected exposure fixture.\n---\n\nRead the supporting guide before making a change.\n`,
        entry = joinHostPath(original, 'SKILL.md')
      await host.createDirectoryExclusive(original, { mode: 0o755 })
      await host.writeFile(entry, bytes)
      await host.createFileExclusive(joinHostPath(original, 'helper.sh'), { mode: 0o755 })
      await host.writeFile(joinHostPath(original, 'helper.sh'), '#!/bin/sh\ntrue\n')
      if (suffix === 'one' || suffix === 'two') {
        const originalFiles = [entry, joinHostPath(original, 'helper.sh')],
          originalModes = await Promise.all(
            originalFiles.map(async (file) => (await host.stat(file)).mode & 0o777),
          )
        const ui = await selectProject(entry, name)
        await ui.ready(
          "!document.getElementById('import-save').disabled",
          `${agent} selected original Save and accept`,
        )
        if (suffix === 'one') {
          await ui.inspect("document.querySelector('#import-options > summary').click()")
          await ui.set('import-name', `保存-𐐨-${agent}`)
          await ui.click('import-refresh')
          await ui.ready(
            `!document.getElementById('import-save').disabled && document.getElementById('import-destination').textContent===${JSON.stringify(`lib/保存-𐐨-${agent}`)}`,
            'exact Unicode Save and accept destination',
          )
        }
        await ui.ready(
          "document.getElementById('exposure-preservation-reason').textContent.length>0 && !document.getElementById('exposure-preservation-reason').textContent.includes('Checking')",
          'automatic unavailable preservation',
        )
        await ui.ready(
          "!document.getElementById('exposure-full').hidden && !document.getElementById('exposure-full').disabled && !document.getElementById('exposure-stub').hidden && !document.getElementById('exposure-stub').disabled && document.getElementById('exposure-review').hidden",
          'unpreserved original offers explicit Full or Stub Save and use',
        )
        if (
          (await host.readdir(original))
            .map((file) => file.name)
            .sort()
            .join(',') !== 'SKILL.md,helper.sh' ||
          (await host.readFile(entry)).toString() !== bytes ||
          (await host.readFile(originalFiles[1]!)).toString() !== '#!/bin/sh\ntrue\n'
        )
          throw new Error('Original files changed before the explicit save decision')
        for (const [index, file] of originalFiles.entries())
          if (((await host.stat(file)).mode & 0o777) !== originalModes[index])
            throw new Error('Original mode changed before the explicit save decision')
        await ui.click('import-save')
        await ui.ready(
          "(() => {try{return JSON.parse(document.getElementById('import-result').textContent).outcome==='verified'}catch{return false}})()",
          'actual accepted-import completion',
        )
        await ui.ready(
          "!document.getElementById('exposure-stub').disabled",
          'automatic accepted-import preservation after Save and accept',
        )
      } else {
        // Separate approved-sync fixtures preserve both public proof families.
        await cli(['review', 'approve', `project/${name}`, '--json'])
      }
      const observed = (await cli([
          'expose',
          '--observe-native',
          entry.path,
          '--agent',
          agent,
          '--scope',
          'project',
          '--json',
        ])) as unknown as Preservation,
        candidate = observed.candidates.find((item) => item.status === 'available')
      if (
        observed.status !== 'available' ||
        !candidate ||
        candidate.basis !==
          (['one', 'two'].includes(suffix) ? 'accepted-import' : 'approved-sync')
      )
        throw new Error(
          'Exact public preservation basis does not match the explicit preparation',
        )
      if (suffix === 'one' && candidate.source.skill_id !== `lib/保存-𐐨-${agent}`)
        throw new Error('Public Unicode canonical identity was changed or inferred')
      const status = await cli([
          'library',
          'status',
          candidate.source.skill_id,
          '--json',
        ]),
        skill = status['skill'] as { path: string }
      sources.push({
        original,
        bytes,
        skillId: candidate.source.skill_id,
        canonical: localPath(skill.path),
      })
      await preserved(sources.at(-1)!)
    }
    const [one, two, three, four] = sources as [Original, Original, Original, Original]
    let ui = await selectProject(
      joinHostPath(one.original, 'SKILL.md'),
      `advanced-${agent}-one`,
    )
    if (label === 'Codex')
      await capture(
        'preserved-original',
        await detail(),
        async () => {
          ui = await selectProject(
            joinHostPath(one.original, 'SKILL.md'),
            'advanced-codex-one',
          )
          await ui.ready(
            "!document.getElementById('exposure-stub').disabled",
            'selected preserved original',
          )
        },
        ui,
      )
    await ui.click('exposure-stub')
    await review(ui, 'adopt-native')
    await ui.click('exposure-cancel')
    await preserved(one)
    await ui.ready(
      "!document.getElementById('exposure-stub').disabled",
      'fresh replacement after cancellation',
    )
    await ui.click('exposure-stub')
    await review(ui, 'adopt-native')
    const uncovered = joinHostPath(one.original, 'uncovered.txt')
    await host.writeFile(uncovered, 'Owned uncovered bytes must remain.\n')
    await ui.click('exposure-confirm')
    await ui.ready(
      "document.getElementById('exposure-review').hidden && document.getElementById('exposure-state').textContent.includes('Preserve the files')",
      `${agent} changed preservation refusal`,
    )
    if (
      (await host.readFile(uncovered)).toString() !==
      'Owned uncovered bytes must remain.\n'
    )
      throw new Error('Refused replacement discarded uncovered original bytes')
    await host.removeFile(uncovered)
    const adopted = await change(ui, 'adopt-native')
    if ((await host.readdir(one.original)).some((item) => item.name === 'helper.sh'))
      throw new Error('Stub replacement retained Full supporting files')
    await preserved(one, false)

    ui = await selectLibrary(one)
    await ui.set('task-agent', agent)
    if (label === 'Codex') {
      const guest = await libraryGuest(),
        retainedRead = (await ui.inspect(
          "document.getElementById('details').textContent",
        )) as string
      await capture(
        'library-selected',
        guest,
        async () => {
          // Appearance restores this completed read; selecting the row would discard it.
          await controls.click('Skillager library')
          await foreground(guest)
          await selectedLibraryReady(one, ui, retainedRead)
        },
        ui,
      )
    }
    await ui.click('exposure-group')
    await membersReady(ui)
    await ui.set('exposure-name', `Advanced ${agent}`)
    await ui.ready(
      `!!document.querySelector('[data-exposure-id="advanced-${agent}-one"]')`,
      'actual standalone replacement choice',
    )
    const defaultReplacement = await ui.inspect(
      `document.querySelector('[data-exposure-id="advanced-${agent}-one"]').checked`,
    )
    if (defaultReplacement)
      throw new Error('Standalone replacement was implicitly selected')
    await ui.inspect(
      `document.querySelector('[data-exposure-id="advanced-${agent}-one"]').click()`,
    )
    const grouped = await change(ui, 'group')
    if ((await host.readdir(base)).some((item) => item.name === `advanced-${agent}-one`))
      throw new Error('Explicit standalone replacement left its old copy')
    const inventory = await cli([
        'expose',
        '--list',
        '--agent',
        agent,
        '--scope',
        'project',
        '--json',
      ]),
      router = (
        inventory['exposures'] as Array<{
          mode: string
          skill_id: string
          skill_ids: string[]
          target: string
        }>
      ).find((item) => item.mode === 'router' && item.skill_ids.includes(one.skillId))
    if (!router) throw new Error('Public inventory did not expose the created Router')
    const routerEntry = localPath(`${router.target}/SKILL.md`)
    const observed = await cli([
      'list',
      '--scope',
      'project',
      '--query',
      router.skill_id,
      '--limit',
      '50',
      '--json',
    ])
    console.log(
      '[smoke] selected Router public occurrence',
      JSON.stringify({
        skillId: router.skill_id,
        target: router.target,
        projectRoot: observed['project_root'],
        observation: observed['observation'],
        rows: (
          observed['skills'] as Array<{
            id: string
            occurrence_id: string
            name: string
            skill_file: string
          }>
        ).map((row) => ({
          id: row.id,
          occurrenceId: row.occurrence_id,
          name: row.name,
          path: row.skill_file,
        })),
      }),
    )
    ui = await selectProject(routerEntry, router.skill_id)
    await ui.ready(
      "!document.getElementById('exposure-edit').disabled && document.querySelectorAll('#router-members > li').length===1",
      'actual selected Router membership',
    )
    if (
      await ui.inspect(
        "document.getElementById('instructions').checkVisibility() || !document.getElementById('selected-task').hidden",
      )
    )
      throw new Error('Selected Router is being treated as an instruction skill')
    if (label === 'Codex')
      await capture(
        'router',
        await detail(),
        async () => {
          ui = await selectProject(routerEntry, router.skill_id)
          await ui.ready(
            "!document.getElementById('exposure-edit').disabled",
            'selected Router content',
          )
        },
        ui,
      )
    await pointer(await detail(), '#exposure-edit')
    await membersReady(ui)
    for (const source of [two, three, four]) await member(ui, source, true)
    const addedMembers = await change(ui, 'set-members')
    await ui.ready(
      "!document.getElementById('exposure-edit').disabled && document.querySelectorAll('#router-members > li').length===4",
      'current Router membership after Done',
    )
    await ui.click('exposure-edit')
    await membersReady(ui)
    await member(ui, one, false)
    if (
      (await ui.inspect(
        "document.querySelectorAll('#exposure-departures select').length",
      )) !== 1
    )
      throw new Error('Departure choices are not confined to the one removed member')
    if (label === 'Codex')
      await capture(
        'router-members',
        await detail(),
        async () => {
          ui = await selectProject(routerEntry, router.skill_id)
          await ui.click('exposure-edit')
          await membersReady(ui)
          await member(ui, one, false)
        },
        ui,
      )
    for (const source of [two, three]) await member(ui, source, false)
    for (const [source, mode] of [
      [one, 'native'],
      [two, 'stub'],
      [three, 'remove'],
    ] as const)
      await ui.inspect(
        `(() => {const select=document.querySelector('#exposure-departures select[data-skill-id=${JSON.stringify(source.skillId)}]');select.value=${JSON.stringify(mode)};select.dispatchEvent(new Event('change',{bubbles:true}));})()`,
      )
    const removedMembers = await change(ui, 'set-members')
    const after = await cli([
        'expose',
        '--list',
        '--agent',
        agent,
        '--scope',
        'project',
        '--json',
      ]),
      copies = after['exposures'] as Array<{ mode: string; skill_id?: string }>
    if (
      !copies.some((item) => item.skill_id === one.skillId && item.mode === 'native') ||
      !copies.some((item) => item.skill_id === two.skillId && item.mode === 'stub') ||
      copies.some((item) => item.skill_id === three.skillId)
    )
      throw new Error(
        'Full, Stub and Remove departures disagree with public project inventory',
      )
    for (const source of [two, three, four]) await preserved(source)
    await ui.ready(
      "!document.getElementById('exposure-ungroup').disabled && document.querySelectorAll('#router-members > li').length===1",
      'current remaining Router member before Ungroup',
    )
    await ui.click('exposure-ungroup')
    const ungrouped = await change(ui, 'ungroup')
    if (
      (await host.readdir(base)).some(
        (item) => `${base.path}/${item.name}` === router.target,
      )
    )
      throw new Error('Ungroup retained the selected Router')
    const tag = await cli(['tag', 'show', `advanced-${agent}`, '--json'])
    if (!JSON.stringify(tag).includes(four.skillId))
      throw new Error('Ungroup discarded curated tag membership')
    ui = await selectProject(
      joinHostPath(two.original, 'SKILL.md'),
      `advanced-${agent}-two`,
    )
    await ui.click('exposure-full')
    const fullAdoption = await change(ui, 'adopt-native')
    await preserved(two)
    proof.push({
      agent,
      adopted,
      grouped,
      addedMembers,
      removedMembers,
      ungrouped,
      fullAdoption,
      exactAcceptedImport: true,
      exactUnicodeCanonicalIdentity: one.skillId,
      unicodeSavedThroughUi: true,
      approvedSync: true,
      canonicalBytesAndModesPreserved: true,
      unselectedOriginalsPreserved: true,
      cancelledWithoutWrites: true,
      changedPreservationRefused: true,
      departingChoices: ['Full', 'Stub', 'Remove'],
      curatedTagRetained: true,
      qualification:
        'Ordinary selected Project/Library controls and installed public CLI; exact unreleased supporting wheel, no signed-package claim.',
    })
  }
  console.log(
    '[smoke] selected exposure: both agents, accepted-import and sync proof, Full/Stub replacement, Group, retained searchable membership, Full/Stub/Remove departures, Ungroup',
  )
  return proof

  async function selectProject(entry: HostPath, query: string): Promise<Ui> {
    await controls.wait(
      async () =>
        Boolean(
          await withinExtensionInspection(
            win.webContents.executeJavaScript(
              "(() => {const button=document.querySelector('.project-tab-main');if(!button?.checkVisibility()||button.disabled)return false;button.click();return true})()",
            ),
          ),
        ),
      'ordinary project destination for selected exposure',
    )
    await controls.click('Skills in this project')
    await foreground(projectGuest)
    await project.set('query', query)
    await project.inspect("document.getElementById('search-form').requestSubmit()")
    try {
      await project.ready(
        `document.getElementById('state').dataset.state==='ready' && !![...document.querySelectorAll('#skills [data-skill-select]')].find(e=>e.dataset.sourcePath===${JSON.stringify(entry.path)})`,
        'selected exact public project occurrence',
      )
    } catch (error) {
      console.log(
        '[smoke] selected Project readiness',
        JSON.stringify({
          expected: entry,
          observed: await project.inspect(`(() => ({
          query: document.getElementById('query').value.slice(0,1000),
          projectScope: document.getElementById('scope-project').getAttribute('aria-pressed'),
          libraryScope: document.getElementById('scope-library').getAttribute('aria-pressed'),
          state: document.getElementById('state').dataset.state,
          rowCount: document.querySelectorAll('#skills [data-skill-select]').length,
          rows: [...document.querySelectorAll('#skills [data-skill-select]')].slice(0,50).map(row=>({id:row.dataset.id,path:row.dataset.sourcePath})),
        }))()`),
        }),
      )
      throw error
    }
    await project.inspect(
      `[...document.querySelectorAll('#skills [data-skill-select]')].find(e=>e.dataset.sourcePath===${JSON.stringify(entry.path)}).click()`,
    )
    const guest = await detail()
    await foreground(guest)
    const ui = skillagerManagementControls(guest, controls)
    await ui.ready(
      `document.getElementById('source-label').textContent.endsWith(${JSON.stringify(` · local: ${entry.path}`)})`,
      'selected exact Project detail identity',
    )
    return ui
  }
  async function selectLibrary(source: Original): Promise<Ui> {
    await controls.click('Skillager library')
    const guest = await libraryGuest()
    await foreground(guest)
    const ui = skillagerManagementControls(guest, controls)
    await ui.set('query', source.skillId.slice(4))
    await ui.inspect("document.getElementById('search-form').requestSubmit()")
    const entry = joinHostPath(source.canonical, 'SKILL.md')
    await ui.ready(
      `document.getElementById('state').dataset.state==='ready' && !!document.querySelector('[data-source-path=${JSON.stringify(entry.path)}]')`,
      'selected exact canonical member',
    )
    await ui.inspect(
      `document.querySelector('[data-source-path=${JSON.stringify(entry.path)}]').click()`,
    )
    await selectedLibraryReady(source, ui)
    return ui
  }
  async function selectedLibraryReady(
    source: Original,
    ui: Ui,
    retainedRead?: string,
  ): Promise<void> {
    const entry = joinHostPath(source.canonical, 'SKILL.md'),
      readMatches =
        retainedRead === undefined
          ? "document.getElementById('details').textContent.length>0"
          : `document.getElementById('details').textContent===${JSON.stringify(retainedRead)}`
    try {
      await ui.ready(
        `document.getElementById('source-label').textContent.endsWith(${JSON.stringify(` · local: ${entry.path}`)}) && !document.getElementById('reader-manage').disabled && !document.getElementById('task-mode').disabled && !document.getElementById('exposure-group').hidden && !document.getElementById('exposure-group').disabled && document.getElementById('instructions').textContent.length>0 && ${readMatches}`,
        retainedRead === undefined
          ? 'selected library reading and Group action'
          : 'same selected library read and Group action restored',
      )
    } catch (error) {
      console.log(
        '[smoke] selected library readiness',
        JSON.stringify(
          await ui.inspect(`(() => {
        const primary=document.getElementById('task-primary'), group=document.getElementById('exposure-group');
        const reader=document.getElementById('reader-state'),classes=['frequency','capacity','hidden','closed','cancel','ended','stale','no longer current','timed out','revoked','not granted','unapproved','root changed','library changed'];
        return {readerState:['ready','loading','stale','error','unapproved'].includes(reader.dataset.state)?reader.dataset.state:null,readerClasses:classes.filter(value=>reader.textContent.toLowerCase().includes(value)),readingAvailable:!document.getElementById('reader-manage').disabled,readMatches:${readMatches},instructionsPresent:document.getElementById('instructions').textContent.length>0,copyControlDisabled:document.getElementById('task-mode').disabled,primaryHidden:primary.hidden,primaryDisabled:primary.disabled,groupHidden:group.hidden,groupDisabled:group.disabled};
      })()`),
        ),
      )
      throw error
    }
  }
  async function foreground(guest: WebContents) {
    await controls.wait(
      async () =>
        Boolean(
          await withinExtensionInspection(
            win.webContents.executeJavaScript(
              `(() => {const frame=[...document.querySelectorAll('webview')].find(item=>item.getWebContentsId()===${guest.id});return frame?.checkVisibility()&&frame.getBoundingClientRect().width>0&&frame.getBoundingClientRect().height>0})()`,
            ),
          ),
        ),
      'actual foreground selected exposure guest',
    )
  }
  async function membersReady(ui: Ui) {
    await ui.ready(
      "!document.getElementById('exposure-member-search-button').disabled && document.querySelectorAll('#exposure-member-results input').length>0",
      'bounded membership page',
    )
  }
  async function member(ui: Ui, source: Original, checked: boolean) {
    await ui.set('exposure-member-query', source.skillId.slice(4))
    await ui.inspect("document.getElementById('exposure-member-search').requestSubmit()")
    await ui.ready(
      `!document.getElementById('exposure-member-search-button').disabled && !!document.querySelector('#exposure-member-results [data-skill-id=${JSON.stringify(source.skillId)}]')`,
      'exact searched member',
    )
    await ui.inspect(
      `(() => {const input=document.querySelector('#exposure-member-results [data-skill-id=${JSON.stringify(source.skillId)}]');if(input.checked!==${checked})input.click();})()`,
    )
  }
  async function review(ui: Ui, operation: string) {
    await ui.ready(
      "!document.getElementById('exposure-review').hidden || (document.getElementById('exposure-preview').checkVisibility() && !document.getElementById('exposure-preview').disabled)",
      'selected exposure review or explicit preparation control',
    )
    if (await ui.inspect("document.getElementById('exposure-review').hidden"))
      await ui.click('exposure-preview')
    await ui.ready(
      `!document.getElementById('exposure-review').hidden && JSON.parse(document.getElementById('exposure-plan').textContent).request.action===${JSON.stringify(operation)}`,
      `complete ${operation} file review`,
    )
    if (
      !(await ui.inspect(
        "(() => {const p=JSON.parse(document.getElementById('exposure-plan').textContent);return !!p.confirmation_token && document.querySelectorAll('#exposure-effects li').length===p.targets.flatMap(t=>t.file_effects).length})()",
      ))
    )
      throw new Error(
        'Human review omitted complete affected file effects or fresh whole-plan token',
      )
  }
  async function change(ui: Ui, operation: string) {
    await review(ui, operation)
    await ui.click('exposure-confirm')
    await ui.ready(
      `(() => {try{const r=JSON.parse(document.getElementById('exposure-result').textContent);return document.getElementById('exposure-review').hidden && !document.getElementById('exposure-operation-details').hidden && !document.getElementById('exposure-cancel').disabled && r.action==='change-exposure'&&r.operation===${JSON.stringify(operation)}}catch{return false}})()`,
      'complete selected exposure result',
    )
    const result = (await ui.inspect(
      "JSON.parse(document.getElementById('exposure-result').textContent)",
    )) as Record<string, unknown>
    if (result['outcome'] !== 'verified' || !Array.isArray(result['results']))
      throw new Error(`Selected ${operation} did not verify`)
    await ui.click('exposure-cancel')
    return result
  }
  async function preserved(source: Original, original = true) {
    for (const path of original
      ? [source.original, source.canonical]
      : [source.canonical])
      if (
        (await host.readFile(joinHostPath(path, 'SKILL.md'))).toString() !==
          source.bytes ||
        (await host.readFile(joinHostPath(path, 'helper.sh'))).toString() !==
          '#!/bin/sh\ntrue\n' ||
        ((await host.stat(joinHostPath(path, 'helper.sh'))).mode & 0o111) === 0
      )
        throw new Error('Selected exposure lost preserved bytes or executable modes')
  }
  async function pointer(guest: WebContents, selector: string) {
    try {
      await focusSmokeWindow(win, 'window')
      await foreground(guest)
      const box = (await guest.executeJavaScript(
        `(() => {const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();if(!e.checkVisibility()||e.disabled||r.top<0||r.bottom>innerHeight)throw new Error('Selected task control is clipped');return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`,
      )) as { x: number; y: number }
      guest.focus()
      guest.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...box })
      try {
        await controls.wait(
          async () =>
            (await guest.executeJavaScript(
              `document.hasFocus() && document.activeElement===document.querySelector(${JSON.stringify(selector)})`,
            )) === true,
          'actual selected exposure guest native input focus',
        )
      } finally {
        guest.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...box })
      }
    } catch (error) {
      console.log(
        '[smoke] selected exposure pointer focus',
        JSON.stringify({
          windowFocused: win.isFocused(),
          windowVisible: win.isVisible(),
          minimized: win.isMinimized(),
          parentFocused: (await withinExtensionInspection(
            win.webContents.executeJavaScript('document.hasFocus()'),
          )) as unknown,
          guest: (await withinExtensionInspection(
            guest.executeJavaScript(
              `({focused:document.hasFocus(),targetFocused:document.activeElement===document.querySelector(${JSON.stringify(selector)})})`,
            ),
          )) as unknown,
        }),
      )
      throw error
    }
  }
  async function capture(
    state: 'router' | 'router-members' | 'preserved-original' | 'library-selected',
    guest: WebContents,
    select: () => Promise<void>,
    ui: Ui,
  ) {
    await captureExtensionVisuals(win, guest, host, state, {
      ...controls,
      select,
      painted: async () => {
        const facts = (await ui.inspect(`(() => {
        const box=e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height,visible:e.checkVisibility()}};
        const contained=r=>r.visible&&r.width>0&&r.height>0&&r.left>=0&&r.right<=innerWidth+1&&r.top>=0&&r.bottom<=innerHeight+1;
        const editing=${state === 'router-members'}, router=${state === 'router'}, original=${state === 'preserved-original'};
        const content=document.getElementById(editing?'exposure-task':router?'router-content':'instructions');
        const bounds=box(content), preview=editing?box(document.getElementById('exposure-preview')):null, cancel=editing?box(document.getElementById('exposure-cancel')):null, replacement=original?box(document.querySelector('#exposure-replacement>summary')):null;
        const failures=[];
        if(!contained(bounds)||bounds.height<80||document.documentElement.scrollWidth>innerWidth+1)failures.push('content');
        if(editing&&(!document.getElementById('router-content').hidden||!contained(preview)||!contained(cancel)))failures.push('editing-footer');
        if(original&&!contained(replacement))failures.push('replacement');
        return {width:innerWidth,height:innerHeight,bounds,preview,cancel,replacement,failures,editing,router,original};
      })()`)) as { failures: string[] }
        if (facts.failures.length)
          throw new Error(`Selected exposure geometry: ${JSON.stringify(facts)}`)
        return facts
      },
    })
  }
}
