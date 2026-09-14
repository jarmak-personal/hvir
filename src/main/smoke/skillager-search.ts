import type { BrowserWindow } from 'electron'
import { captureSkillagerSidebar } from './skillager-onboarding'
import {
  clickSkillagerControl as click,
  inspectSkillagerControls as inspect,
} from './skillager-settings'

/** Chromium controls/IPC and occurrence presentation; CLI ranking has separate public-command evidence. */
export async function verifySkillagerSearch(win: BrowserWindow): Promise<void> {
  const submit = (): void => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
    win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
  }
  await inspect(
    win,
    `
    const field = document.querySelector('#skillager-search-query');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, 'installed-merge');
    field.dispatchEvent(new Event('input', { bubbles: true })); field.focus();
    await wait(() => document.activeElement === field && field.value === 'installed-merge' && !document.querySelector('.skillager-query button').disabled);
  `,
  )
  submit()
  await inspect(
    win,
    `
    const state = () => ({
      focused: document.activeElement === document.querySelector('#skillager-search-query'),
      inputMatches: document.querySelector('#skillager-search-query')?.value === 'installed-merge',
      submitted: !!document.querySelector('.skillager-query-summary')?.textContent.includes('installed-merge'),
      installedHidden: !!document.querySelector('.skillager-query-summary')?.textContent.includes('Installed hidden'),
      searching: !!document.querySelector('.skillager-search-results [role=status]'),
      rows: document.querySelectorAll('.skillager-search-results .skillager-row').length,
      noMatching: !!document.querySelector('.skillager-search-results')?.textContent.includes('No matching skills to add.'),
    });
    try { await wait(() => state().submitted); }
    catch { throw Error('Search query submission did not complete: ' + JSON.stringify(state())); }
    try { await wait(() => state().noMatching && !state().searching); }
    catch { throw Error('Submitted search did not reach the expected zero state: ' + JSON.stringify(state())); }
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
    if (!row.textContent.includes('Your library') || !row.textContent.includes('Matched in Project · Claude Code')) throw Error('Canonical representative obscured its matching occurrence');
    if (!document.querySelector('.skillager-query-summary').textContent.includes('Installed included')) throw Error('Explicit Include installed did not update submitted policy');
  `,
  )
  await verifySearchRowGeometry(win, 1)
  await captureSkillagerSidebar(win, 'search-grouped')
  await click(win, '.skillager-search-advanced > summary')
  for (const option of [1, 2]) {
    const selector = `.skillager-search-option:nth-of-type(${option + 2}) input`
    // Native focus scrolls this exact checkbox into its owning Advanced viewport;
    // the actual toggle is delivered by a hit-tested pointer click.
    await inspect(
      win,
      `
      const controls = document.querySelectorAll('.skillager-search-option input');
      const control = controls[${option - 1}];
      const state = () => ({
        open: !!document.querySelector('.skillager-search-advanced')?.open,
        width: control.getBoundingClientRect().width,
        height: control.getBoundingClientRect().height,
        focused: document.activeElement === control,
        activeTag: document.activeElement?.tagName,
        activeType: document.activeElement instanceof HTMLInputElement ? document.activeElement.type : undefined,
      });
      try {
        await wait(() => state().open && state().width > 0 && state().height > 0);
        control.focus();
        await wait(() => state().focused);
      } catch { throw Error('Advanced checkbox readiness failed: ' + JSON.stringify(state())); }
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
    await wait(() => document.activeElement === field);
  `,
  )
  submit()
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
  await inspect(
    win,
    `await wait(() => !document.querySelector('.skillager-search-advanced').open);`,
  )
  await verifySearchRowGeometry(win, 2)
  await captureSkillagerSidebar(win, 'search-copies')
  console.log(
    '[smoke] Skills search OK (controlled metadata fixture; physical Enter and Advanced checkbox clicks; default installed-hidden zero state, explicit Include installed, truthful submitted options, unclipped selected/matching source lines at the narrow rail and separate native occurrence)',
  )
}

/** Layout proof stays in Chromium; the tree owner tests range and keyboard math. */
async function verifySearchRowGeometry(
  win: BrowserWindow,
  expectedRows: number,
): Promise<void> {
  const geometry = await inspect(
    win,
    `
    const tree = document.querySelector('.skillager-search-results .skillager-tree');
    const viewport = tree.getBoundingClientRect();
    const rows = [...tree.querySelectorAll('.skillager-search-row')];
    const geometry = rows.map(row => {
      const bounds = row.getBoundingClientRect();
      const lines = [...row.querySelectorAll('.skillager-search-context, .skillager-search-match')].map(line => {
        const rect = line.getBoundingClientRect();
        const range = document.createRange(); range.selectNodeContents(line);
        const text = range.getBoundingClientRect();
        return {
          kind: line.classList.contains('skillager-search-match') ? 'match' : 'selected',
          width: rect.width, height: rect.height,
          complete: line.scrollWidth <= line.clientWidth && text.left >= rect.left - 1 && text.right <= rect.right + 1,
          contained: text.top >= bounds.top - 1 && text.bottom <= bounds.bottom + 1 && rect.left >= bounds.left && rect.right <= bounds.right,
        };
      });
      return {
        height: bounds.height,
        visible: bounds.top >= viewport.top - 1 && bounds.bottom <= viewport.bottom + 1,
        lines,
      };
    });
    const state = { viewportWidth: viewport.width, rows: geometry };
    if (rows.length !== ${expectedRows} || viewport.width > 300 || !geometry.every(row =>
      row.height === 56 && row.visible && row.lines.length > 0 && row.lines.every(line =>
        line.width > 0 && line.height === 16 && line.complete && line.contained)))
      throw Error('Search occurrence labels are clipped: ' + JSON.stringify(state));
    return state;
  `,
  )
  console.log('[smoke] Skills search row geometry ' + JSON.stringify(geometry))
}
