// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FileTree } from '../src/renderer/src/tree/FileTree'
import {
  asHostId,
  hostPath,
  localPath,
  type HostPath,
  type DirEntry,
  type ProjectFileOperationProgress,
} from '../src/shared'

const root = hostPath(asHostId('ssh:files-fixture'), '/repo')
let container: HTMLDivElement
let reactRoot: Root
let invoke: ReturnType<typeof vi.fn>
let listeners: Set<(event: ProjectFileOperationProgress) => void>
let downloadResult: unknown
let drop: ReturnType<typeof vi.fn>
let entries: readonly DirEntry[]
const viewers = {
  canRebindPath: () => true,
  rebindPath: () => true,
  reviewPathRemoval: () => ({ openCount: 0, dirtyPaths: [] }),
  closeCleanPath: () => ({ openCount: 0, dirtyPaths: [], closedCount: 0 }),
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  listeners = new Set()
  entries = [
    { name: 'output.txt', type: 'file' },
    { name: 'other.txt', type: 'file' },
    { name: 'folder', type: 'dir' },
    { name: 'link', type: 'symlink' },
  ]
  downloadResult = {
    outcome: 'started',
    operationId: 'download-1',
    generation: 1,
    itemCount: 1,
  }
  drop = vi.fn().mockResolvedValue({
    ok: true,
    value: {
      outcome: 'available',
      grant: { grantId: 'drop', generation: 1, items: [] },
    },
  })
  invoke = vi.fn(async (channel: string, request?: { readonly path?: HostPath }) => {
    if (channel === 'fs:readdir')
      return {
        ok: true,
        value: request?.path?.path === '/repo' ? entries : [],
      }
    if (channel === 'fs:download-entry') return { ok: true, value: downloadResult }
    if (channel === 'fs:acquire-clipboard-files')
      return {
        ok: true,
        value: {
          outcome: 'available',
          grant: { grantId: 'clipboard', generation: 1, items: [] },
        },
      }
    if (channel === 'fs:copy-external')
      return {
        ok: true,
        value: {
          outcome: 'started',
          operationId: 'upload-1',
          generation: 1,
          itemCount: 1,
        },
      }
    if (channel === 'fs:cancel-file-operation') return { ok: true, value: true }
    if (channel === 'fs:deletion-disclosure') return new Promise(() => undefined)
    throw new Error(`Unexpected channel: ${channel}`)
  })
  Object.defineProperty(window, 'hvir', {
    configurable: true,
    value: {
      invoke,
      send: vi.fn(),
      externalFiles: { acquireDropped: drop },
      on(_channel: string, listener: (event: ProjectFileOperationProgress) => void) {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
    },
  })
  container = document.createElement('div')
  document.body.append(container)
  reactRoot = createRoot(container)
})
afterEach(() => {
  act(() => reactRoot.unmount())
  container.remove()
  vi.unstubAllGlobals()
})
async function render(
  path = root,
  options: {
    readonly selected?: HostPath
    readonly refreshVersion?: number
  } = {},
) {
  await act(async () => {
    reactRoot.render(
      <FileTree
        root={path}
        refreshVersion={options.refreshVersion ?? 0}
        selected={options.selected}
        searchRefreshVersion={0}
        ignoredRefreshVersion={0}
        gitEnabled={false}
        viewerPathRebind={viewers}
        onWorkspaceContentChanged={() => undefined}
        onOpen={() => undefined}
      />,
    )
    await Promise.resolve()
  })
}
const row = (name: string) =>
  container.querySelector<HTMLElement>(`[data-file-path="/repo/${name}"]`)!
const downloadButton = () =>
  [...container.querySelectorAll('button')].find(
    (button) => button.textContent === 'Download…',
  )!
async function click(element: HTMLElement) {
  await act(async () => {
    element.click()
    await Promise.resolve()
  })
}
async function emit(event: Partial<ProjectFileOperationProgress>) {
  await act(async () => {
    for (const listener of listeners)
      listener({
        workspaceRoot: root,
        operationId: 'download-1',
        generation: 1,
        phase: 'downloading',
        completedItems: 0,
        totalItems: 1,
        ...event,
      })
    await Promise.resolve()
  })
}

describe('Files downloads', () => {
  it('shows a visible control for SSH, selects real files/folders, and starts without another confirmation', async () => {
    await render()
    expect(downloadButton().disabled).toBe(true)
    await click(row('link'))
    expect(downloadButton().disabled).toBe(true)
    await click(row('folder'))
    expect(downloadButton().title).toBe('Download folder')
    expect(downloadButton().disabled).toBe(false)
    await click(row('output.txt'))
    await click(downloadButton())
    expect(invoke).toHaveBeenCalledWith('fs:download-entry', {
      workspaceRoot: root,
      source: hostPath(root.hostId, '/repo/output.txt'),
    })
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    await emit({})
    expect(document.querySelector('[role="status"]')?.textContent).toContain(
      'Downloading',
    )
    await click(row('folder'))
    await render(root, {
      selected: hostPath(root.hostId, '/repo/other.txt'),
      refreshVersion: 1,
    })
    expect(
      invoke.mock.calls.filter(([channel]) => channel === 'fs:download-entry'),
    ).toHaveLength(1)
    const cancel = [...document.querySelectorAll('button')].find(
      (button) => button.textContent === 'Cancel',
    )!
    await click(cancel)
    expect(invoke).toHaveBeenCalledWith('fs:cancel-file-operation', {
      operationId: 'download-1',
      generation: 1,
    })
    await emit({
      phase: 'completed',
      completedItems: 1,
      result: {
        outcome: 'completed',
        operationId: 'download-1',
        generation: 1,
        items: [
          {
            itemId: 'download:0',
            destination: localPath('/chosen/output.txt'),
            status: 'completed',
            effect: 'copied-file',
          },
        ],
      },
    })
    expect(document.body.textContent).toContain('1 entry downloaded.')
    expect(document.body.textContent).toContain('/chosen/output.txt')
  })
  it('keeps the viewer highlight independent of the download target and follows tab changes', async () => {
    await render(root, { selected: hostPath(root.hostId, '/repo/output.txt') })
    await click(row('folder'))
    expect(row('output.txt').getAttribute('aria-selected')).toBe('true')
    expect(row('folder').getAttribute('aria-selected')).toBe('false')
    expect(downloadButton().title).toBe('Download folder')

    await render(root, { selected: hostPath(root.hostId, '/repo/output.txt') })
    expect(downloadButton().disabled).toBe(false)
    await render(root, { selected: hostPath(root.hostId, '/repo/other.txt') })
    expect(row('other.txt').getAttribute('aria-selected')).toBe('true')
    expect(row('output.txt').getAttribute('aria-selected')).toBe('false')
    expect(downloadButton().disabled).toBe(true)
    expect(container.textContent).toContain('Select a file or folder')
  })

  it('preserves a clicked file target when opening it updates the active viewer selection', async () => {
    await render(root, { selected: hostPath(root.hostId, '/repo/other.txt') })
    await click(row('output.txt'))
    await render(root, { selected: hostPath(root.hostId, '/repo/output.txt') })
    expect(row('output.txt').getAttribute('aria-selected')).toBe('true')
    expect(downloadButton().disabled).toBe(false)
    await click(downloadButton())
    expect(invoke).toHaveBeenCalledWith('fs:download-entry', {
      workspaceRoot: root,
      source: hostPath(root.hostId, '/repo/output.txt'),
    })
  })

  it.each(['rename', 'delete'] as const)(
    'invalidates a target after external %s and tree refresh',
    async (action) => {
      const selected = hostPath(root.hostId, '/repo/output.txt')
      await render(root, { selected })
      await click(row('output.txt'))
      entries = entries.filter((entry) => entry.name !== 'output.txt')
      if (action === 'rename')
        entries = [...entries, { name: 'renamed.txt', type: 'file' }]
      await render(root, { selected, refreshVersion: 1 })
      expect(row('output.txt')).toBeNull()
      expect(downloadButton().disabled).toBe(true)
      expect(downloadButton().title).toBe('Select a file or folder to download')
      expect(
        container.querySelector('.file-download-controls')?.textContent,
      ).not.toContain('output.txt')
      if (action === 'rename') expect(row('renamed.txt')).not.toBeNull()
    },
  )

  it('invalidates a target after a Files operation refresh without a parent refresh', async () => {
    await render()
    await click(row('output.txt'))
    await act(async () => {
      row('folder').dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'v',
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      )
      await Promise.resolve()
    })
    await emit({
      operationId: 'upload-1',
      phase: 'completed',
      completedItems: 1,
      result: {
        outcome: 'completed',
        operationId: 'upload-1',
        generation: 1,
        items: [
          {
            itemId: 'external:0',
            destination: hostPath(root.hostId, '/repo/folder/input.txt'),
            status: 'completed',
            effect: 'copied-file',
          },
        ],
      },
    })
    expect(downloadButton().disabled).toBe(true)
    expect(downloadButton().title).toBe('Select a file or folder to download')
  })

  it('silently handles native picker cancellation and releases the pending control', async () => {
    downloadResult = { outcome: 'cancelled' }
    await render()
    await click(row('output.txt'))
    await click(downloadButton())
    expect(downloadButton().disabled).toBe(false)
    expect(document.querySelector('[role="alert"]')).toBeNull()
  })
  it('hides Download for local workspaces', async () => {
    await render(localPath('/repo'))
    expect(downloadButton()).toBeUndefined()
  })
  it('keeps keyboard paste pointed at the visible SSH folder with copy semantics', async () => {
    await render()
    await act(async () => {
      row('folder').dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'v',
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      )
      await Promise.resolve()
    })
    expect(invoke).toHaveBeenCalledWith('fs:copy-external', {
      workspaceRoot: root,
      destinationDirectory: hostPath(root.hostId, '/repo/folder'),
      grantId: 'clipboard',
      grantGeneration: 1,
    })
  })
  it('keeps external drops pointed at the visible SSH folder with copy semantics', async () => {
    await render()
    const file = new File(['input'], 'input.txt')
    const event = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', {
      value: { types: ['Files'], files: [file] },
    })
    await act(async () => {
      row('folder').dispatchEvent(event)
      await Promise.resolve()
    })
    expect(drop).toHaveBeenCalledWith([file])
    expect(invoke).toHaveBeenCalledWith('fs:copy-external', {
      workspaceRoot: root,
      destinationDirectory: hostPath(root.hostId, '/repo/folder'),
      grantId: 'drop',
      grantGeneration: 1,
    })
  })
})
