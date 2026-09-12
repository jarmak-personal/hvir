import type { BrowserWindow } from 'electron'

const toggle = '.skillager-settings input[type="checkbox"]'
const section = '.settings-section-index [aria-controls="settings-integrations-title"]'
const select = '.settings-section-selector select'
const connect = '.skillager-settings .skillager-connection button:first-of-type'
const close = '.settings-footer button:first-of-type'

/** Settings discovery must work through Chromium hit-testing, not DOM click(). */
export async function enableSkillagerInSettings(win: BrowserWindow): Promise<void> {
  await openSkillagerIntegrations(win)
  await assertDisabled(win)
  await clickSkillagerControl(win, toggle)
  await waitForConnectionChoice(win)
  await clickSkillagerControl(win, close)
  await inspectSkillagerControls(
    win,
    `await wait(() => !document.querySelector('.settings-dialog'));`,
  )
}

/** Exercise the same navigation and scroll shell at a compact viewport, then revoke. */
export async function disableAndReenableSkillagerInSettings(
  win: BrowserWindow,
): Promise<void> {
  const bounds = win.getBounds()
  const minimum = win.getMinimumSize()
  try {
    await openSkillagerIntegrations(win)
    await clickSkillagerControl(win, toggle)
    await assertDisabled(win)

    win.setMinimumSize(0, 0)
    win.setContentSize(640, 460)
    await inspectSkillagerControls(
      win,
      `await wait(() => innerWidth === 640 && innerHeight === 460);`,
    )
    await navigateCompactSettings(win, 'appearance')
    await inspectSkillagerControls(
      win,
      `await wait(() => document.querySelector('#settings-appearance-title'));`,
    )
    await navigateCompactSettings(win, 'integrations')
    await inspectSkillagerControls(
      win,
      `await wait(() => document.querySelector('#settings-integrations-title'));`,
    )
    await assertDisabled(win)
    await clickSkillagerControl(win, toggle)
    await waitForConnectionChoice(win)
    await clickSkillagerControl(win, '.skillager-settings > details > summary')
    await inspectSkillagerControls(
      win,
      `
      if (document.querySelector('.skillager-tab, .skillager-details, .skillager-review, .skillager-row'))
        throw new Error('Re-enabling restored Skillager content or connection');
      const scroll = document.querySelector('.settings-section-scroll');
      if (scroll.scrollHeight <= scroll.clientHeight) throw new Error('Compact settings did not exercise scrolling');
      if (scroll.scrollWidth > scroll.clientWidth + 1 || document.documentElement.scrollWidth > innerWidth + 1)
        throw new Error('Compact settings overflowed horizontally');
    `,
    )
    await scrollSettings(win, -1000)
    await skillagerControlPoint(win, '#skillager-executable')
    await clickSkillagerControl(win, '.skillager-executable button')
    await waitForConnectionChoice(win)
    await scrollSettings(win, 1000)
    await clickSkillagerControl(win, toggle)
    await assertDisabled(win)
    await clickSkillagerControl(win, close)
    await inspectSkillagerControls(
      win,
      `await wait(() => !document.querySelector('.settings-dialog'));`,
    )
    console.log(
      '[smoke] Skillager Settings OK (pointer Integrations navigation and enable/disable; 640×460 visible select/change-event navigation and real wheel scrolling; clean re-enable)',
    )
  } finally {
    if (!win.isDestroyed()) {
      win.setMinimumSize(minimum[0]!, minimum[1]!)
      win.setBounds(bounds)
    }
  }
}

export async function openSkillagerIntegrations(win: BrowserWindow): Promise<void> {
  await clickSkillagerControl(win, '.settings-toggle')
  await clickSkillagerControl(win, section)
  await inspectSkillagerControls(
    win,
    `await wait(() => document.querySelector('#settings-integrations-title'));`,
  )
}

async function assertDisabled(win: BrowserWindow): Promise<void> {
  await inspectSkillagerControls(
    win,
    `
    await wait(() => !document.querySelector(${JSON.stringify(toggle)}).checked);
    await wait(() => !document.querySelector('.skillager-sidebar, .skillager-tab, .skillager-details, .skillager-review, .skillager-exposure-dialog'));
    if (document.querySelector('.skillager-settings').textContent.trim() !== 'Enable Skillager' ||
        document.querySelectorAll('.skillager-settings input, .skillager-settings button').length !== 1 ||
        [...document.querySelectorAll('.rail-nav button')].some((button) => button.textContent.trim() === 'Skills'))
      throw new Error('Disabled Skillager left controls, status, or navigation');
  `,
  )
}

async function waitForConnectionChoice(win: BrowserWindow): Promise<void> {
  await inspectSkillagerControls(
    win,
    `
    await wait(() => document.querySelector(${JSON.stringify(connect)})?.textContent === 'Connect library');
    if (document.querySelector('.skillager-row')) throw new Error('Probe connected implicitly');
  `,
  )
}

async function scrollSettings(win: BrowserWindow, deltaY: number): Promise<void> {
  const location = await skillagerControlPoint(win, '.settings-section-scroll')
  win.webContents.sendInputEvent({ type: 'mouseMove', ...location })
  win.webContents.sendInputEvent({
    type: 'mouseWheel',
    ...location,
    deltaX: 0,
    deltaY,
    canScroll: true,
  })
  await inspectSkillagerControls(
    win,
    `await wait(() => {
    const scroll = document.querySelector('.settings-section-scroll');
    return ${deltaY < 0 ? 'scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 1' : 'scroll.scrollTop === 0'};
  });`,
  )
}

export async function clickSkillagerControl(
  win: BrowserWindow,
  selector: string,
): Promise<void> {
  const location = await skillagerControlPoint(win, selector)
  win.webContents.sendInputEvent({ type: 'mouseMove', ...location })
  for (const type of ['mouseDown', 'mouseUp'] as const)
    win.webContents.sendInputEvent({ type, button: 'left', clickCount: 1, ...location })
}

async function navigateCompactSettings(
  win: BrowserWindow,
  destination: 'appearance' | 'integrations',
): Promise<void> {
  // macOS native popup/type-ahead behavior is outside webContents input ownership.
  // Prove this select is visible, then exercise its production change handler.
  // Checkbox activation and content scrolling still use real pointer events.
  await skillagerControlPoint(win, select)
  await inspectSkillagerControls(
    win,
    `const select = document.querySelector(${JSON.stringify(select)});
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, ${JSON.stringify(destination)});
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(() => document.querySelector('#settings-${destination}-title'));`,
  )
}

export async function skillagerControlPoint(
  win: BrowserWindow,
  selector: string,
  padding = false,
): Promise<{ readonly x: number; readonly y: number }> {
  return inspectSkillagerControls(
    win,
    `
    const element = await wait(() => document.querySelector(${JSON.stringify(selector)}));
    await new Promise(requestAnimationFrame);
    const bounds = element.getBoundingClientRect();
    const x = Math.round(bounds.left + ${padding ? '4' : 'bounds.width / 2'}), y = Math.round(bounds.top + bounds.height / 2);
    const hit = document.elementFromPoint(x, y);
    if (bounds.width <= 0 || bounds.height <= 0 || element.disabled || !element.contains(hit) || (${padding} && hit !== element))
      throw new Error('Skillager Settings control is not hit-testable: ' + JSON.stringify({
        selector: ${JSON.stringify(selector)}, x, y, width: bounds.width, height: bounds.height,
        viewportWidth: innerWidth, viewportHeight: innerHeight, hit: element.contains(hit), disabled: !!element.disabled,
      }));
    return { x, y };
  `,
  )
}

export function inspectSkillagerControls<T>(
  win: BrowserWindow,
  source: string,
): Promise<T> {
  return win.webContents.executeJavaScript(`(async () => {
    const wait = (read) => new Promise((resolve, reject) => {
      const deadline = Date.now() + 10000;
      const poll = () => {
        const value = read(); if (value) return resolve(value);
        if (Date.now() > deadline) return reject(new Error('Skillager Settings readiness timed out: ' + read.toString() + '; ' + JSON.stringify({
          section: document.querySelector('.settings-section-selector select')?.value,
          selectFocused: document.activeElement === document.querySelector('.settings-section-selector select'),
          viewportWidth: innerWidth, viewportHeight: innerHeight,
        })));
        requestAnimationFrame(poll);
      }; poll();
    });
    ${source}
  })()`) as Promise<T>
}
