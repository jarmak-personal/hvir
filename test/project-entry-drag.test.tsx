// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FileTree } from '../src/renderer/src/tree/FileTree'
import {
  canDragProjectEntry,
  PROJECT_ENTRY_DRAG_TYPE,
  projectEntryDropRequest,
} from '../src/renderer/src/tree/project-entry-drag'
import {
  asHostId,
  hostPath,
  localPath,
  type HostPath,
  type ProjectFileOperationProgress,
} from '../src/shared'
import type { ViewerPathRebindCapability } from '../src/renderer/src/viewer/viewer-path-rebind'
import type { ViewerPathRemovalCapability } from '../src/renderer/src/viewer/viewer-path-removal'

const root = localPath('/repo')
let container: HTMLDivElement
let reactRoot: Root
let invoke: ReturnType<typeof vi.fn>
let operationEvents: ((event: ProjectFileOperationProgress) => void)[]
let acquireDropped: ReturnType<typeof vi.fn>
let viewer: ViewerPathRebindCapability & ViewerPathRemovalCapability
let onWorkspaceContentChanged: ReturnType<typeof vi.fn<() => void>>

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  operationEvents = []
  acquireDropped = vi.fn()
  invoke = vi.fn((channel: string, request: { readonly path?: HostPath }) => {
    if (channel === 'fs:readdir') {
      return Promise.resolve({
        ok: true,
        value:
          request.path?.path === '/repo'
            ? [
                { name: 'src', type: 'dir' },
                { name: 'existing.md', type: 'file' },
                { name: 'socket', type: 'other' },
              ]
            : [],
      })
    }
    if (channel === 'fs:deletion-disclosure') return new Promise(() => undefined)
    if (channel === 'fs:organize-entry') {
      return Promise.resolve({
        ok: true,
        value: {
          outcome: 'started',
          operationId: 'drag-move-1',
          generation: 1,
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
      externalFiles: { acquireDropped },
      on: vi.fn(
        (channel: string, callback: (event: ProjectFileOperationProgress) => void) => {
          if (channel === 'fs:project-file-operation') operationEvents.push(callback)
          return () => undefined
        },
      ),
    },
  })
  viewer = {
    canRebindPath: vi.fn(() => true),
    rebindPath: vi.fn(() => true),
    reviewPathRemoval: () => ({ openCount: 0, dirtyPaths: [] }),
    closeCleanPath: () => ({ openCount: 0, dirtyPaths: [], closedCount: 0 }),
  }
  onWorkspaceContentChanged = vi.fn()
  container = document.createElement('div')
  document.body.append(container)
  reactRoot = createRoot(container)
})

afterEach(async () => {
  await act(settle)
  act(() => reactRoot.unmount())
  container.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('project entry drag policy', () => {
  it('admits supported non-root entries and applies the visible target rule', () => {
    expect(canDragProjectEntry(root, localPath('/repo/a.ts'), 'file')).toBe(true)
    expect(canDragProjectEntry(root, localPath('/repo/link'), 'symlink')).toBe(true)
    expect(canDragProjectEntry(root, root, 'dir')).toBe(false)
    expect(canDragProjectEntry(root, localPath('/repo/socket'), 'other')).toBe(false)

    expect(
      projectEntryDropRequest(
        root,
        { source: localPath('/repo/a.ts'), sourceType: 'file' },
        localPath('/repo/src/visible.ts'),
        'file',
      ),
    ).toMatchObject({ destinationDirectory: localPath('/repo/src') })
  })

  it('rejects same-parent, descendant, unsupported, and cross-host targets', () => {
    const file = { source: localPath('/repo/a.ts'), sourceType: 'file' as const }
    expect(projectEntryDropRequest(root, file, root, 'dir')).toBeUndefined()
    expect(
      projectEntryDropRequest(root, file, localPath('/repo/socket'), 'other'),
    ).toBeUndefined()
    expect(
      projectEntryDropRequest(
        root,
        { source: localPath('/repo/src'), sourceType: 'dir' },
        localPath('/repo/src/nested'),
        'dir',
      ),
    ).toBeUndefined()
    expect(
      projectEntryDropRequest(
        root,
        file,
        hostPath(asHostId('ssh:test'), '/repo/src'),
        'dir',
      ),
    ).toBeUndefined()
  })
})

describe('Files tree internal drag interaction', () => {
  it('highlights the actual directory with text and moves through the existing coordinator', async () => {
    renderTree()
    await waitForRows()
    const source = row('/repo/existing.md')!
    const destination = row('/repo/src')!
    const transfer = dragTransfer()

    act(() => {
      source.dispatchEvent(dragEvent('dragstart', transfer))
    })
    expect(transfer.types).toContain(PROJECT_ENTRY_DRAG_TYPE)
    act(() => {
      destination.dispatchEvent(dragEvent('dragover', transfer))
    })

    expect(transfer.dropEffect).toBe('move')
    expect(destination.dataset.fileDropTarget).toBe('move')
    expect(destination.textContent).toContain('Move here')
    expect(container.querySelector('.file-drop-target')?.textContent).toContain(
      'Move into src',
    )

    act(() => {
      destination.dispatchEvent(dragEvent('drop', transfer))
    })
    await act(settle)
    expect(invoke).toHaveBeenCalledWith('fs:organize-entry', {
      action: 'move',
      workspaceRoot: root,
      source: localPath('/repo/existing.md'),
      destinationDirectory: localPath('/repo/src'),
    })
    expect(acquireDropped).not.toHaveBeenCalled()
    expect(container.querySelector('[data-file-drop-target]')).toBeNull()

    act(() => operationEvents.forEach((accept) => accept(completedMove())))
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    })
    expect(viewer.rebindPath).toHaveBeenCalledWith(
      localPath('/repo/existing.md'),
      localPath('/repo/src/existing.md'),
    )
    expect(onWorkspaceContentChanged).toHaveBeenCalledOnce()
  })

  it('rejects invalid targets and clears transient state on drag end', async () => {
    renderTree()
    await waitForRows()
    const source = row('/repo/existing.md')!
    const transfer = dragTransfer()
    act(() => {
      source.dispatchEvent(dragEvent('dragstart', transfer))
    })
    act(() => {
      row('/repo/src')!.dispatchEvent(dragEvent('dragover', transfer))
    })
    expect(container.querySelector('[data-file-drop-target]')).not.toBeNull()

    act(() => {
      source.dispatchEvent(dragEvent('dragend', transfer))
    })
    expect(container.querySelector('[data-file-drop-target]')).toBeNull()
    expect(container.querySelector('.file-drop-target')).toBeNull()

    const rejected = dragTransfer()
    act(() => {
      source.dispatchEvent(dragEvent('dragstart', rejected))
    })
    act(() => {
      row('/repo')!.dispatchEvent(dragEvent('dragover', rejected))
    })
    expect(rejected.dropEffect).toBe('none')
    expect(container.querySelector('[data-file-drop-target]')).toBeNull()
    expect(invoke).not.toHaveBeenCalledWith('fs:organize-entry', expect.anything())
  })
})

function renderTree(): void {
  act(() => {
    reactRoot.render(
      <FileTree
        root={root}
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
}

function row(path: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>('[role="treeitem"]')].find(
    (candidate) => candidate.dataset.filePath === path,
  )
}

async function waitForRows(): Promise<void> {
  for (let attempt = 0; attempt < 60 && !row('/repo/existing.md'); attempt += 1) {
    await act(async () => Promise.resolve())
  }
  expect(row('/repo/existing.md')).toBeDefined()
}

interface TestDataTransfer {
  types: string[]
  files: File[]
  effectAllowed: string
  dropEffect: string
  setData(type: string, value: string): void
  getData(type: string): string
}

function dragTransfer(): TestDataTransfer {
  const data = new Map<string, string>()
  return {
    types: [],
    files: [],
    effectAllowed: 'none',
    dropEffect: 'none',
    setData(type, value) {
      data.set(type, value)
      if (!this.types.includes(type)) this.types.push(type)
    },
    getData: (type) => data.get(type) ?? '',
  }
}

function dragEvent(type: string, dataTransfer: TestDataTransfer): Event {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
  return event
}

function completedMove(): ProjectFileOperationProgress {
  return {
    workspaceRoot: root,
    operationId: 'drag-move-1',
    generation: 1,
    phase: 'completed',
    completedItems: 1,
    totalItems: 1,
    result: {
      outcome: 'completed',
      operationId: 'drag-move-1',
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
    },
  }
}

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}
