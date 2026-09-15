// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { localPath } from '../src/shared/host-path'
import type {
  SkillagerMetadata,
  SkillagerMetadataResult,
  SkillagerResult,
  SkillagerWorkspaceExposure,
} from '../src/shared/skillager'
import type { SkillagerProjectObservation } from '../src/shared/skillager-project'
import {
  useSkillagerWorkspace,
  type SkillagerController,
} from '../src/renderer/src/skillager/use-skillager-workspace'
import { skillagerRouterMember } from '../src/renderer/src/skillager/skillager-model'
import {
  eligibleSkillagerUpdate,
  exposureActions,
} from '../src/renderer/src/skillager/skillager-exposure-model'
import { projectState, selection } from './fixtures/skillager-exposure-fixture'

const source: SkillagerMetadata = {
  id: 'lib/demo',
  name: 'Canonical guide',
  description: 'Accepted source',
  trust: 'reviewed',
  source: { type: 'collection', ownership: 'library', libraryId: selection.library.id },
  contentHash: 'a'.repeat(64),
  tags: [],
  matchReasons: [],
  exposure: 'unknown',
}
const native: SkillagerMetadata = {
  ...source,
  id: 'project/native',
  name: 'Native guide',
  trust: 'discovered',
  source: { type: 'project', ownership: 'external' },
  projectSkill: {
    path: localPath('/workspace/.agents/skills/native'),
    agent: 'codex',
    managed: false,
  },
}
const copy: SkillagerWorkspaceExposure = {
  id: 'lib-demo',
  agent: 'codex',
  skillId: source.id,
  sourceLibraryId: selection.library.id,
  target: localPath('/workspace/.agents/skills/lib-demo'),
  mode: 'native',
  status: 'source_update',
  expectedSourceHash: source.contentHash,
}
const router: SkillagerWorkspaceExposure = {
  id: 'router-demo',
  agent: 'claude',
  target: localPath('/workspace/.claude/skills/router-demo'),
  mode: 'router',
  status: 'current',
  router: {
    slug: 'demo',
    kind: 'tag',
    tag: 'Guides',
    skillIds: [source.id],
    memberSources: [{ skillId: source.id, sourceLibraryId: selection.library.id }],
  },
}
const failure = {
  ok: false,
  reason: 'unavailable',
  message: 'Read unavailable.',
} as const
const library = (
  rows = [source],
  checkedAt = 100,
): SkillagerResult<SkillagerMetadataResult> => ({
  ok: true,
  value: { rows, checkedAt, durationMs: 1, exposures: [copy, router] },
})
const project = (
  managed = true,
  checkedAt = 200,
): SkillagerResult<SkillagerProjectObservation> => ({
  ok: true,
  value: {
    rows: [native],
    checkedAt,
    durationMs: 1,
    exposures: managed ? [copy, router] : [],
    requiresLibraryMetadata: managed,
    setupRunning: false,
    status: {
      projectRoot: localPath('/workspace'),
      agent: 'codex',
      status: 'review-needed',
      canProceed: false,
      reviewNeeded: 1,
      lintBlocked: 0,
      working: 'missing',
    },
  },
})
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
let mount: HTMLDivElement, react: Root, current: SkillagerController
const invoke = vi.fn<(channel: string, request: unknown) => Promise<unknown>>()
function Harness({
  visible = true,
  enabled = true,
  path = '/workspace',
}: {
  visible?: boolean
  enabled?: boolean
  path?: string
}) {
  current = useSkillagerWorkspace({
    enabled,
    projectState: projectState(localPath(path)),
    sidebarVisible: visible,
    viewerVisible: visible,
    onActivate: () => {},
    onDisabled: () => {},
  })
  return null
}
async function render(props: Parameters<typeof Harness>[0] = {}) {
  await act(() => Promise.resolve(react.render(<Harness {...props} />)))
}
async function connect(collapsed = false) {
  await render()
  if (collapsed) act(() => current.setLibraryExpanded(false))
  await act(async () => current.connect())
}
const count = (kind: string) =>
  invoke.mock.calls.filter(([channel]) => channel === `skillager:${kind}`).length
beforeEach(() => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  mount = document.createElement('div')
  document.body.append(mount)
  react = createRoot(mount)
  invoke
    .mockReset()
    .mockImplementation((channel) =>
      Promise.resolve(
        channel === 'skillager:probe'
          ? { ok: true, value: { ...selection, probeId: 'probe' } }
          : channel === 'skillager:connect'
            ? { ok: true, value: { ...selection, connectionId: 'connection' } }
            : channel === 'skillager:inventory'
              ? library()
              : channel === 'skillager:project-metadata'
                ? project()
                : channel === 'skillager:search'
                  ? library()
                  : undefined,
      ),
    )
  Object.defineProperty(window, 'hvir', { configurable: true, value: { invoke } })
})
afterEach(() => {
  act(() => react.unmount())
  mount.remove()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

it.each([false, true])(
  'shares one canonical read for project curation with library collapsed=%s',
  async (collapsed) => {
    vi.useFakeTimers()
    await connect(collapsed)
    expect(count('inventory')).toBe(1)
    expect(current.exposures.rows).toEqual([source])
    expect(current.projectRows.map((row) => row.source.ownership)).toEqual([
      'external',
      'library',
      'unknown',
    ])
    expect(eligibleSkillagerUpdate(current.projectRows[1]!)).toBe(true)
    expect(
      skillagerRouterMember(router, source.id, current.canonical).source.ownership,
    ).toBe('library')
    await act(async () => vi.advanceTimersByTimeAsync(60_000))
    expect(count('inventory')).toBe(2)
    expect(count('project-metadata')).toBe(2)
    await act(async () => current.refreshProjectMetadata())
    expect(count('inventory')).toBe(3)
    expect(count('project-metadata')).toBe(3)
  },
)

it('keeps section demand independent and all-agent browsing separate from setup and submitted search context', async () => {
  vi.useFakeTimers()
  const original = invoke.getMockImplementation()!
  invoke.mockImplementation((channel, request) =>
    channel === 'skillager:project-metadata'
      ? Promise.resolve(project(false))
      : original(channel, request),
  )
  await render()
  act(() => current.setProjectExpanded(false))
  await act(async () => current.connect())
  expect(count('project-metadata')).toBe(0)
  expect(count('inventory')).toBe(1)
  act(() => current.setBrowseAgent('claude'))
  expect(current.agent).toBe('codex')
  expect(count('inventory')).toBe(1)
  await act(async () => current.submit('first query'))
  expect(
    invoke.mock.calls.find(([channel]) => channel === 'skillager:search')![1],
  ).toMatchObject({ scope: 'workspace', browseAgent: 'claude', agent: 'codex' })
  act(() => {
    current.setBrowseAgent('all')
    current.setScope('library')
    current.setQuery('unsubmitted draft')
    current.setLibraryExpanded(false)
    current.setProjectExpanded(true)
  })
  expect(current.submittedContext).toEqual({
    scope: 'workspace',
    browseAgent: 'claude',
    view: 'skills',
    includeInstalled: false,
  })
  expect(current.submitted).toBe('first query')
  await act(async () => vi.advanceTimersByTimeAsync(60_000))
  expect(count('inventory')).toBe(1)
  expect(count('project-metadata')).toBe(2)
  expect(count('search')).toBe(1)
})

it.each(['project', 'inventory'] as const)(
  'joins delayed independent snapshots when %s finishes first, retaining open copy/member identity',
  async (first) => {
    const p = deferred<SkillagerResult<SkillagerProjectObservation>>()
    const l = deferred<SkillagerResult<SkillagerMetadataResult>>()
    const original = invoke.getMockImplementation()!
    invoke.mockImplementation((channel, request) =>
      channel === 'skillager:inventory'
        ? l.promise
        : channel === 'skillager:project-metadata'
          ? p.promise
          : original(channel, request),
    )
    await connect()
    await act(async () => {
      if (first === 'project') p.resolve(project())
      else l.resolve(library())
      await (first === 'project' ? p.promise : l.promise)
    })
    if (first === 'project') {
      expect(current.projectRows[1]!.source.ownership).toBe('unknown')
      act(() => current.select(current.projectRows[1]!))
      act(() =>
        current.select(skillagerRouterMember(router, source.id, current.canonical)),
      )
    }
    const tabIds = current.tabs.map((tab) => tab.id)
    await act(async () => {
      if (first === 'project') l.resolve(library())
      else p.resolve(project())
      await (first === 'project' ? l.promise : p.promise)
    })
    expect(current.projectRows[1]).toMatchObject({
      name: source.name,
      trust: 'reviewed',
      workspaceCheckedAt: 100,
      workspaceFreshness: 'fresh',
    })
    expect(current.tabs.map((tab) => tab.id)).toEqual(tabIds)
    expect(
      current.tabs.every(
        (tab) =>
          tab.metadata.name === source.name && tab.metadata.workspaceCheckedAt === 100,
      ),
    ).toBe(true)
    expect(count('inventory')).toBe(1)
  },
)

it('keeps native/target observations usable after library failure and recovers source actions through the same lane', async () => {
  let observed: SkillagerResult<SkillagerMetadataResult> = failure
  const original = invoke.getMockImplementation()!
  invoke.mockImplementation((channel, request) =>
    channel === 'skillager:inventory'
      ? Promise.resolve(observed)
      : original(channel, request),
  )
  await connect(true)
  expect(current.project.result?.ok).toBe(true)
  expect(current.projectRows[0]).toMatchObject({
    trust: 'discovered',
    workspaceFreshness: 'fresh',
  })
  expect(current.projectRows[1]!.source.ownership).toBe('unknown')
  expect(
    exposureActions(current.projectRows[1]!)
      .filter((action) => !action.disabled)
      .map((action) => action.action),
  ).toEqual(['remove'])
  act(() => current.select(current.projectRows[1]!))
  const selected = current.activeId
  observed = library()
  await act(async () => current.refreshProjectMetadata())
  expect(current.activeId).toBe(selected)
  expect(current.active!.metadata.source.ownership).toBe('library')
  expect(eligibleSkillagerUpdate(current.active!.metadata)).toBe(true)
  expect(count('inventory')).toBe(2)
})

it('does not fail or renew canonical source freshness when only project observation fails or refreshes', async () => {
  let observed: SkillagerResult<SkillagerProjectObservation> = failure
  const original = invoke.getMockImplementation()!
  invoke.mockImplementation((channel, request) =>
    channel === 'skillager:project-metadata'
      ? Promise.resolve(observed)
      : original(channel, request),
  )
  await connect()
  expect(current.inventory.result?.ok).toBe(true)
  expect(current.canonical.checkedAt).toBe(100)
  observed = project(true, 500)
  await act(async () => current.project.refresh())
  expect(current.projectRows[1]!.workspaceCheckedAt).toBe(100)
  expect(count('inventory')).toBe(1)
})

it('reuses the 5,000-source index and joined rows across query edits and browsing preferences', async () => {
  const many = Array.from({ length: 5000 }, (_, i) => ({
    ...source,
    id: i ? `lib/source-${i}` : source.id,
  }))
  const original = invoke.getMockImplementation()!
  invoke.mockImplementation((channel, request) =>
    channel === 'skillager:inventory'
      ? Promise.resolve(library(many))
      : original(channel, request),
  )
  await connect()
  const index = current.canonical.rows,
    joined = current.projectRows
  for (const query of ['d', 'de', 'dem', 'demo']) act(() => current.setQuery(query))
  act(() => current.setBrowseAgent('claude'))
  expect(current.canonical.rows).toBe(index)
  expect(current.projectRows).toBe(joined)
  expect(index.size).toBe(5000)
  expect(count('inventory')).toBe(1)
})

it.each([undefined, 'foreign'])(
  'unqualified/foreign copies and members (%s) never force inventory even in an active detail',
  async (sourceLibraryId) => {
    const raw = project(false)
    if (!raw.ok) throw Error('Expected project fixture')
    const unknownRouter = {
      ...router,
      router: {
        ...router.router!,
        memberSources: [{ skillId: source.id, sourceLibraryId }],
      },
    }
    const observation = {
      ...raw,
      value: { ...raw.value, exposures: [{ ...copy, sourceLibraryId }, unknownRouter] },
    }
    const original = invoke.getMockImplementation()!
    invoke.mockImplementation((channel, request) =>
      channel === 'skillager:project-metadata'
        ? Promise.resolve(observation)
        : original(channel, request),
    )
    await connect(true)
    expect(count('inventory')).toBe(0)
    expect(current.projectRows.every((row) => row.workspaceFreshness === 'fresh')).toBe(
      true,
    )
    act(() => current.select(current.projectRows[1]!))
    act(() => current.setProjectExpanded(false))
    expect(count('inventory')).toBe(0)
    act(() =>
      current.select(
        skillagerRouterMember(
          unknownRouter,
          source.id,
          current.canonical,
          current.projectRows[2],
        ),
      ),
    )
    expect(current.active!.metadata.source.ownership).toBe('unknown')
    expect(current.active!.metadata.workspaceFreshness).toBe('fresh')
    await act(async () => current.refreshProjectMetadata())
    expect(count('inventory')).toBe(0)
    expect(current.active!.metadata.workspaceFreshness).toBe('fresh')
  },
)

it('marks only canonical-dependent project metadata checking during the shared library read', async () => {
  await connect(true)
  const pending = deferred<SkillagerResult<SkillagerMetadataResult>>()
  const original = invoke.getMockImplementation()!
  invoke.mockImplementation((channel, request) =>
    channel === 'skillager:inventory' ? pending.promise : original(channel, request),
  )
  const indexed = current.canonical.rows
  let reading!: Promise<void>
  act(() => {
    reading = current.refresh()
  })
  expect(current.canonical.rows).toBe(indexed)
  expect(current.projectRows[0]!.workspaceFreshness).toBe('fresh')
  expect(current.projectRows[1]!.workspaceFreshness).toBe('checking')
  expect(current.projectRows[2]!.workspaceFreshness).toBe('fresh')
  expect(eligibleSkillagerUpdate(current.projectRows[1]!)).toBe(false)
  await act(async () => {
    pending.resolve(failure)
    await reading
  })
  expect(current.projectRows[0]!.workspaceFreshness).toBe('fresh')
  expect(current.projectRows[1]!.source.ownership).toBe('library')
  expect(current.projectRows[1]!.workspaceFreshness).toBe('unavailable')
  expect(eligibleSkillagerUpdate(current.projectRows[1]!)).toBe(false)
  expect(current.projectRows[2]!.workspaceFreshness).toBe('fresh')
})

it.each(['disable', 'workspace'] as const)(
  'rejects both late snapshots after %s revocation',
  async (kind) => {
    const p = deferred<SkillagerResult<SkillagerProjectObservation>>()
    const l = deferred<SkillagerResult<SkillagerMetadataResult>>()
    const original = invoke.getMockImplementation()!
    invoke.mockImplementation((channel, request) =>
      channel === 'skillager:inventory'
        ? l.promise
        : channel === 'skillager:project-metadata'
          ? p.promise
          : original(channel, request),
    )
    await connect()
    invoke.mockImplementation((channel, request) =>
      channel === 'skillager:inventory' || channel === 'skillager:project-metadata'
        ? Promise.resolve(failure)
        : original(channel, request),
    )
    await render(kind === 'disable' ? { enabled: false } : { path: '/other' })
    await act(async () => {
      p.resolve(project())
      l.resolve(library())
      await Promise.all([p.promise, l.promise])
    })
    expect(current.projectRows).toEqual([])
    expect(current.canonical.rows.size).toBe(0)
    expect(current.tabs).toEqual([])
  },
)
