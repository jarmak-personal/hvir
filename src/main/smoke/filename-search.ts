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
        const input = document.querySelector('[data-filename-search]');
        const terminal = document.querySelector('.terminal-panel canvas') ||
          document.querySelector('.terminal-panel [tabindex]') ||
          document.querySelector('.terminal-panel');
        if (!input || !terminal) {
          if (Date.now() > deadline) return reject(new Error('filename search controls missing'));
          return setTimeout(waitForControl, 50);
        }
        terminal.focus();
        key(terminal, 'p');
        requestAnimationFrame(() => {
          if (document.activeElement === input) {
            return reject(new Error('terminal Mod+P was intercepted'));
          }
          key(document.body, 'p');
          requestAnimationFrame(() => {
            if (document.activeElement !== input) {
              return reject(new Error('workbench Mod+P did not focus filename search'));
            }
            const testDirectory = [...document.querySelectorAll('.directory-row')]
              .find((node) => node.getAttribute('title')?.endsWith('/test'));
            if (!testDirectory ||
                testDirectory.querySelector('.tree-chevron')?.textContent?.trim() !== '›') {
              return reject(new Error('test directory was not collapsed before filename search'));
            }
            inputValue(input, 'rendered.yml');
            waitForResult(input, testDirectory);
          });
        });
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
            document.querySelector('.filename-search-clear')?.click();
            return requestAnimationFrame(() => resolve(
              'terminal preserved · collapsed result · keyboard activation'
            ));
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
