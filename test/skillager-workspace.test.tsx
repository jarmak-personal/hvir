// @vitest-environment happy-dom
import { act, useState, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  useSkillagerWorkspace,
  type SkillagerController,
} from '../src/renderer/src/skillager/use-skillager-workspace'
import { SkillagerSidebar } from '../src/renderer/src/skillager/SkillagerSidebar'
import { SkillagerSettings } from '../src/renderer/src/skillager/SkillagerSettings'
import { SkillagerTabs } from '../src/renderer/src/skillager/SkillagerTabs'
import { SkillagerDetails } from '../src/renderer/src/skillager/SkillagerDetails'
import {
  skillagerObservationDemand,
  skillagerTabs,
  type SkillagerTabs as Tabs,
} from '../src/renderer/src/skillager/skillager-model'
import { localPath, type HostPath } from '../src/shared/host-path'
import type {
  SkillagerMetadata,
  SkillagerMetadataResult,
  SkillagerResult,
} from '../src/shared/skillager'

let mount: HTMLDivElement
let reactRoot: Root
let current: SkillagerController
const library = {
  id: 'library',
  root: localPath('/library'),
  skillsRoot: localPath('/library/skills'),
}
const probe = {
  ok: true,
  value: {
    probeId: 'probe',
    version: 'skillager 0.9.0',
    executable: localPath('/tools/skillager'),
    library,
  },
}
const connection = {
  ok: true,
  value: {
    connectionId: 'connected',
    version: 'skillager 0.9.0',
    executable: localPath('/tools/skillager'),
    library,
  },
}
const rows: SkillagerMetadata[] = Array.from({ length: 5000 }, (_, n) => ({
  id: `lib/skill-${n}`,
  name: `Skill ${n}`,
  description: 'Metadata',
  source: {
    type: 'collection',
    collection: 'lib',
    ownership: 'library',
    libraryId: 'library',
  },
  trust: n === 0 ? 'discovered' : 'reviewed',
  tags: [],
  matchReasons: [],
  exposure: 'unknown',
}))
const invoke = vi.fn<(channel: string, request: unknown) => Promise<unknown>>()
function metadata(selected = rows): SkillagerResult<SkillagerMetadataResult> {
  return {
    ok: true,
    value: { rows: selected, checkedAt: Date.now(), durationMs: 50, exposures: [] },
  }
}
function Harness({
  initial = true,
  visible = true,
  root = localPath('/workspace'),
}: {
  initial?: boolean
  visible?: boolean
  root?: HostPath
}) {
  const [enabled, setEnabled] = useState(initial)
  current = useSkillagerWorkspace({
    enabled,
    root,
    sidebarVisible: visible,
    viewerVisible: true,
    onActivate: () => undefined,
    onDisabled: () => undefined,
  })
  return (
    <>
      <SkillagerSettings controller={current} onEnabled={setEnabled} />
      {enabled ? (
        <SkillagerSidebar controller={current} root={root} hidden={!visible} />
      ) : null}
      <SkillagerTabs controller={current} />
      {current.active ? <SkillagerDetails metadata={current.active.metadata} /> : null}
    </>
  )
}
async function settle() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  })
}
async function render(props: Parameters<typeof Harness>[0] = {}) {
  act(() =>
    reactRoot.render(
      <StrictMode>
        <Harness {...props} />
      </StrictMode>,
    ),
  )
  await settle()
}
async function connect() {
  await act(async () => current.connect())
  await settle()
}
beforeEach(() => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  mount = document.createElement('div')
  document.body.append(mount)
  reactRoot = createRoot(mount)
  invoke
    .mockReset()
    .mockImplementation((channel) =>
      Promise.resolve(
        channel === 'skillager:probe'
          ? probe
          : channel === 'skillager:connect'
            ? connection
            : channel === 'skillager:inventory'
              ? metadata()
              : channel === 'skillager:search'
                ? metadata([rows[4999]!])
                : undefined,
      ),
    )
  Object.defineProperty(window, 'hvir', { configurable: true, value: { invoke } })
})
afterEach(() => {
  act(() => reactRoot.unmount())
  mount.remove()
  vi.restoreAllMocks()
})

describe('Skills renderer demand and metadata views', () => {
  it('keeps only the settings toggle while disabled and makes no probe/read demand', async () => {
    await render({ initial: false })
    expect(mount.textContent).toBe(' Enable Skillager')
    expect(mount.querySelectorAll('input')).toHaveLength(1)
    expect(
      invoke.mock.calls.some(([channel]) =>
        ['skillager:probe', 'skillager:search', 'skillager:inventory'].includes(channel),
      ),
    ).toBe(false)
  })
  it('starts visible demand when enabled after the window was focused', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    await render({ initial: false })
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    act(() =>
      (mount.querySelector('.skillager-settings input') as HTMLInputElement).click(),
    )
    await settle()
    await connect()
    expect(mount.querySelectorAll('.skillager-row')).toHaveLength(50)
  })
  it('requires explicit connection, bounds visible rows, and opens a metadata tab', async () => {
    await render()
    expect(invoke.mock.calls.some(([channel]) => channel === 'skillager:inventory')).toBe(
      false,
    )
    await connect()
    expect(mount.querySelectorAll('.skillager-row')).toHaveLength(50)
    expect(document.activeElement).toBe(mount.querySelector('#skillager-search-query'))
    expect(mount.textContent).toContain('1–50 of 5000')
    const next = [...mount.querySelectorAll('button')].find(
      (button) => button.textContent === 'Next 50',
    )!
    act(() => next.click())
    expect(mount.querySelectorAll('.skillager-row')).toHaveLength(50)
    expect(mount.querySelector('.skillager-row')?.textContent).toContain('Skill 50')
    act(() =>
      [...mount.querySelectorAll('button')]
        .find((button) => button.textContent === 'Previous 50')!
        .click(),
    )
    act(() => (mount.querySelector('.skillager-row') as HTMLButtonElement).click())
    expect(mount.querySelectorAll('.skillager-tab')).toHaveLength(1)
    expect(mount.querySelector('.skillager-details')?.textContent).toContain(
      'Pending review',
    )
    expect(mount.querySelector('.skillager-details')?.textContent).toContain(
      'Not added to this workspace',
    )
    act(() => current.close(current.activeId!))
    expect(mount.querySelector('.skillager-details')).toBeNull()
    expect(current.inventory.result?.ok).toBe(true)
  })
  it('allows a fresh connection after Check again replaces an in-flight connection', async () => {
    await render()
    let finish!: (value: unknown) => void
    invoke.mockImplementation((channel) =>
      channel === 'skillager:connect'
        ? new Promise((resolve) => {
            finish = resolve
          })
        : Promise.resolve(channel === 'skillager:probe' ? probe : undefined),
    )
    act(() => {
      void current.connect()
    })
    expect(current.connecting).toBe(true)
    await act(async () => current.check())
    expect(current.connecting).toBe(false)
    await act(async () => {
      finish(connection)
      await Promise.resolve()
    })
    expect(current.connection).toBeUndefined()
    expect(current.probe).toEqual(probe)
  })
  it('submits explicitly, retains only the latest result, and releases search when sidebar leaves', async () => {
    const pending: Array<(value: SkillagerResult<SkillagerMetadataResult>) => void> = []
    await render()
    await connect()
    invoke.mockImplementation((channel) =>
      channel === 'skillager:search'
        ? new Promise((resolve) => pending.push(resolve))
        : Promise.resolve(undefined),
    )
    act(() => current.setQuery('first'))
    expect(pending).toHaveLength(0)
    act(() => {
      void current.submit()
    })
    act(() => current.setQuery('second'))
    act(() => {
      void current.submit()
    })
    await act(async () => {
      pending[1]!(metadata([{ ...rows[0]!, name: 'Second result' }]))
      await Promise.resolve()
    })
    await act(async () => {
      pending[0]!(metadata([{ ...rows[0]!, name: 'Obsolete result' }]))
      await Promise.resolve()
    })
    expect(mount.textContent).toContain('Second result')
    expect(mount.textContent).not.toContain('Obsolete result')
    await render({ visible: false })
    expect(current.submitted).toBe('')
    expect(
      invoke.mock.calls.filter(([channel]) => channel === 'skillager:cancel').length,
    ).toBeGreaterThan(0)
  })
  it('clears details and metadata on workspace changes and all surfaces on disable', async () => {
    await render()
    await connect()
    act(() => current.select(rows[0]!))
    await render({ root: localPath('/second') })
    expect(current.tabs).toHaveLength(0)
    act(() => current.select(rows[1]!))
    act(() =>
      (mount.querySelector('.skillager-settings input') as HTMLInputElement).click(),
    )
    await settle()
    expect(mount.textContent).toBe(' Enable Skillager')
    expect(current.connection).toBeUndefined()
    const connections = invoke.mock.calls.filter(
      ([channel]) => channel === 'skillager:connect',
    ).length
    act(() =>
      (mount.querySelector('.skillager-settings input') as HTMLInputElement).click(),
    )
    await settle()
    expect(current.connection).toBeUndefined()
    expect(current.tabs).toHaveLength(0)
    expect(current.inventory.result).toBeUndefined()
    expect(
      invoke.mock.calls.filter(([channel]) => channel === 'skillager:connect'),
    ).toHaveLength(connections)
  })
  it('shows selectable install guidance only for a missing CLI and Check again does not connect', async () => {
    invoke.mockImplementation((channel) =>
      Promise.resolve(
        channel === 'skillager:probe'
          ? { ok: false, reason: 'missing', message: 'Missing' }
          : undefined,
      ),
    )
    await render()
    expect(mount.querySelector('.skillager-install')?.textContent).toBe(
      'uv tool install skillager',
    )
    const button = [...mount.querySelectorAll('button')].find(
      (item) => item.textContent === 'Check again',
    )!
    act(() => button.click())
    await settle()
    expect(invoke.mock.calls.some(([channel]) => channel === 'skillager:connect')).toBe(
      false,
    )
  })
  it('bounds retained detail tabs and admits periodic demand only for visible foreground surfaces', () => {
    let state: Tabs = { tabs: [] }
    for (const row of rows.slice(0, 100))
      state = skillagerTabs(state, { type: 'select', metadata: row })
    expect(state.tabs).toHaveLength(20)
    expect(skillagerObservationDemand(true, true, true, false, true)).toBe(true)
    for (const flags of [
      [false, true, true, true, true],
      [true, false, true, true, true],
      [true, true, false, true, true],
      [true, true, true, false, false],
    ])
      expect(
        skillagerObservationDemand(
          ...(flags as [boolean, boolean, boolean, boolean, boolean]),
        ),
      ).toBe(false)
  })
})
