import type { BrowserWindow } from 'electron'

import type { HostPath } from '../../shared'

export async function openDeletionFixture(
  win: BrowserWindow,
  path: HostPath,
): Promise<void> {
  await rendererValue(
    win,
    `(() => {
      const row = document.querySelector(
        '.files-panel [role="treeitem"][title=${JSON.stringify(path.path)}]'
      );
      if (!(row instanceof HTMLButtonElement)) return undefined;
      const tab = document.querySelector(
        '.viewer-tab.active .tab-main[title=${JSON.stringify(path.path)}]'
      );
      if (tab) return true;
      row.click();
      return undefined;
    })()`,
    'clean deletion fixture did not open in the viewer',
    15_000,
  )
}

export async function deleteProjectEntryFromRenderer(options: {
  readonly win: BrowserWindow
  readonly root: HostPath
  readonly source: HostPath
  readonly recovery: 'recoverable' | 'permanent'
  readonly entry: 'pointer' | 'keyboard'
  readonly expectDirtyBlock?: boolean
  readonly expectClosedTab?: boolean
}): Promise<void> {
  const {
    win,
    root,
    source,
    recovery,
    entry,
    expectDirtyBlock = false,
    expectClosedTab = false,
  } = options
  const actionLabel =
    recovery === 'recoverable' ? 'Move to Trash…' : 'Delete Permanently…'
  const workspaceDisplay = `${root.hostId}:${root.path}`
  const sourceDisplay = `${source.hostId}:${source.path}`
  const operationDisplay =
    recovery === 'recoverable' ? 'Move to operating-system Trash' : 'Permanent deletion'
  const recoveryDisplay =
    recovery === 'recoverable'
      ? 'Available through the operating-system Trash.'
      : `None. ${source.hostId} does not provide recoverable deletion.`
  const successText =
    recovery === 'recoverable' ? 'Entry moved to Trash.' : 'Entry deleted permanently.'
  try {
    await rendererValue(
      win,
      `(() => {
        const source = document.querySelector(
          '.files-panel [role="treeitem"][title=${JSON.stringify(source.path)}]'
        );
        if (!window.__hvirDeletionMenu) {
          if (!(source instanceof HTMLButtonElement)) return undefined;
          ${
            entry === 'pointer'
              ? `source.dispatchEvent(new MouseEvent('contextmenu', {
                  bubbles: true, clientX: 38, clientY: 46
                }));`
              : `source.focus();
                source.dispatchEvent(new KeyboardEvent('keydown', {
                  key: 'F10', shiftKey: true, bubbles: true
                }));`
          }
          window.__hvirDeletionMenu = true;
          return undefined;
        }
        const action = [...document.querySelectorAll('.file-action-menu [role="menuitem"]')]
          .find((node) => node.textContent?.trim() === ${JSON.stringify(actionLabel)});
        if (!window.__hvirDeletionDialog) {
          if (!(action instanceof HTMLButtonElement) || action.disabled) return undefined;
          if (${JSON.stringify(entry)} === 'keyboard' && document.activeElement !== action) {
            const focused = document.activeElement;
            if (focused instanceof HTMLButtonElement &&
                focused.getAttribute('role') === 'menuitem') {
              focused.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'ArrowDown', bubbles: true
              }));
            }
            return undefined;
          }
          action.click();
          window.__hvirDeletionDialog = true;
          return undefined;
        }
        ${
          expectDirtyBlock
            ? `const feedback = document.querySelector('.file-operation-feedback.error');
              if (!feedback?.textContent?.includes('unsaved changes')) return undefined;
              if (document.querySelector('.file-deletion-dialog')) {
                throw new Error('dirty deletion guard opened a confirmation dialog');
              }
              const dirtyTab = document.querySelector(
                '.viewer-tab.active .tab-main[title=${JSON.stringify(source.path)}]'
              );
              if (!dirtyTab) {
                throw new Error('dirty deletion guard did not retain the dirty viewer tab');
              }
              return true;`
            : `if (window.__hvirDeletionSubmitted) {
                const feedback = document.querySelector('.file-operation-feedback');
                if (feedback?.classList.contains('error')) {
                  throw new Error(feedback.textContent || 'deletion failed');
                }
                if (document.querySelector('.file-deletion-dialog')) return undefined;
                if (!feedback?.textContent?.includes(${JSON.stringify(successText)})) {
                  return undefined;
                }
                if (document.querySelector(
                  '.files-panel [role="treeitem"][title=${JSON.stringify(source.path)}]'
                )) return undefined;
                ${
                  expectClosedTab
                    ? `if (document.querySelector(
                        '.viewer-tab .tab-main[title=${JSON.stringify(source.path)}]'
                      )) return undefined;`
                    : ''
                }
                return true;
              }
              const dialog = document.querySelector('.file-deletion-dialog');
              if (!(dialog instanceof HTMLFormElement)) return undefined;
              const facts = new Map([...dialog.querySelectorAll('dl > div')].map((row) => [
                row.querySelector('dt')?.textContent?.trim(),
                row.querySelector('dd')?.textContent?.trim()
              ]));
              if (facts.get('Workspace') !== ${JSON.stringify(workspaceDisplay)} ||
                  facts.get('Entry') !== ${JSON.stringify(sourceDisplay)} ||
                  facts.get('Operation') !== ${JSON.stringify(operationDisplay)} ||
                  facts.get('Recovery') !== ${JSON.stringify(recoveryDisplay)}) {
                throw new Error('deletion dialog lost its exact authority/recovery snapshot');
              }
              const submit = dialog.querySelector('button[type="submit"]');
              if (!(submit instanceof HTMLButtonElement)) return undefined;
              ${
                recovery === 'permanent'
                  ? `const input = dialog.querySelector('input');
                    if (!(input instanceof HTMLInputElement)) return undefined;
                    if (input.value !== ${JSON.stringify(source.path.split('/').pop())}) {
                      if (!submit.disabled) {
                        throw new Error('permanent deletion did not require exact-name confirmation');
                      }
                      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
                        ?.set?.call(input, ${JSON.stringify(source.path.split('/').pop())});
                      input.dispatchEvent(new Event('input', { bubbles: true }));
                      return undefined;
                    }
                    if (submit.disabled) return undefined;`
                  : `if (submit.disabled) return undefined;`
              }
              dialog.requestSubmit();
              window.__hvirDeletionSubmitted = true;
              return undefined;`
        }
      })()`,
      `${entry} ${recovery} deletion did not settle`,
      20_000,
    )
  } finally {
    await win.webContents.executeJavaScript(`
      document.querySelector('.file-operation-feedback button')?.click();
      delete window.__hvirDeletionMenu;
      delete window.__hvirDeletionDialog;
      delete window.__hvirDeletionSubmitted;
    `)
  }
}

export async function verifyProjectEntryDeletionRefresh(
  win: BrowserWindow,
  deletedPath: HostPath,
  retainedDirtyPath: HostPath,
): Promise<void> {
  await rendererValue(
    win,
    `(() => {
      if (document.querySelector(
        '.files-panel [role="treeitem"][title=${JSON.stringify(deletedPath.path)}]'
      )) return undefined;
      if (document.querySelector(
        '.viewer-tab .tab-main[title=${JSON.stringify(deletedPath.path)}]'
      )) return undefined;
      const retained = document.querySelector(
        '.viewer-tab .tab-main[title=${JSON.stringify(retainedDirtyPath.path)}]'
      );
      return retained ? true : undefined;
    })()`,
    'Files/viewer deletion refresh did not preserve the correct tab outcomes',
    15_000,
  )
  await rendererValue(
    win,
    `(() => {
      const trigger = document.querySelector('[data-filename-search-trigger]');
      if (!window.__hvirDeletionSearch) {
        if (!(trigger instanceof HTMLButtonElement)) return undefined;
        trigger.click();
        window.__hvirDeletionSearch = true;
        return undefined;
      }
      const input = document.querySelector('[data-filename-search]');
      if (!(input instanceof HTMLInputElement)) return undefined;
      if (input.value !== ${JSON.stringify(deletedPath.path.split('/').pop())}) {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
          ?.set?.call(input, ${JSON.stringify(deletedPath.path.split('/').pop())});
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return undefined;
      }
      const status = document.querySelector('.filename-search-status')?.textContent?.trim();
      const deletedResult = document.querySelector(
        '.filename-search-result[title=${JSON.stringify(deletedPath.path)}]'
      );
      return status === '0 files' && !deletedResult ? true : undefined;
    })()`,
    'filename search retained the deleted entry',
    20_000,
  )
  await win.webContents.executeJavaScript(`
    document.querySelector('.filename-search-close')?.click();
    delete window.__hvirDeletionSearch;
  `)
  await rendererValue(
    win,
    `(() => {
      const git = [...document.querySelectorAll('.rail-nav button')]
        .find((node) => node.textContent?.trim().startsWith('Git'));
      if (!(git instanceof HTMLButtonElement)) return undefined;
      if (git.getAttribute('aria-current') !== 'page') {
        git.click();
        return undefined;
      }
      if (document.querySelector('.git-empty')?.textContent?.includes('Loading changes')) {
        return undefined;
      }
      return document.querySelector(
        '.git-panel .git-file[title=${JSON.stringify(deletedPath.path)}]'
      ) ? undefined : true;
    })()`,
    'Git view retained the deleted entry',
    20_000,
  )
  await win.webContents.executeJavaScript(`
    [...document.querySelectorAll('.rail-nav button')]
      .find((node) => node.textContent?.trim() === 'Files')?.click();
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
