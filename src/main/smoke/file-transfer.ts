import { pathToFileURL } from 'node:url'
import { ElectronClipboardFileSource } from '../project-file-operations/electron-clipboard-files'
import { writeMacFilePasteboard } from './macos-file-pasteboard'
import { clipboard, dialog, type BrowserWindow } from 'electron'
import { joinHostPath, type HostPath } from '../../shared'
import type { ProjectHost } from '../project-host'

export async function pasteClipboardFromRenderer(
  win: BrowserWindow,
  root: HostPath,
  name: string,
): Promise<void> {
  const destination = joinHostPath(root, name)
  await rendererValue(
    win,
    `(() => {
      const row = document.querySelector(
        '.files-panel .directory-row[title=${JSON.stringify(root.path)}]'
      );
      if (!(row instanceof HTMLButtonElement)) return undefined;
      if (!window.__hvirClipboardPasteSent) {
        row.focus();
        row.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'v', bubbles: true,
          metaKey: ${process.platform === 'darwin'},
          ctrlKey: ${process.platform !== 'darwin'}
        }));
        window.__hvirClipboardPasteSent = true;
        return undefined;
      }
      const feedback = document.querySelector('.file-operation-feedback.error');
      if (feedback) throw new Error(feedback.textContent || 'clipboard paste failed');
      return document.querySelector(
        '.files-panel [role="treeitem"][title=${JSON.stringify(destination.path)}]'
      ) ? true : undefined;
    })()`,
  )
  await win.webContents.executeJavaScript('delete window.__hvirClipboardPasteSent')
}

export async function dropDiskFileFromRenderer(
  win: BrowserWindow,
  root: HostPath,
  source: string,
  name: string,
): Promise<void> {
  const debuggerPort = win.webContents.debugger
  const attachedHere = !debuggerPort.isAttached()
  if (attachedHere) debuggerPort.attach('1.3')
  try {
    await win.webContents.executeJavaScript(`
      document.querySelector('#hvir-smoke-drop-input')?.remove();
      const input = document.createElement('input');
      input.id = 'hvir-smoke-drop-input';
      input.type = 'file';
      input.hidden = true;
      document.body.append(input);
    `)
    const document = (await debuggerPort.sendCommand('DOM.getDocument')) as {
      root: { nodeId: number }
    }
    const input = (await debuggerPort.sendCommand('DOM.querySelector', {
      nodeId: document.root.nodeId,
      selector: '#hvir-smoke-drop-input',
    })) as { nodeId: number }
    await debuggerPort.sendCommand('DOM.setFileInputFiles', {
      nodeId: input.nodeId,
      files: [source],
    })
    const destination = joinHostPath(root, name)
    await rendererValue(
      win,
      `(() => {
        const row = document.querySelector(
          '.files-panel .directory-row[title=${JSON.stringify(root.path)}]'
        );
        const file = document.querySelector('#hvir-smoke-drop-input')?.files?.[0];
        if (!(row instanceof HTMLButtonElement) || !(file instanceof File)) {
          return undefined;
        }
        if (!window.__hvirDropSent) {
          const transfer = new DataTransfer();
          transfer.items.add(file);
          row.dispatchEvent(new DragEvent('dragover', {
            bubbles: true, cancelable: true, dataTransfer: transfer
          }));
          row.dispatchEvent(new DragEvent('drop', {
            bubbles: true, cancelable: true, dataTransfer: transfer
          }));
          window.__hvirDropSent = true;
          return undefined;
        }
        const feedback = document.querySelector('.file-operation-feedback.error');
        if (feedback) throw new Error(feedback.textContent || 'disk drop failed');
        return document.querySelector(
          '.files-panel [role="treeitem"][title=${JSON.stringify(destination.path)}]'
        ) ? true : undefined;
      })()`,
    )
  } finally {
    await win.webContents.executeJavaScript(`
      document.querySelector('#hvir-smoke-drop-input')?.remove();
      delete window.__hvirDropSent;
    `)
    if (attachedHere && debuggerPort.isAttached()) debuggerPort.detach()
  }
}

export function rendererValue(
  win: BrowserWindow,
  expression: string,
  waitFor?: string,
): Promise<unknown> {
  return win.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const deadline = Date.now() + 15000;
      const poll = () => {
        if (${JSON.stringify(waitFor)} && Date.now() > deadline) {
          return reject(new Error('Timed out waiting for ' + ${JSON.stringify(waitFor)}));
        }
        try {
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

/** Real renderer/preload/coordinator/LocalHost pipeline; remote transport is the explicit smoke port. */
export async function verifySshDownloadSmoke(options: {
  readonly win: BrowserWindow
  readonly localHost: ProjectHost
  readonly localRoot: HostPath
  readonly remoteRoot: HostPath
  readonly sourceName: string
}): Promise<void> {
  const { win, localHost, localRoot, remoteRoot, sourceName } = options
  const destination = joinHostPath(localRoot, '.hvir-smoke-downloads')
  await localHost.createDirectoryExclusive(destination, { mode: 0o755 })
  const originalPicker = dialog.showOpenDialog.bind(dialog)
  let selections = 0
  dialog.showOpenDialog = () => {
    selections += 1
    return Promise.resolve({ canceled: false, filePaths: [destination.path] })
  }
  try {
    await rendererValue(
      win,
      `(() => {
      const row = document.querySelector('[data-file-path=' + ${JSON.stringify(JSON.stringify(joinHostPath(remoteRoot, sourceName).path))} + ']');
      if (!(row instanceof HTMLElement)) return undefined;
      const button = [...document.querySelectorAll('.file-download-controls button')].find(node => node.textContent === 'Download…');
      // A completed copy can still publish a watcher refresh, which intentionally
      // clears download selection. Reacquire the exact visible source after that
      // invalidation; never retry the download operation itself.
      if (!window.__hvirDownloadSelected || (button instanceof HTMLButtonElement && button.disabled && button.title === 'Select a file or folder to download')) {
        row.click(); window.__hvirDownloadSelected = true; return undefined;
      }
      return button instanceof HTMLButtonElement && !button.disabled;
    })()`,
      'the exact SSH download selection after filesystem refresh',
    )
    await win.webContents.executeJavaScript(`
      window.__hvirDownloadFinished = false;
      window.__hvirDownloadListener = window.hvir.on('fs:project-file-operation', event => {
        if (event.workspaceRoot.hostId === ${JSON.stringify(remoteRoot.hostId)} && event.phase === 'completed') {
          window.__hvirDownloadFinished = event.result?.items?.[0]?.status === 'completed' ? 'completed' : 'failed';
        }
      });
      document.querySelector('.file-download-controls button').click();
    `)
    await rendererValue(
      win,
      `(() => {
      if (window.__hvirDownloadFinished === 'failed') throw new Error('SSH download failed');
      if (document.querySelector('[role="dialog"]')) throw new Error('Download requested an extra confirmation');
      return window.__hvirDownloadFinished === 'completed';
    })()`,
      'SSH download completion',
    )
    if (selections !== 1)
      throw new Error('Download did not use exactly one native selection')
    if (
      (await localHost.readTextFile(joinHostPath(destination, sourceName))) !==
        'drop smoke payload' ||
      (await localHost.readTextFile(joinHostPath(localRoot, sourceName))) !==
        'drop smoke payload'
    ) {
      throw new Error('SSH download changed source or destination bytes')
    }
  } finally {
    dialog.showOpenDialog = originalPicker
    await win.webContents.executeJavaScript(`
      window.__hvirDownloadListener?.();
      delete window.__hvirDownloadListener;
      delete window.__hvirDownloadFinished;
      delete window.__hvirDownloadSelected;
    `)
  }
}

/** Shared native acquisition for the preserved local and SSH paste paths. */
export async function setFileClipboard(
  localHost: ProjectHost,
  clipboardSource: HostPath,
): Promise<void> {
  const clipboardFormat =
    process.platform === 'darwin' ? 'public.file-url' : 'text/uri-list'
  if (process.platform === 'darwin') {
    await writeMacFilePasteboard(localHost, clipboardSource)
  } else {
    clipboard.writeBuffer(
      clipboardFormat,
      Buffer.from(`${pathToFileURL(clipboardSource.path).href}\r\n`),
    )
  }
  if (process.platform === 'darwin') {
    await waitForMacClipboardFileList(clipboardSource.path)
  } else if (
    !new ElectronClipboardFileSource().readPaths().includes(clipboardSource.path)
  ) {
    const availableFormats = clipboard.availableFormats()
    throw new Error(
      `smoke clipboard did not retain reviewed ${clipboardFormat} file-list data; available=${availableFormats.join(',')}`,
    )
  }
}

async function waitForMacClipboardFileList(expectedPath: string): Promise<void> {
  const source = new ElectronClipboardFileSource()
  for (;;) {
    if (source.readPaths().includes(expectedPath)) return
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
  }
}

export async function verifySshClipboardPasteSmoke(options: {
  readonly win: BrowserWindow
  readonly localHost: ProjectHost
  readonly localRoot: HostPath
  readonly remoteRoot: HostPath
  readonly externalDirectory: HostPath
}): Promise<void> {
  const { win, localHost, localRoot, remoteRoot, externalDirectory } = options
  const name = '.hvir-smoke-ssh-paste.txt'
  const source = joinHostPath(externalDirectory, name)
  await localHost.writeFile(source, 'SSH clipboard input')
  try {
    await setFileClipboard(localHost, source)
    await pasteClipboardFromRenderer(win, remoteRoot, name)
    if (
      (await localHost.readTextFile(joinHostPath(localRoot, name))) !==
        'SSH clipboard input' ||
      (await localHost.readTextFile(source)) !== 'SSH clipboard input'
    ) {
      throw new Error('SSH clipboard import changed bytes or its local source')
    }
  } finally {
    await localHost.removeFile(source, { ignoreMissing: true })
  }
}
