import type { BrowserWindow, WebContents } from 'electron'
import { captureExtensionVisuals } from './extension-visuals'
import { createHash } from 'node:crypto'
import { joinHostPath, type HostPath } from '../../shared/host-path'
import type { ProjectHost } from '../project-host/project-host'
import {
  skillagerManagementControls,
  withinExtensionInspection,
  type SkillagerManagementControls,
} from './skillager-management-controls'

/** Actual selected-original human import, exact inspection, preservation and partial Git effects. */
export async function verifyOwnedImport(
  win: BrowserWindow,
  projectGuest: WebContents,
  detail: () => Promise<WebContents>,
  host: ProjectHost,
  workspace: HostPath,
  library: HostPath,
  mode: string,
  controls: SkillagerManagementControls,
): Promise<Record<string, unknown>> {
  const root = joinHostPath(joinHostPath(workspace, '.agents'), 'skills'),
    original = joinHostPath(root, 'owned-original'),
    target = joinHostPath(joinHostPath(library, 'skills'), 'owned-original'),
    project = skillagerManagementControls(projectGuest, controls)
  async function select(name: string) {
    await controls.click('Skills in this project')
    await project.set('query', name)
    await project.inspect("document.getElementById('search-form').requestSubmit()")
    const path = joinHostPath(joinHostPath(root, name), 'SKILL.md').path
    await project.ready(
      `!![...document.querySelectorAll('#skills [data-skill-select]')].find(e=>e.dataset.sourcePath===${JSON.stringify(path)})`,
      'selected original public occurrence',
    )
    await project.inspect(
      `[...document.querySelectorAll('#skills [data-skill-select]')].find(e=>e.dataset.sourcePath===${JSON.stringify(path)}).click()`,
    )
    const guest = await detail(),
      ui = skillagerManagementControls(guest, controls)
    await controls.wait(
      async () =>
        Boolean(
          await withinExtensionInspection(
            win.webContents.executeJavaScript(
              `(() => {const frame=[...document.querySelectorAll('webview')].find(item=>item.getWebContentsId()===${guest.id});return frame?.checkVisibility()})()`,
            ),
          ),
        ),
      'foreground selected original import',
    )
    await ui.ready(
      `document.getElementById('source-label').textContent.endsWith(${JSON.stringify(` · local: ${path}`)})`,
      'selected exact original import identity',
    )
    return ui
  }
  async function absent(path: HostPath) {
    try {
      await host.stat(path)
    } catch (error) {
      if ((error as { code?: unknown }).code === 'ENOENT') return
      throw error
    }
    throw new Error('Import wrote a target before its exact human decision')
  }
  async function snapshot(path: HostPath) {
    const files = []
    for (const entry of (await host.readdir(path)).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const file = joinHostPath(path, entry.name),
        bytes = await host.readFile(file)
      files.push({
        path: entry.name,
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        executable: ((await host.stat(file)).mode & 0o111) !== 0,
      })
    }
    return files
  }
  const ui = await select('owned-original')
  await ui.ready(
    "!document.getElementById('import-save').disabled",
    'selected original Save and accept',
  )
  await ui.click('import-cancel')
  await absent(target)
  await ui.click('import-refresh')
  await ui.ready(
    "!document.getElementById('import-save').disabled",
    'original fresh import review',
  )
  await host.writeFile(
    joinHostPath(original, 'support.txt'),
    'Owned original import support.\n',
  )
  await host.writeFile(
    joinHostPath(original, 'owned-binary.dat'),
    Buffer.from('owned\0import'),
  )
  const before = await snapshot(original)
  await ui.click('import-save')
  await ui.ready(
    "document.getElementById('import-state').textContent.includes('changed after reading')",
    'changed external manifest refuses before import',
  )
  await absent(target)
  await ui.click('import-refresh')
  await ui.ready(
    "!document.getElementById('import-save').disabled && document.querySelectorAll('#import-files [data-review-path]').length===3",
    'complete external import manifest',
  )
  const manifest = (await ui.inspect(
    "JSON.parse(document.getElementById('import-manifest').textContent)",
  )) as {
    file_count: number
    source_file: string
    destination_path: string
    files: unknown[]
  }
  if (
    manifest.file_count !== 3 ||
    manifest.source_file !== joinHostPath(original, 'SKILL.md').path ||
    manifest.destination_path !== target.path
  )
    throw new Error('Native import manifest lost exact source/destination identity')
  await ui.inspect("document.getElementById('import-inspect').click()")
  for (const name of ['SKILL.md', 'support.txt', 'owned-binary.dat']) {
    await ui.inspect(
      `document.querySelector('#import-files [data-review-path=${JSON.stringify(name)}]').click()`,
    )
    await ui.ready(
      name.endsWith('.dat')
        ? "document.getElementById('import-file-body').textContent.includes('Preview unavailable')"
        : `document.getElementById('import-file-state').textContent==='' && document.getElementById('import-file-label').textContent.startsWith(${JSON.stringify(`${name} · `)}) && document.getElementById('import-file-body').textContent.length>0 && !document.getElementById('import-file-body').textContent.startsWith('Preview unavailable')`,
      'optional exact external file inspection',
    )
  }
  await ui.ready(
    "!document.getElementById('import-save').disabled",
    'unsupported inspection does not replace CLI eligibility',
  )
  const importGuest = await detail()
  for (const state of ['import', 'import-files'] as const)
    await captureExtensionVisuals(win, importGuest, host, state, {
      ...controls,
      select: async () => {
        await controls.wait(
          async () =>
            (await win.webContents.executeJavaScript(`(() => {
        const frame=[...document.querySelectorAll('webview')].find(e=>e.getWebContentsId()===${importGuest.id});
        const view=frame?.closest('[data-extension-view]');
        if(!view)return false;
        const tab=[...document.querySelectorAll('.viewer-tab .tab-main')].find(e=>e.title==='Skillager · Skill instructions');
        if(tab)tab.click();
        return frame.checkVisibility();
      })()`)) === true,
          'selected original import visible after appearance change',
        )
        await ui.ready(
          "!document.getElementById('import-save').disabled",
          'fresh import controls after appearance change',
        )
        await ui.inspect(
          "document.getElementById('import-options').open=false;if(!document.getElementById('import-inspection').hidden)document.getElementById('import-inspect').click()",
        )
        if (state === 'import-files') {
          await ui.inspect(
            `document.getElementById('import-inspect').click();document.querySelector('#import-files [data-review-path="SKILL.md"]').click()`,
          )
          await ui.ready(
            "document.getElementById('import-file-state').textContent==='' && document.getElementById('import-file-label').textContent.startsWith('SKILL.md · ') && document.getElementById('import-file-body').textContent.includes('owned-original')",
            'visible optional exact original inspection',
          )
        }
      },
      painted: async () => {
        const facts = (await ui.inspect(`(() => {
      const action=document.getElementById('import-save'), pane=document.getElementById('selected-import'), inspection=document.getElementById('import-inspection');
      const expanded=${state === 'import-files'}, reader=document.getElementById(expanded?'import-inspection':'instructions'), box=reader.getBoundingClientRect();
      const contained=element=>{const r=element.getBoundingClientRect();return element.checkVisibility()&&r.height>0&&r.width>0&&r.left>=0&&r.right<=innerWidth+1&&r.top>=0&&r.bottom<=innerHeight+1};
      const rect=element=>{const r=element.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height,visible:element.checkVisibility()}};
      const effect=document.getElementById('import-effect'), toggle=document.getElementById('import-inspect'), modes=document.querySelector('.instruction-modes');
      const failures=[];
      if(modes.checkVisibility()===expanded)failures.push('instruction-controls');
      if(box.height<120||box.width<180||!contained(reader))failures.push('reader-space');
      if(!contained(action)||action.disabled||!contained(effect)||!effect.textContent.includes('Original')||!contained(toggle)||document.documentElement.scrollWidth>innerWidth+1)failures.push('action-effect-inspection-control');
      let selectedFile;
      if(expanded){
        const body=document.getElementById('import-file-body'), file=body.getBoundingClientRect(), label=document.getElementById('import-file-label'), all=document.getElementById('import-all-files');
        selectedFile={body:rect(body),label:rect(label),all:rect(all),visibleHeight:Math.min(file.bottom,box.bottom)-file.top,expectedLabel:label.textContent.startsWith('SKILL.md'),expectedBody:body.textContent.includes('owned-original')};
        if(inspection.hidden||!contained(label)||!label.textContent.startsWith('SKILL.md')||!contained(all)||toggle.textContent!=='Close files'||!body.textContent.includes('owned-original')||file.top<box.top-1||file.top>=box.bottom-1||Math.min(file.bottom,box.bottom)-file.top<100)failures.push('selected-file-bytes');
      }else if(!inspection.hidden)failures.push('ordinary-instructions');
      return {failures,width:innerWidth,height:innerHeight,reader:rect(reader),action:rect(action),effect:rect(effect),toggle:rect(toggle),selectedFile,singleHumanDecision:true,files:document.querySelectorAll('#import-files [data-review-path]').length,actionVisible:contained(action),effectVisible:contained(effect),inspectionControlVisible:contained(toggle),selectedFileVisible:expanded,readerHeight:box.height,readerWidth:box.width,taskHeight:pane.getBoundingClientRect().height};
    })()`)) as { failures: string[] }
        if (facts.failures.length)
          throw new Error(`Selected import geometry: ${JSON.stringify(facts)}`)
        return facts
      },
    })
  await ui.click('import-save')
  await ui.ready(
    "(() => {try{return JSON.parse(document.getElementById('import-result').textContent).outcome==='verified'}catch{return false}})()",
    'actual Save and accept verified result',
  )
  const imported = await ui.inspect(
    "JSON.parse(document.getElementById('import-result').textContent)",
  )
  if (
    JSON.stringify(await snapshot(original)) !== JSON.stringify(before) ||
    JSON.stringify(await snapshot(target)) !== JSON.stringify(before)
  )
    throw new Error(
      'Save and accept changed original bytes or its complete copied version',
    )
  await ui.click('import-refresh')
  await ui.ready(
    "document.getElementById('import-destination').textContent==='Saved in library' && document.getElementById('import-effect').textContent==='Original unchanged.' && document.getElementById('import-save').hidden && document.getElementById('import-state').textContent===''",
    'public preservation reports saved original without collision noise',
  )
  const proof: Record<string, unknown> = {
    imported,
    completeManifest: manifest,
    originalBefore: before,
    originalAfter: await snapshot(original),
    targetAfter: await snapshot(target),
    cancelledBeforeWrite: true,
    changedManifestRefused: true,
    savedOriginalPreserved: true,
  }
  const absentOriginal = joinHostPath(root, 'owned-import-absent'),
    absentTarget = joinHostPath(joinHostPath(library, 'skills'), 'owned-import-absent')
  await host.createDirectoryExclusive(absentOriginal, { mode: 0o755 })
  await host.writeFile(
    joinHostPath(absentOriginal, 'SKILL.md'),
    '---\nname: owned-import-absent\ndescription: Use only for an owned refused import fixture.\n---\n\nOriginal bytes stay separate after a pre-copy failure.\n',
  )
  const absentBefore = await snapshot(absentOriginal),
    absentUi = await select('owned-import-absent'),
    skills = joinHostPath(library, 'skills'),
    permissions = (await host.stat(skills)).mode & 0o777
  await absentUi.ready(
    "!document.getElementById('import-save').disabled",
    'absent import review',
  )
  await absentUi.inspect("document.getElementById('import-options').open=true")
  await absentUi.set('import-name', 'owned-original')
  await absentUi.click('import-refresh')
  await absentUi.ready(
    "document.getElementById('import-state').textContent.includes('already exists') && document.getElementById('import-save').disabled && !document.getElementById('import-save').hidden",
    'different original cannot overwrite occupied canonical name',
  )
  if (JSON.stringify(await snapshot(target)) !== JSON.stringify(before))
    throw new Error('Refused explicit collision changed the canonical copy')
  proof.collisionRefused = true
  await absentUi.set('import-name', '')
  await absentUi.click('import-refresh')
  await absentUi.ready(
    "!document.getElementById('import-save').disabled",
    'distinct original destination restored after collision',
  )
  async function setSkillsPermissions(mode: number) {
    const changed = await host.exec('chmod', [mode.toString(8), skills.path], {
      cwd: library,
    })
    if (changed.code !== 0) throw new Error('Owned import permission fixture failed')
  }
  await setSkillsPermissions(0o500)
  try {
    await absentUi.click('import-save')
    await absentUi.ready(
      "(() => {try{const r=JSON.parse(document.getElementById('import-result').textContent);return r.outcome==='uncertain'&&typeof r.operationId==='string'}catch{return false}})()",
      'pre-copy failure retains exact import operation',
    )
  } finally {
    await setSkillsPermissions(permissions)
  }
  await absent(absentTarget)
  await absentUi.click('import-reconcile')
  await absentUi.ready(
    "document.getElementById('import-reconcile').textContent==='Acknowledge current facts'",
    'positive public absence observation',
  )
  const absentObserved = (await absentUi.inspect(
    "JSON.parse(document.getElementById('import-result').textContent)",
  )) as { observation: string }
  const absentFacts = JSON.parse(absentObserved.observation) as {
    state: string
    originalCompletion: string
  }
  if (
    absentFacts.state !== 'destination-absent' ||
    absentFacts.originalCompletion !== 'unknown'
  )
    throw new Error('Import absence was not established by current public facts')
  await absentUi.click('import-reconcile')
  await absentUi.ready(
    "document.getElementById('import-reconcile').hidden",
    'specific import blockade acknowledged',
  )
  await absentUi.click('import-refresh')
  await absentUi.ready(
    "!document.getElementById('import-save').disabled",
    'fresh explicit review available after acknowledgment',
  )
  await absent(absentTarget)
  if (JSON.stringify(await snapshot(absentOriginal)) !== JSON.stringify(absentBefore))
    throw new Error('Refused import changed original bytes')
  proof.absentDestination = {
    observed: absentObserved,
    originalBefore: absentBefore,
    originalAfter: await snapshot(absentOriginal),
    acknowledgmentDidNotReplay: true,
    qualification:
      'Task-owned skills directory temporarily denies writes before submission; permission restored before fresh public absence observation. No arbitrary error establishes absence.',
  }
  if (mode !== 'git')
    return {
      ...proof,
      gitFailure:
        'Not applicable to this no-Git fixture; exercised by the separate Git workflow.',
    }
  const failedOriginal = joinHostPath(root, 'owned-import-uncertain')
  await host.createDirectoryExclusive(failedOriginal, { mode: 0o755 })
  await host.writeFile(
    joinHostPath(failedOriginal, 'SKILL.md'),
    '---\nname: owned-import-uncertain\ndescription: Use only for an owned partial-import fixture.\n---\n\nOwned original remains unchanged after Git failure.\n',
  )
  const failureBefore = await snapshot(failedOriginal),
    failedUi = await select('owned-import-uncertain')
  await failedUi.ready(
    "!document.getElementById('import-save').disabled",
    'partial import exact review',
  )
  const hook = joinHostPath(
    joinHostPath(joinHostPath(library, '.git'), 'hooks'),
    'pre-commit',
  )
  await host.writeFile(hook, '#!/bin/sh\nexit 1\n')
  const chmod = await host.exec('chmod', ['700', hook.path], { cwd: library })
  if (chmod.code !== 0) throw new Error('Owned Git failure hook setup failed')
  try {
    await failedUi.click('import-save')
    await failedUi.ready(
      "(() => {try{const r=JSON.parse(document.getElementById('import-result').textContent);return r.outcome==='uncertain'&&typeof r.operationId==='string'}catch{return false}})()",
      'Git failure retains exact import uncertainty',
    )
    const uncertain = await failedUi.inspect(
      "JSON.parse(document.getElementById('import-result').textContent)",
    )
    await failedUi.click('import-reconcile')
    await failedUi.ready(
      "document.getElementById('import-reconcile').textContent==='Acknowledge current facts'",
      'partial import supported current observation',
    )
    const observed = await failedUi.inspect(
      "JSON.parse(document.getElementById('import-result').textContent)",
    )
    if (JSON.stringify(await snapshot(failedOriginal)) !== JSON.stringify(failureBefore))
      throw new Error('Partial Git import modified its original')
    return {
      ...proof,
      gitFailure: {
        uncertain,
        observed,
        originalBefore: failureBefore,
        originalAfter: await snapshot(failedOriginal),
        qualification:
          'Task-owned ordinary Git pre-commit failure after copy; original completion remains unknown. No retry or rollback.',
      },
    }
  } finally {
    await host.removeFile(hook)
  }
}
