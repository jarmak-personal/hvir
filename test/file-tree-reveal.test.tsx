// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
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
  it('expands ancestors, selects the directory, and scrolls its row into view', async () => {
    const onOpen = vi.fn()
    act(() => {
      reactRoot.render(
        <FileTree
          root={workspaceRoot}
          refreshVersion={0}
          searchRefreshVersion={0}
          ignoredRefreshVersion={0}
          selected={target}
          revealRequest={{ path: target, token: 1 }}
          onOpen={onOpen}
          viewerPathRebind={{
            canRebindPath: () => true,
            rebindPath: () => true,
          }}
          onWorkspaceContentChanged={() => undefined}
          gitEnabled={false}
        />,
      )
    })

    await waitFor(() => selectedRow(target) !== undefined)

    expect(treeRow(workspaceRoot)?.getAttribute('aria-expanded')).toBe('true')
    expect(treeRow(localPath('/repo/src'))?.getAttribute('aria-expanded')).toBe('true')
    expect(selectedRow(target)?.getAttribute('aria-expanded')).toBe('true')
    expect(scrollIntoView.mock.instances).toContain(selectedRow(target))
    expect(onOpen).not.toHaveBeenCalled()
  })
})

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
