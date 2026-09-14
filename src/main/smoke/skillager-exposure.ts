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
  const exposureKey = await evaluate(`
    const back = button('.skillager-sidebar', 'Clear search'); if (back) back.click();
    const row = await wait(() => [...document.querySelectorAll('section[aria-label="In this project"] .skillager-row')].find((item) => item.textContent.includes('Full')));
    row.querySelector('.skillager-name').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 30, clientY: 100 }));
    await wait(() => button('[role=menu]', 'Use as stub…'));
    await wait(() => document.activeElement?.getAttribute('role') === 'menuitem' && document.hasFocus());
    return row.dataset.skillKey;
  `)
  if (typeof exposureKey !== 'string' || !exposureKey.startsWith('skillager:copy:'))
    throw Error('Expected an exact managed-copy occurrence for the exposure journey')
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
    await wait(() => button('[role=menu]', 'Use as stub…'));
    button('[role=menu]', 'Use as stub…').click();
    await wait(() => button('.skillager-exposure-dialog', 'Preview changes'));
    button('.skillager-exposure-dialog', 'Preview changes').click();
    await wait(() => button('.skillager-exposure-dialog', 'Confirm exact changes'));
    const text = document.querySelector('.skillager-exposure-dialog').textContent;
    if (!text.includes('support.md') || !text.includes('skillager.materialized.yaml') || !text.includes('Incoming accepted source version') || text.includes('fixture-private-exposure-token')) throw new Error('Exposure effect/identity disclosure failed');
    button('.skillager-exposure-dialog', 'Confirm exact changes').click();
    await wait(() => button('.skillager-exposure-dialog', 'Close'));
    button('.skillager-exposure-dialog', 'Close').click();
    const changed = await wait(() => [...document.querySelectorAll('section[aria-label="In this project"] .skillager-row')].find((item) => item.dataset.skillKey === ${JSON.stringify(exposureKey)} && item.textContent.includes('Stub')));
    checkpoint = 'remove menu';
    changed.closest('.skillager-action-row').querySelector('.skillager-actions-trigger').click();
    await wait(() => button('[role=menu]', 'Remove from this project…'));
    button('[role=menu]', 'Remove from this project…').click();
    await wait(() => button('.skillager-exposure-dialog', 'Preview changes'));
    button('.skillager-exposure-dialog', 'Preview changes').click();
    await wait(() => button('.skillager-exposure-dialog', 'Confirm exact changes'));
    if (!document.querySelector('.skillager-exposure-dialog').textContent.includes('0755 → absent')) throw new Error('Remove lost target-folder effect');
    button('.skillager-exposure-dialog', 'Confirm exact changes').click();
    await wait(() => button('.skillager-exposure-dialog', 'Close'));
    button('.skillager-exposure-dialog', 'Close').click();
    checkpoint = 'add menu';
    const pending = await wait(() => document.querySelector('.skillager-pending-filter input[type=checkbox]')); if (pending.checked) pending.click();
    await wait(() => document.querySelector('section[aria-label="Your library"] .skillager-row'));
    document.querySelector('section[aria-label="Your library"] .skillager-actions-trigger').click();
    await wait(() => button('[role=menu]', 'Add to this project…'));
    button('[role=menu]', 'Add to this project…').click();
    await wait(() => document.querySelector('select[aria-label="Destination project"]'));
    choose('Destination project', 1);
    await wait(() => !button('.skillager-exposure-dialog', 'Preview changes').disabled);
    if (!document.querySelector('select[aria-label="Destination worktree"]').value) throw new Error('Destination worktree missing');
    button('.skillager-exposure-dialog', 'Preview changes').click();
    await wait(() => button('.skillager-exposure-dialog', 'Confirm exact changes'));
    button('.skillager-exposure-dialog', 'Cancel').click();
    await wait(() => !document.querySelector('.skillager-exposure-dialog'));
  `)
  for (const cancellation of ['Cancel', 'Escape']) {
    await evaluate(`
      checkpoint = 'cancel preparing preview';
      document.querySelector('section[aria-label="Your library"] .skillager-actions-trigger').click();
      await wait(() => button('[role=menu]', 'Add to this project…'));
      button('[role=menu]', 'Add to this project…').click();
      await wait(() => document.querySelector('select[aria-label="Destination project"]'));
      choose('Destination project', 1);
      await wait(() => !button('.skillager-exposure-dialog', 'Preview changes').disabled);
      button('.skillager-exposure-dialog', 'Preview changes').click();
      await wait(() => document.querySelector('.skillager-exposure-dialog [role=status]')?.textContent.includes('Preparing complete preview'));
      if (button('.skillager-exposure-dialog', 'Cancel').disabled) throw new Error('Read-only preparation disabled Cancel');
    `)
    if (cancellation === 'Escape') {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
    } else await evaluate(`button('.skillager-exposure-dialog', 'Cancel').click();`)
    await evaluate(`
      checkpoint = 'late cancelled preview';
      await wait(() => !document.querySelector('.skillager-exposure-dialog'));
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (document.querySelector('.skillager-exposure-dialog')) throw new Error('Cancelled preview reappeared');
    `)
  }
  await evaluate(`
    document.querySelector('section[aria-label="Your library"] .skillager-actions-trigger').click();
    await wait(() => document.querySelector('[role=menu]'));
    checkpoint = 'hidden menu';
    button('.rail-nav', 'Files').click();
    await wait(() => !document.querySelector('[role=menu]'));
    button('.rail-nav', 'Skills').click();
  `)
  console.log(
    '[smoke] Skill exposures OK (real IPC; mouse/keyboard menu parity and focus restoration; selected project/worktree; complete effect confirmation; mode change and removal; preparing-preview Cancel/Escape and late-result revocation; hidden-menu cleanup)',
  )
}
