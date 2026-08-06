// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FileTree } from '../src/renderer/src/tree/FileTree'
import { fileActionDestination } from '../src/renderer/src/tree/file-action-destination'
import { projectFileEntryNameError } from '../src/renderer/src/tree/project-file-entry-name'
import {
  localPath,
  type DirEntry,
  type FileOpenContext,
  type HostPath,
  type ProjectFileOperationResult,
  type ProjectFileOperationProgress,
  type ProjectFileOrganizationRequest,
} from '../src/shared'
import type { ViewerPathRebindCapability } from '../src/renderer/src/viewer/viewer-path-rebind'
import type { ViewerPathRemovalCapability } from '../src/renderer/src/viewer/viewer-path-removal'

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
let invoke: ReturnType<
  typeof vi.fn<
    (channel: string, request: { readonly path?: HostPath }) => Promise<unknown>
  >
>
let createEntry: (request: {
  readonly workspaceRoot: HostPath
  readonly destinationDirectory: HostPath
  readonly name: string
  readonly kind: 'file' | 'directory'
}) => Promise<ProjectFileOperationResult>
let projectFileEvents: ((event: ProjectFileOperationProgress) => void)[]
let copyExternal: () => Promise<unknown>
let acquireDropped: ReturnType<typeof vi.fn>
let organizeEntry: (request: ProjectFileOrganizationRequest) => Promise<unknown>
let deletionDisclosure: (request: { readonly source: HostPath }) => Promise<unknown>
let deleteEntry: () => Promise<unknown>
let onHvir: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  entries.set('/repo', [
    { name: 'src', type: 'dir' },
    { name: 'existing.md', type: 'file' },
  ])
  entries.set('/repo/src', [])
  createEntry = (request) => Promise.resolve(completedResult(request))
  projectFileEvents = []
  copyExternal = () =>
    Promise.resolve({
      ok: true,
      value: {
        outcome: 'started',
        operationId: 'copy-1',
        generation: 1,
        itemCount: 1,
      },
    })
  acquireDropped = vi.fn(() => Promise.reject(new Error('not configured')))
  organizeEntry = () =>
    Promise.resolve({
      ok: true,
      value: {
        outcome: 'started',
        operationId: 'organize-1',
        generation: 1,
        itemCount: 1,
      },
    })
  deletionDisclosure = () => new Promise(() => undefined)
  deleteEntry = () =>
    Promise.resolve({
      ok: true,
      value: {
        outcome: 'started',
        operationId: 'delete-1',
        generation: 1,
        itemCount: 1,
      },
    })
  onHvir = vi.fn(
    (channel: string, callback: (event: ProjectFileOperationProgress) => void) => {
      if (channel === 'fs:project-file-operation') projectFileEvents.push(callback)
      return () => {
        projectFileEvents = projectFileEvents.filter(
          (candidate) => candidate !== callback,
        )
      }
    },
  )
  invoke = vi.fn((channel: string, request: { readonly path?: HostPath }) => {
    if (channel === 'fs:readdir') {
      return Promise.resolve({ ok: true, value: entries.get(request.path!.path) ?? [] })
    }
    if (channel === 'fs:create-entry') {
      return createEntry(request as never).then((value) => ({ ok: true, value }))
    }
    if (channel === 'fs:resolve-entry') {
      return Promise.resolve({ ok: true, value: { type: 'file' } })
    }
    if (channel === 'fs:acquire-clipboard-files') {
      return Promise.resolve({
        ok: true,
        value: {
          outcome: 'available',
          grant: {
            grantId: 'grant-1',
            generation: 1,
            items: [{ itemId: 'external:0', name: 'copy.txt', type: 'file' }],
          },
        },
      })
    }
    if (channel === 'fs:copy-external') return copyExternal()
    if (channel === 'fs:organize-entry') return organizeEntry(request as never)
    if (channel === 'fs:deletion-disclosure') {
      return deletionDisclosure(request as unknown as { readonly source: HostPath })
    }
    if (channel === 'fs:delete-entry') return deleteEntry()
    if (channel === 'fs:cancel-file-operation') {
      return Promise.resolve({ ok: true, value: true })
    }
    throw new Error(`Unexpected channel: ${channel}`)
  })
  Object.defineProperty(window, 'hvir', {
    configurable: true,
    value: {
      invoke,
      send: vi.fn(),
      externalFiles: { acquireDropped },
      on: onHvir,
    },
  })
  container = document.createElement('div')
  document.body.append(container)
  reactRoot = createRoot(container)
})

afterEach(async () => {
  await act(settle)
  act(() => reactRoot.unmount())
  document
    .querySelectorAll(
      '.file-action-menu, .file-create-backdrop, .file-operation-feedback',
    )
    .forEach((node) => node.remove())
  container.remove()
  vi.restoreAllMocks()
  vi.useRealTimers()
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
    expect(
      document
        .querySelector('.file-action-menu')
        ?.classList.contains('hvir-scrollbar-obscuring'),
    ).toBe(true)
    clickMenuItem('New File…')
    expectSharedFileDialog('.file-create-dialog')
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

  it('uses Files Ctrl+V once while acquisition is pending and targets a file parent', async () => {
    const acquisition = deferred<unknown>()
    invoke.mockImplementation(
      (channel: string, request: { readonly path?: HostPath }) => {
        if (channel === 'fs:readdir') {
          return Promise.resolve({
            ok: true,
            value: entries.get(request.path!.path) ?? [],
          })
        }
        if (channel === 'fs:acquire-clipboard-files') return acquisition.promise
        throw new Error(`Unexpected channel: ${channel}`)
      },
    )
    renderFileTree(rootPath, vi.fn())
    await waitFor(() => treeRow('/repo/existing.md') !== undefined)
    const row = treeRow('/repo/existing.md')!
    row.focus()

    act(() => {
      row.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, bubbles: true }),
      )
      row.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, bubbles: true }),
      )
    })
    await act(async () => Promise.resolve())

    expect(
      invoke.mock.calls.filter(([channel]) => channel === 'fs:acquire-clipboard-files'),
    ).toHaveLength(1)
  })

  it('reconciles an immediate final event and keeps detailed failures until dismissed', async () => {
    vi.useFakeTimers()
    copyExternal = () => {
      const event: ProjectFileOperationProgress = {
        workspaceRoot: rootPath,
        operationId: 'copy-1',
        generation: 1,
        phase: 'completed',
        completedItems: 1,
        totalItems: 1,
        result: {
          outcome: 'completed',
          operationId: 'copy-1',
          generation: 1,
          items: [
            {
              itemId: 'external:0',
              destination: localPath('/repo/copy.txt'),
              status: 'conflicted',
              effect: 'none',
              reason: 'The destination already exists',
            },
          ],
        },
      }
      for (const listener of projectFileEvents) listener(event)
      return Promise.resolve({
        ok: true,
        value: {
          outcome: 'started',
          operationId: 'copy-1',
          generation: 1,
          itemCount: 1,
        },
      })
    }
    renderFileTree(rootPath, vi.fn())
    await waitFor(() => treeRow('/repo/existing.md') !== undefined)
    const row = treeRow('/repo/existing.md')!
    row.focus()
    act(() => {
      row.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, bubbles: true }),
      )
    })

    await waitFor(() =>
      Boolean(document.querySelector('.file-operation-feedback')?.textContent),
    )
    expect(document.querySelector('.file-copy-progress')).toBeNull()
    expect(document.querySelector('.file-operation-feedback')?.textContent).toContain(
      'destination already exists',
    )
    act(() => {
      vi.advanceTimersByTime(4_100)
    })
    expect(document.querySelector('.file-operation-feedback')).not.toBeNull()
    act(() => {
      ;[
        ...document.querySelectorAll<HTMLButtonElement>(
          '.file-operation-feedback button',
        ),
      ]
        .find((button) => button.textContent === 'Dismiss')!
        .click()
    })
    expect(document.querySelector('.file-operation-feedback')).toBeNull()
  })

  it('routes dropped File objects only through preload and shows the real parent target', async () => {
    acquireDropped.mockResolvedValue({
      ok: true,
      value: {
        outcome: 'available',
        grant: {
          grantId: 'drop-grant',
          generation: 1,
          items: [{ itemId: 'external:0', name: 'drop.txt', type: 'file' }],
        },
      },
    })
    renderFileTree(rootPath, vi.fn())
    await waitFor(() => treeRow('/repo/existing.md') !== undefined)
    const row = treeRow('/repo/existing.md')!
    const file = new File(['drop'], 'drop.txt')
    const transfer = { types: ['Files'], files: [file], dropEffect: 'none' }

    act(() => {
      row.dispatchEvent(dataTransferEvent('dragover', transfer))
    })
    expect(container.querySelector('.file-drop-target')?.textContent).toContain(
      'Copy into repo',
    )
    act(() => {
      row.dispatchEvent(dataTransferEvent('drop', transfer))
    })
    await act(async () => Promise.resolve())

    expect(acquireDropped).toHaveBeenCalledWith([file])
    expect(invoke).not.toHaveBeenCalledWith('fs:acquire-dropped-files', expect.anything())
  })

  it('gates root and entry types while allowing symbolic-link rename and move only', async () => {
    entries
      .get('/repo')!
      .push({ name: 'link', type: 'symlink' }, { name: 'socket', type: 'other' })
    renderFileTree(rootPath, vi.fn())
    await waitFor(() => treeRow('/repo/link') !== undefined)

    act(() => {
      container
        .querySelector('.tree-scroll')!
        .dispatchEvent(
          new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 5 }),
        )
    })
    expect(menuItem('Rename…')?.disabled).toBe(true)
    expect(menuItem('Move…')?.disabled).toBe(true)
    expect(menuItem('Duplicate…')?.disabled).toBe(true)
    void act(() =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })),
    )

    openPointerMenu('/repo/link')
    expect(menuItem('Rename…')?.disabled).toBe(false)
    expect(menuItem('Move…')?.disabled).toBe(false)
    expect(menuItem('Duplicate…')?.disabled).toBe(true)
    void act(() =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })),
    )

    openPointerMenu('/repo/socket')
    expect(menuItem('Rename…')?.disabled).toBe(true)
    expect(menuItem('Move…')?.disabled).toBe(true)
    expect(menuItem('Duplicate…')?.disabled).toBe(true)
  })

  it('renames from the pointer menu and rebinds only after a completed result', async () => {
    const viewerPathRebind: ViewerPathRebindCapability & ViewerPathRemovalCapability = {
      ...TEST_VIEWER_PATH_REBIND,
      canRebindPath: vi.fn(() => true),
      rebindPath: vi.fn(() => true),
    }
    renderFileTree(rootPath, vi.fn(), viewerPathRebind)
    await waitFor(() => treeRow('/repo/existing.md') !== undefined)
    openPointerMenu('/repo/existing.md')
    clickMenuItem('Rename…')
    expectSharedFileDialog('.file-organization-dialog')
    expect(dialogText()).toContain('Source')
    expect(dialogText()).toContain('local:/repo/existing.md')
    setDialogName('renamed.md')
    act(() =>
      document
        .querySelector<HTMLFormElement>('.file-organization-dialog')!
        .requestSubmit(),
    )
    await waitFor(() =>
      invoke.mock.calls.some(([channel]) => channel === 'fs:organize-entry'),
    )
    expect(viewerPathRebind.rebindPath).not.toHaveBeenCalled()
    expect(invoke).toHaveBeenCalledWith('fs:organize-entry', {
      action: 'rename',
      workspaceRoot: rootPath,
      source: localPath('/repo/existing.md'),
      name: 'renamed.md',
    })

    broadcastProjectFileEvent({
      outcome: 'completed',
      operationId: 'organize-1',
      generation: 1,
      items: [
        {
          itemId: 'organize:0',
          source: localPath('/repo/existing.md'),
          destination: localPath('/repo/renamed.md'),
          status: 'completed',
          effect: 'renamed-entry',
        },
      ],
    })
    await act(settle)
    expect(viewerPathRebind.rebindPath).toHaveBeenCalledWith(
      localPath('/repo/existing.md'),
      localPath('/repo/renamed.md'),
    )
  })

  it('moves through keyboard menu and keyboard directory selection', async () => {
    renderFileTree(rootPath, vi.fn())
    await waitFor(() => treeRow('/repo/existing.md') !== undefined)
    openKeyboardMenu(treeRow('/repo/existing.md')!)
    await waitFor(() => document.activeElement?.textContent?.trim() === 'New File…')
    clickMenuItem('Move…')
    await waitFor(() => document.activeElement?.getAttribute('title') === '/repo')
    await waitFor(() => organizationTreeRow('/repo/src') !== undefined)
    act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
      )
    })
    expect(document.activeElement).toBe(organizationTreeRow('/repo/src'))
    act(() => organizationTreeRow('/repo/src')!.click())
    await act(settle)
    act(() =>
      document
        .querySelector<HTMLFormElement>('.file-organization-dialog')!
        .requestSubmit(),
    )
    await waitFor(() =>
      invoke.mock.calls.some(([channel]) => channel === 'fs:organize-entry'),
    )
    expect(invoke).toHaveBeenCalledWith('fs:organize-entry', {
      action: 'move',
      workspaceRoot: rootPath,
      source: localPath('/repo/existing.md'),
      destinationDirectory: localPath('/repo/src'),
    })
    broadcastProjectFileEvent({
      outcome: 'completed',
      operationId: 'organize-1',
      generation: 1,
      items: [
        {
          itemId: 'organize:0',
          source: localPath('/repo/existing.md'),
          destination: localPath('/repo/src/existing.md'),
          status: 'completed',
          effect: 'moved-entry',
        },
      ],
    })
    await act(settle)
  })

  it('duplicates into a selected workspace directory without rebinding viewer tabs', async () => {
    const viewerPathRebind: ViewerPathRebindCapability & ViewerPathRemovalCapability = {
      ...TEST_VIEWER_PATH_REBIND,
      canRebindPath: vi.fn(() => true),
      rebindPath: vi.fn(() => true),
    }
    renderFileTree(rootPath, vi.fn(), viewerPathRebind)
    await waitFor(() => treeRow('/repo/existing.md') !== undefined)
    openPointerMenu('/repo/existing.md')
    clickMenuItem('Duplicate…')
    await waitFor(() => organizationTreeRow('/repo/src') !== undefined)
    act(() => organizationTreeRow('/repo/src')!.click())
    await act(settle)
    setDialogName('exact duplicate.md')
    act(() =>
      document
        .querySelector<HTMLFormElement>('.file-organization-dialog')!
        .requestSubmit(),
    )
    await waitFor(() =>
      invoke.mock.calls.some(([channel]) => channel === 'fs:organize-entry'),
    )

    expect(invoke).toHaveBeenCalledWith('fs:organize-entry', {
      action: 'duplicate',
      workspaceRoot: rootPath,
      source: localPath('/repo/existing.md'),
      destinationDirectory: localPath('/repo/src'),
      name: 'exact duplicate.md',
    })
    broadcastProjectFileEvent({
      outcome: 'completed',
      operationId: 'organize-1',
      generation: 1,
      items: [
        {
          itemId: 'organize:0',
          source: localPath('/repo/existing.md'),
          destination: localPath('/repo/src/exact duplicate.md'),
          status: 'completed',
          effect: 'duplicated-file',
          sourceDisposition: {
            outcome: 'retained',
            path: localPath('/repo/existing.md'),
          },
        },
      ],
    })
    await act(settle)
    expect(viewerPathRebind.rebindPath).not.toHaveBeenCalled()
  })

  it('blocks deletion while a descendant buffer is dirty', async () => {
    makeDeletionAvailable('recoverable')
    const viewer = {
      ...TEST_VIEWER_PATH_REBIND,
      reviewPathRemoval: vi.fn(() => ({
        openCount: 1,
        dirtyPaths: [localPath('/repo/existing.md')],
      })),
    }
    renderFileTree(rootPath, vi.fn(), viewer)
    await waitFor(() => treeRow('/repo/existing.md') !== undefined)

    openPointerMenu('/repo/existing.md')
    await waitFor(() => menuItem('Move to Trash…') !== undefined)
    clickMenuItem('Move to Trash…')

    expect(document.querySelector('.file-deletion-dialog')).toBeNull()
    await waitFor(
      () =>
        document
          .querySelector('.file-operation-feedback')
          ?.textContent?.includes('unsaved changes') === true,
    )
    expect(document.querySelector('.file-operation-feedback')?.textContent).toContain(
      'unsaved changes',
    )
    expect(invoke).not.toHaveBeenCalledWith('fs:delete-entry', expect.anything())
  })

  it('focuses a safe control when keyboard-opening recoverable confirmation', async () => {
    makeDeletionAvailable('recoverable')
    renderFileTree(rootPath, vi.fn())
    await waitFor(() => treeRow('/repo/existing.md') !== undefined)
    openKeyboardMenu(treeRow('/repo/existing.md')!)
    await waitFor(() => menuItem('Move to Trash…') !== undefined)
    const action = menuItem('Move to Trash…')!
    act(() => action.focus())
    act(() => action.click())

    expect(document.activeElement?.textContent?.trim()).toBe('Cancel')
    act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      )
    })
    expect(document.querySelector('.file-deletion-dialog')).toBeNull()
  })

  it('does not reset keyboard menu focus when deletion disclosure resolves', async () => {
    const inspection = deferred<unknown>()
    deletionDisclosure = () => inspection.promise
    renderFileTree(rootPath, vi.fn())
    await waitFor(() => treeRow('/repo/existing.md') !== undefined)
    openKeyboardMenu(treeRow('/repo/existing.md')!)
    const duplicate = menuItem('Duplicate…')!
    act(() => duplicate.focus())
    const initialOperationSubscriptions = projectFileOperationSubscriptionCount()

    await act(async () => {
      inspection.resolve({
        ok: true,
        value: {
          outcome: 'available',
          workspaceRoot: rootPath,
          source: localPath('/repo/existing.md'),
          recovery: 'recoverable',
        },
      })
      await settle()
    })

    expect(menuItem('Move to Trash…')).toBeDefined()
    expect(document.activeElement).toBe(duplicate)
    expect(projectFileOperationSubscriptionCount()).toBe(initialOperationSubscriptions)
  })

  it('confirms recoverable deletion and closes clean descendants only after success', async () => {
    makeDeletionAvailable('recoverable')
    const closeCleanPath = vi.fn(() => ({
      openCount: 1,
      dirtyPaths: [],
      closedCount: 1,
    }))
    const viewer = { ...TEST_VIEWER_PATH_REBIND, closeCleanPath }
    const onWorkspaceContentChanged = vi.fn()
    act(() => {
      reactRoot.render(
        <FileTree
          root={rootPath}
          refreshVersion={0}
          searchRefreshVersion={0}
          ignoredRefreshVersion={0}
          onOpen={vi.fn()}
          viewerPathRebind={viewer}
          onWorkspaceContentChanged={onWorkspaceContentChanged}
          gitEnabled={false}
        />,
      )
    })
    await waitFor(() => treeRow('/repo/existing.md') !== undefined)
    openPointerMenu('/repo/existing.md')
    await waitFor(() => menuItem('Move to Trash…') !== undefined)
    clickMenuItem('Move to Trash…')

    expectSharedFileDialog('.file-deletion-dialog')
    expect(dialogText()).toContain('local:/repo')
    expect(dialogText()).toContain('local:/repo/existing.md')
    expect(dialogText()).toContain('Move to operating-system Trash')
    expect(dialogText()).toContain('Available through the operating-system Trash')
    act(() =>
      document.querySelector<HTMLFormElement>('.file-deletion-dialog')!.requestSubmit(),
    )
    await waitFor(() =>
      invoke.mock.calls.some(([channel]) => channel === 'fs:delete-entry'),
    )
    expect(closeCleanPath).not.toHaveBeenCalled()
    expect(invoke).toHaveBeenCalledWith('fs:delete-entry', {
      workspaceRoot: rootPath,
      source: localPath('/repo/existing.md'),
      confirmedRecovery: 'recoverable',
    })

    broadcastProjectFileEvent({
      outcome: 'completed',
      operationId: 'delete-1',
      generation: 1,
      items: [
        {
          itemId: 'delete:0',
          source: localPath('/repo/existing.md'),
          destination: localPath('/repo/existing.md'),
          status: 'completed',
          effect: 'trashed-entry',
          sourceDisposition: { outcome: 'removed' },
        },
      ],
    })

    await act(settle)
    expect(closeCleanPath).toHaveBeenCalledWith(localPath('/repo/existing.md'))
    expect(onWorkspaceContentChanged).toHaveBeenCalledOnce()
    expect(document.querySelector('.file-operation-feedback')?.textContent).toContain(
      'moved to Trash',
    )
  })

  it('refreshes unknown submitted-Trash state without closing viewer tabs', async () => {
    makeDeletionAvailable('recoverable')
    const closeCleanPath = vi.fn()
    const onWorkspaceContentChanged = vi.fn()
    act(() => {
      reactRoot.render(
        <FileTree
          root={rootPath}
          refreshVersion={0}
          searchRefreshVersion={0}
          ignoredRefreshVersion={0}
          onOpen={vi.fn()}
          viewerPathRebind={{ ...TEST_VIEWER_PATH_REBIND, closeCleanPath }}
          onWorkspaceContentChanged={onWorkspaceContentChanged}
          gitEnabled={false}
        />,
      )
    })
    await waitFor(() => treeRow('/repo/existing.md') !== undefined)
    openPointerMenu('/repo/existing.md')
    await waitFor(() => menuItem('Move to Trash…') !== undefined)
    clickMenuItem('Move to Trash…')
    act(() =>
      document.querySelector<HTMLFormElement>('.file-deletion-dialog')!.requestSubmit(),
    )
    await waitFor(() =>
      invoke.mock.calls.some(([channel]) => channel === 'fs:delete-entry'),
    )

    broadcastProjectFileEvent({
      outcome: 'completed',
      operationId: 'delete-1',
      generation: 1,
      items: [
        {
          itemId: 'delete:0',
          source: localPath('/repo/existing.md'),
          destination: localPath('/repo/existing.md'),
          status: 'failed',
          effect: 'deletion-state-unknown',
          sourceDisposition: {
            outcome: 'unknown',
            path: localPath('/repo/existing.md'),
            totalEntries: 1,
          },
          reason: 'Trash callback rejected after moving',
        },
      ],
    })
    await act(settle)

    expect(closeCleanPath).not.toHaveBeenCalled()
    expect(onWorkspaceContentChanged).toHaveBeenCalledOnce()
    expect(document.querySelector('.file-operation-feedback')?.textContent).toContain(
      'could not be verified',
    )
    expect(document.querySelector('.file-operation-feedback')?.textContent).toContain(
      'Recovery was not confirmed',
    )
  })

  it('keyboard-opens permanent deletion and requires the exact entry name', async () => {
    makeDeletionAvailable('permanent')
    renderFileTree(rootPath, vi.fn())
    await waitFor(() => treeRow('/repo/existing.md') !== undefined)
    const row = treeRow('/repo/existing.md')!
    openKeyboardMenu(row)
    await waitFor(() => menuItem('Delete Permanently…') !== undefined)
    const destructive = menuItem('Delete Permanently…')!
    act(() => destructive.focus())
    expect(document.activeElement).toBe(destructive)
    act(() => destructive.click())

    expect(dialogText()).toContain('Permanent deletion')
    expect(dialogText()).toContain('local does not provide recoverable deletion')
    setDialogName('wrong.md')
    expect(submitButton()?.disabled).toBe(true)
    setDialogName('existing.md')
    expect(submitButton()?.disabled).toBe(false)
    act(() =>
      document.querySelector<HTMLFormElement>('.file-deletion-dialog')!.requestSubmit(),
    )
    await waitFor(() =>
      invoke.mock.calls.some(([channel]) => channel === 'fs:delete-entry'),
    )
    expect(invoke).toHaveBeenCalledWith('fs:delete-entry', {
      workspaceRoot: rootPath,
      source: localPath('/repo/existing.md'),
      confirmedRecovery: 'permanent',
    })
  })

  it('rechecks dirty descendants immediately before deletion submission', async () => {
    makeDeletionAvailable('recoverable')
    const reviewPathRemoval = vi
      .fn()
      .mockReturnValueOnce({ openCount: 1, dirtyPaths: [] })
      .mockReturnValueOnce({
        openCount: 1,
        dirtyPaths: [localPath('/repo/existing.md')],
      })
    renderFileTree(rootPath, vi.fn(), {
      ...TEST_VIEWER_PATH_REBIND,
      reviewPathRemoval,
    })
    await waitFor(() => treeRow('/repo/existing.md') !== undefined)
    openPointerMenu('/repo/existing.md')
    await waitFor(() => menuItem('Move to Trash…') !== undefined)
    clickMenuItem('Move to Trash…')

    act(() =>
      document.querySelector<HTMLFormElement>('.file-deletion-dialog')!.requestSubmit(),
    )

    expect(reviewPathRemoval).toHaveBeenCalledTimes(2)
    expect(dialogText()).toContain('unsaved changes')
    expect(invoke).not.toHaveBeenCalledWith('fs:delete-entry', expect.anything())
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
  viewerPathRebind?: ViewerPathRebindCapability & ViewerPathRemovalCapability,
): void {
  act(() => {
    reactRoot.render(
      <FileTree
        root={root}
        refreshVersion={0}
        searchRefreshVersion={0}
        ignoredRefreshVersion={0}
        onOpen={onOpen}
        viewerPathRebind={viewerPathRebind ?? TEST_VIEWER_PATH_REBIND}
        onWorkspaceContentChanged={() => undefined}
        gitEnabled={false}
      />,
    )
  })
}

const TEST_VIEWER_PATH_REBIND: ViewerPathRebindCapability & ViewerPathRemovalCapability =
  {
    canRebindPath: () => true,
    rebindPath: () => true,
    reviewPathRemoval: () => ({ openCount: 0, dirtyPaths: [] }),
    closeCleanPath: () => ({ openCount: 0, dirtyPaths: [], closedCount: 0 }),
  }

function makeDeletionAvailable(recovery: 'recoverable' | 'permanent'): void {
  deletionDisclosure = ({ source }) =>
    Promise.resolve({
      ok: true,
      value: {
        outcome: 'available',
        workspaceRoot: rootPath,
        source,
        recovery,
      },
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
    (row) => row.dataset.filePath === path,
  )
}

function organizationTreeRow(path: string): HTMLButtonElement | undefined {
  return [
    ...document.querySelectorAll<HTMLButtonElement>(
      '.file-organization-picker [role="treeitem"]',
    ),
  ].find((row) => row.title === path)
}

function broadcastProjectFileEvent(
  result: Extract<ProjectFileOperationResult, { readonly outcome: 'completed' }>,
): void {
  const event: ProjectFileOperationProgress = {
    workspaceRoot: rootPath,
    operationId: result.operationId,
    generation: result.generation,
    phase: 'completed',
    completedItems: result.items.length,
    totalItems: result.items.length,
    result,
  }
  act(() => {
    for (const listener of projectFileEvents) listener(event)
  })
}

function projectFileOperationSubscriptionCount(): number {
  return onHvir.mock.calls.filter(([channel]) => channel === 'fs:project-file-operation')
    .length
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

function expectSharedFileDialog(selector: string): void {
  const dialog = document.querySelector(selector)
  expect(dialog?.classList.contains('project-dialog')).toBe(true)
  expect(dialog?.classList.contains('confirmation-dialog')).toBe(true)
  expect(dialog?.querySelector('.confirmation-dialog-content')).not.toBeNull()
  expect(dialog?.querySelector('.confirmation-dialog-actions')).not.toBeNull()
}

function dataTransferEvent(type: string, dataTransfer: object): Event {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
  return event
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

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}
