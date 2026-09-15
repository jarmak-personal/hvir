import { clickSkillagerDetailControl } from './skillager-review'
import type { BrowserWindow } from 'electron'

/** Production review/exposure owners and real Chromium; only the immediate CLI port is synthetic. */
export async function verifySkillagerUpdate(win: BrowserWindow): Promise<void> {
  const evaluate = <T = void>(body: string): Promise<T> =>
    win.webContents.executeJavaScript(`(async () => {
    const wait = (read) => new Promise((resolve, reject) => { const until = Date.now() + 30000; const poll = () => { const value = read(); if (value) return resolve(value); if (Date.now() > until) return reject(new Error('Workspace update condition timed out: ' + read.toString())); requestAnimationFrame(poll) }; poll() });
    const button = (scope, label) => [...document.querySelectorAll(scope + ' button')].find((item) => item.textContent.trim() === label);
    const detail = (name) => [...document.querySelectorAll('.skillager-details dt')].find(item => item.textContent === name)?.nextElementSibling?.textContent.trim();
    const row = () => [...document.querySelectorAll('section[aria-label="In this project"] .skillager-row')].find((item) => item.querySelector('.skillager-name')?.textContent === 'Skill 0');
    ${body}
  })()`) as Promise<T>
  await evaluate(`
    const entry = await wait(() => document.querySelector('section[aria-label="In this project"] [role=treeitem]')); entry.focus(); entry.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    await wait(() => row()?.textContent.includes('Workspace copy behind'));
    row().click();
    await wait(() => document.querySelector('.skillager-secondary'));
    if (document.querySelector('.skillager-secondary').open) throw Error('Ordinary copy selection expanded metadata implicitly');
  `)
  await clickSkillagerDetailControl(win, '.skillager-secondary > summary')
  const selected = await evaluate<{ key: string; destination: string }>(`
    await wait(() => button('.skillager-review', 'Review workspace update'));
    if (document.querySelector('.skillager-details').textContent.includes('Preview workspace update')) throw new Error('Update preview appeared before explicit update review');
    const destination = detail('Destination'), key = row().dataset.skillKey;
    if (!key || !destination?.startsWith('local:') || !destination.endsWith('/.agents/skills/lib-skill-0')) throw Error('Update selection lost its exact local occurrence');
    return { key, destination };
  `)
  await clickSkillagerDetailControl(
    win,
    '.skillager-review button',
    'Review workspace update',
  )
  await evaluate(`
    await wait(() => button('.skillager-review', 'Preview workspace update…'));
    await wait(() => document.querySelector('.skillager-review-content .cm-editor'));
    if (!document.querySelector('.skillager-review').textContent.includes('Reviewed workspace version')) throw new Error('Exact workspace diff versions were not disclosed');
  `)
  await clickSkillagerDetailControl(
    win,
    '.skillager-review button',
    'Preview workspace update…',
  )
  await evaluate(`
    await wait(() => button('.skillager-exposure-dialog', 'Preview changes'));
    if (!document.querySelector('.skillager-exposure-dialog').textContent.includes('Full skill')) throw new Error('Update changed exposure mode');
    button('.skillager-exposure-dialog', 'Preview changes').click();
    await wait(() => button('.skillager-exposure-dialog', 'Confirm exact changes'));
    if (!document.querySelector('.skillager-exposure-dialog').textContent.includes('support.md')) throw new Error('Update omitted supporting file effects');
    button('.skillager-exposure-dialog', 'Confirm exact changes').click();
    await wait(() => document.querySelector('.skillager-exposure-dialog [role=status]')?.textContent.includes('Updated lib/skill-0 for codex'));
    button('.skillager-exposure-dialog', 'Close').click();
    await wait(() => document.querySelector('section[aria-label="In this project"] .skillager-section-refresh')?.getAttribute('aria-busy') === 'false' && row()?.dataset.skillKey === ${JSON.stringify(selected.key)} &&
      row().querySelector('[role=img][aria-label="Installed Full"]') && row().querySelector('[role=img][aria-label="Codex"]') &&
      !row().querySelector('.skillager-status-badge') && detail('Workspace copy') === 'Codex · Full · Current' && detail('Destination') === ${JSON.stringify(selected.destination)});
    document.querySelector('.skillager-tab.active .tab-close').click();
    await wait(() => !document.querySelector('.skillager-details'));
    row().click();
    await wait(() => document.querySelector('.skillager-details'));
    if (document.querySelector('.skillager-review-content') || button('.skillager-review', 'Preview workspace update…')) throw new Error('Closing review retained update content or proof');
    if (!document.querySelector('.terminal-container canvas') || !document.querySelector('.viewer-tab:not(.skillager-tab)')) throw new Error('Update displaced terminal or ordinary viewer');
  `)
  console.log(
    '[smoke] Skill updates OK (acceptance-triggered authoritative badge; separate physical exact-review gesture; complete preview; mode-preserving explicit update; refreshed badge clearance; review content/proof cleanup; terminal and ordinary viewer preserved)',
  )
}
