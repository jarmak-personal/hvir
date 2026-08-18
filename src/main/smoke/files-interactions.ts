import type { BrowserWindow } from 'electron'

import { dirnameHostPath, hostPathEquals, type HostPath } from '../../shared'

export async function verifyFilesInteractionsSmoke(
  win: BrowserWindow,
  path: HostPath,
  revealedEntries: readonly HostPath[],
): Promise<void> {
  const expectedLabel =
    process.platform === 'darwin' ? 'Reveal in Finder' : 'Show in File Manager'
  const originalSize = win.getContentSize() as [number, number]
  try {
    await rendererValue(
      win,
      `(() => {
        const row = document.querySelector(
          '.files-panel [role="treeitem"][title=${JSON.stringify(path.path)}]'
        );
        if (!(row instanceof HTMLButtonElement)) return undefined;
        if (!window.__hvirFilesRevealMenu) {
          row.dispatchEvent(new MouseEvent('contextmenu', {
            bubbles: true,
            clientX: window.innerWidth - 1,
            clientY: window.innerHeight - 1
          }));
          window.__hvirFilesRevealMenu = true;
          return undefined;
        }
        const menu = document.querySelector('.file-action-menu');
        if (!(menu instanceof HTMLElement)) return undefined;
        return menu.getBoundingClientRect().right <= window.innerWidth &&
          menu.getBoundingClientRect().bottom <= window.innerHeight;
      })()`,
      'local Files action menu did not open inside the viewport',
    )

    win.setContentSize(480, 320)
    await rendererValue(
      win,
      `window.innerWidth === 480 && window.innerHeight === 320 ? true : undefined`,
      'Files interaction viewport did not resize to 480x320',
    )
    await rendererValue(
      win,
      `(() => {
        const menu = document.querySelector('.file-action-menu');
        if (!(menu instanceof HTMLElement)) return undefined;
        const bounds = menu.getBoundingClientRect();
        if (bounds.left < 0 || bounds.top < 0 || bounds.right > window.innerWidth ||
            bounds.bottom > window.innerHeight || menu.clientHeight > 304) return undefined;
        const action = [...menu.querySelectorAll('[role="menuitem"]')]
          .find((node) => node.textContent?.trim() === ${JSON.stringify(expectedLabel)});
        if (!(action instanceof HTMLButtonElement)) {
          throw new Error('local reveal action is unavailable');
        }
        action.scrollIntoView({ block: 'nearest' });
        const actionBounds = action.getBoundingClientRect();
        return actionBounds.top >= bounds.top && actionBounds.bottom <= bounds.bottom;
      })()`,
      'resized Files action menu was not bounded and internally reachable',
    )
    await win.webContents.executeJavaScript(`
      [...document.querySelectorAll('.file-action-menu [role="menuitem"]')]
        .find((node) => node.textContent?.trim() === ${JSON.stringify(expectedLabel)})
        ?.click();
    `)
    await withTimeout(
      (async () => {
        while (!revealedEntries.some((candidate) => hostPathEquals(candidate, path))) {
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
      })(),
      'local Files reveal did not reach its native adapter',
    )

    await rendererValue(
      win,
      `(() => {
        const tab = document.querySelector('.viewer-tab.active .tab-main');
        if (!(tab instanceof HTMLButtonElement)) return undefined;
        if (!window.__hvirFilesPathMenu) {
          tab.dispatchEvent(new MouseEvent('contextmenu', {
            bubbles: true,
            clientX: window.innerWidth - 1,
            clientY: window.innerHeight - 1
          }));
          window.__hvirFilesPathMenu = true;
          return undefined;
        }
        const menu = document.querySelector('.path-copy-menu');
        if (!(menu instanceof HTMLElement)) return undefined;
        const bounds = menu.getBoundingClientRect();
        return bounds.left >= 0 && bounds.top >= 0 &&
          bounds.right <= window.innerWidth && bounds.bottom <= window.innerHeight;
      })()`,
      'path-copy menu was not reachable at 480x320',
    )
    win.setContentSize(520, 360)
    await rendererValue(
      win,
      `(() => {
        if (window.innerWidth !== 520 || window.innerHeight !== 360) return undefined;
        const menu = document.querySelector('.path-copy-menu');
        if (!(menu instanceof HTMLElement)) return undefined;
        const bounds = menu.getBoundingClientRect();
        return bounds.left >= 0 && bounds.top >= 0 &&
          bounds.right <= window.innerWidth && bounds.bottom <= window.innerHeight;
      })()`,
      'path-copy menu escaped after a live resize',
    )
    await win.webContents.executeJavaScript(
      `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`,
    )

    await verifyPointerTreeFocus(win, path)
  } finally {
    win.setContentSize(originalSize[0], originalSize[1])
    await win.webContents.executeJavaScript(`
      delete window.__hvirFilesRevealMenu;
      delete window.__hvirFilesPathMenu;
      delete window.__hvirFilesPointerOpen;
      delete window.__hvirFilesDirectoryPointer;
      delete window.__hvirFilesCollapsedDirectoryPointer;
    `)
  }
}

async function verifyPointerTreeFocus(win: BrowserWindow, path: HostPath): Promise<void> {
  const directory = dirnameHostPath(path)
  await rendererValue(
    win,
    `(() => {
      if (document.querySelector('.terminal-surface.active .terminal-container')) return true;
      const create = document.querySelector('.terminal-empty button');
      if (!(create instanceof HTMLButtonElement)) return undefined;
      if (!window.__hvirFilesTerminalRequested) {
        create.click();
        window.__hvirFilesTerminalRequested = true;
      }
      return undefined;
    })()`,
    'Files focus smoke could not create a visible terminal',
    20_000,
  )
  await rendererValue(
    win,
    `(() => {
      const row = document.querySelector(
        '.files-panel [role="treeitem"][title=${JSON.stringify(path.path)}]'
      );
      if (!(row instanceof HTMLButtonElement)) return undefined;
      if (!window.__hvirFilesPointerOpen) {
        row.focus();
        row.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
        window.__hvirFilesPointerOpen = true;
        return undefined;
      }
      return document.activeElement?.closest('.terminal-surface.active') ? true : undefined;
    })()`,
    'pointer-opened file did not return focus to the visible active terminal',
  )
  await rendererValue(
    win,
    `(() => {
      const row = document.querySelector(
        '.files-panel [role="treeitem"][title=${JSON.stringify(path.path)}]'
      );
      if (!(row instanceof HTMLButtonElement)) return undefined;
      row.focus();
      row.click();
      return document.activeElement === row ? true : undefined;
    })()`,
    'keyboard-opened file transferred focus away from its tree row',
  )
  await rendererValue(
    win,
    `(() => {
      const row = document.querySelector(
        '.files-panel .directory-row[title=${JSON.stringify(directory.path)}]'
      );
      if (!(row instanceof HTMLButtonElement)) return undefined;
      if (!window.__hvirFilesDirectoryPointer) {
        row.focus();
        row.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
        window.__hvirFilesDirectoryPointer = true;
        return undefined;
      }
      return document.activeElement?.closest('.terminal-surface.active') ? true : undefined;
    })()`,
    'pointer-activated directory did not return focus to the visible active terminal',
  )
  await rendererValue(
    win,
    `(() => {
      const row = document.querySelector(
        '.files-panel .directory-row[title=${JSON.stringify(directory.path)}]'
      );
      if (!(row instanceof HTMLButtonElement)) return undefined;
      row.focus();
      row.click();
      return document.activeElement === row && row.getAttribute('aria-expanded') === 'true'
        ? true : undefined;
    })()`,
    'keyboard-activated directory transferred focus away from its tree row',
  )
  await rendererValue(
    win,
    `(() => {
      const collapse = document.querySelector('.terminal-collapse-toggle');
      if (!(collapse instanceof HTMLButtonElement)) return undefined;
      if (collapse.getAttribute('aria-pressed') !== 'true') {
        collapse.click();
        return undefined;
      }
      const deck = document.querySelector('.terminal-deck');
      if (!(deck instanceof HTMLElement) || getComputedStyle(deck).visibility !== 'hidden') {
        return undefined;
      }
      const row = document.querySelector(
        '.files-panel .directory-row[title=${JSON.stringify(directory.path)}]'
      );
      if (!(row instanceof HTMLButtonElement)) return undefined;
      if (!window.__hvirFilesCollapsedDirectoryPointer) {
        row.focus();
        row.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
        window.__hvirFilesCollapsedDirectoryPointer = true;
        return undefined;
      }
      return document.activeElement === row ? true : undefined;
    })()`,
    'pointer-activated directory changed focus while no terminal was visible',
  )
  await win.webContents.executeJavaScript(`
    const directory = document.querySelector(
      '.files-panel .directory-row[title=${JSON.stringify(directory.path)}]'
    );
    if (directory instanceof HTMLButtonElement &&
        directory.getAttribute('aria-expanded') !== 'true') directory.click();
    const collapse = document.querySelector('.terminal-collapse-toggle');
    if (collapse instanceof HTMLButtonElement &&
        collapse.getAttribute('aria-pressed') === 'true') collapse.click();
    delete window.__hvirFilesTerminalRequested;
  `)
}

function rendererValue(
  win: BrowserWindow,
  expression: string,
  message: string,
  timeoutMs = 10_000,
): Promise<unknown> {
  return win.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const deadline = Date.now() + ${timeoutMs};
      const poll = () => {
        try {
          const value = ${expression};
          if (value) return resolve(value);
        } catch (error) {
          return reject(error);
        }
        if (Date.now() > deadline) return reject(new Error(${JSON.stringify(message)}));
        setTimeout(poll, 25);
      };
      poll();
    })
  `) as Promise<unknown>
}

function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) =>
      setTimeout(() => reject(new Error(message)), 10_000),
    ),
  ])
}
