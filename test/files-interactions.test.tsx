// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FileTree } from '../src/renderer/src/tree/FileTree'
import { fileManagerRevealLabel } from '../src/renderer/src/tree/file-manager-reveal'
import { focusVisibleActiveTerminalAfterLayout } from '../src/renderer/src/workbench/active-terminal-focus'
import {
  asHostId,
  hostPath,
  localPath,
  type FileOpenContext,
  type HostPath,
} from '../src/shared'

const localRoot = localPath('/repo')
let container: HTMLDivElement
let reactRoot: Root
let invoke: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  invoke = vi.fn((channel: string, request: { readonly path?: HostPath }) => {
    if (channel === 'fs:readdir') {
      return Promise.resolve({
        ok: true,
        value:
          request.path?.path === '/repo'
            ? [
                { name: 'src', type: 'dir' },
                { name: 'existing.md', type: 'file' },
                { name: 'linked.md', type: 'symlink' },
              ]
            : [],
      })
    }
    if (channel === 'fs:resolve-entry') {
      return Promise.resolve({ ok: true, value: { type: 'file' } })
    }
    if (channel === 'fs:reveal-entry') {
      return Promise.resolve({ ok: true, value: undefined })
    }
    if (channel === 'fs:deletion-disclosure') return new Promise(() => undefined)
    if (channel === 'git:ignored-entries') {
      return Promise.resolve({ ignoredNames: [] })
    }
    throw new Error(`Unexpected channel: ${channel}`)
  })
  Object.defineProperty(window, 'hvir', {
    configurable: true,
    value: {
      invoke,
      send: vi.fn(),
      externalFiles: { acquireDropped: vi.fn() },
      on: vi.fn(() => () => undefined),
    },
  })
  container = document.createElement('div')
  document.body.append(container)
  reactRoot = createRoot(container)
})

afterEach(async () => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
  act(() => reactRoot.unmount())
  document
    .querySelectorAll('.file-action-menu, .file-operation-feedback')
    .forEach((node) => node.remove())
  document.querySelectorAll('.terminal-deck').forEach((node) => node.remove())
  container.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('Files rail reveal and activation focus', () => {
  it('returns only pointer-activation focus to a visible active terminal', async () => {
    const terminalDeck = document.createElement('div')
    terminalDeck.className = 'terminal-deck'
    terminalDeck.innerHTML =
      '<section class="terminal-surface active"><div class="terminal-container" tabindex="-1"></div></section>'
    vi.spyOn(terminalDeck, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 400,
      bottom: 200,
      width: 400,
      height: 200,
      toJSON: () => undefined,
    })
    document.body.append(terminalDeck)
    const terminal = terminalDeck.querySelector<HTMLElement>('.terminal-container')!
    const onOpen = vi.fn()
    renderFileTree(localRoot, onOpen, focusVisibleActiveTerminalAfterLayout)
    await waitFor(() => treeRow('/repo/existing.md') !== undefined)
    const row = treeRow('/repo/existing.md')!
    const directory = treeRow('/repo/src')!

    row.focus()
    act(() => {
      row.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))
    })
    await waitFor(() => document.activeElement === terminal)

    row.focus()
    act(() => {
      row.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }))
    })
    await act(async () => Promise.resolve())
    expect(document.activeElement).toBe(row)

    directory.focus()
    act(() => {
      directory.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))
    })
    await waitFor(() => document.activeElement === terminal)
    expect(directory.getAttribute('aria-expanded')).toBe('true')

    directory.focus()
    act(() => {
      directory.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }))
    })
    await act(async () => Promise.resolve())
    expect(document.activeElement).toBe(directory)
    expect(directory.getAttribute('aria-expanded')).toBe('false')

    terminalDeck.style.visibility = 'hidden'
    directory.focus()
    act(() => {
      directory.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))
    })
    await act(async () => Promise.resolve())
    expect(document.activeElement).toBe(directory)
    expect(directory.getAttribute('aria-expanded')).toBe('true')
    expect(onOpen).toHaveBeenCalledTimes(2)
  })

  it('reveals exact supported local entries and omits the action for SSH', async () => {
    renderFileTree(localRoot, vi.fn())
    await waitFor(() => treeRow('/repo/linked.md') !== undefined)
    const label = fileManagerRevealLabel()

    for (const path of ['/repo', '/repo/src', '/repo/existing.md', '/repo/linked.md']) {
      openPointerMenu(path)
      await waitFor(() => menuItem(label)?.disabled === false)
      const callsBeforeReveal = invoke.mock.calls.length
      act(() => menuItem(label)!.click())
      await waitFor(
        () =>
          document.querySelector('.file-action-menu') === null &&
          invoke.mock.calls.length > callsBeforeReveal,
      )
      expect(invoke).toHaveBeenLastCalledWith('fs:reveal-entry', {
        workspaceRoot: localRoot,
        path: localPath(path),
      })
    }

    const sshRoot = hostPath(asHostId('ssh:example'), '/repo')
    renderFileTree(sshRoot, vi.fn())
    await waitFor(() => treeRow('/repo/existing.md') !== undefined)
    openPointerMenu('/repo/existing.md')
    expect(menuItem(label)).toBeUndefined()
  })
})

function renderFileTree(
  root: HostPath,
  onOpen: (path: HostPath, pinned: boolean, context?: FileOpenContext) => void,
  onPointerActivate?: () => void,
): void {
  act(() => {
    reactRoot.render(
      <FileTree
        root={root}
        refreshVersion={0}
        searchRefreshVersion={0}
        ignoredRefreshVersion={0}
        onOpen={onOpen}
        onPointerActivate={onPointerActivate}
        viewerPathRebind={{
          canRebindPath: () => true,
          rebindPath: () => true,
          reviewPathRemoval: () => ({ openCount: 0, dirtyPaths: [] }),
          closeCleanPath: () => ({ openCount: 0, dirtyPaths: [], closedCount: 0 }),
        }}
        onWorkspaceContentChanged={() => undefined}
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

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    if (condition()) return
  }
  throw new Error('Timed out waiting for Files interaction UI')
}
