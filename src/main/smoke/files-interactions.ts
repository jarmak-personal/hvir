import type { BrowserWindow } from 'electron'

import { dirnameHostPath, hostPathEquals, type HostPath } from '../../shared'
import type { SmokeFailureCheckpoint } from './failure-evidence.mts'

export async function verifyFilesInteractionsSmoke(
  win: BrowserWindow,
  path: HostPath,
  revealedEntries: readonly HostPath[],
  checkpoint: (checkpoint: SmokeFailureCheckpoint) => void,
): Promise<void> {
  const expectedLabel =
    process.platform === 'darwin' ? 'Reveal in Finder' : 'Show in File Manager'
  const originalSize = win.getContentSize() as [number, number]
  try {
    checkpoint('project-files-local-reveal-menu-awaiting')
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
    )

    win.setContentSize(480, 320)
    await rendererValue(
      win,
      `window.innerWidth === 480 && window.innerHeight === 320 ? true : undefined`,
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
    )
    checkpoint('project-files-local-reveal-menu-ready')
    checkpoint('project-files-local-reveal-action-awaiting')
    await win.webContents.executeJavaScript(`
      [...document.querySelectorAll('.file-action-menu [role="menuitem"]')]
        .find((node) => node.textContent?.trim() === ${JSON.stringify(expectedLabel)})
        ?.click();
    `)
    await (async () => {
      while (!revealedEntries.some((candidate) => hostPathEquals(candidate, path))) {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    })()
    checkpoint('project-files-local-reveal-action-ready')

    checkpoint('project-files-local-path-menu-awaiting')
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
    )
    await win.webContents.executeJavaScript(
      `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`,
    )
    checkpoint('project-files-local-path-menu-ready')

    checkpoint('project-files-local-tree-focus-awaiting')
    await verifyPointerTreeFocus(win, path)
    checkpoint('project-files-local-tree-focus-ready')
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
      const failure = document.querySelector(
        '.terminal-surface.active .terminal-recovery-status'
      )?.textContent?.trim();
      if (failure) throw new Error('file interaction terminal failed: ' + failure);
      const create = document.querySelector('.terminal-empty button');
      if (!(create instanceof HTMLButtonElement)) return undefined;
      if (!window.__hvirFilesTerminalRequested) {
        create.click();
        window.__hvirFilesTerminalRequested = true;
      }
      return undefined;
    })()`,
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

function rendererValue(win: BrowserWindow, expression: string): Promise<unknown> {
  return win.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const poll = () => {
        try {
          const feedback = document.querySelector('.file-operation-feedback.error');
          if (feedback) {
            throw new Error(feedback.textContent || 'file interaction failed');
          }
          const value = ${expression};
          if (value) return resolve(value);
        } catch (error) {
          return reject(error);
        }
        setTimeout(poll, 25);
      };
      poll();
    })
  `) as Promise<unknown>
}
