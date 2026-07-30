import type { BrowserWindow } from 'electron'

export async function verifyFilenameSearch(win: BrowserWindow): Promise<string> {
  return win.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const deadline = Date.now() + 20000;
      const mod = navigator.userAgent.includes('Mac')
        ? { metaKey: true }
        : { ctrlKey: true };
      const key = (target, value) => target.dispatchEvent(new KeyboardEvent('keydown', {
        key: value,
        bubbles: true,
        cancelable: true,
        ...mod,
      }));
      const inputValue = (input, value) => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      };
      const waitForControl = () => {
        const trigger = document.querySelector('[data-filename-search-trigger]');
        const testDirectory = [...document.querySelectorAll('.directory-row')]
          .find((node) => node.getAttribute('title')?.endsWith('/test'));
        const rootRow = document.querySelector(
          '.files-panel .directory-tree > .tree-directory > .directory-row'
        );
        const rootGitStatus = rootRow?.querySelector('.tree-git-status.directory');
        if (!trigger || !testDirectory) {
          if (Date.now() > deadline) return reject(new Error('filename search controls missing'));
          return setTimeout(waitForControl, 50);
        }
        if (!rootGitStatus) {
          if (Date.now() > deadline) {
            return reject(new Error('root Git status badge missing for layout check'));
          }
          return setTimeout(waitForControl, 50);
        }
        if (document.querySelector('[data-filename-search]')) {
          return reject(new Error('filename search field consumed idle rail space'));
        }
        const triggerRect = trigger.getBoundingClientRect();
        const gitStatusRect = rootGitStatus.getBoundingClientRect();
        if (gitStatusRect.right + 4 > triggerRect.left) {
          return reject(new Error('filename search action overlapped the root Git status badge'));
        }
        trigger.click();
        waitForTriggeredInput(testDirectory);
      };
      const waitForTriggeredInput = (testDirectory) => {
        const input = document.querySelector('[data-filename-search]');
        if (!input) {
          if (Date.now() > deadline) {
            return reject(new Error('filename search action did not open the input'));
          }
          return setTimeout(() => waitForTriggeredInput(testDirectory), 25);
        }
        if (document.activeElement !== input) {
          return reject(new Error('filename search action did not focus the input'));
        }
        input.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Escape', bubbles: true, cancelable: true
        }));
        waitForDismissal(testDirectory);
      };
      const waitForDismissal = (testDirectory) => {
        if (document.querySelector('[data-filename-search]')) {
          if (Date.now() > deadline) {
            return reject(new Error('Escape did not dismiss filename search'));
          }
          return setTimeout(() => waitForDismissal(testDirectory), 25);
        }
        key(document.body, 'p');
        const waitForInput = () => {
          const input = document.querySelector('[data-filename-search]');
          if (!input) {
            if (Date.now() > deadline) {
              return reject(new Error('workbench Mod+P did not open filename search'));
            }
            return setTimeout(waitForInput, 25);
          }
          if (document.activeElement !== input) {
            return reject(new Error('workbench Mod+P did not focus filename search'));
          }
          if (testDirectory.querySelector('.tree-chevron')?.textContent?.trim() !== '›') {
            return reject(new Error('test directory was not collapsed before filename search'));
          }
          inputValue(input, 'rendered*.yml');
          waitForResult(input, testDirectory);
        };
        waitForInput();
      };
      const waitForResult = (input, testDirectory) => {
        const result = [...document.querySelectorAll('.filename-search-result')]
          .find((node) => node.textContent?.includes('rendered.yml'));
        if (!result) {
          if (Date.now() > deadline) return reject(new Error('collapsed filename result missing'));
          return setTimeout(() => waitForResult(input, testDirectory), 50);
        }
        input.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'ArrowDown', bubbles: true, cancelable: true
        }));
        if (document.activeElement !== result) {
          return reject(new Error('filename result keyboard navigation failed'));
        }
        result.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter', bubbles: true, cancelable: true
        }));
        const waitForOpen = () => {
          const title = document.querySelector('.viewer-tab.active .tab-name')?.textContent?.trim();
          if (title === 'rendered.yml') {
            if (testDirectory.querySelector('.tree-chevron')?.textContent?.trim() !== '›') {
              return reject(new Error('filename search expanded the lazy tree'));
            }
            if (document.querySelector('[data-filename-search]') ||
                !document.querySelector('[data-filename-search-trigger]')) {
              return reject(new Error('filename result did not restore the Files tree'));
            }
            return resolve(
              'on-demand · badge-safe · wildcard · collapsed result · keyboard activation'
            );
          }
          if (Date.now() > deadline) return reject(new Error('filename result did not open: ' + title));
          setTimeout(waitForOpen, 50);
        };
        waitForOpen();
      };
      waitForControl();
    })
  `) as Promise<string>
}
