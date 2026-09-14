// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DirectoryTree } from '../src/renderer/src/tree/DirectoryTree'
import { FileTree } from '../src/renderer/src/tree/FileTree'
import { localPath, type DirEntry, type HostPath } from '../src/shared'

const workspaceRoot = localPath('/repo')
const target = localPath('/repo/src/renderer')
const entries = new Map<string, readonly DirEntry[]>([
  ['/repo', [{ name: 'src', type: 'dir' }]],
  [
    '/repo/src',
    [
      { name: 'renderer', type: 'dir' },
      { name: 'main.ts', type: 'file' },
    ],
  ],
  ['/repo/src/renderer', []],
])

let container: HTMLDivElement
let reactRoot: Root
let originalScrollIntoView: PropertyDescriptor | undefined
const scrollIntoView = vi.fn()
const frames = new Map<number, FrameRequestCallback>()
let frameId = 0

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  frames.clear()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = ++frameId
    frames.set(id, callback)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    frames.delete(id)
  })
  originalScrollIntoView = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    'scrollIntoView',
  )
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: scrollIntoView,
  })
  scrollIntoView.mockReset()
  Object.defineProperty(window, 'hvir', {
    configurable: true,
    value: {
      invoke: vi.fn((_channel: string, request: { readonly path: HostPath }) =>
        Promise.resolve({
          ok: true as const,
          value: entries.get(request.path.path) ?? [],
        }),
      ),
      send: vi.fn(),
      on: vi.fn(() => () => undefined),
      externalFiles: {
        acquireDropped: vi.fn(() => Promise.reject(new Error('not configured'))),
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
  if (originalScrollIntoView) {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScrollIntoView)
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
  }
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('Files rail directory reveal', () => {
  it('expands ancestors, selects the directory, and scrolls/focuses the exact revealed row', async () => {
    const onOpen = vi.fn()
    act(() => {
      reactRoot.render(
        <FileTree
          root={workspaceRoot}
          refreshVersion={0}
          searchRefreshVersion={0}
          ignoredRefreshVersion={0}
          selected={target}
          revealRequest={{ path: target, token: 1, focusRow: true }}
          onOpen={onOpen}
          viewerPathRebind={{
            canRebindPath: () => true,
            rebindPath: () => true,
            reviewPathRemoval: () => ({ openCount: 0, dirtyPaths: [] }),
            closeCleanPath: () => ({
              openCount: 0,
              dirtyPaths: [],
              closedCount: 0,
            }),
          }}
          onWorkspaceContentChanged={() => undefined}
          gitEnabled={false}
        />,
      )
    })

    await waitFor(() => selectedRow(target) !== undefined)
    flushFrames()
    expect(document.activeElement).toBe(selectedRow(target))

    expect(treeRow(workspaceRoot)?.getAttribute('aria-expanded')).toBe('true')
    expect(treeRow(localPath('/repo/src'))?.getAttribute('aria-expanded')).toBe('true')
    expect(selectedRow(target)?.getAttribute('aria-expanded')).toBe('true')
    expect(scrollIntoView.mock.instances).toContain(selectedRow(target))
    expect(onOpen).not.toHaveBeenCalled()
  })
})

it.each(['selection', 'request', 'unmount'] as const)(
  'cancels explicit row focus when its %s departs before layout',
  async (change) => {
    const loadEntries = () => Promise.resolve([])
    act(() =>
      reactRoot.render(
        <DirectoryTree
          root={target}
          loadEntries={loadEntries}
          selected={target}
          revealRequest={{ path: target, token: 1, focusRow: true }}
        />,
      ),
    )
    expect(frames.size).toBe(1)
    act(() =>
      reactRoot.render(
        change === 'unmount' ? null : (
          <DirectoryTree
            root={target}
            loadEntries={loadEntries}
            selected={change === 'selection' ? undefined : target}
            revealRequest={
              change === 'request'
                ? undefined
                : { path: target, token: 1, focusRow: true }
            }
          />
        ),
      ),
    )
    expect(frames.size).toBe(0)
    flushFrames()
    expect(scrollIntoView).not.toHaveBeenCalled()
    expect(document.activeElement).not.toBe(treeRow(target))
    await act(async () => {
      await Promise.resolve()
    })
  },
)
it('does not focus a directory for ordinary selection without an explicit reveal', async () => {
  const loadEntries = () => Promise.resolve([])
  act(() =>
    reactRoot.render(
      <DirectoryTree root={target} loadEntries={loadEntries} selected={target} />,
    ),
  )
  expect(frames.size).toBe(0)
  expect(document.activeElement).not.toBe(treeRow(target))
  await act(async () => {
    await Promise.resolve()
  })
})
it('preserves input focus for an ordinary scroll-only folder reveal', async () => {
  const input = document.createElement('input')
  document.body.append(input)
  input.focus()
  const loadEntries = () => Promise.resolve([])
  try {
    act(() =>
      reactRoot.render(
        <DirectoryTree
          root={target}
          loadEntries={loadEntries}
          selected={target}
          revealRequest={{ path: target, token: 1 }}
        />,
      ),
    )
    flushFrames()
    expect(scrollIntoView.mock.instances).toContain(treeRow(target))
    expect(document.activeElement).toBe(input)
  } finally {
    input.remove()
  }
  await act(async () => {
    await Promise.resolve()
  })
})
function flushFrames(): void {
  act(() => {
    const pending = [...frames.values()]
    frames.clear()
    for (const callback of pending) callback(performance.now())
  })
}

function treeRow(path: HostPath): HTMLButtonElement | undefined {
  return (
    [...container.querySelectorAll<HTMLButtonElement>('[role="treeitem"]')].find(
      (row) => row.title === path.path,
    ) ?? undefined
  )
}

function selectedRow(path: HostPath): HTMLButtonElement | undefined {
  const row = treeRow(path)
  return row?.getAttribute('aria-selected') === 'true' ? row : undefined
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (condition()) return
    await act(async () => {
      await Promise.resolve()
    })
  }
  throw new Error('Timed out waiting for the Files tree reveal')
}
