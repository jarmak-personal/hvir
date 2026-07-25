import type { BrowserWindow } from 'electron'

/** Prove that a dirty Git rail can request a branch switch and settle on its result. */
export function verifyDirtyBranchSwitch(win: BrowserWindow): Promise<string> {
  return win.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const deadline = Date.now() + 15000;
      [...document.querySelectorAll('button')]
        .find((node) => node.textContent?.trim().startsWith('Changes'))?.click();
      const start = () => {
        const select = document.querySelector('#git-branch-select');
        const target = select && [...select.options]
          .find((option) => option.value === 'main');
        if (!select || !target || !document.querySelector('.git-file')) {
          if (Date.now() > deadline) {
            return reject(new Error('Dirty branch target or working-tree evidence missing'));
          }
          return setTimeout(start, 25);
        }
        if (target.disabled) return reject(new Error('Dirty branch target is disabled'));
        select.value = target.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        setTimeout(() => poll(target.value), 25);
      };
      const poll = (target) => {
        const current = document.querySelector('#git-branch-select');
        const error = document.querySelector('.git-branch-control small.error');
        if (error) return reject(new Error(error.textContent || 'Branch switch failed'));
        if (current?.value === target && document.querySelector('.git-file')) {
          return resolve(target);
        }
        if (Date.now() > deadline) {
          return reject(new Error('Dirty branch switch did not refresh'));
        }
        setTimeout(() => poll(target), 25);
      };
      start();
    })
  `) as Promise<string>
}
