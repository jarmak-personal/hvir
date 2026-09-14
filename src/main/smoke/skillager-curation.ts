import type { BrowserWindow } from 'electron'
import {
  inspectSkillagerControls,
  clickSkillagerControl,
  skillagerControlPoint,
} from './skillager-settings'
import { captureSkillagerCurationDialog } from './skillager-onboarding'

/** Chromium/IPC evidence for native preparation and the shared named-router action dialog. */
export async function verifySkillagerCuration(win: BrowserWindow): Promise<void> {
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
