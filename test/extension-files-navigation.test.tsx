// @vitest-environment happy-dom
import { act, type ComponentProps } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { asHostId, DEFAULT_KEYBINDINGS, hostPath, type HostPath } from '../src/shared'
import type { ExtensionView } from '../src/shared/extensions/workbench'
import { validateExtensionManifest } from '../src/shared/extensions/manifest'
import { exampleManifest } from './fixtures/extension-package'
import type { FileTree } from '../src/renderer/src/tree/FileTree'
import { WorkbenchProjectRail } from '../src/renderer/src/workbench/WorkbenchProjectRail'
import { useWorkbenchLayout } from '../src/renderer/src/workbench/use-workbench-layout'
import { useWorkbenchCommands } from '../src/renderer/src/workbench/use-workbench-commands'
import { useTerminalPathActivation } from '../src/renderer/src/workbench/use-terminal-path-activation'
import {
  ExtensionContributionContext,
  type Contributions,
} from '../src/renderer/src/extensions/extension-contribution-context'

vi.mock('../src/renderer/src/theme', () => ({ useAppTheme: () => 'dark' }))
vi.mock('../src/renderer/src/settings/settings', () => ({
  useAppSettings: () => ({ interfaceScale: 1, interfaceFont: 'system' }),
}))
vi.mock('../src/renderer/src/extensions/ElectronExtensionGuestSurface', () => ({
  ElectronExtensionGuestSurface: () => <div data-guest />,
}))
// These content surfaces do not own rail placement or workbench keyboard routing.
vi.mock('../src/renderer/src/tree/FileTree', () => ({
  FileTree: ({ hidden, revealRequest }: ComponentProps<typeof FileTree>) => (
    <section className="files-panel" hidden={hidden}>
      <input data-filename-search aria-label="Find file" />
      <span data-revealed={revealRequest?.path.path} />
    </section>
  ),
}))
vi.mock('../src/renderer/src/git/GitPanel', () => ({ GitPanel: () => null }))

afterEach(() => {
  document.body.replaceChildren()
  localStorage.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function fixture(host = 'local') {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const frames: FrameRequestCallback[] = []
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    frames.push(callback),
  )
  const listeners = new Map<string, (value: unknown) => void>()
  const invoke = vi.fn((channel: string, value?: { path: HostPath }) =>
    Promise.resolve(
      channel === 'fs:resolve-entry'
        ? { ok: true, value: { path: value?.path, type: 'dir' } }
        : undefined,
    ),
  )
  vi.stubGlobal('hvir', {
    invoke,
    send: vi.fn(),
    on: (channel: string, listener: (value: unknown) => void) => {
      listeners.set(channel, listener)
      return () => listeners.delete(channel)
    },
  })
  const workspaceRoot = hostPath(asHostId(host), '/repo')
  const directory = hostPath(asHostId(host), '/repo/skills')
  const manifest = validateExtensionManifest(
    exampleManifest({
      views: [
        { ...exampleManifest().views[0]!, navigation: 'left', placement: 'workspace' },
      ],
    }),
  ).manifest
  const guest: ExtensionView = {
    id: 'left-view',
    installationId: 'one',
    contributionId: manifest.views[0]!.id,
    title: 'Project extension',
    extensionName: 'Example',
    partition: 'partition',
    url: 'hvir-extension://left-view/detail.html',
    role: 'view',
    context: {
      surface: 'left',
      visible: true,
      workspace: { id: 'workspace', name: 'Workspace', host },
    },
  }
  const open = vi.fn(() => Promise.resolve(guest)),
    close = vi.fn(),
    demand = vi.fn(() => () => undefined)
  const model: Contributions = {
    state: [{ installationId: 'one', extensionName: 'Example', manifest, values: [] }],
    views: [guest],
    topActive: false,
    obscured: false,
    terminalIds: {},
    sessions: [],
    workspaceId: 'workspace',
    foreground: true,
    open,
    close,
    demand,
    closeTop: vi.fn(),
    selectTop: vi.fn(),
    selectViewer: vi.fn(),
    retireLandingFocus: vi.fn(),
    focusLanding: vi.fn(),
  }
  let layout!: ReturnType<typeof useWorkbenchLayout>
  let terminal!: ReturnType<typeof useTerminalPathActivation>
  function Harness({ workspace }: { workspace: string }) {
    layout = useWorkbenchLayout({
      root: workspaceRoot,
      gitAvailable: true,
      workspaceMissing: false,
    })
    terminal = useTerminalPathActivation({
      root: workspaceRoot,
      workspaceId: workspace,
      openFile: vi.fn(),
      revealDirectory: layout.focusTree,
    })
    useWorkbenchCommands(DEFAULT_KEYBINDINGS, {
      findFile: layout.focusFilenameSearch,
      focusTree: layout.focusTree,
      canUseViewerCommands: () => true,
      cycleViewMode: vi.fn(),
      findInFile: vi.fn(),
      findInTerminal: () => false,
      goToLine: vi.fn(),
      toggleTerminalFocus: layout.toggleTerminalFocus,
      focusTerminal: layout.focusTerminal,
      focusViewer: vi.fn(),
      switchWorkspace: vi.fn(),
      closeWebPane: vi.fn(),
      escapeWebPaneFocus: vi.fn(),
    })
    return (
      <ExtensionContributionContext.Provider value={{ ...model, workspaceId: workspace }}>
        <main ref={layout.workbenchRef}>
          <WorkbenchProjectRail
            mode={layout.railMode}
            onMode={layout.setRailMode}
            activation={layout.railActivation}
            gitEnabled
            changedCount={0}
            visible
            files={{
              root: workspaceRoot,
              refreshVersion: 0,
              searchRefreshVersion: 0,
              ignoredRefreshVersion: 0,
              hidden: layout.railMode !== 'files',
              revealRequest: terminal.revealRequest,
              onOpen: vi.fn(),
              onWorkspaceContentChanged: vi.fn(),
              viewerPathRebind: {
                canRebindPath: () => true,
                rebindPath: () => true,
                reviewPathRemoval: () => ({ openCount: 0, dirtyPaths: [] }),
                closeCleanPath: () => ({ openCount: 0, closedCount: 0, dirtyPaths: [] }),
              },
            }}
          />
        </main>
      </ExtensionContributionContext.Provider>
    )
  }
  const element = document.createElement('div')
  document.body.append(element)
  const root = createRoot(element)
  const render = async (workspace = 'workspace') => {
    await act(async () => {
      root.render(<Harness workspace={workspace} />)
      await Promise.resolve()
    })
  }
  await render()
  const clickExtension = () =>
    element
      .querySelector<HTMLButtonElement>('[aria-label="Extension project views"] button')!
      .click()
  const shortcut = (key: string) => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key,
        ...(/Mac/.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true }),
        bubbles: true,
        cancelable: true,
      }),
    )
  }
  return {
    element,
    guest,
    open,
    close,
    demand,
    render,
    clickExtension,
    shortcut,
    get layout() {
      return layout
    },
    revealTerminal: () => terminal.activate({ path: directory }),
    revealSource: () =>
      listeners.get('extensions:files-reveal')!({
        workspaceId: 'workspace',
        root: workspaceRoot,
        path: directory,
      }),
    flushFrames: () => act(() => frames.splice(0).forEach((frame) => frame(0))),
    dispose: () => act(() => root.unmount()),
  }
}

it.each(
  ['local', 'ssh-test'].flatMap((host) =>
    ['findFile', 'focusTree', 'terminal', 'source'].map((origin) => ({ host, origin })),
  ),
)(
  'shows Files before focus for $origin on $host and retains its extension guest',
  async ({ host, origin }) => {
    const f = await fixture(host)
    try {
      act(() => f.layout.setRailMode('git'))
      await act(async () => {
        f.clickExtension()
        await Promise.resolve()
      })
      expect(f.element.querySelector('.files-panel')?.closest('[hidden]')).not.toBeNull()
      const retainedGuest = f.element.querySelector('[data-guest]')
      await act(async () => {
        if (origin === 'findFile') f.shortcut('p')
        else if (origin === 'focusTree') f.shortcut('0')
        else if (origin === 'terminal') f.revealTerminal()
        else f.revealSource()
        await Promise.resolve()
      })
      expect(f.element.querySelector('.files-panel')?.closest('[hidden]')).toBeNull()
      expect(
        f.element.querySelector('[data-extension-view]')?.hasAttribute('hidden'),
      ).toBe(true)
      expect(f.element.querySelector('[data-guest]')).toBe(retainedGuest)
      expect(f.close).not.toHaveBeenCalled()
      expect(f.demand).toHaveBeenLastCalledWith('left', [])
      if (origin === 'terminal' || origin === 'source')
        expect(
          f.element.querySelector('[data-revealed]')?.getAttribute('data-revealed'),
        ).toBe('/repo/skills')
      f.flushFrames()
      expect(document.activeElement).toBe(
        f.element.querySelector(
          origin === 'findFile' ? '[data-filename-search]' : '.tree-panel',
        ),
      )
      await act(async () => {
        f.clickExtension()
        await Promise.resolve()
      })
      expect(f.element.querySelector('.files-panel')?.closest('[hidden]')).not.toBeNull()
      expect(f.element.querySelector('[data-guest]')).toBe(retainedGuest)
    } finally {
      f.dispose()
    }
  },
)

it.each(['Files', 'Project views', 'workspace round trip', 'unmount'] as const)(
  'does not let a pending extension open undo %s',
  async (transition) => {
    const f = await fixture()
    let mounted = true
    try {
      await act(async () => {
        f.clickExtension()
        await Promise.resolve()
      })
      let complete!: (view: ExtensionView) => void
      f.open.mockReturnValueOnce(
        new Promise((resolve) => {
          complete = resolve
        }),
      )
      act(() => f.clickExtension())
      if (transition === 'Files') act(() => f.shortcut('0'))
      else if (transition === 'Project views')
        act(() => {
          ;[...f.element.querySelectorAll<HTMLButtonElement>('button')]
            .find((button) => button.textContent === 'Project views')!
            .click()
        })
      else if (transition === 'workspace round trip') {
        await f.render('second-workspace')
        await f.render()
      } else {
        f.dispose()
        mounted = false
      }
      await act(async () => {
        complete(f.guest)
        await Promise.resolve()
      })
      if (mounted) {
        expect(f.element.querySelector('.files-panel')?.closest('[hidden]')).toBeNull()
        expect(
          f.element.querySelector('[data-extension-view]')?.hasAttribute('hidden'),
        ).toBe(true)
      } else expect(f.element.childElementCount).toBe(0)
      if (transition !== 'workspace round trip') expect(f.close).not.toHaveBeenCalled()
    } finally {
      if (mounted) f.dispose()
    }
  },
)

it.each(
  (['files', 'git'] as const).flatMap((initial) =>
    (['files', 'git'] as const).map((mode) => ({ initial, mode })),
  ),
)(
  'does not let a pending first extension open undo the $mode button from $initial',
  async ({ initial, mode }) => {
    const f = await fixture()
    try {
      act(() => f.layout.setRailMode(initial))
      let complete!: (view: ExtensionView) => void
      f.open.mockReturnValueOnce(
        new Promise((resolve) => {
          complete = resolve
        }),
      )
      act(() => f.clickExtension())
      const nav = f.element.querySelector('nav[aria-label="Project views"]')!
      const button = [...nav.querySelectorAll<HTMLButtonElement>('button')].find(
        (item) => item.textContent?.toLowerCase() === mode,
      )!
      expect(nav.closest('[hidden]')).toBeNull()
      act(() => button.click())
      await act(async () => {
        complete(f.guest)
        await Promise.resolve()
      })
      expect(nav.closest('[hidden]')).toBeNull()
      expect(button.getAttribute('aria-current')).toBe('page')
      expect(f.layout.railMode).toBe(mode)
      expect(
        f.element.querySelector('[data-extension-view]')?.hasAttribute('hidden'),
      ).toBe(true)
      expect(f.close).not.toHaveBeenCalled()
    } finally {
      f.dispose()
    }
  },
)
