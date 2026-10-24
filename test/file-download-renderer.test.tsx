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
  type ProjectFileOperationProgress,
} from '../src/shared'

const root = hostPath(asHostId('ssh:files-fixture'), '/repo')
let container: HTMLDivElement
let reactRoot: Root
let invoke: ReturnType<typeof vi.fn>
let listeners: Set<(event: ProjectFileOperationProgress) => void>
let downloadResult: unknown
let drop: ReturnType<typeof vi.fn>
const viewers = {
  canRebindPath: () => true,
  rebindPath: () => true,
  reviewPathRemoval: () => ({ openCount: 0, dirtyPaths: [] }),
  closeCleanPath: () => ({ openCount: 0, dirtyPaths: [], closedCount: 0 }),
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  listeners = new Set()
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
        value:
          request?.path?.path === '/repo'
            ? [
                { name: 'output.txt', type: 'file' },
                { name: 'folder', type: 'dir' },
                { name: 'link', type: 'symlink' },
              ]
            : [],
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
async function render(path = root) {
  await act(async () => {
    reactRoot.render(
      <FileTree
        root={path}
        refreshVersion={0}
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
    expect(row('folder').getAttribute('aria-selected')).toBe('true')
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
