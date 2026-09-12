import type { BrowserWindow } from 'electron'
import type { ProjectState } from '../../shared'

export interface SkillagerSmokeProjects {
  readonly local: () => ProjectState
  readonly remote: () => ProjectState
  readonly publish: (state: ProjectState) => void
}

/** Real Chromium/IPC/owners over the existing explicit remote project and CLI fixtures. */
export async function verifySkillagerRemote(
  win: BrowserWindow,
  projects: SkillagerSmokeProjects,
): Promise<void> {
  const evaluate = (body: string) =>
    win.webContents.executeJavaScript(`(async () => {
    const wait = (read) => new Promise((resolve, reject) => { const until = Date.now() + 30000; const poll = () => { const value = read(); if (value) return resolve(value); if (Date.now() > until) return reject(new Error('Remote skill condition timed out: ' + read.toString() + '; ' + document.querySelector('.skillager-exposure-dialog')?.textContent)); requestAnimationFrame(poll) }; poll() });
    const button = (scope, label) => [...document.querySelectorAll(scope + ' button')].find((item) => item.textContent.trim() === label);
    const choose = (label, value) => { const field = document.querySelector('select[aria-label="' + label + '"]'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(field, value); field.dispatchEvent(new Event('change', { bubbles: true })); };
    ${body}
  })()`)
  const local = projects.local(),
    remote = projects.remote()
  projects.publish({ ...local, projects: [...local.projects, ...remote.projects] })
  await evaluate(`
    button('.skillager-sidebar', 'Personal library').click();
    const rows = await wait(() => document.querySelectorAll('.skillager-row').length === 50 && document.querySelectorAll('.skillager-row'));
    rows[2].parentElement.querySelector('.skillager-actions-trigger').click();
    await wait(() => button('[role=menu]', 'Add to project…'));
    button('[role=menu]', 'Add to project…').click();
    await wait(() => document.querySelector('select[aria-label="Destination project"] option[value="smoke-remote-file-project"]'));
    choose('Destination project', 'smoke-remote-file-project');
    await wait(() => document.querySelector('select[aria-label="Discovery mode"] option[value=stub]').disabled);
    if (document.querySelector('select[aria-label="Discovery mode"]').value !== 'native') throw new Error('SSH selected Stub');
    button('.skillager-exposure-dialog', 'Preview changes').click();
    await wait(() => button('.skillager-exposure-dialog', 'Confirm exact changes'));
    const text = document.querySelector('.skillager-exposure-dialog').textContent;
    if (!text.includes('smoke-remote:/srv/hvir') || !text.includes('.hvir-skillager.json') || !text.includes('Not checked on remote host')) throw new Error('Remote identity, record, or prerequisite disclosure missing');
    button('.skillager-exposure-dialog', 'Confirm exact changes').click();
    await wait(() => button('.skillager-exposure-dialog', 'Close'));
    button('.skillager-exposure-dialog', 'Close').click();
  `)
  projects.publish({ ...remote, projects: [...local.projects, ...remote.projects] })
  await evaluate(`
    await wait(() => document.querySelector('#skillager-search-scope option[value=workspace]').disabled);
    button('.skillager-sidebar', 'This workspace').click();
    const row = await wait(() => [...document.querySelectorAll('.skillager-row')].find((item) => item.querySelector('strong')?.textContent === 'Skill 0' && item.textContent.includes('Workspace copy behind')));
    row.click();
    await wait(() => button('.skillager-review', 'Review workspace update'));
    button('.skillager-review', 'Review workspace update').click();
    await wait(() => button('.skillager-review', 'Preview workspace update…'));
    await wait(() => document.querySelector('.skillager-review-content .cm-editor'));
    button('.skillager-review', 'Preview workspace update…').click();
    await wait(() => button('.skillager-exposure-dialog', 'Preview changes'));
    button('.skillager-exposure-dialog', 'Preview changes').click();
    await wait(() => button('.skillager-exposure-dialog', 'Confirm exact changes'));
    if (!document.querySelector('.skillager-exposure-dialog').textContent.includes('smoke-remote:/srv/hvir/.agents/skills/lib-skill-0')) throw new Error('Update lost exact remote destination');
    button('.skillager-exposure-dialog', 'Confirm exact changes').click();
    await wait(() => button('.skillager-exposure-dialog', 'Close'));
    button('.skillager-exposure-dialog', 'Close').click();
    const current = await wait(() => [...document.querySelectorAll('.skillager-row')].find((item) => item.querySelector('strong')?.textContent === 'Skill 0' && item.textContent.includes('Current')));
    current.parentElement.querySelector('.skillager-actions-trigger').click();
    await wait(() => button('[role=menu]', 'Remove workspace copy…'));
    if (!button('[role=menu]', 'Change to Stub…').disabled) throw new Error('Remote mode change remained available');
    button('[role=menu]', 'Remove workspace copy…').click();
    await wait(() => button('.skillager-exposure-dialog', 'Preview changes'));
    button('.skillager-exposure-dialog', 'Preview changes').click();
    await wait(() => button('.skillager-exposure-dialog', 'Confirm exact changes'));
    const removal = document.querySelector('.skillager-exposure-dialog');
    if (!removal.textContent.includes('Remove this verified workspace copy') || removal.querySelector('[aria-label="Remote prerequisites"]')) throw new Error('Remove describes source-consuming effects');
    button('.skillager-exposure-dialog', 'Confirm exact changes').click();
    await wait(() => button('.skillager-exposure-dialog', 'Close'));
    button('.skillager-exposure-dialog', 'Close').click();
  `)
  projects.publish(local)
  await evaluate(`
    button('.skillager-sidebar', 'Personal library').click();
    const row = await wait(() => document.querySelector('.skillager-row'));
    row.click(); await wait(() => document.querySelector('.skillager-tab.active'));
  `)
  console.log(
    '[smoke] SSH skills OK (registered host/worktree selection, Full-only mode, remote effects/prerequisites, verified update diff and explicit update, unchanged-copy removal, host-qualified IPC)',
  )
}
