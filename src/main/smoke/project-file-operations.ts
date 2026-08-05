import { clipboard, type BrowserWindow } from 'electron'
import { pathToFileURL } from 'node:url'

import {
  containsHostPath,
  dirnameHostPath,
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
import { ElectronClipboardFileSource } from '../project-file-operations/electron-clipboard-files'
import { writeMacFilePasteboard } from './macos-file-pasteboard'

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
    fileTransfer: localHost.fileTransfer
      ? {
          readFileChunks: (path, streamOptions) =>
            localHost.fileTransfer!.readFileChunks(toLocal(path), streamOptions),
          writeFileChunksExclusive: (path, chunks, streamOptions) =>
            localHost.fileTransfer!.writeFileChunksExclusive(
              toLocal(path),
              chunks,
              streamOptions,
            ),
          setMetadata: (path, metadataOptions) =>
            localHost.fileTransfer!.setMetadata(toLocal(path), metadataOptions),
          renameNoReplace: (source, destination, streamOptions) =>
            localHost.fileTransfer!.renameNoReplace(
              toLocal(source),
              toLocal(destination),
              streamOptions,
            ),
          removeDirectory: (path, removeOptions) =>
            localHost.fileTransfer!.removeDirectory(toLocal(path), removeOptions),
        }
      : undefined,
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
  const renamedName = '.hvir-smoke-renamed-pointer.txt'
  const keyboardName = '.hvir-smoke-created-keyboard'
  const organizationDirectoryName = '.hvir-smoke-organization-target'
  const duplicatedName = '.hvir-smoke-duplicated-pointer.txt'
  const snapshotName = '.hvir-smoke-created-snapshot.txt'
  const clipboardName = '.hvir-smoke-copied-clipboard.txt'
  const droppedName = '.hvir-smoke-copied-drop.txt'
  const pointerPath = joinHostPath(localRoot, pointerName)
  const renamedPath = joinHostPath(localRoot, renamedName)
  const keyboardPath = joinHostPath(localRoot, keyboardName)
  const organizationDirectory = joinHostPath(localRoot, organizationDirectoryName)
  const movedPointerPath = joinHostPath(organizationDirectory, renamedName)
  const duplicatedPath = joinHostPath(organizationDirectory, duplicatedName)
  const remoteKeyboardPath = joinHostPath(remoteRoot, keyboardName)
  const remoteOrganizationDirectory = joinHostPath(remoteRoot, organizationDirectoryName)
  const movedKeyboardPath = joinHostPath(organizationDirectory, keyboardName)
  const snapshotPath = joinHostPath(localRoot, snapshotName)
  const switchedPath = joinHostPath(switchedRoot, snapshotName)
  const externalDirectory = dirnameHostPath(localRoot)
  const clipboardSource = joinHostPath(externalDirectory, clipboardName)
  const droppedSource = joinHostPath(externalDirectory, droppedName)

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
    const organizationPayload = 'organization smoke payload\n'
    await localHost.writeFile(pointerPath, organizationPayload)
    await waitForEditorContent(win, organizationPayload)
    await organizeFromRenderer({
      win,
      root: localRoot,
      source: pointerPath,
      action: 'rename',
      name: renamedName,
      destination: renamedPath,
      entry: 'pointer',
      expectActiveTab: true,
    })
    await expectMissingHostPath(localHost, pointerPath)
    if ((await localHost.readTextFile(renamedPath)) !== organizationPayload) {
      throw new Error('rename did not preserve exact file content')
    }

    await createFromRenderer({
      win,
      root: localRoot,
      name: organizationDirectoryName,
      kind: 'directory',
      entry: 'pointer',
    })
    await markActiveEditorDirty(win, 'unsaved organization marker')
    await organizeFromRenderer({
      win,
      root: localRoot,
      source: renamedPath,
      action: 'move',
      destinationDirectory: organizationDirectory,
      destination: movedPointerPath,
      entry: 'pointer',
      expectActiveTab: true,
      expectDirtyText: 'unsaved organization marker',
    })
    await expectMissingHostPath(localHost, renamedPath)
    if ((await localHost.readTextFile(movedPointerPath)) !== organizationPayload) {
      throw new Error('move did not preserve the saved file bytes')
    }

    await revealTreeDirectory(win, organizationDirectory)
    await organizeFromRenderer({
      win,
      root: localRoot,
      source: movedPointerPath,
      action: 'duplicate',
      name: duplicatedName,
      destinationDirectory: organizationDirectory,
      destination: duplicatedPath,
      entry: 'pointer',
    })
    if ((await localHost.readTextFile(duplicatedPath)) !== organizationPayload) {
      throw new Error('duplicate did not preserve exact saved file bytes')
    }
    await verifyOrganizationRefresh(win, duplicatedPath)

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
    await organizeFromRenderer({
      win,
      root: remoteRoot,
      source: remoteKeyboardPath,
      action: 'move',
      destinationDirectory: remoteOrganizationDirectory,
      destination: joinHostPath(remoteOrganizationDirectory, keyboardName),
      entry: 'keyboard',
    })
    await expectMissingHostPath(localHost, keyboardPath)
    if ((await localHost.stat(movedKeyboardPath)).type !== 'dir') {
      throw new Error('remote keyboard move did not preserve the directory')
    }

    publish(localState())
    await localHost.writeFile(clipboardSource, 'clipboard smoke payload')
    await localHost.writeFile(droppedSource, 'drop smoke payload')
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
    await pasteClipboardFromRenderer(win, localRoot, clipboardName)
    const clipboardDestination = joinHostPath(localRoot, clipboardName)
    await waitForHostPath(localHost, clipboardDestination)
    if (
      (await localHost.readTextFile(clipboardDestination)) !== 'clipboard smoke payload'
    ) {
      throw new Error('clipboard copy did not preserve exact file content')
    }

    publish(remoteState())
    await dropDiskFileFromRenderer(win, remoteRoot, droppedSource.path, droppedName)
    const droppedDestination = joinHostPath(localRoot, droppedName)
    await waitForHostPath(localHost, droppedDestination)
    if ((await localHost.readTextFile(droppedDestination)) !== 'drop smoke payload') {
      throw new Error('remote drop copy did not preserve exact file content')
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

    return 'pointer create + clean rename · dirty-tab move · verified duplicate + tree/search/Git refresh · keyboard remote directory move · clipboard local copy · preload drop remote copy · workspace switch preserved snapshot'
  } catch (reason) {
    const state = await readProjectFileSmokeState(win)
    throw new Error(
      `Project file operation smoke failed: ${
        reason instanceof Error ? reason.message : String(reason)
      }; state=${JSON.stringify(state)}`,
      { cause: reason },
    )
  } finally {
    clipboard.clear()
    await Promise.all([
      localHost.removeFile(clipboardSource, { ignoreMissing: true }),
      localHost.removeFile(droppedSource, { ignoreMissing: true }),
    ])
    publish(localState())
  }
}

async function organizeFromRenderer(options: {
  readonly win: BrowserWindow
  readonly root: HostPath
  readonly source: HostPath
  readonly action: 'rename' | 'move' | 'duplicate'
  readonly destination: HostPath
  readonly destinationDirectory?: HostPath
  readonly name?: string
  readonly entry: 'pointer' | 'keyboard'
  readonly expectActiveTab?: boolean
  readonly expectDirtyText?: string
}): Promise<void> {
  const {
    win,
    root,
    source,
    action,
    destination,
    destinationDirectory,
    name,
    entry,
    expectActiveTab = false,
    expectDirtyText,
  } = options
  const label = `${action[0]!.toUpperCase()}${action.slice(1)}…`
  const workspaceDisplay = `${root.hostId}:${root.path}`
  const sourceDisplay = `${source.hostId}:${source.path}`
  const destinationDisplay = destinationDirectory
    ? `${destinationDirectory.hostId}:${destinationDirectory.path}`
    : undefined
  try {
    await rendererValue(
      win,
      `(() => {
        if (window.__hvirOrganizationSubmitted) {
          const feedback = document.querySelector('.file-operation-feedback.error');
          if (feedback) throw new Error(feedback.textContent || 'organization failed');
          if (document.querySelector('.file-organization-dialog')) return undefined;
          ${
            expectActiveTab
              ? `const tab = document.querySelector(
                  '.viewer-tab.active .tab-main[title=${JSON.stringify(destination.path)}]'
                );
                if (!tab) return undefined;`
              : ''
          }
          ${
            expectDirtyText
              ? `if (!document.querySelector('.viewer-tab.active .tab-status')
                    ?.textContent?.trim()) return undefined;
                if (!document.querySelector('.cm-content')?.textContent
                    ?.includes(${JSON.stringify(expectDirtyText)})) return undefined;`
              : ''
          }
          return true;
        }
        const source = document.querySelector(
          '.files-panel [role="treeitem"][title=${JSON.stringify(source.path)}]'
        );
        if (!(source instanceof HTMLButtonElement)) return undefined;
        if (!window.__hvirOrganizationMenu) {
          ${
            entry === 'pointer'
              ? `source.dispatchEvent(new MouseEvent('contextmenu', {
                  bubbles: true, clientX: 34, clientY: 42
                }));`
              : `source.focus();
                source.dispatchEvent(new KeyboardEvent('keydown', {
                  key: 'F10', shiftKey: true, bubbles: true
                }));`
          }
          window.__hvirOrganizationMenu = true;
          return undefined;
        }
        const action = [...document.querySelectorAll('.file-action-menu [role="menuitem"]')]
          .find((node) => node.textContent?.trim() === ${JSON.stringify(label)});
        if (!window.__hvirOrganizationDialog) {
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
          window.__hvirOrganizationDialog = true;
          return undefined;
        }
        const dialog = document.querySelector('.file-organization-dialog');
        if (!(dialog instanceof HTMLFormElement)) return undefined;
        const facts = new Map([...dialog.querySelectorAll('dl > div')].map((row) => [
          row.querySelector('dt')?.textContent?.trim(),
          row.querySelector('code')?.textContent?.trim()
        ]));
        if (facts.get('Workspace') !== ${JSON.stringify(workspaceDisplay)} ||
            facts.get('Source') !== ${JSON.stringify(sourceDisplay)}) {
          throw new Error('organization dialog lost its workspace/source snapshot');
        }
        ${
          destinationDirectory
            ? `const target = dialog.querySelector(
                '.file-organization-picker [role="treeitem"][title=${JSON.stringify(
                  destinationDirectory.path,
                )}]'
              );
              if (!(target instanceof HTMLButtonElement)) return undefined;
              if (target.getAttribute('aria-selected') !== 'true') {
                if (${JSON.stringify(entry)} === 'keyboard' &&
                    document.activeElement !== target) {
                  const focused = document.activeElement;
                  if (focused instanceof HTMLButtonElement &&
                      focused.getAttribute('role') === 'treeitem') {
                    focused.dispatchEvent(new KeyboardEvent('keydown', {
                      key: 'ArrowDown', bubbles: true
                    }));
                  }
                  return undefined;
                }
                target.click();
                return undefined;
              }
              if (facts.get('Destination') !== ${JSON.stringify(destinationDisplay)}) {
                return undefined;
              }`
            : ''
        }
        ${
          name
            ? `const input = dialog.querySelector('input');
              if (!(input instanceof HTMLInputElement)) return undefined;
              if (input.value !== ${JSON.stringify(name)}) {
                Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
                  ?.set?.call(input, ${JSON.stringify(name)});
                input.dispatchEvent(new Event('input', { bubbles: true }));
                return undefined;
              }`
            : ''
        }
        dialog.requestSubmit();
        window.__hvirOrganizationSubmitted = true;
        return undefined;
      })()`,
      `${entry} ${action} did not settle`,
      20_000,
    )
  } finally {
    await win.webContents.executeJavaScript(`
      delete window.__hvirOrganizationMenu;
      delete window.__hvirOrganizationDialog;
      delete window.__hvirOrganizationSubmitted;
    `)
  }
}

async function waitForEditorContent(win: BrowserWindow, content: string): Promise<void> {
  await rendererValue(
    win,
    `document.querySelector('.cm-content')?.textContent?.includes(${JSON.stringify(
      content.trim(),
    )}) ? true : undefined`,
    'clean open file did not refresh after its saved content changed',
    15_000,
  )
}

async function markActiveEditorDirty(win: BrowserWindow, marker: string): Promise<void> {
  await win.webContents.executeJavaScript(
    `document.querySelector('.cm-content')?.focus()`,
  )
  await win.webContents.insertText(`${marker}\n`)
  await rendererValue(
    win,
    `document.querySelector('.viewer-tab.active .tab-status')?.textContent?.includes('●') &&
      document.querySelector('.cm-content')?.textContent?.includes(${JSON.stringify(marker)})
        ? true
        : undefined`,
    'editor did not retain the unsaved organization marker',
  )
}

async function revealTreeDirectory(win: BrowserWindow, path: HostPath): Promise<void> {
  await rendererValue(
    win,
    `(() => {
      const row = document.querySelector(
        '.files-panel .directory-row[title=${JSON.stringify(path.path)}]'
      );
      if (!(row instanceof HTMLButtonElement)) return undefined;
      if (row.getAttribute('aria-expanded') !== 'true') {
        row.click();
        return undefined;
      }
      return true;
    })()`,
    'organization destination did not expand in the Files tree',
  )
}

async function verifyOrganizationRefresh(
  win: BrowserWindow,
  duplicatedPath: HostPath,
): Promise<void> {
  await rendererValue(
    win,
    `document.querySelector(
      '.files-panel [role="treeitem"][title=${JSON.stringify(duplicatedPath.path)}]'
    ) ? true : undefined`,
    'Files tree did not refresh for the duplicate',
    15_000,
  )
  await rendererValue(
    win,
    `(() => {
      const trigger = document.querySelector('[data-filename-search-trigger]');
      if (!window.__hvirOrganizationSearch) {
        if (!(trigger instanceof HTMLButtonElement)) return undefined;
        trigger.click();
        window.__hvirOrganizationSearch = true;
        return undefined;
      }
      const input = document.querySelector('[data-filename-search]');
      if (!(input instanceof HTMLInputElement)) return undefined;
      if (input.value !== ${JSON.stringify(duplicatedPath.path.split('/').pop())}) {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
          ?.set?.call(input, ${JSON.stringify(duplicatedPath.path.split('/').pop())});
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return undefined;
      }
      return document.querySelector(
        '.filename-search-result[title=${JSON.stringify(duplicatedPath.path)}]'
      ) ? true : undefined;
    })()`,
    'filename search did not refresh for the duplicate',
    20_000,
  )
  await win.webContents.executeJavaScript(`
    document.querySelector('.filename-search-close')?.click();
    delete window.__hvirOrganizationSearch;
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
      return document.querySelector(
        '.git-panel .git-file[title=${JSON.stringify(duplicatedPath.path)}]'
      ) ? true : undefined;
    })()`,
    'Git view did not refresh for the duplicate',
    20_000,
  )
  await win.webContents.executeJavaScript(`
    [...document.querySelectorAll('.rail-nav button')]
      .find((node) => node.textContent?.trim() === 'Files')?.click();
  `)
}

async function expectMissingHostPath(host: ProjectHost, path: HostPath): Promise<void> {
  try {
    await host.stat(path)
  } catch (reason) {
    if (isMissingPathError(reason)) return
    throw reason
  }
  throw new Error(`source remained after organization: ${path.path}`)
}

async function pasteClipboardFromRenderer(
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
    'clipboard file paste did not settle',
    20_000,
  )
  await win.webContents.executeJavaScript('delete window.__hvirClipboardPasteSent')
}

async function dropDiskFileFromRenderer(
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
        return document.querySelector(
          '.files-panel [role="treeitem"][title=${JSON.stringify(destination.path)}]'
        ) ? true : undefined;
      })()`,
      'disk-backed File drop did not settle',
      20_000,
    )
  } finally {
    await win.webContents.executeJavaScript(`
      document.querySelector('#hvir-smoke-drop-input')?.remove();
      delete window.__hvirDropSent;
    `)
    if (attachedHere && debuggerPort.isAttached()) debuggerPort.detach()
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

async function waitForMacClipboardFileList(expectedPath: string): Promise<void> {
  const source = new ElectronClipboardFileSource()
  const deadline = Date.now() + 5_000
  while (Date.now() <= deadline) {
    if (source.readPaths().includes(expectedPath)) return
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
  }
  const availableFormats = clipboard.availableFormats()
  throw new Error(
    `smoke clipboard did not retain reviewed public.file-url file-list data; available=${availableFormats.join(',')}`,
  )
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
      feedback: document.querySelector('.file-operation-feedback')?.textContent?.trim(),
      progress: document.querySelector('.file-copy-progress')?.textContent?.trim(),
      treeRows: [...document.querySelectorAll('.files-panel [role="treeitem"]')]
        .map((node) => node.getAttribute('title'))
        .filter((value) => value?.includes('hvir-smoke-created'))
        .slice(0, 12)
    }))()
  `)
}
