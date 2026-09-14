import type { BrowserWindow } from 'electron'
import { SKILLAGER_PROJECT_FIXTURE_ROWS } from './skillager-project-fixture'
import {
  captureSkillagerSidebar,
  selectSkillagerExecutable,
} from './skillager-onboarding'
import {
  clickSkillagerControl as click,
  inspectSkillagerControls as inspect,
  skillagerControlPoint,
} from './skillager-settings'

const library = 'section[aria-label="Your library"]'
const project = 'section[aria-label="In this project"]'

/** Physical scroll/keyboard delivery proves the semantic window and independently reachable headers. */
export async function verifySkillagerExplorer(win: BrowserWindow): Promise<void> {
  await inspect(
    win,
    `
    await wait(() => document.querySelector('${library} .skillager-row'));
    if (document.querySelector('.skillager-search-disclosure').open || document.querySelector('.skillager-search-advanced').open) throw Error('Search and Advanced must start collapsed');
    if (document.querySelector('#skillager-agent').value !== 'all') throw Error('Browsing did not default to All agents');
    if (!document.querySelector('${library} .skillager-section-header').textContent.includes('5000')) throw Error('Complete library inventory count missing');
  `,
  )
  await click(win, `${library} .skillager-row`)
  await inspect(win, `document.querySelector('${library} [role=treeitem]').focus();`)
  for (const type of ['keyDown', 'keyUp'] as const)
    win.webContents.sendInputEvent({ type, keyCode: 'End' })
  await inspect(
    win,
    `
    await wait(() => { const tree = document.querySelector('${library} [role=tree]'); return tree.scrollTop + tree.clientHeight >= tree.scrollHeight - 1 && document.activeElement === [...tree.querySelectorAll('[role=treeitem]')].at(-1); });
    const tree = document.querySelector('${library} [role=tree]');
    if (tree.querySelectorAll('[role=treeitem]').length > Math.ceil(tree.clientHeight / 25) + 6) throw Error('Library DOM grew with inventory');
    if (tree.scrollHeight !== 125000) throw Error('Library scroll range lost metadata');
    document.activeElement.click();
    await wait(() => document.querySelector('.skillager-details'));
  `,
  )
  const controlledProject = !process.env.HVIR_SKILLAGER_SMOKE_FIXTURE
  if (controlledProject)
    await inspect(
      win,
      `await wait(() => {
      const section = document.querySelector('${project}'), tree = section?.querySelector('[role=tree]');
      return section?.querySelector('.skillager-section-header small')?.textContent.trim() === '${SKILLAGER_PROJECT_FIXTURE_ROWS + 2}' && tree && tree.clientHeight > 0 && tree.scrollHeight > tree.clientHeight;
    });`,
    )
  const scrollable = await inspect<boolean>(
    win,
    `
    const tree = document.querySelector('${project} [role=tree]'); return Boolean(tree && tree.scrollHeight > tree.clientHeight);
  `,
  )
  if (controlledProject && !scrollable)
    throw Error(
      'Controlled project metadata lost its expected scroll range before wheel input',
    )
  if (scrollable) {
    const at = await skillagerControlPoint(win, `${project} [role=tree]`)
    win.webContents.sendInputEvent({ type: 'mouseMove', ...at })
    win.webContents.sendInputEvent({
      type: 'mouseWheel',
      ...at,
      deltaX: 0,
      deltaY: -5000,
      canScroll: true,
    })
    await inspect(
      win,
      `await wait(() => document.querySelector('${project} [role=tree]').scrollTop > 0);`,
    )
  }
  await skillagerControlPoint(
    win,
    `${project} .skillager-section-header button:first-child`,
  )
  await skillagerControlPoint(
    win,
    `${library} .skillager-section-header button:first-child`,
  )
  await captureSkillagerSidebar(win, 'explorer')
  console.log(
    '[smoke] Skills explorer OK (5000 complete library rows; physical End; independently hit-testable project/library headers; bounded DOM and 125000px actual library scroll range; stable detail; project wheel: ' +
      (scrollable
        ? 'physical input over observed overflowing tree'
        : 'not exercised: real CLI project did not provide a long tree') +
      ')',
  )
}

/** Same production tree and IPC owner, with a bounded explicitly named metadata-capacity fixture. */
export async function verifySkillagerExpansionCapacity(
  win: BrowserWindow,
): Promise<void> {
  await selectSkillagerExecutable(win, '/hvir-smoke/explorer-capacity')
  await inspect(
    win,
    `await wait(() => document.querySelector('.skillager-settings .skillager-connection button')?.textContent === 'Connect library');`,
  )
  await click(win, '.settings-footer button:first-of-type')
  await click(win, '.rail-nav button:last-of-type')
  await click(win, '.skillager-connection button:first-of-type')
  await inspect(
    win,
    `await wait(() => document.querySelector('${project} [role=treeitem]')); document.querySelector('${project} [role=treeitem]').focus();`,
  )
  const key = (keyCode: string): void => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode })
    if (keyCode === 'Enter')
      win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode })
  }
  key('End')
  await capacityGroupFocused(win, 8)
  for (let step = 8; step > 0; step--) {
    key('Up')
    await capacityGroupFocused(win, step - 1)
  }
  for (let index = 0; index < 8; index++) {
    key('Right')
    await inspect(
      win,
      `await wait(() => document.activeElement?.getAttribute('aria-expanded') === 'true');`,
    )
    if (index < 7) {
      key('End')
      await capacityGroupFocused(win, 8)
      for (let step = 8; step > index + 1; step--) {
        key('Up')
        await capacityGroupFocused(win, step - 1)
      }
    }
  }
  await inspect(
    win,
    `const tree = document.querySelector('${project} [role=tree]'); if (tree.scrollHeight !== 1000000) throw Error('Expanded browser scroll range did not reach the supported 1Mpx boundary'); if (tree.querySelectorAll('[role=treeitem]').length > Math.ceil(tree.clientHeight /25)+6) throw Error('Expanded DOM exceeded its viewport');`,
  )
  key('End')
  await capacityGroupFocused(win, 8)
  key('Right')
  await inspect(
    win,
    `await wait(() => document.querySelector('${project} [role=status]')?.textContent.includes('Collapse another skill')); if (document.activeElement?.getAttribute('aria-expanded') !== 'false') throw Error('Rejected group expanded partially');`,
  )
  key('Up')
  await inspect(
    win,
    `await wait(() => document.querySelector('${project} [role=tree]')?.contains(document.activeElement) && document.activeElement?.getAttribute('aria-level') === '2');`,
  )
  key('Enter')
  await inspect(
    win,
    `await wait(() => document.querySelector('.skillager-details')?.textContent.includes('Router member'));`,
  )
  key('Left')
  await capacityGroupFocused(win, 7)
  key('Left')
  await inspect(
    win,
    `await wait(() => document.activeElement?.getAttribute('aria-expanded') === 'false'); if (!document.querySelector('.skillager-details')) throw Error('Collapsing router lost its open member detail');`,
  )
  console.log(
    '[smoke] Skills expansion OK (actual 1,000,000px/40,000-row range; bounded mounted window; whole-group refusal; physical End/member selection and collapse retain detail)',
  )
}

async function capacityGroupFocused(win: BrowserWindow, index: number): Promise<void> {
  await inspect(
    win,
    `try {
    await wait(() => {
      const row = document.activeElement, tree = document.querySelector('${project} [role=tree]');
      return tree?.contains(row) && row?.getAttribute('role') === 'treeitem' && row.querySelector('.skillager-name')?.textContent === 'Capacity group ${index}';
    });
  } catch {
    const row = document.activeElement, tree = document.querySelector('${project} [role=tree]');
    throw Error('Capacity group ${index} did not receive keyboard focus: ' + JSON.stringify({
      tag: row?.tagName, role: row?.getAttribute('role'), name: row?.querySelector('.skillager-name')?.textContent,
      inProjectTree: tree?.contains(row), scrollTop: tree?.scrollTop, clientHeight: tree?.clientHeight, scrollHeight: tree?.scrollHeight,
      mounted: tree?.querySelectorAll('[role=treeitem]').length,
    }));
  }`,
  )
}
