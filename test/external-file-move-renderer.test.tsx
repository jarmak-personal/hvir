// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FileTree } from '../src/renderer/src/tree/FileTree'
import {
  localPath,
  type DirEntry,
  type HostPath,
  type ProjectFileOperationProgress,
  type ProjectFileOperationResult,
} from '../src/shared'
import type { ViewerPathRebindCapability } from '../src/renderer/src/viewer/viewer-path-rebind'
import type { ViewerPathRemovalCapability } from '../src/renderer/src/viewer/viewer-path-removal'

const root = localPath('/repo')
const entries = new Map<string, readonly DirEntry[]>([
  [
    '/repo',
    [
      { name: 'src', type: 'dir' },
      { name: 'existing.md', type: 'file' },
    ],
  ],
  ['/repo/src', []],
])
const viewerPaths: ViewerPathRebindCapability & ViewerPathRemovalCapability = {
  canRebindPath: () => true,
  rebindPath: () => true,
  reviewPathRemoval: () => ({ openCount: 0, dirtyPaths: [] }),
  closeCleanPath: () => ({ openCount: 0, dirtyPaths: [], closedCount: 0 }),
}

let container: HTMLDivElement
let reactRoot: Root
let invoke: ReturnType<typeof vi.fn>
let listeners: Array<(event: ProjectFileOperationProgress) => void>
let mixedPicker: boolean

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  listeners = []
  mixedPicker = false
  invoke = vi.fn((channel: string, request?: { readonly path?: HostPath }) => {
    if (channel === 'fs:readdir') {
      return Promise.resolve({
        ok: true,
        value: entries.get(request!.path!.path) ?? [],
      })
    }
    if (channel === 'fs:deletion-disclosure') {
      return new Promise(() => undefined)
    }
    if (channel === 'fs:external-move-disclosure') {
      return Promise.resolve({
        ok: true,
        value: {
          outcome: 'available',
          picker: mixedPicker
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
          recovery: 'recoverable',
        },
      })
    }
    if (channel === 'fs:acquire-external-move-files') {
      return Promise.resolve({
        ok: true,
        value: {
          outcome: 'available',
          grant: {
            grantId: 'move-grant-1',
            generation: 3,
            items: [{ itemId: 'external:0', name: 'selected.txt', type: 'file' }],
          },
        },
      })
    }
    if (channel === 'fs:move-external') {
      return Promise.resolve({
        ok: true,
        value: {
          outcome: 'started',
          operationId: 'external-move-1',
          generation: 4,
          itemCount: 1,
        },
      })
    }
    throw new Error(`Unexpected channel: ${channel}`)
  })
  Object.defineProperty(window, 'hvir', {
    configurable: true,
    value: {
      invoke,
      send: vi.fn(),
      externalFiles: { acquireDropped: vi.fn() },
      on: vi.fn(
        (channel: string, callback: (event: ProjectFileOperationProgress) => void) => {
          if (channel === 'fs:project-file-operation') listeners.push(callback)
          return () => {
            listeners = listeners.filter((candidate) => candidate !== callback)
          }
        },
      ),
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
  vi.unstubAllGlobals()
})

describe('external file move renderer workflow', () => {
  it('discloses, confirms, and refreshes a pointer-initiated move', async () => {
    const onWorkspaceContentChanged = vi.fn()
    renderFileTree(onWorkspaceContentChanged)
    await waitFor(() => treeRow() !== undefined)
    act(() => {
      treeRow()!.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          clientX: 18,
          clientY: 22,
        }),
      )
    })
    act(() => menuItem('Move External Items Here…')!.click())

    await waitFor(() => dialogText().includes('files and folders cannot be mixed'))
    expect(dialogText()).toContain('local:/repo')
    expect(dialogText()).toContain('Application-host Trash')
    act(() => dialogButton('Choose Files…')!.click())
    await waitFor(() => dialogText().includes('selected.txt'))
    expect(dialogText()).not.toContain('/outside')
    await waitFor(() => document.activeElement === dialogButton('Cancel'))
    act(() => dialogButton('Move Selected Items')!.click())
    await waitFor(() =>
      invoke.mock.calls.some(([channel]) => channel === 'fs:move-external'),
    )
    expect(invoke).toHaveBeenCalledWith('fs:move-external', {
      workspaceRoot: root,
      destinationDirectory: root,
      grantId: 'move-grant-1',
      grantGeneration: 3,
    })

    broadcastCompletedMove()
    await act(settle)
    expect(onWorkspaceContentChanged).toHaveBeenCalledOnce()
    expect(document.querySelector('.file-operation-feedback')?.textContent).toContain(
      '1 moved',
    )
  })

  it('keyboard-reaches the macOS mixed picker and focuses safe confirmation', async () => {
    mixedPicker = true
    renderFileTree(vi.fn())
    await waitFor(() => treeRow() !== undefined)
    treeRow()!.focus()
    act(() => {
      treeRow()!.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'F10',
          shiftKey: true,
          bubbles: true,
        }),
      )
    })
    await waitFor(() => document.activeElement?.textContent?.trim() === 'New File…')
    await focusMenuItem('Move External Items Here…')
    act(() => (document.activeElement as HTMLButtonElement).click())

    await waitFor(() => dialogText().includes('multiple files and folders together'))
    const choose = dialogButton('Choose Files or Folders…')!
    await waitFor(() => document.activeElement === choose)
    act(() => choose.click())
    await waitFor(() => dialogText().includes('selected.txt'))
    await waitFor(() => document.activeElement === dialogButton('Cancel'))
    expect(invoke).toHaveBeenCalledWith('fs:acquire-external-move-files', {
      selection: 'mixed',
    })
  })
})

function renderFileTree(onWorkspaceContentChanged: () => void): void {
  act(() => {
    reactRoot.render(
      <FileTree
        root={root}
        refreshVersion={0}
        searchRefreshVersion={0}
        ignoredRefreshVersion={0}
        onOpen={vi.fn()}
        viewerPathRebind={viewerPaths}
        onWorkspaceContentChanged={onWorkspaceContentChanged}
        gitEnabled={false}
      />,
    )
  })
}

function treeRow(): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>('[role="treeitem"]')].find(
    (row) => row.dataset.filePath === '/repo/existing.md',
  )
}

function menuItem(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
    (button) => button.textContent?.trim() === label,
  )
}

function dialogButton(label: string): HTMLButtonElement | undefined {
  return [
    ...document.querySelectorAll<HTMLButtonElement>('.file-external-move-dialog button'),
  ].find((button) => button.textContent?.trim() === label)
}

async function focusMenuItem(label: string): Promise<void> {
  for (let step = 0; step < 12; step += 1) {
    if (document.activeElement?.textContent?.trim() === label) return
    act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
      )
    })
    await act(async () => Promise.resolve())
  }
  throw new Error(`Could not keyboard-focus ${label}`)
}

function broadcastCompletedMove(): void {
  const result: Extract<ProjectFileOperationResult, { readonly outcome: 'completed' }> = {
    outcome: 'completed',
    operationId: 'external-move-1',
    generation: 4,
    items: [
      {
        itemId: 'external:0',
        source: localPath('/outside/selected.txt'),
        destination: localPath('/repo/selected.txt'),
        status: 'completed',
        effect: 'moved-external-file',
        sourceDisposition: { outcome: 'removed' },
      },
    ],
  }
  const event: ProjectFileOperationProgress = {
    workspaceRoot: root,
    operationId: result.operationId,
    generation: result.generation,
    phase: 'completed',
    completedItems: 1,
    totalItems: 1,
    result,
  }
  act(() => {
    for (const listener of listeners) listener(event)
  })
}

function dialogText(): string {
  return document.querySelector('.file-external-move-dialog')?.textContent ?? ''
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (condition()) return
    await act(async () => Promise.resolve())
  }
  throw new Error('Timed out waiting for external move UI')
}

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}
