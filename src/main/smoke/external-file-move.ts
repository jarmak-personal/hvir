import type { BrowserWindow } from 'electron'

import {
  dirnameHostPath,
  joinHostPath,
  type HostPath,
  type ProjectState,
} from '../../shared'
import type { ProjectHost } from '../project-host'
import type { ExternalMovePickerPort } from '../project-file-operations/electron-external-move-picker'

export interface ExternalMoveSmokeControl {
  readonly picker: ExternalMovePickerPort
  select(paths: readonly HostPath[]): void
  assertSelection(selection: 'mixed' | 'files' | 'directory'): void
}

/** Deterministic native-picker edge for the production-composed Electron smoke. */
export function createExternalMoveSmokeControl(): ExternalMoveSmokeControl {
  let nextPaths: readonly HostPath[] | undefined
  let lastSelection: 'mixed' | 'files' | 'directory' | undefined
  const mixed = process.platform === 'darwin'
  return {
    picker: {
      policy: mixed
        ? {
            kind: 'mixed-multiple',
            limitation:
              'This platform can select multiple files and folders together in one native dialog.',
          }
        : {
            kind: 'files-or-single-directory',
            limitation:
              'This platform selects multiple files or one folder at a time; files and folders cannot be mixed in one native dialog.',
          },
      pick(selection) {
        if (!nextPaths) throw new Error('External move smoke picker was not armed')
        lastSelection = selection
        const selected = nextPaths
        nextPaths = undefined
        return Promise.resolve(selected.map((path) => path.path))
      },
    },
    select(paths) {
      if (nextPaths) throw new Error('External move smoke picker is already armed')
      nextPaths = paths
      lastSelection = undefined
    },
    assertSelection(selection) {
      if (lastSelection !== selection) {
        throw new Error(
          `Native selection boundary received ${lastSelection ?? 'no selection'} instead of ${selection}`,
        )
      }
    },
  }
}

export async function verifyExternalFileMoveSmoke(options: {
  readonly win: BrowserWindow
  readonly localHost: ProjectHost
  readonly localRoot: HostPath
  readonly remoteRoot: HostPath
  readonly trashRecoveryRoot: HostPath
  readonly control: ExternalMoveSmokeControl
  readonly failTrashFor: (path?: HostPath) => void
  readonly localState: () => ProjectState
  readonly remoteState: () => ProjectState
  readonly publish: (state: ProjectState) => void
}): Promise<string> {
  const {
    win,
    localHost,
    localRoot,
    remoteRoot,
    trashRecoveryRoot,
    control,
    failTrashFor,
    localState,
    remoteState,
    publish,
  } = options
  const externalDirectory = dirnameHostPath(localRoot)
  const localName = '.hvir-smoke-moved-external-local.txt'
  const remoteName = '.hvir-smoke-moved-external-remote'
  const retainedName = '.hvir-smoke-copied-external-retained.txt'
  const localSource = joinHostPath(externalDirectory, localName)
  const remoteSource = joinHostPath(externalDirectory, remoteName)
  const remoteNestedSource = joinHostPath(remoteSource, 'nested.txt')
  const retainedSource = joinHostPath(externalDirectory, retainedName)
  const localDestination = joinHostPath(localRoot, localName)
  const remoteDestination = joinHostPath(remoteRoot, remoteName)
  const remoteBackingDestination = joinHostPath(localRoot, remoteName)
  const remoteNestedDestination = joinHostPath(remoteBackingDestination, 'nested.txt')
  const retainedDestination = joinHostPath(localRoot, retainedName)
  const cleanupPaths = [
    localSource,
    remoteSource,
    retainedSource,
    localDestination,
    remoteBackingDestination,
    retainedDestination,
  ]
  await removeFixtures(localHost, cleanupPaths)

  try {
    publish(localState())
    await localHost.writeFile(localSource, 'local external move payload')
    control.select([localSource])
    await moveExternalFromRenderer({
      win,
      root: localRoot,
      source: localSource,
      destination: localDestination,
      kind: 'file',
      entry: 'keyboard',
      expectedFeedback: '1 moved.',
    })
    control.assertSelection(process.platform === 'darwin' ? 'mixed' : 'files')
    await expectMissingHostPath(localHost, localSource)
    if (
      (await localHost.readTextFile(localDestination)) !== 'local external move payload'
    ) {
      throw new Error('local external move did not preserve exact file content')
    }
    const recoveredLocal = await recoveredPath(localHost, trashRecoveryRoot, localName)
    if (
      (await localHost.readTextFile(recoveredLocal)) !== 'local external move payload'
    ) {
      throw new Error('local external move did not use recoverable Trash')
    }
    await verifyExternalMoveRefresh(win, localDestination)

    publish(remoteState())
    await localHost.createDirectoryExclusive(remoteSource, { mode: 0o755 })
    await localHost.writeFile(remoteNestedSource, 'remote external move payload')
    control.select([remoteSource])
    await moveExternalFromRenderer({
      win,
      root: remoteRoot,
      source: remoteSource,
      destination: remoteDestination,
      kind: 'directory',
      entry: 'pointer',
      expectedFeedback: '1 moved.',
    })
    control.assertSelection(process.platform === 'darwin' ? 'mixed' : 'directory')
    await expectMissingHostPath(localHost, remoteSource)
    if (
      (await localHost.readTextFile(remoteNestedDestination)) !==
      'remote external move payload'
    ) {
      throw new Error('synthetic-SSH external move did not preserve the directory tree')
    }

    publish(localState())
    await localHost.writeFile(retainedSource, 'source-retained external move payload')
    failTrashFor(retainedSource)
    control.select([retainedSource])
    await moveExternalFromRenderer({
      win,
      root: localRoot,
      source: retainedSource,
      destination: retainedDestination,
      kind: 'file',
      entry: 'pointer',
      expectedFeedback: '1 copied with source retained.',
    })
    failTrashFor()
    if (
      (await localHost.readTextFile(retainedSource)) !==
        'source-retained external move payload' ||
      (await localHost.readTextFile(retainedDestination)) !==
        'source-retained external move payload'
    ) {
      throw new Error('Trash failure did not preserve both source and verified copy')
    }
    return 'native external move picker + local move + synthetic-SSH tree move + source-retained Trash failure + keyboard access + tree refresh'
  } finally {
    failTrashFor()
    await removeFixtures(localHost, cleanupPaths)
    publish(localState())
  }
}

async function moveExternalFromRenderer(options: {
  readonly win: BrowserWindow
  readonly root: HostPath
  readonly source: HostPath
  readonly destination: HostPath
  readonly kind: 'file' | 'directory'
  readonly entry: 'pointer' | 'keyboard'
  readonly expectedFeedback: string
}): Promise<void> {
  const { win, root, source, destination, kind, entry, expectedFeedback } = options
  const workspaceDisplay = `${root.hostId}:${root.path}`
  const chooseLabel =
    process.platform === 'darwin'
      ? 'Choose Files or Folders…'
      : kind === 'file'
        ? 'Choose Files…'
        : 'Choose Folder…'
  try {
    await rendererValue(
      win,
      `(() => {
        if (window.__hvirExternalMoveSubmitted) {
          const feedback = document.querySelector('.file-operation-feedback');
          if (!feedback?.textContent?.includes(${JSON.stringify(expectedFeedback)})) {
            return undefined;
          }
          return document.querySelector(
            '.files-panel [role="treeitem"][title=${JSON.stringify(destination.path)}]'
          ) ? true : undefined;
        }
        const root = document.querySelector(
          '.files-panel .directory-row[title=${JSON.stringify(root.path)}]'
        );
        if (!(root instanceof HTMLButtonElement)) return undefined;
        if (!window.__hvirExternalMoveMenu) {
          ${
            entry === 'pointer'
              ? `root.dispatchEvent(new MouseEvent('contextmenu', {
                  bubbles: true, clientX: 46, clientY: 54
                }));`
              : `root.focus();
                root.dispatchEvent(new KeyboardEvent('keydown', {
                  key: 'F10', shiftKey: true, bubbles: true
                }));`
          }
          window.__hvirExternalMoveMenu = true;
          return undefined;
        }
        const action = [...document.querySelectorAll('.file-action-menu [role="menuitem"]')]
          .find((node) => node.textContent?.trim() === 'Move External Items Here…');
        if (!window.__hvirExternalMoveDialog) {
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
          window.__hvirExternalMoveDialog = true;
          return undefined;
        }
        const dialog = document.querySelector('.file-external-move-dialog');
        if (!(dialog instanceof HTMLElement)) return undefined;
        const facts = new Map([...dialog.querySelectorAll('dl > div')].map((row) => [
          row.querySelector('dt')?.textContent?.trim(),
          row.querySelector('dd')?.textContent?.trim()
        ]));
        if (facts.get('Workspace') !== ${JSON.stringify(workspaceDisplay)} ||
            facts.get('Destination') !== ${JSON.stringify(workspaceDisplay)} ||
            facts.get('Source recovery') !== 'Application-host Trash') {
          throw new Error('external move dialog lost its bounded destination disclosure');
        }
        if (!window.__hvirExternalMoveSelected) {
          const choose = [...dialog.querySelectorAll('button')]
            .find((node) => node.textContent?.trim() === ${JSON.stringify(chooseLabel)});
          if (!(choose instanceof HTMLButtonElement) || choose.disabled) return undefined;
          if (${JSON.stringify(entry)} === 'keyboard' && document.activeElement !== choose) {
            return undefined;
          }
          choose.click();
          window.__hvirExternalMoveSelected = true;
          return undefined;
        }
        if (!dialog.textContent?.includes(${JSON.stringify(source.path.split('/').at(-1))})) {
          return undefined;
        }
        if (dialog.textContent.includes(${JSON.stringify(source.path)})) {
          throw new Error('native source path crossed into renderer confirmation');
        }
        const cancel = [...dialog.querySelectorAll('button')]
          .find((node) => node.textContent?.trim() === 'Cancel');
        if (!(cancel instanceof HTMLButtonElement) || document.activeElement !== cancel) {
          return undefined;
        }
        const confirm = [...dialog.querySelectorAll('button')]
          .find((node) => node.textContent?.trim() === 'Move Selected Items');
        if (!(confirm instanceof HTMLButtonElement) || confirm.disabled) return undefined;
        confirm.click();
        window.__hvirExternalMoveSubmitted = true;
        return undefined;
      })()`,
    )
  } finally {
    await win.webContents.executeJavaScript(`
      delete window.__hvirExternalMoveMenu;
      delete window.__hvirExternalMoveDialog;
      delete window.__hvirExternalMoveSelected;
      delete window.__hvirExternalMoveSubmitted;
    `)
  }
}

async function verifyExternalMoveRefresh(
  win: BrowserWindow,
  destination: HostPath,
): Promise<void> {
  await rendererValue(
    win,
    `(() => {
      const trigger = document.querySelector('[data-filename-search-trigger]');
      if (!window.__hvirExternalMoveSearch) {
        if (!(trigger instanceof HTMLButtonElement)) return undefined;
        trigger.click();
        window.__hvirExternalMoveSearch = true;
        return undefined;
      }
      const input = document.querySelector('[data-filename-search]');
      if (!(input instanceof HTMLInputElement)) return undefined;
      if (input.value !== ${JSON.stringify(destination.path.split('/').at(-1))}) {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
          ?.set?.call(input, ${JSON.stringify(destination.path.split('/').at(-1))});
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return undefined;
      }
      return document.querySelector(
        '.filename-search-result[title=${JSON.stringify(destination.path)}]'
      ) ? true : undefined;
    })()`,
  )
  await win.webContents.executeJavaScript(`
    document.querySelector('.filename-search-close')?.click();
    delete window.__hvirExternalMoveSearch;
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
        '.git-panel .git-file[title=${JSON.stringify(destination.path)}]'
      ) ? true : undefined;
    })()`,
  )
  await win.webContents.executeJavaScript(`
    [...document.querySelectorAll('.rail-nav button')]
      .find((node) => node.textContent?.trim() === 'Files')?.click();
  `)
}

async function recoveredPath(
  host: ProjectHost,
  recoveryRoot: HostPath,
  sourceName: string,
): Promise<HostPath> {
  const matches = (await host.readdir(recoveryRoot)).filter((entry) =>
    entry.name.endsWith(`-${sourceName}`),
  )
  if (matches.length !== 1) {
    throw new Error('recoverable Trash did not retain one exact external source')
  }
  return joinHostPath(recoveryRoot, matches[0]!.name)
}

async function expectMissingHostPath(host: ProjectHost, path: HostPath): Promise<void> {
  try {
    await host.stat(path)
  } catch (reason) {
    if (isMissingPathError(reason)) return
    throw reason
  }
  throw new Error(`external source remained after a completed move: ${path.path}`)
}

function removeFixtures(host: ProjectHost, paths: readonly HostPath[]): Promise<void> {
  return host
    .exec('rm', ['-rf', '--', ...paths.map((path) => path.path)])
    .then(() => undefined)
}

function rendererValue(win: BrowserWindow, expression: string): Promise<unknown> {
  return win.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const poll = () => {
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

function isMissingPathError(reason: unknown): boolean {
  return (
    typeof reason === 'object' &&
    reason !== null &&
    (reason as { code?: unknown }).code === 'ENOENT'
  )
}
