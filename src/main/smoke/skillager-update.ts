import type { BrowserWindow } from 'electron'

/** Production review/exposure owners and real Chromium; only the immediate CLI port is synthetic. */
export async function verifySkillagerUpdate(win: BrowserWindow): Promise<void> {
  await win.webContents.executeJavaScript(`(async () => {
    const wait = (read) => new Promise((resolve, reject) => { const until = Date.now() + 30000; const poll = () => { const value = read(); if (value) return resolve(value); if (Date.now() > until) return reject(new Error('Workspace update condition timed out: ' + read.toString())); requestAnimationFrame(poll) }; poll() });
    const button = (scope, label) => [...document.querySelectorAll(scope + ' button')].find((item) => item.textContent.trim() === label);
    const row = () => [...document.querySelectorAll('.skillager-row')].find((item) => item.querySelector('strong')?.textContent === 'Skill 0');
    button('.skillager-sidebar', 'This workspace').click();
    await wait(() => row()?.textContent.includes('Workspace copy behind'));
    row().click();
    await wait(() => button('.skillager-review', 'Review workspace update'));
    if (document.querySelector('.skillager-details').textContent.includes('Preview workspace update')) throw new Error('Update preview appeared before explicit update review');
    button('.skillager-review', 'Review workspace update').click();
    await wait(() => button('.skillager-review', 'Preview workspace update…'));
    await wait(() => document.querySelector('.skillager-review-content .cm-editor'));
    if (!document.querySelector('.skillager-review').textContent.includes('Reviewed workspace version')) throw new Error('Exact workspace diff versions were not disclosed');
    button('.skillager-review', 'Preview workspace update…').click();
    await wait(() => button('.skillager-exposure-dialog', 'Preview changes'));
    if (!document.querySelector('.skillager-exposure-dialog').textContent.includes('Full skill')) throw new Error('Update changed exposure mode');
    button('.skillager-exposure-dialog', 'Preview changes').click();
    await wait(() => button('.skillager-exposure-dialog', 'Confirm exact changes'));
    if (!document.querySelector('.skillager-exposure-dialog').textContent.includes('support.md')) throw new Error('Update omitted supporting file effects');
    button('.skillager-exposure-dialog', 'Confirm exact changes').click();
    await wait(() => document.querySelector('.skillager-exposure-dialog [role=status]')?.textContent.includes('Updated lib/skill-0 for codex'));
    button('.skillager-exposure-dialog', 'Close').click();
    await wait(() => row()?.textContent.includes('native · Current'));
    if (row().textContent.includes('Workspace copy behind')) throw new Error('Completed update retained obsolete badge');
    document.querySelector('.skillager-tab.active .tab-close').click();
    await wait(() => !document.querySelector('.skillager-details'));
    row().click();
    await wait(() => document.querySelector('.skillager-details'));
    if (document.querySelector('.skillager-review-content') || button('.skillager-review', 'Preview workspace update…')) throw new Error('Closing review retained update content or proof');
    if (!document.querySelector('.terminal-container canvas') || !document.querySelector('.viewer-tab:not(.skillager-tab)')) throw new Error('Update displaced terminal or ordinary viewer');
  })()`)
  console.log(
    '[smoke] Skill updates OK (acceptance-triggered authoritative badge; exact source diff; complete preview; mode-preserving explicit update; refreshed badge clearance; review content/proof cleanup; terminal and ordinary viewer preserved)',
  )
}
