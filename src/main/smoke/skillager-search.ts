import type { BrowserWindow } from 'electron'
import {
  clickSkillagerControl as click,
  inspectSkillagerControls as inspect,
} from './skillager-settings'

/** Chromium controls/IPC and occurrence presentation; CLI ranking has separate public-command evidence. */
export async function verifySkillagerSearch(win: BrowserWindow): Promise<void> {
  await inspect(
    win,
    `
    const field = document.querySelector('#skillager-search-query');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, 'installed-merge');
    field.dispatchEvent(new Event('input', { bubbles: true })); field.focus();
    await wait(() => field.value === 'installed-merge' && !document.querySelector('.skillager-query button').disabled);
  `,
  )
  for (const type of ['keyDown', 'keyUp'] as const)
    win.webContents.sendInputEvent({ type, keyCode: 'Enter' })
  await inspect(
    win,
    `
    await wait(() => document.querySelector('.skillager-query-summary')?.textContent.includes('installed-merge') && document.querySelector('.skillager-search-results')?.textContent.includes('No matching skills to add.'));
    if (!document.querySelector('.skillager-query-summary').textContent.includes('Installed hidden')) throw Error('Default search lost submitted installed policy');
    if (document.querySelector('.skillager-search-advanced').open) throw Error('Advanced opened implicitly');
  `,
  )
  await click(win, '.skillager-search-results .skillager-empty button')
  await inspect(
    win,
    `
    await wait(() => document.querySelectorAll('.skillager-search-results .skillager-row').length === 1 && !document.querySelector('.skillager-search-results [role=status]'));
    const row = document.querySelector('.skillager-search-results .skillager-row');
    if (!row.textContent.includes('Your library') || !row.textContent.includes('Matched in Project original · Claude Code')) throw Error('Canonical representative obscured its matching occurrence');
    if (!document.querySelector('.skillager-query-summary').textContent.includes('Installed included')) throw Error('Explicit Include installed did not update submitted policy');
  `,
  )
  await click(win, '.skillager-search-advanced > summary')
  for (const option of [1, 2]) {
    const selector = `.skillager-search-option:nth-of-type(${option + 2}) input`
    // Native focus scrolls this exact checkbox into its owning Advanced viewport;
    // the actual toggle is delivered by a hit-tested pointer click.
    await inspect(
      win,
      `
      const controls = document.querySelectorAll('.skillager-search-option input');
      controls[${option - 1}].focus();
      await wait(() => document.activeElement === controls[${option - 1}]);
    `,
    )
    await click(win, selector)
  }
  await inspect(
    win,
    `
    const summary = document.querySelector('.skillager-query-summary').textContent;
    if (!summary.includes('One row per known skill') || !summary.includes('Installed included')) throw Error('Draft options relabeled submitted results');
    const field = document.querySelector('#skillager-search-query'); field.focus();
  `,
  )
  for (const type of ['keyDown', 'keyUp'] as const)
    win.webContents.sendInputEvent({ type, keyCode: 'Enter' })
  await inspect(
    win,
    `
    await wait(() => document.querySelectorAll('.skillager-search-results .skillager-row').length === 2 && document.querySelector('.skillager-query-summary').textContent.includes('Separate copies'));
    const rows = [...document.querySelectorAll('.skillager-search-results .skillager-row')];
    if (!rows.some(row => row.textContent.includes('Your library')) || !rows.some(row => row.textContent.includes('Project original · Claude Code'))) throw Error('Concrete occurrences are not visibly distinguished');
  `,
  )
  await click(
    win,
    '.skillager-search-results .skillager-tree-line:nth-child(2) .skillager-row',
  )
  await inspect(
    win,
    `await wait(() => document.querySelector('.skillager-details')?.textContent.includes('Project original · Claude Code'));`,
  )
  await inspect(
    win,
    `document.querySelector('.skillager-search-advanced > summary').focus();`,
  )
  await click(win, '.skillager-search-advanced > summary')
  console.log(
    '[smoke] Skills search OK (controlled metadata fixture; physical Enter and Advanced checkbox clicks; default installed-hidden zero state, explicit Include installed, truthful submitted options, canonical match source and separate native occurrence)',
  )
}
