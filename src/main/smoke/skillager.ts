import { verifySkillagerOnboarding } from './skillager-onboarding'
import { verifySkillagerProject } from './skillager-project'
import {
  enableSkillagerInSettings,
  disableAndReenableSkillagerInSettings,
} from './skillager-settings'
import { verifySkillagerUpdate } from './skillager-update'
import { verifySkillagerExposure } from './skillager-exposure'
import { verifySkillagerReview } from './skillager-review'
import { app, type BrowserWindow } from 'electron'
import type { PtySupervisor } from '../pty/pty-supervisor'
import { prepareTerminalScenario } from './terminal-scenario-ready'
import { verifySkillagerRemote } from './skillager-remote'
import type { createSmokeProjectState } from './project-state-fixture'
import type { EmitRendererEvent } from '../ipc/deps'

export async function verifySkillagerScenario(
  win: BrowserWindow,
  supervisor: PtySupervisor,
  projects: Pick<
    ReturnType<typeof createSmokeProjectState>,
    'base' | 'remoteFiles' | 'set'
  >,
  emit: EmitRendererEvent,
): Promise<void> {
  app.focus({ steal: true })
  win.focus()
  win.webContents.focus()
  await prepareTerminalScenario(win, supervisor)
  const terminal = supervisor.list().find((item) => item.ownerId === win.webContents.id)!
  let output = ''
  const detach = supervisor.attach(terminal.id, terminal.ownerId, {
    onData: (value) => {
      output = (output + value).slice(-4096)
    },
    onExit: () => undefined,
  })
  const evaluate = <T>(source: string): Promise<T> =>
    win.webContents.executeJavaScript(`(async () => {
    const wait = (read) => new Promise((resolve, reject) => {
      const deadline = Date.now() + 30000;
      const poll = () => { const value = read(); if (value) return resolve(value); if (Date.now() > deadline) return reject(new Error('Skillager smoke condition timed out: ' + read.toString() + '; status=' + JSON.stringify({ rows: document.querySelectorAll('.skillager-row').length, focused: document.hasFocus(), visibility: document.visibilityState, selected: document.querySelector('.rail-nav [aria-current]')?.textContent, sidebar: document.querySelector('.skillager-sidebar')?.textContent?.slice(0, 1000) }))); requestAnimationFrame(poll); }; poll();
    });
    const button = (scope, text) => [...document.querySelectorAll(scope + ' button')].find((item) => item.textContent.trim() === text);
    const setInput = (input, text) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, text); input.dispatchEvent(new Event('input', { bubbles: true })); };
    ${source}
  })()`) as Promise<T>
  const typeInTerminal = (text: string): void => {
    for (const keyCode of text) {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode })
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode })
    }
    for (const type of ['keyDown', 'keyUp'] as const)
      win.webContents.sendInputEvent({ type, keyCode: 'U', modifiers: ['control'] })
  }
  try {
    await evaluate(`await wait(() => document.hasFocus());`)
    await evaluate(`
      if (button('.rail-nav', 'Skills') || document.querySelector('.skillager-sidebar')) throw new Error('Disabled Skillager leaked into the workbench');
      const file = await wait(() => document.querySelector('.file-row'));
      file.click();
      await wait(() => document.querySelector('.viewer-tab:not(.skillager-tab)'));
    `)
    await enableSkillagerInSettings(win)
    if (!process.env.HVIR_SKILLAGER_SMOKE_FIXTURE) await verifySkillagerOnboarding(win)
    await evaluate(`
      button('.rail-nav', 'Skills').click();
      await wait(() => !document.querySelector('.skillager-sidebar').hidden);
      button('.skillager-sidebar', 'Connect library').click();
      await wait(() => document.querySelectorAll('.skillager-row').length === 50);
      button('.skillager-sidebar', 'Next 50').click();
      await wait(() => document.querySelector('[aria-label="Library page"]').textContent.includes('51–100'));
      if (document.querySelectorAll('.skillager-row').length !== 50) throw new Error('Browsing expanded the DOM window');
      document.querySelector('.skillager-row').click();
      await wait(() => document.querySelector('.skillager-details'));
      if (!document.querySelector('.viewer-tab:not(.skillager-tab)') || !document.querySelector('.terminal-container canvas')) throw new Error('Skill selection displaced the document or terminal');
      document.querySelector('.viewer-tab:not(.skillager-tab) .tab-main').click();
      await wait(() => !document.querySelector('.skillager-details'));
      const field = document.querySelector('#skillager-search-query'); setInput(field, 'deadlockneedle'); field.focus();
      await new Promise(requestAnimationFrame);
    `)
    // Real keyboard Enter submits the query through the production form/hook/IPC owner.
    await evaluate(
      `const field = document.querySelector('#skillager-search-query'); field.focus(); await wait(() => document.activeElement === field && !document.querySelector('.skillager-search button[type=submit]').disabled);`,
    )
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
    win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
    const firstStarted = performance.now()
    await evaluate(`
      await wait(() => document.querySelector('.skillager-sidebar [role="status"]')?.textContent.includes('Searching'));
      const field = document.querySelector('#skillager-search-query');
      setInput(field, 'amberneedle');
      await new Promise(requestAnimationFrame);
      if (field.value !== 'amberneedle') throw new Error('Typing was blocked during search');
      document.querySelector('.viewer-tab:not(.skillager-tab) .tab-main').click();
      document.querySelector('.terminal-engine-host').focus();
    `)
    typeInTerminal('HVIRSKILLS')
    const first = await evaluate<{ frames: number; maxGapMs: number }>(`
      let previous = performance.now(), maxGapMs = 0, frames = 0;
      await wait(() => {
        const now = performance.now(); maxGapMs = Math.max(maxGapMs, now - previous); previous = now; frames++;
        return !document.querySelector('.skillager-sidebar [role="status"]') && document.querySelectorAll('.skillager-row').length === 1;
      });
      const row = document.querySelector('.skillager-row');
      if (!row.textContent.toLowerCase().includes('body')) throw new Error('Body match reason missing');
      row.click();
      await wait(() => document.querySelector('.skillager-details'));
      return { frames, maxGapMs };
    `)
    const firstMs = performance.now() - firstStarted
    if (!output.toLowerCase().includes('hvirskills'))
      throw new Error('Terminal did not accept input while searching')
    const warmStarted = performance.now()
    await evaluate(`
      document.querySelector('.skillager-search').requestSubmit();
      await wait(() => document.querySelector('.skillager-sidebar [role="status"]')?.textContent.includes('Searching'));
      const field = document.querySelector('#skillager-search-query'); setInput(field, 'cobaltneedle');
      await new Promise(requestAnimationFrame);
      if (field.value !== 'cobaltneedle') throw new Error('Typing was blocked during warm search');
      document.querySelector('.viewer-tab:not(.skillager-tab) .tab-main').click();
      await wait(() => !document.querySelector('.skillager-details'));
      document.querySelector('.terminal-engine-host').focus();
    `)
    typeInTerminal('HVIRWARM')
    const warm = await evaluate<{ frames: number; maxGapMs: number }>(`
      let previous = performance.now(), maxGapMs = 0, frames = 0;
      await wait(() => {
        const now = performance.now(); maxGapMs = Math.max(maxGapMs, now - previous); previous = now; frames++;
        return !document.querySelector('.skillager-sidebar [role="status"]') && document.querySelectorAll('.skillager-row').length === 1;
      });
      if (!document.querySelector('.skillager-row').textContent.toLowerCase().includes('amberneedle')) throw new Error('Replacement query result missing');
      document.querySelector('.skillager-row').click();
      await wait(() => document.querySelector('.skillager-details'));
      return { frames, maxGapMs };
    `)
    const warmMs = performance.now() - warmStarted
    if (!output.toLowerCase().includes('hvirwarm'))
      throw new Error('Terminal did not accept input during warm search')
    await verifySkillagerReview(win)
    if (!process.env.HVIR_SKILLAGER_SMOKE_FIXTURE) {
      await verifySkillagerUpdate(win)
      await verifySkillagerExposure(win)
      await verifySkillagerRemote(win, {
        local: projects.base,
        remote: projects.remoteFiles,
        publish: (state) => emit('project:state', projects.set(state)),
      })
    }
    await evaluate(`
      const field = document.querySelector('#skillager-search-query'); setInput(field, 'obsolete');
      await new Promise(requestAnimationFrame); document.querySelector('.skillager-search').requestSubmit();
      await wait(() => document.querySelector('.skillager-sidebar [role="status"]')?.textContent.includes('Searching'));
      button('.rail-nav', 'Files').click();
      document.querySelector('.skillager-tab.active .tab-close').click();
      await wait(() => !document.querySelector('.skillager-details'));
    `)
    if (!process.env.HVIR_SKILLAGER_SMOKE_FIXTURE)
      await verifySkillagerProject(win, supervisor)
    await disableAndReenableSkillagerInSettings(win)
    console.log(
      `[smoke] Skills OK (${process.env.HVIR_SKILLAGER_SMOKE_FIXTURE ? 'real CLI, fresh search cache' : 'delayed fixture'}; 5,000 rows; 50 visible; first ${firstMs.toFixed(0)}ms/${first.frames} frames/${first.maxGapMs.toFixed(1)}ms maximum gap; warm ${warmMs.toFixed(0)}ms/${warm.frames} frames/${warm.maxGapMs.toFixed(1)}ms maximum gap; typing, document navigation and terminal input during both searches; cancellation, disable)`,
    )
  } finally {
    await detach()
  }
}
