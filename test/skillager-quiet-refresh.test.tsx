// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { asHostId, hostPath, localPath, type HostPath } from '../src/shared/host-path'
import type {
  SkillagerMetadata,
  SkillagerMetadataResult,
  SkillagerResult,
} from '../src/shared/skillager'
import type { SkillagerProjectObservation } from '../src/shared/skillager-project'
import type { SkillagerContentRequest } from '../src/shared/skillager-content'
import { SkillagerSidebar } from '../src/renderer/src/skillager/SkillagerSidebar'
import {
  useSkillagerWorkspace,
  type SkillagerController,
} from '../src/renderer/src/skillager/use-skillager-workspace'
import { eligibleSkillagerUpdate } from '../src/renderer/src/skillager/skillager-exposure-model'
import { projectState, selection } from './fixtures/skillager-exposure-fixture'

const source: SkillagerMetadata = {
  id: 'lib/guide',
  name: 'Guide',
  description: 'Accepted guide',
  trust: 'reviewed',
  source: { type: 'collection', ownership: 'library', libraryId: selection.library.id },
  contentHash: 'a'.repeat(64),
  tags: [],
  matchReasons: [],
  exposure: 'unknown',
}
const copy = {
  id: 'lib-guide',
  agent: 'codex' as const,
  skillId: source.id,
  sourceLibraryId: selection.library.id,
  target: localPath('/workspace/.agents/skills/lib-guide'),
  mode: 'native',
  status: 'source_update',
  expectedSourceHash: source.contentHash,
  currentHash: 'b'.repeat(64),
}
const failure = {
  ok: false,
  reason: 'unavailable',
  message: 'Metadata command failed.',
} as const
const library = (checkedAt = 100): SkillagerMetadataResult => ({
  rows: Array.from({ length: 100 }, (_, i) =>
    i ? { ...source, id: `lib/guide-${i}`, name: `Guide ${i}` } : source,
  ),
  exposures: [copy],
  checkedAt,
  durationMs: 1,
})
const project = (checkedAt = 200): SkillagerProjectObservation => ({
  rows: [],
  exposures: [copy],
  checkedAt,
  durationMs: 1,
  requiresLibraryMetadata: true,
  setupRunning: false,
  status: {
    projectRoot: localPath('/workspace'),
    agent: 'codex',
    status: 'ready',
    canProceed: true,
    reviewNeeded: 0,
    lintBlocked: 0,
    working: 'present',
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
let readLibrary: () => Promise<SkillagerResult<SkillagerMetadataResult>>
let readProject: () => Promise<SkillagerResult<SkillagerProjectObservation>>
const invoke = vi.fn<(channel: string, request: unknown) => Promise<unknown>>()
function Harness({
  enabled = true,
  visible = true,
  root = localPath('/workspace'),
}: {
  enabled?: boolean
  visible?: boolean
  root?: HostPath
}) {
  current = useSkillagerWorkspace({
    enabled,
    projectState: projectState(root),
    sidebarVisible: visible,
    viewerVisible: visible,
    onActivate: () => {},
    onDisabled: () => {},
  })
  return enabled ? (
    <>
      <SkillagerSidebar controller={current} root={root} hidden={!visible} />
      <output>{current.content.state.content?.text}</output>
    </>
  ) : null
}
async function render(props: Parameters<typeof Harness>[0] = {}) {
  await act(() => Promise.resolve(react.render(<Harness {...props} />)))
}
async function connect() {
  await render()
  await act(async () => current.connect())
}
const section = (name: string) =>
  mount.querySelector<HTMLElement>(`section[aria-label="${name}"]`)!
const tree = (name = 'Your library') =>
  section(name).querySelector<HTMLElement>('[role="tree"]')!
const calls = (kind: string) =>
  invoke.mock.calls.filter(([channel]) => channel === `skillager:${kind}`)
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(250)
  mount = document.createElement('div')
  document.body.append(mount)
  react = createRoot(mount)
  readLibrary = () => Promise.resolve({ ok: true, value: library() })
  readProject = () => Promise.resolve({ ok: true, value: project() })
  invoke.mockReset().mockImplementation((channel, request) => {
    if (channel === 'skillager:inventory') return readLibrary()
    if (channel === 'skillager:project-metadata') return readProject()
    if (channel === 'skillager:open-document') {
      const { selection: selected } = request as SkillagerContentRequest
      return Promise.resolve({
        ok: true,
        value: {
          contentId: 'body',
          selection: selected,
          content: {
            entry: 'SKILL.md',
            path: selected.path,
            size: 20,
            text: 'Retained instructions',
          },
        },
      })
    }
    return Promise.resolve(
      channel === 'skillager:probe'
        ? { ok: true, value: { ...selection, probeId: 'probe' } }
        : channel === 'skillager:connect'
          ? { ok: true, value: { ...selection, connectionId: 'connection' } }
          : channel === 'skillager:review'
            ? failure
            : undefined,
    )
  })
  Object.defineProperty(window, 'hvir', { configurable: true, value: { invoke } })
})
afterEach(() => {
  act(() => react.unmount())
  mount.remove()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

it('retains the bounded tree, focus, expanded copies and last check through periodic refresh failure and retry', async () => {
  vi.useFakeTimers()
  await connect()
  const libraryTree = tree(),
    projectTree = tree('In this project')
  act(() => {
    libraryTree.querySelector<HTMLButtonElement>('[role="treeitem"]')!.focus()
    document.activeElement!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
    )
  })
  const focused = document.activeElement,
    labels = libraryTree.textContent
  const observed = current.inventory.observed,
    checkedAt = current.canonical.checkedAt
  const pending = deferred<SkillagerResult<SkillagerMetadataResult>>()
  readLibrary = () => pending.promise
  await act(async () => vi.advanceTimersByTimeAsync(60_000))
  expect(tree()).toBe(libraryTree)
  expect(tree('In this project')).toBe(projectTree)
  expect(libraryTree.textContent).toBe(labels)
  expect(document.activeElement).toBe(focused)
  expect(current.inventory.observed).toBe(observed)
  expect(current.canonical.checkedAt).toBe(checkedAt)
  expect(section('Your library').querySelector('header')?.textContent).toContain(
    'Refreshing…',
  )
  expect(
    section('Your library').querySelector('header button[aria-busy="true"]'),
  ).not.toBeNull()
  expect(eligibleSkillagerUpdate(current.projectRows[0]!)).toBe(false)
  await act(() => Promise.resolve(pending.resolve(failure)))
  expect(tree()).toBe(libraryTree)
  expect(libraryTree.textContent).toBe(labels)
  expect(document.activeElement).toBe(focused)
  expect(current.inventory.observed).toBe(observed)
  expect(
    section('Your library').querySelector('header [role="alert"]')?.getAttribute('title'),
  ).toContain(failure.message)
  expect(section('Your library').querySelector('.skillager-first-skill')).toBeNull()
  expect(current.projectRows[0]).toMatchObject({
    name: 'Guide',
    workspaceFreshness: 'unavailable',
  })
  readLibrary = () => Promise.resolve({ ok: true, value: library(500) })
  await act(() =>
    Promise.resolve(
      (
        section('Your library').querySelector(
          'button[aria-label="Refresh your library"]',
        ) as HTMLButtonElement
      ).click(),
    ),
  )
  expect(tree()).toBe(libraryTree)
  expect(document.activeElement).toBe(focused)
  expect(current.canonical.checkedAt).toBe(500)
  expect(eligibleSkillagerUpdate(current.projectRows[0]!)).toBe(true)
  expect(section('Your library').querySelector('[role="alert"]')).toBeNull()
})

it('keeps a scrolled window and successful setup disclosure through a failed project refresh', async () => {
  await connect()
  const libraryTree = tree(),
    setup = section('In this project').querySelector('details')!
  expect(setup.open).toBe(false)
  act(() => {
    libraryTree.scrollTop = 1500
    libraryTree.dispatchEvent(new Event('scroll'))
  })
  const before = libraryTree.textContent
  const pending = deferred<SkillagerResult<SkillagerProjectObservation>>()
  readProject = () => pending.promise
  let refresh!: Promise<void>
  act(() => {
    refresh = current.project.refresh()
  })
  expect(setup.open).toBe(false)
  expect(current.projectRows[0]!.workspaceFreshness).toBe('checking')
  await act(async () => {
    pending.resolve(failure)
    await refresh
  })
  expect(setup.open).toBe(false)
  expect(setup.textContent).toContain('Ready · Working installed')
  expect(setup.querySelector('button')?.disabled).toBe(true)
  expect(tree()).toBe(libraryTree)
  expect(libraryTree.scrollTop).toBe(1500)
  expect(libraryTree.textContent).toBe(before)
  expect(current.canonical.freshness).toBe('fresh')
  expect(current.projectRows[0]!.workspaceFreshness).toBe('unavailable')
  expect(section('In this project').textContent).toContain('Workspace copy behind')
  await act(() => Promise.resolve(current.select(current.projectRows[0]!)))
  expect(current.active?.metadata.workspaceFreshness).toBe('unavailable')
  expect(eligibleSkillagerUpdate(current.active!.metadata)).toBe(false)
})

it('separates never-checked failure from proven empty and clears retained data on identity revocation', async () => {
  readLibrary = () => Promise.resolve(failure)
  readProject = () => Promise.resolve(failure)
  await connect()
  expect(current.inventory.observed).toBeUndefined()
  expect(current.project.observed).toBeUndefined()
  expect(mount.querySelector('.skillager-first-skill')).toBeNull()
  expect(section('In this project').textContent).not.toContain('No project skills')
  readLibrary = () =>
    Promise.resolve({ ok: true, value: { ...library(), rows: [], exposures: [] } })
  await act(async () => current.refresh())
  expect(mount.querySelector('.skillager-first-skill')).not.toBeNull()
  const pending = deferred<SkillagerResult<SkillagerMetadataResult>>()
  readLibrary = () => pending.promise
  let refresh!: Promise<void>
  act(() => {
    refresh = current.refresh()
  })
  await render({ root: localPath('/different') })
  await act(async () => {
    pending.resolve(failure)
    await refresh
  })
  expect(current.inventory.observed).toBeUndefined()
  expect(mount.querySelector('.skillager-first-skill')).toBeNull()
  await render({ enabled: false })
  expect(current.inventory.observed).toBeUndefined()
  expect(current.project.observed).toBeUndefined()
  expect(mount.textContent).toBe('')
})

it('keeps opened bytes and document-read counts independent of retained metadata and successful replacement', async () => {
  await connect()
  await act(() => Promise.resolve(current.select(current.projectRows[0]!)))
  const content = current.content.state.content
  expect(mount.querySelector('output')?.textContent).toBe('Retained instructions')
  expect(calls('open-document')).toHaveLength(1)
  readLibrary = () => Promise.resolve(failure)
  readProject = () => Promise.resolve(failure)
  await act(async () => current.refreshProjectMetadata())
  expect(current.content.state.content).toBe(content)
  const advanced = { ...source, contentHash: 'c'.repeat(64) }
  readLibrary = () =>
    Promise.resolve({ ok: true, value: { ...library(500), rows: [advanced] } })
  readProject = () =>
    Promise.resolve({
      ok: true,
      value: {
        ...project(500),
        exposures: [{ ...copy, expectedSourceHash: advanced.contentHash }],
      },
    })
  await act(async () => current.refreshProjectMetadata())
  expect(current.active?.metadata.contentHash).toBe(advanced.contentHash)
  expect(current.content.state.content).toBe(content)
  expect(calls('open-document')).toHaveLength(1)
  expect(calls('read-document')).toHaveLength(0)
})

it.each(['library', 'project'] as const)(
  'an open menu cannot enter Update review with stale %s evidence or a changed same-name occurrence',
  async (owner) => {
    await connect()
    const selected = current.projectRows[0]!
    const trigger =
      tree('In this project').querySelector<HTMLButtonElement>('[role="treeitem"]')!
    act(() => current.exposures.menu.open(selected, 'sidebar', trigger))
    expect(
      current.exposures.menu
        .actions(selected)
        .find((action) => action.action === 'review-update')?.disabled,
    ).toBe(false)
    if (owner === 'library') readLibrary = () => Promise.resolve(failure)
    else readProject = () => Promise.resolve(failure)
    await act(async () => current.refreshProjectMetadata())
    expect(current.exposures.menu.request?.metadata).toBe(selected)
    expect(
      current.exposures.menu
        .actions(selected)
        .find((action) => action.action === 'review-update')?.disabled,
    ).toBe(true)
    await act(() => Promise.resolve(current.exposures.menu.select('review-update')))
    expect(calls('review')).toHaveLength(0)
    // Equal bytes and display name do not bind a different canonical identity at this target.
    const replacement = {
      ...source,
      id: owner === 'project' ? 'lib/reassigned' : source.id,
      source: {
        ...source.source,
        libraryId: owner === 'library' ? 'other-library' : source.source.libraryId,
      },
    }
    readLibrary = () =>
      Promise.resolve({ ok: true, value: { ...library(), rows: [replacement] } })
    readProject = () =>
      Promise.resolve({
        ok: true,
        value: {
          ...project(),
          exposures: [
            {
              ...copy,
              skillId: replacement.id,
              sourceLibraryId: replacement.source.libraryId,
            },
          ],
        },
      })
    await act(async () => current.refreshProjectMetadata())
    expect(eligibleSkillagerUpdate(current.projectRows[0]!)).toBe(true)
    await act(() => Promise.resolve(current.exposures.start(selected, 'review-update')))
    expect(calls('review')).toHaveLength(0)
    readProject = () =>
      Promise.resolve({ ok: true, value: { ...project(), exposures: [] } })
    await act(async () => current.project.refresh())
    await act(() => Promise.resolve(current.exposures.start(selected, 'review-update')))
    expect(calls('review')).toHaveLength(0)
  },
)

it('another visible section cannot renew freshness after the owning section collapses', async () => {
  readProject = () =>
    Promise.resolve({
      ok: true,
      value: { ...project(), exposures: [], requiresLibraryMetadata: false },
    })
  await connect()
  act(() => current.setLibraryExpanded(false))
  expect(current.observing).toBe(true)
  expect(current.canonical.freshness).toBe('stale')
  await act(async () => current.project.refresh())
  expect(current.canonical.freshness).toBe('stale')
  act(() => current.setLibraryExpanded(true))
  await act(() => Promise.resolve())
  act(() => current.setProjectExpanded(false))
  expect(current.projectFreshness).toBe('stale')
  await act(async () => current.refresh())
  expect(current.projectFreshness).toBe('stale')
})

it.each(['local', 'remote'] as const)(
  'retains %s copy observations and selected search identity on partial success without granting fresh target authority',
  async (kind) => {
    const root =
      kind === 'local'
        ? localPath('/workspace')
        : hostPath(asHostId('ssh:quiet'), '/workspace')
    const exposure = { ...copy, target: hostPath(root.hostId, copy.target.path) }
    const native: SkillagerMetadata = {
      ...source,
      id: 'project/native',
      name: 'Original',
      source: { type: 'project', ownership: 'external' },
      projectSkill: {
        path: localPath('/workspace/.agents/skills/original'),
        agent: 'codex',
        managed: false,
      },
    }
    readLibrary = () =>
      Promise.resolve({ ok: true, value: { ...library(), exposures: [exposure] } })
    readProject = () =>
      Promise.resolve({
        ok: true,
        value: { ...project(), rows: [native], exposures: [exposure] },
      })
    await render({ root })
    await act(async () => current.connect())
    const projectTree = tree('In this project')
    const installed = current.projectRows.find((row) => row.workspace)!
    const occurrence = {
      id: 'selected-copy',
      kind: 'full' as const,
      path: exposure.target,
      entrypoint: hostPath(root.hostId, `${exposure.target.path}/SKILL.md`),
      agent: exposure.agent,
      exposure,
    }
    const selected = {
      ...installed,
      search: {
        groupId: 'search-group',
        groupOccurrences: 1,
        installed: true,
        canonical: { libraryId: selection.library.id, skillId: source.id },
        occurrence,
        match: {
          occurrence,
          skillId: source.id,
          contentHash: source.contentHash!,
          score: 1,
          reasons: ['name'],
        },
      },
    }
    await act(() => Promise.resolve(current.select(selected)))
    const before = current.active!.metadata.workspaceCheckedAt
    if (kind === 'remote')
      readLibrary = () =>
        Promise.resolve({
          ok: true,
          value: {
            ...library(600),
            rows: [{ ...source, name: 'Fresh source name' }],
            exposures: undefined,
          },
        })
    else
      readProject = () =>
        Promise.resolve({
          ok: true,
          value: {
            ...project(600),
            rows: [{ ...native, name: 'Fresh original name' }],
            exposures: undefined,
            requiresLibraryMetadata: false,
          },
        })
    await act(async () => current.refreshProjectMetadata())
    expect(tree('In this project')).toBe(projectTree)
    expect(current.projectRows.find((row) => row.workspace)).toMatchObject({
      workspace: exposure,
      workspaceFreshness: 'unavailable',
      workspaceCheckedAt: before,
    })
    expect(current.projectFreshness).toBe('unavailable')
    expect(current.canonical.freshness).toBe('fresh')
    expect(current.active?.metadata).toMatchObject({
      workspaceFreshness: 'unavailable',
      workspaceCheckedAt: before,
      search: selected.search,
      contentHash: selected.contentHash,
    })
    expect(eligibleSkillagerUpdate(current.active!.metadata)).toBe(false)
    expect(
      section('In this project')
        .querySelector('header [role="alert"]')
        ?.getAttribute('title'),
    ).toContain('Last observed copies are retained')
    if (kind === 'local')
      expect(current.projectRows.find((row) => row.projectSkill)).toMatchObject({
        name: 'Fresh original name',
        workspaceFreshness: 'fresh',
        workspaceCheckedAt: 600,
      })
    else expect(current.canonical.checkedAt).toBe(600)
    readLibrary = () =>
      Promise.resolve({ ok: true, value: { ...library(700), exposures: [exposure] } })
    readProject = () =>
      Promise.resolve({
        ok: true,
        value: { ...project(700), rows: [native], exposures: [exposure] },
      })
    await act(async () => current.refreshProjectMetadata())
    expect(tree('In this project')).toBe(projectTree)
    expect(current.projectFreshness).toBe('fresh')
    expect(current.active?.metadata.workspaceFreshness).toBe('fresh')
    expect(current.active?.metadata.workspaceCheckedAt).toBe(700)
    expect(current.active?.metadata.search).toEqual(selected.search)
  },
)

it('keeps initially unknown remote copies distinct from a later authoritative empty list', async () => {
  const root = hostPath(asHostId('ssh:quiet'), '/workspace')
  readLibrary = () =>
    Promise.resolve({ ok: true, value: { ...library(), exposures: undefined } })
  await render({ root })
  await act(async () => current.connect())
  expect(current.canonical.freshness).toBe('fresh')
  expect(current.inventory.observedExposures).toBeUndefined()
  expect(current.projectFreshness).toBe('unavailable')
  expect(current.projectRows).toEqual([])
  expect(section('In this project').textContent).not.toContain(
    'No managed project copies',
  )
  expect(current.libraryRows[0]!.exposure).toBe('unknown')
  readLibrary = () =>
    Promise.resolve({ ok: true, value: { ...library(300), exposures: [] } })
  await act(async () => current.refresh())
  expect(current.inventory.observedExposures?.exposures).toEqual([])
  expect(current.projectFreshness).toBe('fresh')
  expect(section('In this project').textContent).toContain('No managed project copies')
})

it('retains only public router counters for the same qualified source during partial inventory success', async () => {
  const root = hostPath(asHostId('ssh:quiet'), '/workspace')
  const router = {
    id: 'tools',
    agent: 'codex' as const,
    mode: 'router',
    status: 'current',
    target: hostPath(root.hostId, '/workspace/.agents/skills/tools'),
    router: {
      slug: 'tools',
      kind: 'tag',
      skillIds: [source.id],
      memberSources: [{ skillId: source.id, sourceLibraryId: selection.library.id }],
    },
  }
  readLibrary = () =>
    Promise.resolve({
      ok: true,
      value: {
        ...library(),
        rows: [{ ...source, workspaceRouterCount: 1 }],
        exposures: [router],
      },
    })
  await render({ root })
  await act(async () => current.connect())
  expect(current.libraryRows[0]!.workspaceRouterCount).toBe(1)
  const before = tree().textContent
  readLibrary = () =>
    Promise.resolve({
      ok: true,
      value: { ...library(500), rows: [source], exposures: undefined },
    })
  await act(async () => current.refresh())
  expect(tree().textContent).toBe(before)
  expect(current.libraryRows[0]).toMatchObject({
    workspaceRouterCount: 1,
    exposure: 'project',
    workspaceFreshness: 'unavailable',
    workspaceCheckedAt: 100,
  })
  readLibrary = () =>
    Promise.resolve({
      ok: true,
      value: {
        ...library(600),
        rows: [{ ...source, source: { ...source.source, libraryId: 'another-library' } }],
        exposures: undefined,
      },
    })
  await act(async () => current.refresh())
  expect(current.libraryRows[0]!.workspaceRouterCount).toBeUndefined()
})

it('selecting a library copy admits its own bounded project check when the project section is collapsed', async () => {
  await connect()
  act(() => current.setProjectExpanded(false))
  expect(current.canonical.freshness).toBe('fresh')
  expect(current.projectFreshness).toBe('stale')
  const row = current.libraryRows[0]!
  const selected = {
    ...row,
    workspace: row.workspaceCopies![0],
    workspaceCopies: undefined,
  }
  expect(eligibleSkillagerUpdate(selected)).toBe(true)
  const action = current.exposures.menu
    .actions(selected)
    .find((item) => item.action === 'review-update')!
  expect(action.disabled).toBe(true)
  expect(action.label).toContain('current copy check required')
  const before = calls('project-metadata').length
  await act(() => Promise.resolve(current.select(selected)))
  expect(calls('project-metadata')).toHaveLength(before + 1)
  expect(current.projectExpanded).toBe(false)
  expect(current.projectFreshness).toBe('fresh')
  expect(
    current.exposures.menu
      .actions(current.active!.metadata)
      .find((item) => item.action === 'review-update')?.disabled,
  ).toBe(false)
})
