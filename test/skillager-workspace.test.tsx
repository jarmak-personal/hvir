// @vitest-environment happy-dom
import { projectState } from './fixtures/skillager-exposure-fixture'
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
  skillagerWorkspaceMetadata,
  skillagerTabs,
  type SkillagerTabs as Tabs,
} from '../src/renderer/src/skillager/skillager-model'
import { asHostId, hostPath, localPath, type HostPath } from '../src/shared/host-path'
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
  connected = true,
  root = localPath('/workspace'),
}: {
  initial?: boolean
  visible?: boolean
  connected?: boolean
  root?: HostPath
}) {
  const [enabled, setEnabled] = useState(initial)
  current = useSkillagerWorkspace({
    enabled,
    projectState: {
      ...projectState(root),
      connectionState: connected ? 'connected' : 'disconnected',
    },
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
  vi.useRealTimers()
})

describe('Skills renderer demand and metadata views', () => {
  it('requeries the submitted search after acceptance and rejects its obsolete in-flight result', async () => {
    await render()
    await connect()
    act(() => current.select(rows[0]!))
    const tab = current.active!
    const original = invoke.getMockImplementation()!
    let oldSearch!: (value: unknown) => void
    let searches = 0
    invoke.mockImplementation((channel, request) => {
      if (channel === 'skillager:review')
        return Promise.resolve({
          ok: true,
          value: {
            reviewId: 'review',
            skillId: tab.metadata.id,
            root: localPath('/library/skills/skill-0'),
            hash: 'a'.repeat(64),
            canAccept: true,
            files: [],
            findings: [],
            scanRisk: 'low',
            lintStatus: 'ok',
            history: { available: false, versions: [] },
          },
        })
      if (channel === 'skillager:accept-review')
        return Promise.resolve({
          ok: true,
          value: { status: 'accepted', hash: 'a'.repeat(64) },
        })
      if (channel === 'skillager:search') {
        searches++
        return searches === 1
          ? new Promise((resolve) => {
              oldSearch = resolve
            })
          : Promise.resolve(metadata([rows[1]!]))
      }
      return original(channel, request)
    })
    await act(async () => current.reviews.review(tab))
    act(() => current.setQuery('needle'))
    let pending!: Promise<void>
    act(() => {
      pending = current.submit()
    })
    act(() => current.setQuery('unfinished next query'))
    await act(async () => current.reviews.accept(tab.id))
    await settle()
    expect(searches).toBe(2)
    expect(
      invoke.mock.calls.filter(([channel]) => channel === 'skillager:search').at(-1)?.[1],
    ).toMatchObject({ query: 'needle' })
    await act(async () => {
      oldSearch(metadata([rows[2]!]))
      await pending
    })
    expect(current.query).toBe('unfinished next query')
    expect(current.search.result).toMatchObject({ ok: true, value: { rows: [rows[1]!] } })
    expect(
      invoke.mock.calls.some(
        ([channel, request]) =>
          channel === 'skillager:cancel' &&
          (request as { kind?: string }).kind === 'search',
      ),
    ).toBe(true)
  })
  it('observes badge arrival on the one 60-second foreground schedule and stops hidden/background/disabled demand', async () => {
    vi.useFakeTimers()
    const original = invoke.getMockImplementation()!
    const accepted = { ...rows[1]!, contentHash: 'b'.repeat(64) }
    const exposure = {
      id: 'lib-skill-1',
      skillId: accepted.id,
      mode: 'stub',
      status: 'current',
      target: localPath('/workspace/.claude/skills/lib-skill-1'),
      expectedSourceHash: 'b'.repeat(64),
    }
    let drift = 'current'
    invoke.mockImplementation((channel, request) =>
      channel === 'skillager:inventory'
        ? Promise.resolve({
            ok: true,
            value: {
              rows: [accepted],
              exposures: [{ ...exposure, status: drift }],
              checkedAt: Date.now(),
              durationMs: 1,
            },
          })
        : original(channel, request),
    )
    await render()
    await connect()
    const count = () =>
      invoke.mock.calls.filter(([channel]) => channel === 'skillager:inventory').length
    const initial = count()
    act(() =>
      current.select(
        skillagerWorkspaceMetadata(
          current.inventory.result!.ok
            ? current.inventory.result!.value
            : { rows: [], checkedAt: 1, durationMs: 1 },
        )[0]!,
      ),
    )
    drift = 'source_update'
    await act(async () => vi.advanceTimersByTimeAsync(59_999))
    expect(count()).toBe(initial)
    await act(async () => vi.advanceTimersByTimeAsync(1))
    expect(count()).toBe(initial + 1)
    expect(mount.querySelector('.skillager-details')?.textContent).toContain(
      'Workspace copy behind',
    )
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    act(() => {
      window.dispatchEvent(new Event('blur'))
    })
    await act(async () => vi.advanceTimersByTimeAsync(120_000))
    expect(count()).toBe(initial + 1)
    expect(current.active?.metadata.workspaceFreshness).toBe('stale')
    expect(mount.querySelector('.skillager-sidebar')?.textContent).not.toContain(
      'Workspace copy behind',
    )
    act(() => (mount.querySelector('.skillager-row') as HTMLButtonElement).click())
    expect(current.active?.metadata.workspaceFreshness).toBe('stale')
    act(() =>
      (
        mount.querySelectorAll('.skillager-perspectives button')[1] as HTMLButtonElement
      ).click(),
    )
    expect(mount.querySelector('.skillager-sidebar')?.textContent).not.toContain(
      'Workspace copy behind',
    )
    act(() => (mount.querySelector('.skillager-row') as HTMLButtonElement).click())
    expect(current.active?.metadata.workspaceFreshness).toBe('stale')
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    await settle()
    expect(count()).toBe(initial + 2)
    await render({ connected: false })
    const disconnectedReads = count()
    expect(disconnectedReads).toBe(initial + 3)
    await act(async () => vi.advanceTimersByTimeAsync(120_000))
    expect(count()).toBe(disconnectedReads)
    expect(current.active?.metadata.workspaceFreshness).toBe('stale')
    expect(mount.querySelector('.skillager-sidebar')?.textContent).not.toContain(
      'Workspace copy behind',
    )
    act(() => (mount.querySelector('.skillager-row') as HTMLButtonElement).click())
    expect(current.active?.metadata.workspaceFreshness).toBe('stale')
    await act(async () => current.refresh())
    expect(count()).toBe(disconnectedReads + 1)
    await render({ connected: true })
    await settle()
    expect(count()).toBe(disconnectedReads + 2)
    act(() => current.deactivate())
    await render({ visible: false })
    await act(async () => vi.advanceTimersByTimeAsync(120_000))
    expect(count()).toBe(disconnectedReads + 2)
    await render({ visible: true })
    await settle()
    const visible = count()
    act(() =>
      (mount.querySelector('.skillager-settings input') as HTMLInputElement).click(),
    )
    await settle()
    await act(async () => vi.advanceTimersByTimeAsync(120_000))
    expect(count()).toBe(visible)
    expect(current.tabs).toEqual([])
    expect(mount.textContent).not.toContain('Workspace copy')
    expect(
      invoke.mock.calls.some(([channel]) =>
        [
          'skillager:accept-review',
          'skillager:preview-exposure',
          'skillager:apply-exposure',
        ].includes(channel),
      ),
    ).toBe(false)
  })
  it('acceptance invalidates an older workspace read before it can restore obsolete badge state', async () => {
    const original = invoke.getMockImplementation()!
    const row = { ...rows[0]!, contentHash: 'b'.repeat(64), trust: 'reviewed' as const }
    const observed = (status: string) => ({
      ok: true as const,
      value: {
        rows: [row],
        checkedAt: Date.now(),
        durationMs: 1,
        exposures: [
          {
            id: 'lib-skill-0',
            skillId: row.id,
            target: localPath('/workspace/.agents/skills/lib-skill-0'),
            mode: 'native',
            status,
            expectedSourceHash: row.contentHash,
          },
        ],
      },
    })
    let count = 0,
      finish!: (value: unknown) => void
    invoke.mockImplementation((channel, request) => {
      if (channel === 'skillager:inventory')
        return ++count === 2
          ? new Promise((resolve) => {
              finish = resolve
            })
          : Promise.resolve(observed(count === 1 ? 'current' : 'source_update'))
      if (channel === 'skillager:review')
        return Promise.resolve({
          ok: true,
          value: {
            reviewId: 'review',
            skillId: row.id,
            root: localPath('/library/skills/skill-0'),
            hash: row.contentHash,
            canAccept: true,
            files: [],
            findings: [],
            scanRisk: 'low',
            lintStatus: 'ok',
            history: { available: false, versions: [] },
          },
        })
      if (channel === 'skillager:accept-review')
        return Promise.resolve({
          ok: true,
          value: { status: 'accepted', hash: row.contentHash },
        })
      return original(channel, request)
    })
    await render()
    await connect()
    act(() => current.select(row))
    await act(async () => current.reviews.review(current.active!))
    let old!: Promise<void>
    act(() => {
      old = current.refresh()
    })
    expect(current.active?.metadata.workspaceFreshness).toBe('checking')
    await act(async () => current.reviews.accept(current.activeId!))
    await settle()
    expect(current.active?.metadata.workspace?.status).toBe('source_update')
    await act(async () => {
      finish(observed('current'))
      await old
    })
    expect(current.active?.metadata.workspace?.status).toBe('source_update')
    expect(current.active?.metadata.workspaceFreshness).toBe('fresh')
    invoke.mockImplementation((channel, request) =>
      channel === 'skillager:inventory'
        ? Promise.resolve({
            ok: false,
            reason: 'unavailable',
            message: 'Unavailable source',
          })
        : original(channel, request),
    )
    await act(async () => current.refresh())
    expect(current.active?.metadata.workspaceFreshness).toBe('unavailable')
    expect(mount.querySelector('.skillager-details')?.textContent).toContain(
      'stale / unavailable',
    )
    expect(mount.querySelector('.skillager-details')?.textContent).not.toContain(
      'Workspace copy behind',
    )
  })
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
  it('cancels submitted search on host loss and rejects its late result', async () => {
    await render()
    await connect()
    const original = invoke.getMockImplementation()!
    let finish!: (value: unknown) => void
    invoke.mockImplementation((channel, request) =>
      channel === 'skillager:search'
        ? new Promise((resolve) => {
            finish = resolve
          })
        : original(channel, request),
    )
    let pending!: Promise<void>
    act(() => {
      pending = current.submit('needle')
    })
    const request = invoke.mock.calls.find(
      ([channel]) => channel === 'skillager:search',
    )![1] as { requestId: number }
    await render({ connected: false })
    const cancellation = invoke.mock.calls
      .filter(
        ([channel, value]) =>
          channel === 'skillager:cancel' && (value as { kind: string }).kind === 'search',
      )
      .at(-1)![1] as { requestId: number }
    expect(cancellation.requestId).toBeGreaterThan(request.requestId)
    expect(current.submitted).toBe('')
    expect(current.search.loading).toBe(false)
    await act(async () => {
      finish(metadata([{ ...rows[0]!, name: 'Late after host loss' }]))
      await pending
    })
    expect(current.search.result).toBeUndefined()
    expect(mount.textContent).not.toContain('Late after host loss')
    const searches = invoke.mock.calls.filter(
      ([channel]) => channel === 'skillager:search',
    ).length
    invoke.mockImplementation(original)
    await act(async () => current.submit('fresh Personal search'))
    expect(
      invoke.mock.calls.filter(([channel]) => channel === 'skillager:search'),
    ).toHaveLength(searches + 1)
    expect(current.search.result).toMatchObject({
      ok: true,
      value: { rows: [rows[4999]!] },
    })
  })
  it('reads Personal metadata for a disconnected SSH workspace without periodic demand or destination actions', async () => {
    vi.useFakeTimers()
    const remote = hostPath(asHostId('ssh:fixture'), '/workspace')
    const original = invoke.getMockImplementation()!
    invoke.mockImplementation((channel, request) =>
      channel === 'skillager:inventory'
        ? Promise.resolve({
            ok: true,
            value: { rows: [rows[0]!], checkedAt: 1, durationMs: 1 },
          })
        : original(channel, request),
    )
    await render({ root: remote, connected: false })
    await connect()
    expect(mount.querySelector('.skillager-row')?.textContent).toContain('Skill 0')
    expect(current.observing).toBe(false)
    const reads = invoke.mock.calls.filter(
      ([channel]) => channel === 'skillager:inventory',
    ).length
    await act(async () => vi.advanceTimersByTimeAsync(180_000))
    expect(
      invoke.mock.calls.filter(([channel]) => channel === 'skillager:inventory'),
    ).toHaveLength(reads)
    await act(async () => current.refresh())
    expect(
      invoke.mock.calls.filter(([channel]) => channel === 'skillager:inventory'),
    ).toHaveLength(reads + 1)
    act(() => current.exposures.start(rows[0]!, 'add'))
    expect(current.exposures.state).toBeUndefined()
    expect(
      mount.querySelector<HTMLOptionElement>('option[value="workspace"]')?.disabled,
    ).toBe(true)
  })
  it.each(['current', 'removed'])(
    'shows %s remote state with retained cleanup and carries it into details',
    async (status) => {
      const remote = hostPath(asHostId('ssh:fixture'), '/workspace')
      const original = invoke.getMockImplementation()!
      invoke.mockImplementation((channel, request) =>
        channel === 'skillager:inventory'
          ? Promise.resolve({
              ok: true,
              value: {
                rows: [{ ...rows[0]!, trust: 'reviewed' }],
                checkedAt: 1,
                durationMs: 1,
                exposures: [
                  {
                    id: 'lib-skill-0',
                    skillId: rows[0]!.id,
                    mode: 'native',
                    status,
                    reconciliation: 'cleanup-pending',
                    target: hostPath(
                      remote.hostId,
                      '/workspace/.agents/skills/lib-skill-0',
                    ),
                  },
                ],
              },
            })
          : original(channel, request),
      )
      await render({ root: remote })
      await connect()
      act(() =>
        [...mount.querySelectorAll('button')]
          .find((item) => item.textContent === 'This workspace')!
          .click(),
      )
      expect(mount.querySelector('.skillager-row')?.textContent).toContain(
        `${status === 'current' ? 'Current' : 'Workspace copy removed'} · Cleanup retained`,
      )
      act(() => mount.querySelector<HTMLButtonElement>('.skillager-row')!.click())
      expect(current.active?.metadata.workspace?.reconciliation).toBe('cleanup-pending')
      expect(mount.querySelector('.skillager-details')?.textContent).toContain(
        'Cleanup retained',
      )
    },
  )
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
