// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FileTree } from '../src/renderer/src/tree/FileTree'
import {
  fileActionDestination,
  projectFileEntryNameError,
} from '../src/renderer/src/tree/use-file-create-actions'
import {
  localPath,
  type DirEntry,
  type FileOpenContext,
  type HostPath,
  type ProjectFileOperationResult,
} from '../src/shared'

const rootPath = localPath('/repo')
const entries = new Map<string, DirEntry[]>([
  [
    '/repo',
    [
      { name: 'src', type: 'dir' },
      { name: 'existing.md', type: 'file' },
    ],
  ],
  ['/repo/src', []],
  ['/other', []],
])

let container: HTMLDivElement
let reactRoot: Root
let invoke: ReturnType<typeof vi.fn>
let createEntry: (request: {
  readonly workspaceRoot: HostPath
  readonly destinationDirectory: HostPath
  readonly name: string
  readonly kind: 'file' | 'directory'
}) => Promise<ProjectFileOperationResult>

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  entries.set('/repo/src', [])
  createEntry = (request) => Promise.resolve(completedResult(request))
  invoke = vi.fn((channel: string, request: { readonly path?: HostPath }) => {
    if (channel === 'fs:readdir') {
      return Promise.resolve({ ok: true, value: entries.get(request.path!.path) ?? [] })
    }
    if (channel === 'fs:create-entry') {
      return createEntry(request as never).then((value) => ({ ok: true, value }))
    }
    throw new Error(`Unexpected channel: ${channel}`)
  })
  Object.defineProperty(window, 'hvir', {
    configurable: true,
    value: { invoke, send: vi.fn(), on: vi.fn() },
  })
  container = document.createElement('div')
  document.body.append(container)
  reactRoot = createRoot(container)
})

afterEach(() => {
  act(() => reactRoot.unmount())
  document
    .querySelectorAll(
      '.file-action-menu, .file-create-backdrop, .file-operation-feedback',
    )
    .forEach((node) => node.remove())
  container.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('Files rail create actions', () => {
  it('targets a file parent, validates one exact name, and opens a created file in source view', async () => {
    const onOpen = vi.fn()
    renderFileTree(rootPath, onOpen)
    await waitFor(() => treeRow('/repo/existing.md') !== undefined)

    act(() => {
      treeRow('/repo/existing.md')!.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, clientX: 18, clientY: 22 }),
      )
    })
    clickMenuItem('New File…')
    expect(dialogText()).toContain('Workspace')
    expect(dialogText()).toContain('local:/repo')
    expect(dialogText()).toContain('Destination')

    setDialogName('../bad')
    expect(document.querySelector('.file-create-error')?.textContent).toContain(
      'Use one name',
    )
    expect(submitButton()?.disabled).toBe(true)
    expect(invoke).not.toHaveBeenCalledWith('fs:create-entry', expect.anything())

    setDialogName('created.md')
    act(() =>
      document.querySelector<HTMLFormElement>('.file-create-dialog')!.requestSubmit(),
    )
    await waitFor(() => onOpen.mock.calls.length === 1)

    expect(invoke).toHaveBeenCalledWith('fs:create-entry', {
      workspaceRoot: rootPath,
      destinationDirectory: rootPath,
      name: 'created.md',
      kind: 'file',
    })
    expect(onOpen).toHaveBeenCalledWith(
      localPath('/repo/created.md'),
      true,
      'created-file',
    )
  })

  it('opens actions from the keyboard and reveals a newly created directory', async () => {
    createEntry = (request) => {
      entries.get('/repo/src')!.push({ name: request.name, type: 'dir' })
      return Promise.resolve(completedResult(request))
    }
    renderFileTree(rootPath, vi.fn())
    await waitFor(() => treeRow('/repo/src') !== undefined)
    const src = treeRow('/repo/src')!
    src.focus()

    act(() => {
      src.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true }),
      )
    })
    await waitFor(() => document.activeElement?.textContent?.trim() === 'New File…')
    clickMenuItem('New Folder…')
    expect(dialogText()).toContain('local:/repo/src')
    setDialogName('generated')
    act(() =>
      document.querySelector<HTMLFormElement>('.file-create-dialog')!.requestSubmit(),
    )

    await waitFor(
      () => treeRow('/repo/src/generated')?.getAttribute('aria-selected') === 'true',
    )
    expect(invoke).toHaveBeenCalledWith('fs:create-entry', {
      workspaceRoot: rootPath,
      destinationDirectory: localPath('/repo/src'),
      name: 'generated',
      kind: 'directory',
    })
  })

  it('restores keyboard focus after both successful and failed path copies', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    renderFileTree(rootPath, vi.fn())
    await waitFor(() => treeRow('/repo/existing.md') !== undefined)
    const row = treeRow('/repo/existing.md')!

    openKeyboardMenu(row)
    await waitFor(() => document.activeElement?.textContent?.trim() === 'New File…')
    clickMenuItem('Copy Absolute Path')
    await waitFor(() => document.activeElement === row)
    expect(writeText).toHaveBeenLastCalledWith('/repo/existing.md')

    writeText.mockRejectedValueOnce(new Error('clipboard unavailable'))
    openKeyboardMenu(row)
    await waitFor(() => document.activeElement?.textContent?.trim() === 'New File…')
    clickMenuItem('Copy Relative Path')
    await waitFor(() => document.activeElement === row)
    expect(writeText).toHaveBeenLastCalledWith('existing.md')
  })

  it('dismisses a pending create and suppresses its late completion', async () => {
    const late = deferred<ProjectFileOperationResult>()
    createEntry = () => late.promise
    const onOpen = vi.fn()
    renderFileTree(rootPath, onOpen)
    await waitFor(() => treeRow('/repo/existing.md') !== undefined)
    openPointerMenu('/repo/existing.md')
    clickMenuItem('New File…')
    setDialogName('dismissed.txt')
    act(() =>
      document.querySelector<HTMLFormElement>('.file-create-dialog')!.requestSubmit(),
    )
    await waitFor(() => submitButton()?.textContent?.includes('Creating') === true)

    const cancel = [
      ...document.querySelectorAll<HTMLButtonElement>('.file-create-dialog button'),
    ].find((button) => button.textContent?.trim() === 'Cancel')!
    expect(cancel.disabled).toBe(false)
    act(() => cancel.click())
    expect(document.querySelector('.file-create-dialog')).toBeNull()

    await act(async () => {
      late.resolve({
        outcome: 'completed',
        operationId: 'dismissed-operation',
        generation: 1,
        items: [
          {
            itemId: 'create:0',
            destination: localPath('/repo/dismissed.txt'),
            status: 'completed',
            effect: 'created-file',
          },
        ],
      })
      await Promise.resolve()
    })
    expect(onOpen).not.toHaveBeenCalled()
    expect(document.querySelector('.file-operation-feedback')).toBeNull()
    expect(document.querySelector('.file-create-dialog')).toBeNull()
  })

  it('resets pending state on workspace replacement and ignores the old late completion', async () => {
    const late = deferred<ProjectFileOperationResult>()
    createEntry = () => late.promise
    const onOpen = vi.fn()
    renderFileTree(rootPath, onOpen)
    await waitFor(() => treeRow('/repo/existing.md') !== undefined)
    openPointerMenu('/repo/existing.md')
    clickMenuItem('New File…')
    setDialogName('late.txt')
    act(() =>
      document.querySelector<HTMLFormElement>('.file-create-dialog')!.requestSubmit(),
    )
    await waitFor(() => submitButton()?.textContent?.includes('Creating') === true)

    renderFileTree(localPath('/other'), onOpen)
    await act(async () => Promise.resolve())
    act(() => {
      container
        .querySelector('.tree-scroll')!
        .dispatchEvent(
          new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 5 }),
        )
    })
    expect(menuItem('New File…')?.disabled).toBe(false)

    late.resolve({
      outcome: 'completed',
      operationId: 'late-operation',
      generation: 1,
      items: [
        {
          itemId: 'create:0',
          destination: localPath('/repo/late.txt'),
          status: 'completed',
          effect: 'created-file',
        },
      ],
    })
    await act(async () => Promise.resolve())
    expect(onOpen).not.toHaveBeenCalled()
    expect(document.querySelector('.file-operation-feedback')).toBeNull()
  })
})

describe('Files create targeting policy', () => {
  it('uses a directory itself and a file or symbolic link parent', () => {
    expect(fileActionDestination(rootPath, localPath('/repo/src'), 'dir')).toEqual(
      localPath('/repo/src'),
    )
    expect(fileActionDestination(rootPath, localPath('/repo/src/a.ts'), 'file')).toEqual(
      localPath('/repo/src'),
    )
    expect(
      fileActionDestination(rootPath, localPath('/repo/src/link'), 'symlink'),
    ).toEqual(localPath('/repo/src'))
  })

  it('does not trim or normalize invalid names into valid ones', () => {
    expect(projectFileEntryNameError('')).toBeDefined()
    expect(projectFileEntryNameError('.')).toBeDefined()
    expect(projectFileEntryNameError('a/b')).toBeDefined()
    expect(projectFileEntryNameError(' exact ')).toBeUndefined()
  })
})

function renderFileTree(
  root: HostPath,
  onOpen: (path: HostPath, pinned: boolean, context?: FileOpenContext) => void,
): void {
  act(() => {
    reactRoot.render(
      <FileTree
        root={root}
        refreshVersion={0}
        searchRefreshVersion={0}
        ignoredRefreshVersion={0}
        onOpen={onOpen}
        gitEnabled={false}
      />,
    )
  })
}

function openPointerMenu(path: string): void {
  act(() => {
    treeRow(path)!.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, clientX: 18, clientY: 22 }),
    )
  })
}

function openKeyboardMenu(row: HTMLButtonElement): void {
  row.focus()
  act(() => {
    row.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true }),
    )
  })
}

function clickMenuItem(label: string): void {
  act(() => menuItem(label)!.click())
}

function menuItem(label: string): HTMLButtonElement | undefined {
  return [
    ...document.querySelectorAll<HTMLButtonElement>('.file-action-menu button'),
  ].find((button) => button.textContent?.trim() === label)
}

function treeRow(path: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>('[role="treeitem"]')].find(
    (row) => row.title === path,
  )
}

function dialogText(): string {
  return document.querySelector('.file-create-dialog')?.textContent ?? ''
}

function setDialogName(value: string): void {
  const input = document.querySelector<HTMLInputElement>('.file-create-dialog input')!
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      input,
      value,
    )
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function submitButton(): HTMLButtonElement | undefined {
  return (
    document.querySelector<HTMLButtonElement>(
      '.file-create-dialog button[type="submit"]',
    ) ?? undefined
  )
}

function completedResult(request: {
  readonly destinationDirectory: HostPath
  readonly name: string
  readonly kind: 'file' | 'directory'
}): ProjectFileOperationResult {
  return {
    outcome: 'completed',
    operationId: 'operation-1',
    generation: 1,
    items: [
      {
        itemId: 'create:0',
        destination: localPath(`${request.destinationDirectory.path}/${request.name}`),
        status: 'completed',
        effect: request.kind === 'file' ? 'created-file' : 'created-directory',
      },
    ],
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (condition()) return
    await act(async () => Promise.resolve())
  }
  throw new Error('Timed out waiting for Files create UI')
}
