import type { BrowserWindow } from 'electron'

const SENTINEL = '/secret/project TOKEN=hvir-health-smoke'

/** Real Electron event wiring plus renderer presentation for a console-only load fault. */
export async function verifyWorkbenchHealthFault(win: BrowserWindow): Promise<string> {
  win.webContents.emit('did-fail-load', {}, -105, SENTINEL, `file://${SENTINEL}`, true)
  const opened = (await win.webContents.executeJavaScript(
    waitForHealthLabel('1 unresolved fault'),
  )) as string
  if (opened.includes(SENTINEL))
    throw new Error('Health affordance exposed fault context')

  win.webContents.emit('did-finish-load')
  await win.webContents.executeJavaScript(waitForHealthLabel('no unresolved faults'))
  const history = (await win.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const deadline = Date.now() + 3000;
      document.querySelector('.workbench-health-toggle')?.click();
      const inspect = () => {
        const text = document.querySelector('.workbench-health-dialog')?.textContent || '';
        if (text.includes('Workbench document failed to load') && text.includes('resolved')) {
          const close = [...document.querySelectorAll('.workbench-health-dialog button')]
            .find((button) => button.textContent?.trim() === 'Close');
          close?.click();
          resolve(text);
        } else if (Date.now() > deadline) {
          reject(new Error('resolved workbench health history missing'));
        } else {
          setTimeout(inspect, 20);
        }
      };
      inspect();
    })
  `)) as string
  if (history.includes(SENTINEL)) throw new Error('Health history exposed fault context')
  return 'load fault visible and resolved after document recovery'
}

function waitForHealthLabel(expected: string): string {
  return `
    new Promise((resolve, reject) => {
      const deadline = Date.now() + 3000;
      const inspect = () => {
        const label = document.querySelector('.workbench-health-toggle')?.getAttribute('aria-label') || '';
        if (label.includes(${JSON.stringify(expected)})) resolve(label);
        else if (Date.now() > deadline) reject(new Error('workbench health affordance missing: ' + label));
        else setTimeout(inspect, 20);
      };
      inspect();
    })
  `
}
