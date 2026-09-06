import type { BrowserWindow } from 'electron'
import type { PtySupervisor } from '../pty/pty-supervisor'
import { ensureExplicitBareShellLaunch } from './terminal-explicit-launch'

/** Materialize the explicit terminal required by layout/settings conformance. */
export async function prepareTerminalScenario(
  win: BrowserWindow,
  supervisor: PtySupervisor,
): Promise<void> {
  await ensureExplicitBareShellLaunch(win, supervisor)
  await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 10000;
    const inspect = () => {
      if (document.querySelector('.terminal-container canvas') &&
          document.querySelector('[aria-label="Files"] .tree-directory')) return resolve();
      if (Date.now() > deadline) return reject(new Error('terminal scenario presentation unavailable'));
      requestAnimationFrame(inspect);
    };
    inspect();
  })`)
}
