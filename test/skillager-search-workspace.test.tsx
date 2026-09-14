// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  useSkillagerWorkspace,
  type SkillagerController,
} from '../src/renderer/src/skillager/use-skillager-workspace'
import { SkillagerSidebar } from '../src/renderer/src/skillager/SkillagerSidebar'
import { projectState } from './fixtures/skillager-exposure-fixture'
import { searchLibrary } from './fixtures/skillager-search-fixture'
import { localPath, hostPath, asHostId, type HostPath } from '../src/shared/host-path'
import type { SkillagerMetadataResult, SkillagerResult } from '../src/shared/skillager'

let mount: HTMLDivElement, root: Root, current: SkillagerController
const invoke = vi.fn<(channel: string, request: unknown) => Promise<unknown>>()
let search: () => Promise<SkillagerResult<SkillagerMetadataResult>>
const empty: SkillagerResult<SkillagerMetadataResult> = {
  ok: true,
  value: { rows: [], checkedAt: 1, durationMs: 1, exposures: [] },
}
function Harness({
  workspace = localPath('/project'),
  visible = true,
}: {
  workspace?: HostPath
  visible?: boolean
}) {
  current = useSkillagerWorkspace({
    enabled: true,
    sidebarVisible: visible,
    viewerVisible: false,
    projectState: projectState(workspace),
    onActivate() {},
    onDisabled() {},
  })
  return <SkillagerSidebar controller={current} root={workspace} hidden={!visible} />
}
beforeEach(() => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  mount = document.createElement('div')
  document.body.append(mount)
  root = createRoot(mount)
  search = () => Promise.resolve(empty)
  invoke.mockReset().mockImplementation((channel) => {
    if (channel === 'skillager:search') return search()
    return Promise.resolve(
      channel === 'skillager:probe'
        ? {
            ok: true,
            value: {
              probeId: 'probe',
              executable: localPath('/skillager'),
              version: 'fixture',
              library: searchLibrary,
            },
          }
        : channel === 'skillager:connect'
          ? {
              ok: true,
              value: {
                connectionId: 'connection',
                executable: localPath('/skillager'),
                version: 'fixture',
                library: searchLibrary,
              },
            }
          : channel === 'skillager:inventory'
            ? empty
            : {
                ok: false,
                reason: 'unavailable',
                message: 'Fixture observation unavailable.',
              },
    )
  })
  Object.defineProperty(window, 'hvir', { configurable: true, value: { invoke } })
})
afterEach(() => {
  act(() => root.unmount())
  mount.remove()
  vi.restoreAllMocks()
})
async function settle(action: () => unknown): Promise<void> {
  await act(async () => {
    await Promise.resolve(action())
  })
}
async function start(workspace?: HostPath) {
  await settle(() => root.render(<Harness workspace={workspace} />))
  await act(async () => current.connect())
}
function button(label: string): HTMLButtonElement {
  const found = [...mount.querySelectorAll('button')].find(
    (item) => item.textContent === label,
  )
  if (!found) throw Error(`Missing ${label}`)
  return found
}
it('keeps default and submitted Advanced policy visible while draft options change', async () => {
  await start()
  expect(current.includeInstalled).toBe(false)
  expect(current.separateCopies).toBe(false)
  act(() => current.setBrowseAgent('claude'))
  await act(async () => current.submit('merge'))
  expect(
    invoke.mock.calls.find(([channel]) => channel === 'skillager:search')?.[1],
  ).toMatchObject({
    view: 'skills',
    includeInstalled: false,
    browseAgent: 'claude',
    agent: 'codex',
  })
  act(() => {
    current.setIncludeInstalled(true)
    current.setSeparateCopies(true)
    current.setBrowseAgent('all')
    current.setQuery('draft')
  })
  expect(mount.querySelector('.skillager-query-summary')?.textContent).toContain(
    'One row per known skill · Installed hidden · Prefers Claude Code',
  )
  expect(mount.querySelector('.skillager-query-summary')?.textContent).not.toContain(
    'draft',
  )
  expect(mount.textContent).toContain(
    'No matching skills to add. Installed skills are hidden.',
  )
  await settle(() => button('Include installed and search').click())
  expect(
    invoke.mock.calls.filter(([channel]) => channel === 'skillager:search').at(-1)?.[1],
  ).toMatchObject({
    query: 'merge',
    view: 'skills',
    includeInstalled: true,
    browseAgent: 'claude',
  })
  expect(mount.querySelector('.skillager-query-summary')?.textContent).toContain(
    'Installed included',
  )
  expect(mount.textContent).toContain('No matching skills.')
})
it.each(['search-unsupported', 'installed-unknown'] as const)(
  'keeps %s distinct from empty results and retries only through the explicit control',
  async (reason) => {
    await start()
    search = () =>
      Promise.resolve({ ok: false, reason, message: 'Unavailable search policy.' })
    act(() => {
      current.setBrowseAgent('claude')
      current.setSeparateCopies(true)
    })
    await act(async () => current.submit('merge'))
    expect(mount.textContent).not.toContain('No matching skills')
    expect(
      invoke.mock.calls.filter(([channel]) => channel === 'skillager:search'),
    ).toHaveLength(1)
    search = () => Promise.resolve(empty)
    await settle(() =>
      button(
        reason === 'search-unsupported'
          ? 'Search with installed Skillager…'
          : 'Include installed and search',
      ).click(),
    )
    expect(
      invoke.mock.calls.filter(([channel]) => channel === 'skillager:search').at(-1)?.[1],
    ).toMatchObject({
      query: 'merge',
      browseAgent: 'claude',
      includeInstalled: true,
      view: reason === 'search-unsupported' ? 'legacy' : 'copies',
    })
    expect(mount.querySelector('.skillager-query-summary')?.textContent).toContain(
      reason === 'search-unsupported'
        ? 'Legacy results · Installed included · Prefers Claude Code'
        : 'Separate copies · Installed included',
    )
    if (reason === 'search-unsupported')
      expect(mount.textContent).toContain('Older Skillager may group agent variants.')
  },
)
it('does not show empty results or let a hidden-search late completion restore them', async () => {
  await start()
  let finish!: (value: SkillagerResult<SkillagerMetadataResult>) => void
  search = () =>
    new Promise((resolve) => {
      finish = resolve
    })
  let pending!: Promise<void>
  act(() => {
    pending = current.submit('merge')
  })
  expect(mount.textContent).toContain('Searching Skillager')
  expect(mount.textContent).not.toContain('No matching skills')
  await settle(() => root.render(<Harness visible={false} />))
  await act(async () => {
    finish(empty)
    await pending
  })
  expect(current.submitted).toBe('')
  expect(current.search.result).toBeUndefined()
})
it('limits the remote installed-hidden explanation to skills added through hvir', async () => {
  await start(hostPath(asHostId('ssh:fixture'), '/remote'))
  await act(async () => current.submit('merge'))
  expect(mount.querySelector('.skillager-query-summary')?.textContent).toContain(
    'Hidden: skills added through hvir',
  )
  expect(mount.textContent).toContain(
    'No matching skills to add. Skills added through hvir are hidden.',
  )
})
