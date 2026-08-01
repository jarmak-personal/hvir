// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { pathCopyValue } from '../src/renderer/src/path-copy/path-copy'
import { DirectoryTree } from '../src/renderer/src/tree/DirectoryTree'
import { TabStrip } from '../src/renderer/src/viewer/TabStrip'
import type { ViewerPaneId, ViewerTab } from '../src/renderer/src/viewer/tab-state'
import { asHostId, hostPath, localPath, type HostPath } from '../src/shared'

let host: HTMLDivElement
let root: Root
let writeText: ReturnType<typeof vi.fn<(value: string) => Promise<void>>>
let originalClipboard: PropertyDescriptor | undefined

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  writeText = vi.fn<(value: string) => Promise<void>>().mockResolvedValue(undefined)
  originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  if (originalClipboard) {
    Object.defineProperty(navigator, 'clipboard', originalClipboard)
  } else {
    Reflect.deleteProperty(navigator, 'clipboard')
  }
  document.querySelectorAll('.path-copy-menu, .path-copy-feedback').forEach((node) => {
    node.remove()
  })
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('path copy formatting', () => {
  it('preserves POSIX paths, spaces, Unicode, and host-side SSH identity', () => {
    const localRoot = localPath('/Users/example/My Project')
    expect(pathCopyValue(localRoot, localRoot, 'relative')).toBe('.')
    expect(
      pathCopyValue(
        localRoot,
        localPath('/Users/example/My Project/src/猫 file.ts'),
        'relative',
      ),
    ).toBe('src/猫 file.ts')
    expect(
      pathCopyValue(
        localRoot,
        localPath('/Users/example/My Project/src/猫 file.ts'),
        'absolute',
      ),
    ).toBe('/Users/example/My Project/src/猫 file.ts')

    const sshHost = asHostId('ssh:production')
    const sshRoot = hostPath(sshHost, '/srv/app')
    const sshPath = hostPath(sshHost, '/srv/app/docs/guide.md')
    expect(pathCopyValue(sshRoot, sshPath, 'relative')).toBe('docs/guide.md')
    expect(pathCopyValue(sshRoot, sshPath, 'absolute')).toBe('/srv/app/docs/guide.md')
  })

  it('rejects paths outside the host-qualified workspace', () => {
    expect(() =>
      pathCopyValue(localPath('/repo'), localPath('/other/file.ts'), 'relative'),
    ).toThrow('outside the active workspace')
    expect(() =>
      pathCopyValue(localPath('/repo'), localPath('/other/file.ts'), 'absolute'),
    ).toThrow('outside the active workspace')
    expect(() =>
      pathCopyValue(
        localPath('/repo'),
        hostPath(asHostId('ssh:example'), '/repo/file.ts'),
        'relative',
      ),
    ).toThrow('not on the active workspace host')
  })
})

describe('Files rail path actions', () => {
  it('copies root, file, directory, and visible symbolic-link paths without selecting or opening', async () => {
    const workspaceRoot = hostPath(asHostId('ssh:example'), '/srv/Project Space')
    const onOpenFile = vi.fn()
    const onSelectDirectory = vi.fn()

    await act(async () => {
      root.render(
        <DirectoryTree
          root={workspaceRoot}
          rootLabel="Project Space"
          pathCopyRoot={workspaceRoot}
          loadEntries={(path) =>
            Promise.resolve(
              path.path === workspaceRoot.path
                ? [
                    { name: 'docs', type: 'dir' },
                    { name: 'notes.md', type: 'file' },
                    { name: 'folder link', type: 'symlink' },
                    { name: '猫 link.md', type: 'symlink' },
                  ]
                : [],
            )
          }
          resolveEntry={(path) =>
            Promise.resolve(path.path.endsWith('folder link') ? 'dir' : 'file')
          }
          onOpenFile={onOpenFile}
          onSelectDirectory={onSelectDirectory}
        />,
      )
      await Promise.resolve()
    })

    await copyFromTreeRow('Project Space', 'Copy Relative Path')
    await copyFromTreeRow('docs', 'Copy Absolute Path')
    await copyFromTreeRow('folder link', 'Copy Relative Path')
    await copyFromTreeRow('猫 link.md', 'Copy Relative Path')
    await copyFromTreeRow('notes.md', 'Copy Relative Path')

    expect(writeText.mock.calls).toEqual([
      ['.'],
      ['/srv/Project Space/docs'],
      ['folder link'],
      ['猫 link.md'],
      ['notes.md'],
    ])
    expect(onOpenFile).not.toHaveBeenCalled()
    expect(onSelectDirectory).not.toHaveBeenCalled()
    expect(document.querySelector('[role="status"]')?.textContent).toBe(
      'Relative Path copied.',
    )
  })

  it('does not add path actions to another DirectoryTree consumer', async () => {
    const workspaceRoot = localPath('/repo')
    await act(async () => {
      root.render(
        <DirectoryTree
          root={workspaceRoot}
          loadEntries={() => Promise.resolve([{ name: 'src', type: 'dir' }])}
        />,
      )
      await Promise.resolve()
    })

    contextMenu(treeRow('/repo'))
    expect(document.querySelector('[role="menu"]')).toBeNull()
  })
})

describe('viewer tab path actions', () => {
  it.each<ViewerPaneId>(['primary', 'secondary'])(
    'copies file-backed tabs in the %s pane across modes and tab states',
    async (pane) => {
      const workspaceRoot = localPath('/repo')
      const callbacks = renderTabStrip(
        pane,
        [
          viewerTab('/repo/rendered.md', pane, 'rendered', false, false),
          viewerTab('/repo/source.ts', pane, 'source', true, false),
          viewerTab('/repo/dirty.diff', pane, 'diff', true, true),
        ],
        workspaceRoot,
      )

      for (const [name, expected] of [
        ['rendered.md', 'rendered.md'],
        ['source.ts', 'source.ts'],
        ['dirty.diff', 'dirty.diff'],
      ] as const) {
        contextMenu(viewerTabElement(name))
        expect(menuButton('Copy Relative Path')).toBeTruthy()
        expect(menuButton('Copy Absolute Path')).toBeTruthy()
        await clickMenuButton('Copy Relative Path')
        expect(writeText).toHaveBeenLastCalledWith(expected)
      }

      expect(callbacks.onActivate).not.toHaveBeenCalled()
      expect(callbacks.onPin).not.toHaveBeenCalled()
      expect(callbacks.onClose).not.toHaveBeenCalled()
    },
  )

  it('excludes Git and web tabs and restores focus while reporting clipboard failure', async () => {
    const workspaceRoot = localPath('/repo')
    writeText.mockRejectedValueOnce(new Error('clipboard denied'))
    renderTabStrip(
      'primary',
      [viewerTab('/repo/notes.md', 'primary', 'source', true, false)],
      workspaceRoot,
      true,
    )

    contextMenu(host.querySelector('.git-graph-tab'))
    expect(document.querySelector('[role="menu"]')).toBeNull()
    contextMenu(host.querySelector('.web-pane-tab'))
    expect(document.querySelector('[role="menu"]')).toBeNull()

    const tabButton = host.querySelector<HTMLButtonElement>(
      '.viewer-tab:not(.git-graph-tab):not(.web-pane-tab) .tab-main',
    )
    if (!tabButton) throw new Error('Missing file tab button')
    tabButton.focus()
    act(() => {
      tabButton.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'F10',
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      )
    })
    expect(menuButton('Copy Relative Path')).toBe(document.activeElement)

    await clickMenuButton('Copy Absolute Path')

    expect(writeText).toHaveBeenCalledWith('/repo/notes.md')
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      'Could not copy the path to the clipboard.',
    )
    expect(tabButton).toBe(document.activeElement)
  })

  it('does not let a late clipboard completion dismiss a newer path menu', async () => {
    const workspaceRoot = localPath('/repo')
    let completeWrite: (() => void) | undefined
    writeText.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          completeWrite = resolve
        }),
    )
    const callbacks = renderTabStrip(
      'primary',
      [
        viewerTab('/repo/first.ts', 'primary', 'source', true, false),
        viewerTab('/repo/second.ts', 'primary', 'source', true, false),
      ],
      workspaceRoot,
    )

    contextMenu(viewerTabElement('first.ts'))
    await clickMenuButton('Copy Relative Path')
    act(() => {
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    })
    contextMenu(viewerTabElement('second.ts'))

    await act(async () => {
      completeWrite?.()
      await Promise.resolve()
    })

    expect(document.querySelector('[role="menu"]')?.getAttribute('aria-label')).toBe(
      'Path actions for second.ts',
    )
    expect(callbacks.onActivate).not.toHaveBeenCalled()
    expect(callbacks.onPin).not.toHaveBeenCalled()
  })
})

async function copyFromTreeRow(name: string, action: string): Promise<void> {
  contextMenu(treeRow(name))
  await clickMenuButton(action)
}

function treeRow(name: string): HTMLButtonElement {
  const match = [...host.querySelectorAll<HTMLButtonElement>('[role="treeitem"]')].find(
    (candidate) => candidate.textContent?.includes(name),
  )
  if (!match) throw new Error(`Missing tree row '${name}'`)
  return match
}

function contextMenu(target: Element | null): void {
  if (!target) throw new Error('Missing context-menu target')
  act(() => {
    target.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 20,
        clientY: 20,
      }),
    )
  })
}

function menuButton(label: string): HTMLButtonElement {
  const match = [
    ...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
  ].find((candidate) => candidate.textContent === label)
  if (!match) throw new Error(`Missing menu action '${label}'`)
  return match
}

async function clickMenuButton(label: string): Promise<void> {
  await act(async () => {
    menuButton(label).click()
    await Promise.resolve()
  })
}

function renderTabStrip(
  pane: ViewerPaneId,
  tabs: readonly ViewerTab[],
  pathCopyRoot: HostPath,
  includeNonFileTabs = false,
) {
  const callbacks = {
    onActivate: vi.fn(),
    onClose: vi.fn(),
    onPin: vi.fn(),
  }
  act(() => {
    root.render(
      <TabStrip
        tabs={tabs}
        pane={pane}
        pathCopyRoot={pathCopyRoot}
        activeId={tabs[0]?.id}
        onActivate={callbacks.onActivate}
        onClose={callbacks.onClose}
        onPin={callbacks.onPin}
        onReorder={vi.fn()}
        onMoveToPane={vi.fn()}
        split={pane === 'secondary'}
        onSplit={vi.fn()}
        onClosePane={pane === 'secondary' ? vi.fn() : undefined}
        graphOpen={includeNonFileTabs}
        graphActive={false}
        onActivateGraph={vi.fn()}
        onCloseGraph={vi.fn()}
        webTabs={
          includeNonFileTabs ? [{ id: 'web-pane', title: 'Web preview' }] : undefined
        }
        onActivateWeb={vi.fn()}
        onCloseWeb={vi.fn()}
      />,
    )
  })
  return callbacks
}

function viewerTabElement(name: string): HTMLDivElement {
  const match = [...host.querySelectorAll<HTMLDivElement>('.viewer-tab')].find(
    (candidate) => candidate.textContent?.includes(name),
  )
  if (!match) throw new Error(`Missing viewer tab '${name}'`)
  return match
}

function viewerTab(
  pathValue: string,
  pane: ViewerPaneId,
  mode: ViewerTab['mode'],
  pinned: boolean,
  dirty: boolean,
): ViewerTab {
  const path = localPath(pathValue)
  return {
    id: `${pane}:${pathValue}`,
    path,
    pane,
    pinned,
    mode,
    diffBase: 'head',
    position: { mode, line: 1, scrollTop: 0 },
    file: { path, content: 'content', size: 7, mtimeMs: 1, binary: false },
    loading: false,
    dirty,
    conflict: false,
  }
}
