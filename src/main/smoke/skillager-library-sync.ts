import type { BrowserWindow } from 'electron'
import type { SkillagerSyncApplyHold } from './skillager-library-sync-fixture'
import {
  clickSkillagerControl as click,
  inspectSkillagerControls as inspect,
  skillagerControlPoint,
} from './skillager-settings'

/** Chromium pointer/keyboard/scroll proof over the named delayed sync port. */
export async function verifySkillagerLibrarySync(
  win: BrowserWindow,
  empty: boolean,
  held?: SkillagerSyncApplyHold,
): Promise<void> {
  const library = 'section[aria-label="Your library"]'
  const key = (keyCode: string) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode })
    if (keyCode === 'Enter')
      win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode })
  }
  if (empty) {
    if (!held) throw Error('Empty library journey requires a held fixture sync')
    await inspect(
      win,
      `const scroll = document.querySelector('${library} .skillager-section-empty'); scroll.scrollTop = 0; await wait(() => scroll.scrollTop === 0);`,
    )
    await click(win, '.skillager-sync-empty button')
  } else {
    await click(win, '[aria-label="Your library actions"]')
    await inspect(
      win,
      `await wait(() => document.activeElement?.getAttribute('role') === 'menuitem');`,
    )
    key('Escape')
    await inspect(
      win,
      `await wait(() => !document.querySelector('[role=menu]') && document.activeElement?.getAttribute('aria-label') === 'Your library actions');`,
    )
    key('Enter')
    await inspect(
      win,
      `await wait(() => document.activeElement?.getAttribute('role') === 'menuitem');`,
    )
    key('Enter')
  }
  await inspect(
    win,
    `await wait(() => document.querySelector('.skillager-sync-progress [role=status]')?.textContent.includes('Checking approved'));`,
  )
  if (!empty) {
    await click(win, '.skillager-sync-progress > button')
    await inspect(
      win,
      `await wait(() => !document.querySelector('.skillager-sync-progress [role=status]')?.textContent.includes('Checking approved'));`,
    )
    await click(win, '[aria-label="Your library actions"]')
    await inspect(
      win,
      `await wait(() => document.activeElement?.getAttribute('role') === 'menuitem');`,
    )
    key('Enter')
  }
  if (empty) {
    if (!(await held!.submitted)) throw Error('Fixture sync was not submitted')
    await inspect(
      win,
      `await wait(() => document.querySelector('.skillager-sync-progress [role=status]')?.textContent.includes('Syncing approved'));
      if (document.querySelector('.skillager-tab.active')) throw Error('Passive rail journey must begin without an active skill detail');`,
    )
    await click(win, '.rail-nav button:first-of-type')
    await inspect(
      win,
      `await wait(() => document.querySelector('.skillager-sidebar').hidden);
      if (!document.querySelector('.skillager-sync-progress [role=status]')?.textContent.includes('Syncing approved')) throw Error('Sync did not remain submitted while Files became visible');`,
    )
    held!.release()
    await inspect(
      win,
      `await wait(() => document.querySelector('.skillager-sync-progress [role=status]')?.textContent.includes('Sync completed'));`,
    )
    await click(win, '.rail-nav button:last-of-type')
    await inspect(
      win,
      `await wait(() => !document.querySelector('.skillager-sidebar').hidden);
      if (!document.querySelector('.skillager-sync-progress [role=status]')?.textContent.includes('Sync completed')) throw Error('Returning to Skills lost the completed sync result');`,
    )
  }
  await inspect(
    win,
    `await wait(() => document.querySelector('.skillager-sync-progress [role=status]')?.textContent.includes('Sync completed'));`,
  )
  if (empty)
    await inspect(
      win,
      `await wait(() => document.querySelector('${library} .skillager-row') && !document.querySelector('.skillager-sync-empty') && document.querySelector('[aria-label="Your library actions"]'));`,
    )
  await click(win, '.skillager-sync-progress summary')
  await inspect(
    win,
    `await wait(() => document.querySelector('.skillager-sync-progress details').open); if (document.querySelectorAll('.skillager-sync-items li').length !== ${empty ? 1 : 50}) throw Error('Sync outcomes did not retain a bounded page'); if (!document.querySelector('.viewer-tab:not(.skillager-tab)') || !document.querySelector('.terminal-container canvas')) throw Error('Sync displaced ordinary work');`,
  )
  if (!empty) {
    await inspect(
      win,
      `const scroll = document.querySelector('.skillager-sync-progress'); scroll.scrollTop = scroll.scrollHeight; await wait(() => scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 1);`,
    )
    await click(win, '.skillager-sync-progress nav button:last-child')
    await inspect(
      win,
      `await wait(() => document.querySelector('.skillager-sync-items').start === 51); if (document.querySelectorAll('.skillager-sync-items li').length !== 50) throw Error('Outcome DOM accumulated pages');`,
    )
  }
  const bounds = win.getBounds(),
    minimum = win.getMinimumSize()
  try {
    win.setMinimumSize(640, 460)
    win.setContentSize(640, 460)
    await inspect(
      win,
      `await wait(() => innerWidth === 640 && innerHeight === 460); if (document.documentElement.scrollWidth > innerWidth + 1) throw Error('Sync overflowed compact viewport');`,
    )
    await skillagerControlPoint(win, '[aria-label="Your library actions"]')
    await skillagerControlPoint(
      win,
      'section[aria-label="In this project"] .skillager-section-header button:first-child',
    )
  } finally {
    win.setMinimumSize(minimum[0]!, minimum[1]!)
    win.setBounds(bounds)
  }
  await inspect(win, `document.querySelector('.skillager-sync-progress').scrollTop = 0;`)
  await click(win, '.skillager-sync-progress summary')
  console.log(
    `[smoke] Skillager sync OK (${empty ? 'empty primary action, submitted sync retained across physical Files to Skills navigation, populated library menu' : 'keyboard menu, cancelled check, 5000 retained outcomes with 50 mounted rows and page navigation'}; 640×460 headers reachable; ordinary viewer and terminal retained; delayed CLI fixture)`,
  )
}
