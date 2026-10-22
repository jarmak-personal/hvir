import type { BrowserWindow, WebContents } from 'electron'
import { createHash } from 'node:crypto'
import { joinHostPath, localPath, type HostPath } from '../../shared/host-path'
import type { ProjectHost } from '../project-host/project-host'
import { captureExtensionVisuals } from './extension-visuals'
import { focusSmokeWindow } from './window-focus'
import {
  skillagerManagementControls,
  type SkillagerManagementControls,
} from './skillager-management-controls'

/** Maintained package, real guest input, trusted Files decision, and installed public CLI. */
export async function verifyOwnedSkillRowActions(
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
    folder = joinHostPath(joinHostPath(workspace, '.agents'), 'skills'),
    name = 'owned-context-skill',
    original = joinHostPath(folder, name),
    instruction = joinHostPath(original, 'SKILL.md'),
    other = joinHostPath(folder, 'owned-context-trash'),
    compound = joinHostPath(folder, 'owned-context-combined'),
    body = `---\nname: ${name}\ndescription: Owned contextual action fixture.\n---\n\n# Keep the reader\n\n${'Read this independently of project actions.\n\n'.repeat(60)}`
  for (const path of [
    joinHostPath(workspace, '.agents'),
    folder,
    original,
    other,
    compound,
  ])
    await host.createDirectoryExclusive(path, { mode: 0o755 }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    })
  await host.writeFile(instruction, body)
  await host.writeFile(
    joinHostPath(other, 'SKILL.md'),
    '---\nname: owned-context-trash\ndescription: Owned recoverable original.\n---\n\nKeep until explicit Trash.\n',
  )
  await host.writeFile(
    joinHostPath(compound, 'SKILL.md'),
    '---\nname: owned-context-combined\ndescription: Owned combined decision.\n---\n\nOne reviewed Save and use decision.\n',
  )
  await filter('owned-context')
  await chooseRow(instruction.path)
  const reader = await detail(),
    reading = skillagerManagementControls(reader, controls)
  await reading.ready(
    "!!document.getElementById('instructions')?.firstElementChild",
    'independent selected original reader',
  )
  await reading.inspect("document.getElementById('instructions').scrollTop=180")
  const before = await reading.inspect(`(() => {
    const body=document.getElementById('instructions');
    return {html:body.innerHTML,scroll:body.scrollTop,title:document.getElementById('detail-title').textContent};
  })()`)
  await rightClick(joinHostPath(other, 'SKILL.md').path)
  const choices = await menuLabels()
  if (
    JSON.stringify(choices) !==
    JSON.stringify([
      'Save to library…',
      'Use full copy…',
      'Use stub…',
      'Remove from project…',
      'Show in Files',
    ])
  )
    throw new Error('Native right-click did not reach the exact skill action menu')
  await escape()
  await ellipsis(joinHostPath(other, 'SKILL.md').path)
  if (JSON.stringify(await menuLabels()) !== JSON.stringify(choices))
    throw new Error('Visible row action differs from right-click')
  await escape()
  await ui.inspect(`(() => {
    const row=${row(instruction.path)};row.focus();
  })()`)
  guest.sendInputEvent({ type: 'keyDown', keyCode: 'F10', modifiers: ['shift'] })
  guest.sendInputEvent({ type: 'keyUp', keyCode: 'F10', modifiers: ['shift'] })
  await menu()
  await escape()
  await ui.ready(
    `document.activeElement===${row(instruction.path)}`,
    'Shift-F10 Escape returns the invoking row',
  )
  const after = await reading.inspect(`(() => {
    const body=document.getElementById('instructions');
    return {html:body.innerHTML,scroll:body.scrollTop,title:document.getElementById('detail-title').textContent};
  })()`)
  if (JSON.stringify(after) !== JSON.stringify(before))
    throw new Error('Opening or dismissing row actions replaced the independent reader')
  await captureExtensionVisuals(win, guest, host, 'project', {
    ...controls,
    select: async () => {
      await controls.click('Skills in this project')
      await filter('owned-context')
      await ellipsis(instruction.path)
    },
    painted: geometry,
  })
  await escape()
  await task(instruction.path, 'save')
  await decision('import-save')
  const manifest = (await ui.inspect(
    "JSON.parse(document.getElementById('import-manifest').textContent)",
  )) as { destination_path: string; destination_id: string }
  const destination = manifest.destination_path,
    skillId = manifest.destination_id
  if (!destination.startsWith(`${owned.path}/`))
    throw new Error('Row save escaped its owned library')
  await captureExtensionVisuals(win, guest, host, 'import', {
    ...controls,
    select: async () => {
      await controls.click('Skills in this project')
      await filter('owned-context')
      await task(instruction.path, 'save')
      await decision('import-save')
    },
    painted: geometry,
  })
  await ui.click('import-save')
  await result('import-result', 'verified')
  if ((await host.readFile(instruction)).toString() !== body)
    throw new Error('Save to library changed the original')
  await ui.click('skill-task-close')
  await task(instruction.path, 'stub')
  await decision('exposure-confirm')
  await ui.click('exposure-confirm')
  await result('exposure-result', 'verified')
  await observed('Installed Stub')
  await ui.click('skill-task-close')
  await task(instruction.path, 'native')
  await decision('task-confirm')
  await ui.click('task-confirm')
  await result('task-result', 'verified')
  await observed('Installed Full')
  await ui.click('skill-task-close')
  await task(instruction.path, 'remove')
  await decision('task-confirm')
  await ui.click('task-confirm')
  await result('task-result', 'verified')
  await ui.ready(`!${row(instruction.path)}`, 'removed managed occurrence disappears')
  if (
    (await host.readFile(joinHostPath(localPath(destination), 'SKILL.md'))).toString() !==
    body
  )
    throw new Error('Managed removal changed the canonical library')
  await ui.click('skill-task-close')
  await task(joinHostPath(other, 'SKILL.md').path, 'remove')
  await trashDialog()
  await controls.click('Cancel')
  await ui.ready(
    "document.getElementById('skill-task-message').textContent==='Cancelled.'",
    'native Trash cancellation retained the original',
  )
  await host.stat(other)
  await ui.click('skill-task-close')
  await task(joinHostPath(other, 'SKILL.md').path, 'remove')
  await trashDialog()
  await controls.click('Move to Trash')
  await ui.ready(
    `!${row(joinHostPath(other, 'SKILL.md').path)}`,
    'trusted Trash refresh removes only the actual original',
  )
  await ui.click('skill-task-close')
  await task(joinHostPath(compound, 'SKILL.md').path, 'stub')
  await decision('import-save')
  if (
    (await ui.inspect("document.getElementById('import-save').textContent")) !==
    'Save and use Stub'
  )
    throw new Error('Unsaved row action did not prepare the single combined decision')
  await host.writeFile(
    joinHostPath(compound, 'new-support.md'),
    'Owned post-review drift.\n',
  )
  await ui.click('import-save')
  await ui.ready(
    "document.getElementById('skill-task-retry').checkVisibility() && !!document.getElementById('import-state').textContent && !document.getElementById('import-reconcile').checkVisibility()",
    'definite refusal has a visible fresh-review step',
  )
  await observed('Project original', joinHostPath(compound, 'SKILL.md').path)
  await ui.click('skill-task-retry')
  await decision('import-save')
  await ui.click('import-save')
  await result('import-result', 'verified')
  await observed('Installed Stub', joinHostPath(compound, 'SKILL.md').path)
  await ui.click('skill-task-close')
  await ui.click('scope-library')
  await filter(name)
  await task(joinHostPath(localPath(destination), 'SKILL.md').path, 'stub')
  await decision('task-primary')
  await ui.click('task-primary')
  await result('task-result', 'verified')
  const added = (await ui.inspect(
    "JSON.parse(document.getElementById('task-result').textContent)",
  )) as { target: HostPath }
  await ui.click('skill-task-close')
  await ui.click('scope-project')
  await filter('owned-context')
  await observed('Installed Stub', joinHostPath(added.target, 'SKILL.md').path)
  const inventory = await cli(['list', '--scope', 'project', '--json', '--limit', '100'])
  return {
    rightClick: true,
    ellipsis: true,
    keyboard: true,
    readerPreserved: true,
    nativeTrash: { cancelled: true, completed: true },
    originalSave: { originalUnchanged: true, skillId },
    combined: { oneDecision: true, refusalRetainedOriginal: true, freshReview: true },
    managed: ['Stub', 'Full', 'Remove', 'Library → Stub'],
    immediateTruthfulRefresh: true,
    queryPreserved: true,
    canonicalHash: createHash('sha256').update(body).digest('hex'),
    finalInventory: inventory,
  }

  function row(path: string): string {
    return `[...document.querySelectorAll('#skills [data-skill-select]')].find(node=>node.dataset.sourcePath===${JSON.stringify(path)})`
  }
  async function filter(query: string): Promise<void> {
    await ui.set('query', query)
    await ui.inspect("document.getElementById('search-form').requestSubmit()")
    await ui.ready(
      `document.getElementById('query').value===${JSON.stringify(query)} && !['stale','connecting'].includes(document.getElementById('state').dataset.state)`,
      'fresh filtered occurrence inventory',
    )
  }
  async function chooseRow(path: string): Promise<void> {
    await ui.ready(`!!${row(path)}`, 'exact readable occurrence')
    await ui.inspect(`${row(path)}.click()`)
  }
  async function ellipsis(path: string): Promise<void> {
    await ui.ready(`!!${row(path)}`, 'exact actionable occurrence')
    await ui.inspect(
      `${row(path)}.parentElement.querySelector('[data-skill-actions]').click()`,
    )
    await menu()
  }
  async function rightClick(path: string): Promise<void> {
    await focusSmokeWindow(win, 'window')
    const point = (await ui.inspect(`(() => {
      const button=${row(path)};button.scrollIntoView({block:'nearest'});
      const r=button.getBoundingClientRect();return {x:Math.round(r.left+20),y:Math.round(r.top+12)};
    })()`)) as { x: number; y: number }
    guest.focus()
    guest.sendInputEvent({ type: 'mouseDown', button: 'right', clickCount: 1, ...point })
    guest.sendInputEvent({ type: 'mouseUp', button: 'right', clickCount: 1, ...point })
    await menu()
  }
  async function menu(): Promise<void> {
    await ui.ready(
      "document.getElementById('skill-row-menu').checkVisibility()",
      'row menu',
    )
  }
  async function menuLabels(): Promise<unknown> {
    return ui.inspect(
      "[...document.querySelectorAll('#skill-row-menu button')].map(button=>button.textContent)",
    )
  }
  async function escape(): Promise<void> {
    guest.focus()
    guest.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    guest.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
    await ui.ready(
      "document.getElementById('skill-row-menu').hidden",
      'row menu dismissed',
    )
  }
  async function task(path: string, action: string): Promise<void> {
    await ellipsis(path)
    await ui.inspect(
      `document.querySelector('#skill-row-menu [data-task=${action}]').click()`,
    )
  }
  async function decision(id: string): Promise<void> {
    await ui.ready(
      `document.getElementById(${JSON.stringify(id)}).checkVisibility() && !document.getElementById(${JSON.stringify(id)}).disabled`,
      'inline reviewed decision',
    )
  }
  async function result(id: string, outcome: string): Promise<void> {
    await ui.ready(
      `(() => {try{return JSON.parse(document.getElementById(${JSON.stringify(id)}).textContent).outcome===${JSON.stringify(outcome)}}catch{return false}})()`,
      'inline operation result',
    )
  }
  async function observed(kind: string, path = instruction.path): Promise<void> {
    await ui.ready(
      `!!${row(path)}?.textContent.includes(${JSON.stringify(kind.replace('Installed ', ''))}) && document.getElementById('query').value==='owned-context'`,
      `fresh ${kind} without refresh click`,
    )
  }
  async function trashDialog(): Promise<void> {
    await controls.wait(
      () =>
        win.webContents.executeJavaScript(`(() => {
      const dialog=document.querySelector('.file-deletion-dialog');
      return dialog?.checkVisibility() && dialog.textContent.includes(${JSON.stringify(other.path)}) &&
        document.querySelectorAll('.file-deletion-dialog').length===1;
    })()`),
      'one exact trusted Files Trash confirmation',
    )
  }
  async function geometry(): Promise<unknown> {
    return ui.inspect(`(() => {
      const menu=document.getElementById('skill-row-menu'),sheet=document.getElementById('skill-task-sheet');
      const node=menu.checkVisibility()?menu:sheet, r=node.getBoundingClientRect();
      const decision=[...node.querySelectorAll('button')].filter(button=>button.checkVisibility());
      if(!node.checkVisibility()||r.left<0||r.right>innerWidth+1||r.bottom>innerHeight+1||node.scrollWidth>node.clientWidth+1)
        throw new Error('Contextual task or menu escapes the guest');
      if(document.querySelector('#skills button button,#skills [role=option]'))throw new Error('Nested row action semantics');
      return {width:innerWidth,height:innerHeight,task:node.id,contained:true,buttons:decision.map(button=>button.textContent.trim())};
    })()`)
  }
}
