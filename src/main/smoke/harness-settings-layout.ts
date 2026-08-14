import type { BrowserWindow } from 'electron'

/** Physical pointer and focus acceptance for the terminal-rail manual profile path. */
export async function verifyHarnessManualProfilePointerActivation(
  win: BrowserWindow,
): Promise<string> {
  clickMouse(
    win,
    await waitForButtonPoint(
      win,
      '.terminal-icon-button[aria-label="New terminal"]',
      '+',
    ),
  )
  clickMouse(
    win,
    await waitForButtonPoint(win, '.terminal-new-menu button', 'Add a harness…'),
  )

  const configurePoint = (await withTimeout(
    win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 10000;
        const inspect = () => {
          const dialog = document.querySelector('.add-harness-dialog');
          const configure = [...(dialog?.querySelectorAll('button') || [])]
            .find((button) => button.textContent?.trim() === 'Configure manually…');
          if (dialog instanceof HTMLElement && configure instanceof HTMLButtonElement &&
              !configure.disabled) {
            return requestAnimationFrame(() => requestAnimationFrame(() => {
              if (!dialog.contains(document.activeElement)) {
                return reject(new Error(
                  'nested add-harness dialog did not retain focus before pointer input'
                ));
              }
              const bounds = configure.getBoundingClientRect();
              if (bounds.width <= 0 || bounds.height <= 0) {
                return reject(new Error('manual profile action has no pointer target'));
              }
              resolve({ x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 });
            }));
          }
          if (Date.now() > deadline) {
            return reject(new Error('manual profile action did not become ready'));
          }
          requestAnimationFrame(inspect);
        };
        inspect();
      })
    `),
    'manual profile pointer target timed out',
  )) as PointerPoint
  clickMouse(win, configurePoint)

  const status = (await withTimeout(
    win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 10000;
        const inspect = () => {
          const rawError = document.body.textContent?.includes(
            "Error invoking remote method 'harness:preview'"
          );
          if (rawError) return reject(new Error('raw preview IPC error reached the renderer'));
          const addDialog = document.querySelector('.add-harness-dialog');
          const active = document.querySelector('.settings-profile-list button.active');
          const name = active?.querySelector('strong')?.textContent?.trim();
          const detail = active?.querySelector('small')?.textContent || '';
          const preview = document.querySelector(
            '.settings-profile-preview-disclosure summary'
          );
          const previewText = preview?.textContent || '';
          const previewDetail = preview?.querySelector('small');
          if (previewDetail?.classList.contains('settings-profile-disclosure-error') ||
              previewText.includes('Needs attention')) {
            return reject(new Error('incomplete preview guidance used error presentation'));
          }
          if (!addDialog && name === 'Custom command' && detail.includes('Unsaved') &&
              previewText.includes('Enter an executable command to preview this profile.')) {
            return resolve('nested focus + one physical activation + local preview guidance');
          }
          if (Date.now() > deadline) {
            return reject(new Error(
              'physical manual activation did not open the preview-gated Custom draft'
            ));
          }
          requestAnimationFrame(inspect);
        };
        inspect();
      })
    `),
    'manual profile activation timed out',
  )) as string

  await withTimeout(
    win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 10000;
        const close = [...document.querySelectorAll('.settings-dialog button')]
          .find((button) => button.textContent?.trim() === 'Close settings');
        if (!(close instanceof HTMLButtonElement)) {
          return reject(new Error('settings close action missing after manual activation'));
        }
        close.click();
        const discard = () => {
          const prompt = document.querySelector('.unsaved-harness-dialog');
          const button = [...(prompt?.querySelectorAll('button') || [])]
            .find((candidate) => candidate.textContent?.trim() === 'Discard changes');
          if (button instanceof HTMLButtonElement) {
            button.click();
            return waitForClose();
          }
          if (Date.now() > deadline) {
            return reject(new Error('manual draft discard prompt did not open'));
          }
          requestAnimationFrame(discard);
        };
        const waitForClose = () => {
          if (!document.querySelector('.settings-dialog')) return resolve(true);
          if (Date.now() > deadline) {
            return reject(new Error('settings remained open after discarding manual draft'));
          }
          requestAnimationFrame(waitForClose);
        };
        discard();
      })
    `),
    'manual draft cleanup timed out',
  )
  return status
}

/** Chromium geometry and focus acceptance for the compact Harnesses settings surface. */
export async function verifyCompactHarnessSettings(win: BrowserWindow): Promise<string> {
  const originalContentSize = win.getContentSize()
  win.setContentSize(640, 720)
  try {
    return (await withTimeout(
      win.webContents.executeJavaScript(`
        new Promise((resolve, reject) => {
          const deadline = Date.now() + 10000;
          const waitFor = (read, failure) => {
            const value = read();
            if (value) return value;
            if (Date.now() > deadline) throw new Error(failure);
            return undefined;
          };
          document.querySelector('.settings-toggle')?.click();
          const openHarnesses = () => {
            const dialog = document.querySelector('.settings-dialog');
            const harnesses = [...(dialog?.querySelectorAll(
              '.settings-section-index button'
            ) || [])].find((button) => button.textContent?.trim() === 'Harnesses');
            if (!dialog || !harnesses) {
              if (Date.now() > deadline) {
                return reject(new Error('compact settings surface did not paint'));
              }
              return requestAnimationFrame(openHarnesses);
            }
            harnesses.click();
            const inspect = () => {
              try {
                const profile = waitFor(
                  () => document.querySelector('.settings-profile-editor'),
                  'compact harness editor did not paint'
                );
                if (!profile) return requestAnimationFrame(inspect);
                const required = [
                  document.querySelector('.settings-dialog'),
                  document.querySelector('.settings-shell-body'),
                  document.querySelector('.settings-content'),
                  document.querySelector('.settings-harness-layout'),
                  document.querySelector('.settings-profile-editor-shell'),
                  profile
                ];
                if (required.some((element) => !(element instanceof HTMLElement))) {
                  throw new Error('compact harness layout owner missing');
                }
                const overflowing = required.find(
                  (element) => element.scrollWidth > element.clientWidth + 1
                );
                if (overflowing) {
                  throw new Error(
                    'compact harness layout scrolls horizontally: ' +
                    overflowing.className + ' ' +
                    overflowing.scrollWidth + '>' + overflowing.clientWidth
                  );
                }
                if (document.documentElement.scrollWidth > window.innerWidth + 1) {
                  throw new Error('compact Harnesses widened the page');
                }
                const shell = document.querySelector('.settings-profile-editor-shell');
                const shellBounds = shell.getBoundingClientRect();
                const disclosures = [...profile.querySelectorAll(
                  '.settings-profile-disclosure'
                )];
                if (disclosures.length !== 2) {
                  throw new Error('compact common/advanced/preview hierarchy is incomplete');
                }
                disclosures.forEach((details) => { details.open = true; });
                const actions = [...shell.querySelectorAll(
                  '.settings-profile-actions button'
                )];
                if (actions.length !== 5) {
                  throw new Error('compact profile actions are incomplete');
                }
                const clippedAction = actions.find((action) => {
                  const bounds = action.getBoundingClientRect();
                  return bounds.width <= 0 || bounds.left < shellBounds.left - 1 ||
                    bounds.right > shellBounds.right + 1;
                });
                if (clippedAction) {
                  throw new Error(
                    'compact profile action is clipped: ' + clippedAction.textContent
                  );
                }
                const controls = [...profile.querySelectorAll(
                  'input, select, textarea, summary, button'
                )].filter((control) => control.getClientRects().length > 0);
                const clippedControl = controls.find((control) => {
                  const bounds = control.getBoundingClientRect();
                  return bounds.width <= 0 || bounds.left < shellBounds.left - 1 ||
                    bounds.right > shellBounds.right + 1;
                });
                if (clippedControl) {
                  throw new Error(
                    'compact profile control is clipped: ' +
                    (clippedControl.getAttribute('aria-label') || clippedControl.tagName)
                  );
                }
                const advancedSummary = disclosures[0].querySelector('summary');
                advancedSummary.focus();
                if (parseFloat(getComputedStyle(advancedSummary).outlineWidth) < 1) {
                  throw new Error('compact advanced disclosure focus is not visible');
                }
                [...document.querySelectorAll('.settings-dialog button')]
                  .find((button) => button.textContent?.trim() === 'Close settings')
                  ?.click();
                requestAnimationFrame(() => {
                  if (document.querySelector('.settings-dialog')) {
                    return reject(new Error('compact settings dialog did not close'));
                  }
                  resolve(
                    window.innerWidth + 'px · zero horizontal page/layout overflow · ' +
                    actions.length + ' actions and ' + controls.length + ' fields reachable'
                  );
                });
              } catch (error) {
                reject(error);
              }
            };
            requestAnimationFrame(inspect);
          };
          requestAnimationFrame(openHarnesses);
        })
      `),
      'compact harness settings smoke timed out',
    )) as string
  } finally {
    win.setContentSize(originalContentSize[0]!, originalContentSize[1]!)
  }
}

interface PointerPoint {
  readonly x: number
  readonly y: number
}

async function waitForButtonPoint(
  win: BrowserWindow,
  selector: string,
  label: string,
): Promise<PointerPoint> {
  return (await withTimeout(
    win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 10000;
        const inspect = () => {
          const button = [...document.querySelectorAll(${JSON.stringify(selector)})]
            .find((candidate) => candidate.textContent?.trim() === ${JSON.stringify(label)});
          if (button instanceof HTMLButtonElement && !button.disabled) {
            const bounds = button.getBoundingClientRect();
            if (bounds.width > 0 && bounds.height > 0) {
              return resolve({
                x: bounds.left + bounds.width / 2,
                y: bounds.top + bounds.height / 2
              });
            }
          }
          if (Date.now() > deadline) {
            return reject(new Error(${JSON.stringify(`${label} pointer target missing`)}));
          }
          requestAnimationFrame(inspect);
        };
        inspect();
      })
    `),
    `${label} pointer target timed out`,
  )) as PointerPoint
}

function clickMouse(win: BrowserWindow, point: PointerPoint): void {
  const location = { x: Math.round(point.x), y: Math.round(point.y) }
  win.webContents.sendInputEvent({ type: 'mouseMove', ...location })
  win.webContents.sendInputEvent({
    type: 'mouseDown',
    button: 'left',
    clickCount: 1,
    ...location,
  })
  win.webContents.sendInputEvent({
    type: 'mouseUp',
    button: 'left',
    clickCount: 1,
    ...location,
  })
}

async function withTimeout<T>(
  promise: Promise<T>,
  message: string,
  timeoutMs = 15_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
