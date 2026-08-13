import type { BrowserWindow } from 'electron'

/** Chromium geometry and focus acceptance for the compact Harnesses settings surface. */
export async function verifyCompactHarnessSettings(
  win: BrowserWindow,
): Promise<string> {
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
