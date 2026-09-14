import type { BrowserWindow } from 'electron'
import type { PtySupervisor } from '../pty/pty-supervisor'
import {
  captureSkillagerSidebar,
  selectSkillagerExecutable,
} from './skillager-onboarding'
import {
  clickSkillagerControl as click,
  inspectSkillagerControls as inspect,
  openSkillagerIntegrations,
  skillagerControlPoint,
} from './skillager-settings'

/** Real input and ordinary PTY lifecycle over the explicitly scripted CLI fixture. */
export async function verifySkillagerProject(
  win: BrowserWindow,
  supervisor: PtySupervisor,
): Promise<void> {
  const ordinary = supervisor.list().map((terminal) => terminal.id)
  await connectFixture(win)
  await inspect(
    win,
    `await wait(() => [...document.querySelectorAll('.skillager-row')].filter((row) => row.textContent.includes('Project fixture')).length === 3);
    await wait(() => {
      const action = document.querySelector('.skillager-project-setup button');
      return action?.textContent === 'Set up in terminal' && !action.disabled;
    });
    const native = [...document.querySelectorAll('.skillager-row')].find((row) => row.textContent.includes('Project fixture 1'));
    if (!native.textContent.includes('Original') || !native.textContent.includes('Blocked') || native.closest('.skillager-action-row')) throw new Error('Native metadata gained managed actions');
    if (!document.querySelector('.viewer-tab:not(.skillager-tab)')) throw new Error('Project observation displaced the ordinary document');`,
  )
  await reveal(win, '.skillager-project-setup button')
  await captureSkillagerSidebar(win, 'project-before')
  const first = await launch(win, supervisor, new Set(ordinary))
  await answer(win, supervisor, first, 'p')
  await refresh(win)
  await inspect(
    win,
    `await wait(() => {
      const action = document.querySelector('.skillager-project-setup button');
      return action?.textContent === 'Set up in terminal' && !action.disabled;
    });
    if (!document.querySelector('.skillager-project-setup').textContent.includes('Working not installed')) throw new Error('Exit zero incorrectly established readiness');`,
  )
  await reveal(win, '.skillager-project-setup button')
  const second = await launch(win, supervisor, new Set([...ordinary, first]))
  await openSkillagerIntegrations(win)
  await click(win, '.skillager-settings input[type=checkbox]')
  await inspect(
    win,
    `await wait(() => !document.querySelector('.skillager-sidebar, .skillager-tab, .skillager-details'));
    if (document.querySelector('.skillager-settings').textContent.trim() !== 'Enable Skillager') throw new Error('Disabled project setup retained feature UI');`,
  )
  if (!supervisor.get(second))
    throw Error('Disabling killed the handed-off setup terminal')
  await click(win, '.skillager-settings input[type=checkbox]')
  await inspect(
    win,
    `await wait(() => document.querySelector('.skillager-settings .skillager-connection button')?.textContent === 'Connect library');
    if (document.querySelector('.skillager-row')) throw new Error('Re-enable reconnected project setup');`,
  )
  await click(win, '.settings-footer button:first-of-type')
  await connectFixture(win)
  await inspect(
    win,
    `await wait(() => document.querySelector('.skillager-project-setup button')?.textContent === 'Setup terminal running');
    if (!document.querySelector('.skillager-project-setup button').disabled) throw new Error('Re-enable lost the running setup guard');`,
  )
  await answer(win, supervisor, second, 'r')
  await refresh(win)
  await inspect(
    win,
    `await wait(() => document.querySelector('.skillager-project-setup summary')?.textContent === 'Project setup…');
    if (!document.querySelector('.skillager-project-setup').textContent.includes('Working installed')) throw new Error('Public fixture artifact state was not shown');
    if (document.querySelector('.skillager-project-setup').open) throw new Error('Completed setup card remained open');`,
  )
  await reveal(win, '.skillager-project-setup summary')
  await captureSkillagerSidebar(win, 'project-ready')
  for (const id of ordinary)
    if (!supervisor.get(id)) throw Error('Project setup disturbed an existing terminal')
  console.log(
    '[smoke] Skillager project setup OK (deterministic CLI metadata/script fixture; physical action and new-PTY answers; native pending/blocked metadata; exit-zero pause remains incomplete; duplicate guard across disable/re-enable; public readiness/Working; existing terminal and document retained)',
  )
}

async function connectFixture(win: BrowserWindow): Promise<void> {
  await selectSkillagerExecutable(win, '/hvir-smoke/project-setup')
  await inspect(
    win,
    `await wait(() => document.querySelector('.skillager-settings .skillager-connection button')?.textContent === 'Connect library');`,
  )
  await click(win, '.settings-footer button:first-of-type')
  await click(win, '.rail-nav button:last-of-type')
  await click(win, '.skillager-connection button:first-of-type')
  await inspect(win, `await wait(() => document.querySelector('.skillager-search'));`)
}

async function launch(
  win: BrowserWindow,
  supervisor: PtySupervisor,
  previous: ReadonlySet<string>,
): Promise<string> {
  await click(win, '.skillager-project-setup button')
  const id = await inspect<string>(
    win,
    `try { return await wait(() => {
      const panel = [...document.querySelectorAll('.terminal-panel.visible')].find((item) => !${JSON.stringify([...previous])}.includes(item.dataset.terminalSession));
      return panel && /^pid [0-9]+$/.test(panel.dataset.terminalStatus) && panel.dataset.terminalSession;
    }); } catch {
      throw Error('Setup terminal handoff unavailable: ' + JSON.stringify({
        panels: [...document.querySelectorAll('.terminal-panel')].map((item) => ({ id: item.dataset.terminalSession, visible: item.classList.contains('visible'), status: item.dataset.terminalStatus, fixtureTitle: item.getAttribute('aria-label') === 'Skillager setup fixture ready' })),
        setup: document.querySelector('.skillager-project-setup button')?.textContent,
        focused: document.hasFocus(),
      }));
    }`,
  )
  if (!supervisor.get(id))
    throw Error('Setup terminal did not reach the ordinary supervisor')
  await inspect(
    win,
    `await wait(() => document.querySelector('.skillager-project-setup button')?.textContent === 'Setup terminal running');
    if (!document.querySelector('.skillager-project-setup button').disabled) throw new Error('Setup allows duplicate interactive launches');`,
  )
  return id
}

async function answer(
  win: BrowserWindow,
  supervisor: PtySupervisor,
  id: string,
  choice: 'p' | 'r',
): Promise<void> {
  let dispose: (() => void | Promise<void>) | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const exited = new Promise<number | undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), 10_000)
    dispose = supervisor.attach(id, win.webContents.id, {
      onData: () => {},
      onExit: ({ exitCode }) => resolve(exitCode),
    })
  })
  try {
    const selector = `.terminal-panel.visible[data-terminal-session="${id}"] .terminal-engine-host`
    await click(win, selector)
    await inspect(
      win,
      `await wait(() => {
        const input = document.querySelector(${JSON.stringify(selector)})?.querySelector('textarea');
        return input && document.activeElement === input;
      });`,
    )
    win.webContents.sendInputEvent({ type: 'char', keyCode: choice })
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
    win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
    if ((await exited) !== 0)
      throw Error('Fixture setup terminal did not exit successfully')
  } finally {
    if (timer) clearTimeout(timer)
    await dispose?.()
  }
}

async function refresh(win: BrowserWindow): Promise<void> {
  const selector = 'button[aria-label="Refresh in this project"]'
  await reveal(win, selector)
  await inspect(
    win,
    `await wait(() => !document.querySelector(${JSON.stringify(selector)}).disabled);`,
  )
  await click(win, selector)
}

async function reveal(win: BrowserWindow, selector: string): Promise<void> {
  const scrollSelector = selector.startsWith('.skillager-project-setup')
    ? '.skillager-project-setup-scroll'
    : '.skillager-sidebar'
  let geometry: unknown
  for (let step = 0; step < 8; step++) {
    const state = await inspect<{
      visible: boolean
      delta: number
      destination: number
    }>(
      win,
      `
      const item = await wait(() => document.querySelector(${JSON.stringify(selector)})), sidebar = document.querySelector(${JSON.stringify(scrollSelector)});
      const rect = item.getBoundingClientRect(), outer = sidebar.getBoundingClientRect();
      const delta = rect.top < outer.top ? 500 : -500;
      return { visible: rect.top >= outer.top && rect.bottom <= outer.bottom, delta, destination: Math.max(0, Math.min(sidebar.scrollHeight - sidebar.clientHeight, sidebar.scrollTop - delta)), top: sidebar.scrollTop, clientHeight: sidebar.clientHeight, scrollHeight: sidebar.scrollHeight, targetTop: rect.top, targetBottom: rect.bottom, viewportTop: outer.top, viewportBottom: outer.bottom };`,
    )
    geometry = state
    if (state.visible) {
      await skillagerControlPoint(win, selector)
      return
    }
    const location = await skillagerControlPoint(win, scrollSelector, true)
    win.webContents.sendInputEvent({ type: 'mouseMove', ...location })
    win.webContents.sendInputEvent({
      type: 'mouseWheel',
      ...location,
      deltaX: 0,
      deltaY: state.delta,
      canScroll: true,
    })
    await inspect(
      win,
      `await wait(() => {
        const sidebar = document.querySelector(${JSON.stringify(scrollSelector)}), item = document.querySelector(${JSON.stringify(selector)});
        const rect = item.getBoundingClientRect(), outer = sidebar.getBoundingClientRect();
        return (rect.top >= outer.top && rect.bottom <= outer.bottom) || Math.abs(sidebar.scrollTop - ${state.destination}) <= 1;
      });`,
    )
  }
  throw Error(
    'Project setup control did not become scroll-reachable: ' + JSON.stringify(geometry),
  )
}
