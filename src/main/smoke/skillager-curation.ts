import { SKILLAGER_PENDING_FILES_FIXTURE } from './skillager-project-fixture'
import { LocalHost } from '../project-host/local-host'
import { joinHostPath, type HostPath } from '../../shared/host-path'
import type { BrowserWindow } from 'electron'
import {
  inspectSkillagerControls,
  clickSkillagerControl,
  skillagerControlPoint,
} from './skillager-settings'
import { captureSkillagerCurationDialog } from './skillager-onboarding'

/** Chromium/IPC evidence for native preparation and the shared named-router action dialog. */
export async function verifySkillagerCuration(
  win: BrowserWindow,
  root: HostPath,
): Promise<void> {
  await verifyPendingFolderHandoff(win, root)
  const inspect = (source: string) =>
    inspectSkillagerControls(
      win,
      `
    const button = (scope, text) => [...document.querySelectorAll(scope + ' button')].find(item => item.textContent.trim() === text);
    ${source}
  `,
    )
  await inspect(`
    const tree = document.querySelector('section[aria-label="In this project"] [role=tree]'); tree.scrollTop = 0;
    const original = await wait(() => [...document.querySelectorAll('section[aria-label="In this project"] .skillager-row')].find(row => row.textContent.includes('Observed project skill 4')));
    original.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 180 }));
    await wait(() => button('[role=menu]', 'Stub…'));
    button('[role=menu]', 'Stub…').click();
    await wait(() => document.querySelector('.skillager-exposure-dialog [role=status]')?.textContent.includes('Preparing'));
    if (button('.skillager-exposure-dialog', 'Cancel').disabled) throw Error('Native metadata preparation disabled cancellation');
  `)
  for (const type of ['keyDown', 'keyUp'] as const)
    win.webContents.sendInputEvent({ type, keyCode: 'Escape' })
  await inspect(`
    await wait(() => !document.querySelector('.skillager-exposure-dialog'));
    const row = await wait(() => document.querySelector('section[aria-label="Your library"] .skillager-row')); row.click();
    await wait(() => document.querySelector('.skillager-details .skillager-actions-trigger'));
    document.querySelector('.skillager-details .skillager-actions-trigger').click();
    await wait(() => button('[role=menu]', 'Group in router…'));
    button('[role=menu]', 'Group in router…').click();
    const name = await wait(() => { const field = document.querySelector('[aria-label="New router name"]'); return field && !field.disabled && field; });
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(name, 'Smoke guidance'); name.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(() => name.value === 'Smoke guidance');
  `)
  await captureSkillagerCurationDialog(win, 'curation-choice')
  await inspect(`
    button('.skillager-exposure-dialog', 'Preview changes').click();
    await wait(() => button('.skillager-exposure-dialog', 'Confirm exact changes'));
    const dialog = document.querySelector('.skillager-exposure-dialog');
    for (const text of ['Confirmed router membership', 'Selected source versions', 'Complete project effects', 'tags.json', 'skillager.materialized.yaml']) {
      if (!(text === 'Confirmed router membership' ? dialog.querySelector('[aria-label="' + text + '"]') : dialog.textContent.includes(text))) throw Error('Curation disclosure missing: ' + text);
    }
    if (dialog.textContent.includes('fixture-private-curation-token')) throw Error('Private confirmation token reached the renderer');
    const bounds = dialog.getBoundingClientRect(), footer = dialog.querySelector('.dialog-actions').getBoundingClientRect();
    if (bounds.left < 0 || bounds.top < 0 || bounds.right > innerWidth || bounds.bottom > innerHeight || footer.bottom > bounds.bottom || footer.top < bounds.top) throw Error('Curation dialog/footer exceeds viewport');
  `)
  const confirm = '.skillager-exposure-dialog .confirmation-action-primary'
  await skillagerControlPoint(win, confirm)
  await captureSkillagerCurationDialog(win, 'curation-preview')
  await clickSkillagerControl(win, confirm)
  await inspect(`
    await wait(() => document.querySelector('[aria-label="Actual project outcomes"]'));
    button('.skillager-exposure-dialog', 'Close').click();
    const router = await wait(() => [...document.querySelectorAll('section[aria-label="In this project"] .skillager-row')].find(row => row.textContent.includes('smoke-guidance')));
    router.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 180 }));
    await wait(() => button('[role=menu]', 'Remove from this project…'));
    button('[role=menu]', 'Remove from this project…').click();
    await wait(() => button('.skillager-exposure-dialog', 'Preview changes'));
    button('.skillager-exposure-dialog', 'Preview changes').click();
    await wait(() => button('.skillager-exposure-dialog', 'Confirm exact changes'));
    if (!document.querySelector('.skillager-exposure-dialog').textContent.includes('curated tag is retained')) throw Error('Router Remove lost retained-tag disclosure');
    button('.skillager-exposure-dialog', 'Confirm exact changes').click();
    await wait(() => button('.skillager-exposure-dialog', 'Close'));
    button('.skillager-exposure-dialog', 'Close').click();
  `)
  console.log(
    '[smoke] Skill curation OK (native read-only preparation Escape; details-menu grouping; editable router name; complete member/source/tag/file effects; actual outcomes; target-owned router removal; private token retained in main)',
  )
}

/** The native fixture folder belongs to the existing disposable smoke project root. */
async function verifyPendingFolderHandoff(
  win: BrowserWindow,
  root: HostPath,
): Promise<void> {
  if (root.hostId !== 'local') throw new Error('Expected local closed fixture')
  const host = new LocalHost(),
    folder = joinHostPath(root, SKILLAGER_PENDING_FILES_FIXTURE.relativePath)
  const body =
    '---\nname: pending-original\ndescription: Pending removal navigation fixture.\n---\n\nKeep this unapproved original.\n'
  const support = 'Unapproved supporting material remains intact.\n'
  try {
    const created = await host.exec('/bin/mkdir', ['-p', '--', folder.path], {
      signal: AbortSignal.timeout(5000),
      maxBuffer: 1024,
    })
    if (created.code !== 0) throw new Error('Could not prepare pending Files fixture')
    await host.writeFile(joinHostPath(folder, 'SKILL.md'), body)
    await host.writeFile(joinHostPath(folder, 'support.txt'), support)
    await inspectSkillagerControls(
      win,
      `
      const tree = document.querySelector('section[aria-label="In this project"] [role=tree]'); tree.scrollTop = 0;
      const pending = await wait(() => [...document.querySelectorAll('section[aria-label="In this project"] .skillager-row')].find(row => row.textContent.includes(${JSON.stringify(SKILLAGER_PENDING_FILES_FIXTURE.name)})));
      if (!pending.textContent.includes('Pending review')) throw Error('Files handoff did not start from a pending original');
      pending.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 180 }));
      const action = await wait(() => [...document.querySelectorAll('[role=menuitem]')].find(item => item.textContent === 'Remove in Files…'));
      if (action.disabled) throw Error('Pending original Files action unavailable');
      action.click();
      const selected = await wait(() => [...document.querySelectorAll('[data-file-path][aria-selected="true"]')].find(item => item.dataset.filePath === ${JSON.stringify(folder.path)} && item.dataset.fileHost === 'local'));
      await wait(() => document.activeElement === selected && [...document.querySelectorAll('.rail-nav button')].some(item => item.textContent === 'Files' && item.getAttribute('aria-current') === 'page') && !document.querySelector('.skillager-exposure-dialog'));
      if (selected.dataset.fileType !== 'dir') throw Error('Files handoff changed entry kind');
      [...document.querySelectorAll('.rail-nav button')].find(item => item.textContent === 'Skills').click();
      await wait(() => !document.querySelector('.skillager-sidebar').hidden);
      const original = await wait(() => [...document.querySelectorAll('section[aria-label="In this project"] .skillager-row')].find(row => row.textContent.includes(${JSON.stringify(SKILLAGER_PENDING_FILES_FIXTURE.name)})));
      if (!original.textContent.includes('Pending review')) throw Error('Files handoff changed approval');
    `,
    )
    if (
      (await host.stat(folder)).type !== 'dir' ||
      (await host.readFile(joinHostPath(folder, 'SKILL.md'))).toString() !== body ||
      (await host.readFile(joinHostPath(folder, 'support.txt'))).toString() !== support
    )
      throw new Error('Files handoff removed or changed pending original material')
    console.log(
      '[smoke] Pending skill Files handoff OK (exact host-qualified folder selected/focused; action closed; pending approval and original/support bytes retained; separate Files deletion untouched)',
    )
  } finally {
    await host.dispose()
  }
}
