// @vitest-environment happy-dom
import { projectState } from './fixtures/skillager-exposure-fixture'
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { localPath } from '../src/shared/host-path'
import type { SkillagerMetadata } from '../src/shared/skillager'
import { useViewerWorkspace } from '../src/renderer/src/viewer/use-viewer-workspace'
import { useGitWorkspace } from '../src/renderer/src/git/use-git-workspace'
import { useWebPaneWorkspace } from '../src/renderer/src/dashboards/use-web-pane-workspace'
import {
  useReviewWorkspace,
  useWatchFanout,
} from '../src/renderer/src/document-review/use-document-review-workspace'
import { useSkillagerWorkspace } from '../src/renderer/src/skillager/use-skillager-workspace'
import { WorkbenchViewerPane } from '../src/renderer/src/workbench/WorkbenchViewerPane'

// Keep the real selection owners and workbench composition. Their child content
// engines are outside this visibility/lifetime contract.
vi.mock('../src/renderer/src/viewer/FileViewer', () => ({
  FileViewer: () => <div data-content="document" />,
}))
vi.mock('../src/renderer/src/git/GitGraphView', () => ({
  GitGraphView: () => <div data-content="git" />,
}))
vi.mock('../src/renderer/src/dashboards/WebPane', () => ({
  WebPane: ({ focused }: { focused: boolean }) => (
    <div data-content="web" data-focused={String(focused)} />
  ),
}))

const root = localPath('/workspace')
const row: SkillagerMetadata = {
  id: 'lib/example',
  name: 'Example',
  description: 'Metadata',
  source: {
    type: 'collection',
    collection: 'lib',
    ownership: 'library',
    libraryId: 'library',
  },
  trust: 'discovered',
  tags: [],
  matchReasons: [],
  exposure: 'unknown',
}
let mount: HTMLDivElement
let reactRoot: Root
let viewer: ReturnType<typeof useViewerWorkspace>
let git: ReturnType<typeof useGitWorkspace>
let web: ReturnType<typeof useWebPaneWorkspace>
let skills: ReturnType<typeof useSkillagerWorkspace>
let setEnabled: (enabled: boolean) => void
const invoke = vi.fn<(channel: string, request: unknown) => Promise<unknown>>()
const send = vi.fn()

function Harness() {
  const [enabled, changeEnabled] = useState(true)
  setEnabled = changeEnabled
  viewer = useViewerWorkspace({
    onActivateFile: () => {
      skills.deactivate()
      git.deactivateGraph()
      web.setActive(false)
    },
  })
  web = useWebPaneWorkspace({
    onActivate: () => {
      skills.deactivate()
      git.deactivateGraph()
    },
    onError: (message) => {
      throw new Error(message)
    },
  })
  skills = useSkillagerWorkspace({
    enabled,
    projectState: projectState(root),
    sidebarVisible: false,
    viewerVisible: true,
    onActivate: () => {
      web.setFocused(false)
      viewer.focusPane('primary')
    },
    onDisabled: () => undefined,
  })
  git = useGitWorkspace({
    root,
    hasDirtyViewerTabs: () => false,
    acceptProjectState: () => undefined,
    refreshContent: () => undefined,
    refreshGit: () => undefined,
    activateViewer: () => skills.deactivate(),
    deactivateWebPane: () => web.setActive(false),
  })
  const watch = useWatchFanout(() => undefined)
  const documentReview = useReviewWorkspace(undefined, watch)
  return (
    <WorkbenchViewerPane
      pane="primary"
      root={root}
      viewer={viewer}
      git={git}
      web={web}
      documentReview={documentReview}
      skillager={skills}
      workspaceMissing={false}
      connectionState="connected"
      gitVersion={0}
      revealSourceTerminal={() => Promise.resolve()}
    />
  )
}
async function settle() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  })
}
beforeEach(async () => {
  localStorage.clear()
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  invoke.mockReset().mockImplementation((channel) =>
    Promise.resolve(
      channel === 'web-pane:open'
        ? {
            ok: true,
            value: {
              paneId: 'web-pane',
              origin: 'http://localhost:3000',
              url: 'http://localhost:3000/',
              partition: 'fixture',
            },
          }
        : channel === 'fs:read'
          ? { ok: false, error: 'No content engine in this fixture' }
          : channel === 'skillager:probe'
            ? { ok: false, reason: 'missing', message: 'Missing' }
            : undefined,
    ),
  )
  send.mockClear()
  Object.defineProperty(window, 'hvir', {
    configurable: true,
    value: {
      invoke,
      send,
      on: () => () => Promise.resolve(),
    },
  })
  mount = document.createElement('div')
  document.body.append(mount)
  reactRoot = createRoot(mount)
  act(() => reactRoot.render(<Harness />))
  await settle()
  act(() => {
    viewer.switchWorkspace(root)
    web.setWorkspaceRoot(root)
    viewer.openFile(localPath('/workspace/file.md'), true)
  })
  await settle()
})
afterEach(() => {
  act(() => reactRoot.unmount())
  mount.remove()
  vi.restoreAllMocks()
})

it.each(['document', 'git', 'web'] as const)(
  'reveals the retained %s selection after Skills is disabled, without reconnecting on re-enable',
  async (kind) => {
    if (kind === 'git') act(() => git.openGraph('commit'))
    if (kind === 'web') {
      act(() =>
        web.openLink({
          terminalId: 'terminal',
          workspaceRoot: root,
          url: 'http://localhost:3000/',
        }),
      )
      await settle()
      act(() => web.setFocused(true))
    }
    const content = mount.querySelector(`[data-content="${kind}"]`)!
    const visible = () => !content.closest('[hidden], .web-view-hidden')
    expect(visible()).toBe(true)
    const originalTab = mount.querySelector('.viewer-tab.active')!
    expect(originalTab).not.toBeNull()
    act(() => skills.select(row))
    expect(visible()).toBe(false)
    expect(originalTab.getAttribute('aria-selected')).toBe('false')
    expect(mount.querySelectorAll('.viewer-tab.active')).toHaveLength(1)
    if (kind === 'web') {
      expect(content.getAttribute('data-focused')).toBe('false')
      expect(send).toHaveBeenLastCalledWith('web-pane:full-page', { paneId: undefined })
    }
    act(() => setEnabled(false))
    await settle()
    expect(visible()).toBe(true)
    expect(mount.querySelector(`[data-content="${kind}"]`)).toBe(content)
    expect(mount.querySelector('.viewer-tab.active')).toBe(originalTab)
    expect(mount.querySelector('.skillager-tab')).toBeNull()
    expect(invoke.mock.calls.some(([channel]) => channel === 'web-pane:close')).toBe(
      false,
    )
    act(() => setEnabled(true))
    await settle()
    expect(visible()).toBe(true)
    expect(skills.tabs).toHaveLength(0)
    expect(skills.connection).toBeUndefined()
    expect(invoke.mock.calls.some(([channel]) => channel === 'skillager:connect')).toBe(
      false,
    )
  },
)
