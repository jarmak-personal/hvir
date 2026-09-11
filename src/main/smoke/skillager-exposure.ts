import type { BrowserWindow } from 'electron'

export async function verifySkillagerExposure(win: BrowserWindow): Promise<void> {
  const evaluate = (body: string): Promise<unknown> =>
    win.webContents.executeJavaScript(`(async () => {
    const wait = (read) => new Promise((resolve, reject) => { const until = Date.now() + 30000; const poll = () => { const value = read(); if (value) return resolve(value); if (Date.now() > until) return reject(new Error('Exposure readiness timed out: ' + read.toString() + '; ' + document.querySelector('.skillager-exposure-dialog')?.textContent)); requestAnimationFrame(poll) }; poll() });
    const button = (scope, label) => [...document.querySelectorAll(scope + ' button')].find((item) => item.textContent.trim() === label);
    const choose = (label, index) => { const field = document.querySelector('select[aria-label="' + label + '"]'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(field, field.options[index].value); field.dispatchEvent(new Event('change', { bubbles: true })); };
    let checkpoint = 'start';
    try { ${body} } catch (error) { throw new Error('Exposure ' + checkpoint + ': ' + error.message); }
  })()`)
  await evaluate(`
    const back = button('.skillager-sidebar', 'Back to browsing'); if (back) back.click();
    button('.skillager-sidebar', 'This workspace').click();
    const row = await wait(() => [...document.querySelectorAll('.skillager-row')].find((item) => item.textContent.includes('native')));
    row.querySelector('strong').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 30, clientY: 100 }));
    await wait(() => button('[role=menu]', 'Change to Stub…'));
    await wait(() => document.activeElement?.getAttribute('role') === 'menuitem' && document.hasFocus());
  `)
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
  await evaluate(
    `await wait(() => !document.querySelector('[aria-label^="Skill actions"]')); if (!document.activeElement.classList.contains('skillager-row')) throw new Error('Context menu did not restore row focus');`,
  )
  win.webContents.sendInputEvent({
    type: 'keyDown',
    keyCode: 'F10',
    modifiers: ['shift'],
  })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'F10', modifiers: ['shift'] })
  await evaluate(`
    await wait(() => button('[role=menu]', 'Change to Stub…'));
    button('[role=menu]', 'Change to Stub…').click();
    await wait(() => button('.skillager-exposure-dialog', 'Preview changes'));
    button('.skillager-exposure-dialog', 'Preview changes').click();
    await wait(() => button('.skillager-exposure-dialog', 'Confirm exact changes'));
    const text = document.querySelector('.skillager-exposure-dialog').textContent;
    if (!text.includes('support.md') || !text.includes('skillager.materialized.yaml') || !text.includes('Incoming accepted source version') || text.includes('fixture-private-exposure-token')) throw new Error('Exposure effect/identity disclosure failed');
    button('.skillager-exposure-dialog', 'Confirm exact changes').click();
    await wait(() => button('.skillager-exposure-dialog', 'Close'));
    button('.skillager-exposure-dialog', 'Close').click();
    await wait(() => [...document.querySelectorAll('.skillager-row')].some((item) => item.textContent.includes('stub')));
    checkpoint = 'remove menu';
    document.querySelector('.skillager-sidebar .skillager-actions-trigger').click();
    await wait(() => button('[role=menu]', 'Remove workspace copy…'));
    button('[role=menu]', 'Remove workspace copy…').click();
    await wait(() => button('.skillager-exposure-dialog', 'Preview changes'));
    button('.skillager-exposure-dialog', 'Preview changes').click();
    await wait(() => button('.skillager-exposure-dialog', 'Confirm exact changes'));
    if (!document.querySelector('.skillager-exposure-dialog').textContent.includes('0755 → absent')) throw new Error('Remove lost target-folder effect');
    button('.skillager-exposure-dialog', 'Confirm exact changes').click();
    await wait(() => button('.skillager-exposure-dialog', 'Close'));
    button('.skillager-exposure-dialog', 'Close').click();
    checkpoint = 'add menu';
    button('.skillager-sidebar', 'Personal library').click();
    const pending = await wait(() => document.querySelector('.skillager-list-controls input[type=checkbox]')); if (pending.checked) pending.click();
    await wait(() => document.querySelectorAll('.skillager-row').length === 50);
    document.querySelector('.skillager-sidebar .skillager-actions-trigger').click();
    await wait(() => button('[role=menu]', 'Add to project…'));
    button('[role=menu]', 'Add to project…').click();
    await wait(() => document.querySelector('select[aria-label="Destination project"]'));
    choose('Destination project', 1);
    await wait(() => !button('.skillager-exposure-dialog', 'Preview changes').disabled);
    if (!document.querySelector('select[aria-label="Destination worktree"]').value) throw new Error('Destination worktree missing');
    button('.skillager-exposure-dialog', 'Preview changes').click();
    await wait(() => button('.skillager-exposure-dialog', 'Confirm exact changes'));
    button('.skillager-exposure-dialog', 'Cancel').click();
    await wait(() => !document.querySelector('.skillager-exposure-dialog'));
    document.querySelector('.skillager-sidebar .skillager-actions-trigger').click();
    await wait(() => document.querySelector('[role=menu]'));
    checkpoint = 'hidden menu';
    button('.rail-nav', 'Files').click();
    await wait(() => !document.querySelector('[role=menu]'));
    button('.rail-nav', 'Skills').click();
  `)
  console.log(
    '[smoke] Skill exposures OK (real IPC; mouse/keyboard menu parity and focus restoration; selected project/worktree; complete effect confirmation; mode change and removal; preview cancellation; hidden-menu cleanup)',
  )
}
