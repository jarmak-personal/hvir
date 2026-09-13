import type { BrowserWindow } from 'electron'
import { LocalHost } from '../project-host/local-host'
import { localPath, joinHostPath } from '../../shared/host-path'
import {
  clickSkillagerControl as click,
  inspectSkillagerControls as inspect,
  openSkillagerIntegrations,
  skillagerControlPoint,
} from './skillager-settings'

/** Chromium/input evidence over the labeled setup CLI/picker fixture ports. */
export async function verifySkillagerOnboarding(win: BrowserWindow): Promise<void> {
  await selectSkillagerExecutable(win, '/hvir-smoke/onboarding')
  await inspect(
    win,
    `await wait(() => document.querySelector('.skillager-library-setup'));`,
  )
  await click(win, '.settings-footer button:first-of-type')
  await click(win, '.rail-nav button:last-of-type')
  await inspect(
    win,
    `
    await wait(() => !document.querySelector('.skillager-sidebar').hidden);
    if (!document.querySelector('.skillager-sidebar .skillager-git-choice input').checked)
      throw new Error('Personal Git history was not enabled by default');
    if (document.querySelector('.skillager-row, .skillager-first-skill')) throw new Error('Uninitialized library was connected');
  `,
  )
  await click(win, '.skillager-sidebar .skillager-library-setup > button:first-of-type')
  await inspect(
    win,
    `await wait(() => document.querySelector('.skillager-sidebar .skillager-library-location').textContent === '/hvir-smoke/chosen library');`,
  )
  await captureSkillagerSidebar(win, 'setup')
  await click(win, '.skillager-sidebar .skillager-git-choice input')
  await inspect(
    win,
    `if (document.querySelector('.skillager-sidebar .skillager-git-choice input').checked) throw new Error('Explicit no-Git choice failed');`,
  )
  await click(win, '.skillager-sidebar .skillager-git-choice input')
  await click(win, '.skillager-sidebar .skillager-library-setup > button:last-of-type')
  await inspect(
    win,
    `
    await wait(() => document.querySelector('.skillager-sidebar .skillager-library-setup button:last-of-type')?.textContent.includes('Creating'));
    await wait(() => document.querySelector('.skillager-first-skill'));
    if (!document.querySelector('.viewer-tab:not(.skillager-tab)') || !document.querySelector('.terminal-container canvas')) throw new Error('Setup displaced ordinary work');
  `,
  )
  const at = await skillagerControlPoint(win, '.skillager-sidebar', true)
  win.webContents.sendInputEvent({ type: 'mouseMove', ...at })
  win.webContents.sendInputEvent({
    type: 'mouseWheel',
    ...at,
    deltaX: 0,
    deltaY: -1000,
    canScroll: true,
  })
  await inspect(
    win,
    `try { await wait(() => { const sidebar = document.querySelector('.skillager-sidebar'); return sidebar.scrollTop + sidebar.clientHeight >= sidebar.scrollHeight - 1; }); }
    catch { const sidebar = document.querySelector('.skillager-sidebar'), prompt = document.querySelector('.skillager-first-skill textarea');
      const rect = sidebar.getBoundingClientRect(), promptRect = prompt.getBoundingClientRect(), rail = document.querySelector('.rail-content');
      throw new Error('Guidance scroll geometry: ' + JSON.stringify({ top: sidebar.scrollTop, client: sidebar.clientHeight, total: sidebar.scrollHeight, height: rect.height, overflow: getComputedStyle(sidebar).overflowY, railClient: rail.clientHeight, railTotal: rail.scrollHeight, railTop: rail.scrollTop, promptHit: prompt.contains(document.elementFromPoint(promptRect.x + promptRect.width / 2, promptRect.y + promptRect.height / 2)), promptTop: promptRect.top, promptHeight: promptRect.height, viewport: innerHeight, focused: document.hasFocus() })); }`,
  )
  const prompt = '.skillager-first-skill textarea'
  await click(win, prompt)
  await inspect(
    win,
    `await wait(() => document.activeElement === document.querySelector(${JSON.stringify(prompt)}));`,
  )
  win.webContents.selectAll()
  await inspect(
    win,
    `
    await wait(() => { const prompt = document.querySelector(${JSON.stringify(prompt)}); return prompt.readOnly && prompt.selectionStart === 0 && prompt.selectionEnd === prompt.value.length; });
    if (!document.querySelector(${JSON.stringify(prompt)}).value.includes('/hvir-smoke/chosen library')) throw new Error('First skill prompt uses the wrong library');
  `,
  )
  await skillagerControlPoint(win, prompt)
  await captureSkillagerSidebar(win, 'connected-empty')
  await selectSkillagerExecutable(win, '/hvir-smoke/skillager')
  await inspect(
    win,
    `await wait(() => [...document.querySelectorAll('.skillager-settings button')].some((button) => button.textContent === 'Connect library'));`,
  )
  await click(win, '.settings-footer button:first-of-type')
  console.log(
    '[smoke] Skillager onboarding OK (retained location, folder-port choice, physical Git/create controls, verified direct metadata connection, selectable first-skill guidance, ordinary viewers retained)',
  )
}

export async function selectSkillagerExecutable(
  win: BrowserWindow,
  value: string,
): Promise<void> {
  await openSkillagerIntegrations(win)
  await click(win, '.skillager-settings > details > summary')
  await inspect(
    win,
    `
    const field = document.querySelector('#skillager-executable');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, ${JSON.stringify(value)});
    field.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(requestAnimationFrame);
  `,
  )
  await click(win, '.skillager-executable button')
}

/** Opt-in, cropped, closed-fixture visuals; ordinary tests produce no screenshots. */
export async function captureSkillagerSidebar(
  win: BrowserWindow,
  name: 'setup' | 'connected-empty' | 'project-before' | 'project-ready',
): Promise<void> {
  const directory = process.env.HVIR_SKILLAGER_VISUAL_DIRECTORY
  if (!directory) return
  if (!directory.startsWith('/') || directory === '/')
    throw Error('Expected an explicit capture directory')
  const rect = await inspect<{ x: number; y: number; width: number; height: number }>(
    win,
    `
    const rect = document.querySelector('.tree-panel').getBoundingClientRect();
    return { x: Math.ceil(rect.x), y: Math.ceil(rect.y), width: Math.floor(rect.width), height: Math.floor(rect.height) };
  `,
  )
  const image = await win.webContents.capturePage(rect)
  const host = new LocalHost()
  try {
    await host.writeFile(
      joinHostPath(localPath(directory), 'skillager-' + name + '.png'),
      image.toPNG(),
    )
  } finally {
    await host.dispose()
  }
}
