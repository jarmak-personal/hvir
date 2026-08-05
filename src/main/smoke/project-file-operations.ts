import type { BrowserWindow } from 'electron'

import {
  containsHostPath,
  hostPathEquals,
  joinHostPath,
  type HostPath,
  type ProjectState,
} from '../../shared'
import type {
  ExclusiveCreateOptions,
  ProjectHost,
  ReadFileOptions,
} from '../project-host'

/**
 * Immediate deterministic remote filesystem boundary for the renderer smoke.
 * SshHost's SFTP mechanics remain covered by its adapter tests; this port keeps
 * the Electron scenario hermetic while preserving remote host-qualified paths.
 */
export function createRemoteProjectFileSmokeHost(options: {
  readonly localHost: ProjectHost
  readonly localRoot: HostPath
  readonly remoteRoot: HostPath
}): ProjectHost {
  const { localHost, localRoot, remoteRoot } = options
  const toLocal = (path: HostPath): HostPath => {
    if (!containsHostPath(remoteRoot, path)) {
      throw new Error('Remote smoke path escapes its registered workspace')
    }
    const suffix = path.path.slice(remoteRoot.path.length).replace(/^\//, '')
    return suffix ? joinHostPath(localRoot, suffix) : localRoot
  }
  const toRemote = (path: HostPath): HostPath => {
    if (!containsHostPath(localRoot, path)) {
      throw new Error('Local smoke path escapes its registered workspace')
    }
    const suffix = path.path.slice(localRoot.path.length).replace(/^\//, '')
    return suffix ? joinHostPath(remoteRoot, suffix) : remoteRoot
  }
  return {
    hostId: remoteRoot.hostId,
    connectionState: 'connected',
    watchTier: 'polling',
    onConnectionState(callback) {
      callback('connected')
      return () => undefined
    },
    async realpath(path) {
      return toRemote(await localHost.realpath(toLocal(path)))
    },
    stat: (path) => localHost.stat(toLocal(path)),
    readdir: (path) => localHost.readdir(toLocal(path)),
    readFile: (path, readOptions?: ReadFileOptions) =>
      localHost.readFile(toLocal(path), readOptions),
    createFileExclusive: (path, createOptions: ExclusiveCreateOptions) =>
      localHost.createFileExclusive(toLocal(path), createOptions),
    createDirectoryExclusive: (path, createOptions: ExclusiveCreateOptions) =>
      localHost.createDirectoryExclusive(toLocal(path), createOptions),
  } as ProjectHost
}

export async function verifyProjectFileOperationsSmoke(options: {
  readonly win: BrowserWindow
  readonly localHost: ProjectHost
  readonly localRoot: HostPath
  readonly remoteRoot: HostPath
  readonly switchedRoot: HostPath
  readonly localState: () => ProjectState
  readonly remoteState: () => ProjectState
  readonly switchedState: () => ProjectState
  readonly publish: (state: ProjectState) => void
}): Promise<string> {
  const {
    win,
    localHost,
    localRoot,
    remoteRoot,
    switchedRoot,
    localState,
    remoteState,
    switchedState,
    publish,
  } = options
  const pointerName = '.hvir-smoke-created-pointer.txt'
  const keyboardName = '.hvir-smoke-created-keyboard'
  const snapshotName = '.hvir-smoke-created-snapshot.txt'
  const pointerPath = joinHostPath(localRoot, pointerName)
  const keyboardPath = joinHostPath(localRoot, keyboardName)
  const snapshotPath = joinHostPath(localRoot, snapshotName)
  const switchedPath = joinHostPath(switchedRoot, snapshotName)

  try {
    publish(localState())
    await createFromRenderer({
      win,
      root: localRoot,
      name: pointerName,
      kind: 'file',
      entry: 'pointer',
    })
    const pointerStat = await localHost.stat(pointerPath)
    if (pointerStat.type !== 'file' || pointerStat.size !== 0) {
      throw new Error('pointer create did not produce one empty regular file')
    }

    publish(remoteState())
    await createFromRenderer({
      win,
      root: remoteRoot,
      name: keyboardName,
      kind: 'directory',
      entry: 'keyboard',
    })
    if ((await localHost.stat(keyboardPath)).type !== 'dir') {
      throw new Error('remote keyboard create did not produce one directory')
    }

    publish(localState())
    const originalCreate = localHost.createFileExclusive.bind(localHost)
    let releaseCreate: (() => void) | undefined
    let markEntered: (() => void) | undefined
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve
    })
    const release = new Promise<void>((resolve) => {
      releaseCreate = resolve
    })
    localHost.createFileExclusive = async (path, createOptions) => {
      if (hostPathEquals(path, snapshotPath)) {
        markEntered?.()
        await release
      }
      return originalCreate(path, createOptions)
    }
    try {
      await submitCreateFromRenderer(win, localRoot, snapshotName)
      await withTimeout(entered, 'snapshot create did not reach its approved effect')
      publish(switchedState())
      await waitForActiveRoot(win, switchedRoot)
      releaseCreate?.()
      await waitForHostPath(localHost, snapshotPath)
      try {
        await localHost.stat(switchedPath)
        throw new Error('workspace switch retargeted an accepted file create')
      } catch (reason) {
        if (!isMissingPathError(reason)) throw reason
      }
      await rendererValue(
        win,
        `(() => {
          const lateTab = [...document.querySelectorAll('.viewer-tab .tab-main')]
            .some((node) => node.getAttribute('title') === ${JSON.stringify(snapshotPath.path)});
          return !lateTab && !document.querySelector('.file-create-dialog')
            ? 'late completion ignored by replacement workspace'
            : undefined;
        })()`,
        'replacement workspace consumed a late create completion',
      )
    } finally {
      releaseCreate?.()
      localHost.createFileExclusive = originalCreate
    }

    return 'pointer file→source + tree · keyboard remote directory→selected · workspace switch preserved snapshot'
  } catch (reason) {
    const state = await readProjectFileSmokeState(win)
    throw new Error(
      `Project file operation smoke failed: ${
        reason instanceof Error ? reason.message : String(reason)
      }; state=${JSON.stringify(state)}`,
      { cause: reason },
    )
  } finally {
    publish(localState())
  }
}

async function createFromRenderer(options: {
  readonly win: BrowserWindow
  readonly root: HostPath
  readonly name: string
  readonly kind: 'file' | 'directory'
  readonly entry: 'pointer' | 'keyboard'
}): Promise<void> {
  const { win, root, name, kind, entry } = options
  const destination = `${root.hostId}:${root.path}`
  const targetPath = joinHostPath(root, name).path
  await rendererValue(
    win,
    `(() => {
      const root = document.querySelector(
        '.files-panel .directory-row[title=${JSON.stringify(root.path)}]'
      );
      if (!(root instanceof HTMLButtonElement)) return undefined;
      if (!window.__hvirProjectFileMenu) {
        ${
          entry === 'pointer'
            ? `root.dispatchEvent(new MouseEvent('contextmenu', {
                bubbles: true, clientX: 24, clientY: 32
              }));`
            : `root.focus();
              root.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'F10', shiftKey: true, bubbles: true
              }));`
        }
        window.__hvirProjectFileMenu = true;
        return undefined;
      }
      const action = [...document.querySelectorAll('.file-action-menu [role="menuitem"]')]
        .find((node) => node.textContent?.trim() === ${JSON.stringify(
          kind === 'file' ? 'New File…' : 'New Folder…',
        )});
      if (!window.__hvirProjectFileDialog) {
        if (!(action instanceof HTMLButtonElement)) return undefined;
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
        window.__hvirProjectFileDialog = true;
        return undefined;
      }
      if (window.__hvirProjectFileSubmitted) {
        const created = document.querySelector(
          '.files-panel [role="treeitem"][title=${JSON.stringify(targetPath)}]'
        );
        if (${JSON.stringify(kind)} === 'file') {
          const tab = document.querySelector(
            '.viewer-tab.active .tab-main[title=${JSON.stringify(targetPath)}]'
          );
          const source = document.querySelector(
            '.mode-control button[aria-pressed="true"]'
          );
          return created && tab && source?.textContent?.trim() === 'source'
            ? true
            : undefined;
        }
        return created?.getAttribute('aria-selected') === 'true' ? true : undefined;
      }
      const dialog = document.querySelector('.file-create-dialog');
      const input = dialog?.querySelector('input');
      const codes = [...(dialog?.querySelectorAll('code') || [])]
        .map((node) => node.textContent?.trim());
      if (!(dialog instanceof HTMLFormElement) || !(input instanceof HTMLInputElement)) {
        return undefined;
      }
      if (codes.length !== 2 || codes.some((value) => value !== ${JSON.stringify(destination)})) {
        throw new Error('create dialog did not preserve the exact workspace and destination');
      }
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
        ?.set?.call(input, ${JSON.stringify(name)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      dialog.requestSubmit();
      window.__hvirProjectFileSubmitted = true;
      return undefined;
    })()`,
    `${entry} ${kind} creation did not settle`,
    15_000,
  )
  await clearRendererCreateMarkers(win)
}

async function submitCreateFromRenderer(
  win: BrowserWindow,
  root: HostPath,
  name: string,
): Promise<void> {
  await clearRendererCreateMarkers(win)
  await rendererValue(
    win,
    `(() => {
      const row = document.querySelector(
        '.files-panel .directory-row[title=${JSON.stringify(root.path)}]'
      );
      if (!(row instanceof HTMLButtonElement)) return undefined;
      if (!window.__hvirProjectFileMenu) {
        row.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true, clientX: 28, clientY: 36
        }));
        window.__hvirProjectFileMenu = true;
        return undefined;
      }
      const action = [...document.querySelectorAll('.file-action-menu [role="menuitem"]')]
        .find((node) => node.textContent?.trim() === 'New File…');
      if (!window.__hvirProjectFileDialog) {
        if (!(action instanceof HTMLButtonElement)) return undefined;
        action.click();
        window.__hvirProjectFileDialog = true;
        return undefined;
      }
      const dialog = document.querySelector('.file-create-dialog');
      const input = dialog?.querySelector('input');
      if (!(dialog instanceof HTMLFormElement) || !(input instanceof HTMLInputElement)) {
        return undefined;
      }
      if (!window.__hvirProjectFileSubmitted) {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
          ?.set?.call(input, ${JSON.stringify(name)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
        dialog.requestSubmit();
        window.__hvirProjectFileSubmitted = true;
        return undefined;
      }
      return dialog.textContent?.includes('Creating…') ? true : undefined;
    })()`,
    'snapshot create was not submitted',
  )
}

function waitForActiveRoot(win: BrowserWindow, root: HostPath): Promise<unknown> {
  return rendererValue(
    win,
    `document.querySelector('.files-panel .directory-row[title=${JSON.stringify(
      root.path,
    )}]') ? true : undefined`,
    'replacement workspace tree did not settle',
  )
}

async function waitForHostPath(host: ProjectHost, path: HostPath): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() <= deadline) {
    try {
      await host.stat(path)
      return
    } catch (reason) {
      if (!isMissingPathError(reason)) throw reason
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('accepted create did not complete at its snapshotted path')
}

function clearRendererCreateMarkers(win: BrowserWindow): Promise<unknown> {
  return win.webContents.executeJavaScript(`
    delete window.__hvirProjectFileMenu;
    delete window.__hvirProjectFileDialog;
    delete window.__hvirProjectFileSubmitted;
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

function isMissingPathError(reason: unknown): boolean {
  return (
    typeof reason === 'object' &&
    reason !== null &&
    (reason as { code?: unknown }).code === 'ENOENT'
  )
}

async function readProjectFileSmokeState(win: BrowserWindow): Promise<unknown> {
  if (win.isDestroyed()) return { renderer: 'destroyed' }
  return win.webContents.executeJavaScript(`
    (() => ({
      project: document.querySelector('.project-tab.active')?.textContent?.trim().slice(0, 120),
      root: document.querySelector('.files-panel .directory-row')?.getAttribute('title'),
      menu: document.querySelector('.file-action-menu')?.textContent?.trim().slice(0, 160),
      dialog: document.querySelector('.file-create-dialog')?.textContent?.trim().slice(0, 200),
      activeTab: document.querySelector('.viewer-tab.active .tab-main')?.getAttribute('title'),
      mode: document.querySelector('.mode-control button[aria-pressed="true"]')
        ?.textContent?.trim(),
      treeRows: [...document.querySelectorAll('.files-panel [role="treeitem"]')]
        .map((node) => node.getAttribute('title'))
        .filter((value) => value?.includes('hvir-smoke-created'))
        .slice(0, 12)
    }))()
  `)
}
