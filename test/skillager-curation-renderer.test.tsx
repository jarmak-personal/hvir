// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SkillagerExposureDialog } from '../src/renderer/src/skillager/SkillagerExposureDialog'
import {
  SkillagerActions,
  SkillagerActionsMenu,
} from '../src/renderer/src/skillager/SkillagerActions'
import {
  useSkillagerExposure,
  type SkillagerExposureController,
} from '../src/renderer/src/skillager/use-skillager-exposure'
import { parsePlanPreview } from '../src/main/skillager/skillager-exposure-plan-contract'
import { localPath } from '../src/shared/host-path'
import type {
  SkillagerMetadata,
  SkillagerWorkspaceExposure,
} from '../src/shared/skillager'
import type { SkillagerPlanPreview } from '../src/shared/skillager-exposure-plan'
import { projectState } from './fixtures/skillager-exposure-fixture'
import {
  planRequest,
  planResponse,
  planSelection,
} from './fixtures/skillager-plan-fixture'
import {
  syncContext,
  syncLibrary,
  syncSelection,
  syncStatus,
} from './fixtures/skillager-sync-fixture'

const native: SkillagerMetadata = {
  id: 'project/example',
  name: 'Original',
  description: '',
  trust: 'reviewed',
  source: { type: 'project', ownership: 'external' },
  tags: [],
  matchReasons: [],
  exposure: 'native',
  projectSkill: {
    path: localPath('/workspace/.skills/example'),
    agent: 'codex',
    managed: false,
  },
}
const canonical: SkillagerMetadata = {
  ...native,
  id: 'lib/example',
  name: 'Example',
  source: { type: 'collection', ownership: 'library', libraryId: syncLibrary.id },
  projectSkill: undefined,
}
const second = { ...canonical, id: 'lib/second', name: 'Second' }
const copy: SkillagerWorkspaceExposure = {
  id: 'lib-example',
  skillId: canonical.id,
  sourceLibraryId: syncLibrary.id,
  agent: 'codex',
  mode: 'native',
  status: 'current',
  target: localPath('/workspace/.agents/skills/lib-example'),
}
const direct = { ...canonical, workspace: copy }
const router: SkillagerWorkspaceExposure = {
  id: 'router-guidance',
  agent: 'codex',
  mode: 'router',
  status: 'current',
  target: localPath('/workspace/.agents/skills/router-guidance'),
  router: {
    kind: 'tag',
    slug: 'router-guidance',
    tag: 'guidance',
    skillIds: ['lib/example', 'lib/missing'],
    memberSources: [
      { skillId: 'lib/example', sourceLibraryId: syncLibrary.id },
      { skillId: 'lib/missing', sourceLibraryId: syncLibrary.id },
    ],
  },
}
const routerRow = {
  ...native,
  id: 'router/guidance',
  name: 'Guidance',
  projectSkill: undefined,
  workspace: router,
}
const invoke = vi.fn<(channel: string, request: unknown) => Promise<unknown>>()
let controller: SkillagerExposureController, root: Root, mount: HTMLDivElement
const completed = vi.fn(),
  reveal = vi.fn<(path: unknown, signal: AbortSignal) => Promise<void>>(),
  update = vi.fn()
const preview = (): SkillagerPlanPreview => ({
  ...parsePlanPreview(planResponse(), 0, planSelection, planRequest).detail,
  previewId: 'plan-preview',
})
async function settle(action: () => unknown) {
  await act(async () => {
    await action()
  })
}
function Harness({
  visible = true,
  connection = 'connection',
  workspace = syncContext,
  detail = 'detail',
} = {}) {
  controller = useSkillagerExposure({
    connection: { ...syncSelection, connectionId: connection },
    projectState: projectState(workspace),
    agent: 'claude',
    detailId: detail,
    visible,
    sidebarVisible: visible,
    detailsVisible: visible,
    rows: [canonical, second],
    projectRows: [native, direct, routerRow],
    onCompleted: completed,
    onFiles: reveal,
    onUpdateReview: update,
  })
  return (
    <>
      <SkillagerActions metadata={native} controller={controller.menu} surface="sidebar">
        <button className="native-row">
          <strong>Original row</strong>
        </button>
      </SkillagerActions>
      <SkillagerActions metadata={native} controller={controller.menu} surface="details">
        <button className="native-details">Original details</button>
      </SkillagerActions>
      <SkillagerActionsMenu controller={controller.menu} />
      <SkillagerExposureDialog controller={controller} />
    </>
  )
}
const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent === label,
  )!
const input = (label: string) =>
  document.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!
const checkbox = (label: string) =>
  [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(
    (item) => item.closest('label')!.textContent.includes(label),
  )!
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  Object.assign(window, { hvir: { invoke } })
  invoke.mockReset()
  completed.mockReset()
  reveal.mockReset()
  update.mockReset()
  invoke.mockImplementation((channel) =>
    Promise.resolve(
      channel === 'skillager:exposure-lineage'
        ? { ok: true, value: syncStatus() }
        : channel === 'skillager:preview-exposure'
          ? { ok: true, value: preview() }
          : { ok: true },
    ),
  )
  reveal.mockResolvedValue(undefined)
  mount = document.createElement('div')
  document.body.append(mount)
  root = createRoot(mount)
  await settle(() => root.render(<Harness />))
})
afterEach(async () => {
  await settle(() => root.unmount())
  mount.remove()
})

it.each(['Cancel', 'Escape', 'disable', 'workspace', 'reconnect', 'selection'] as const)(
  'cancels read-only native preparation through %s and drops late public lineage',
  async (event) => {
    let finish!: (value: unknown) => void
    invoke.mockImplementation((channel) =>
      Promise.resolve(
        channel === 'skillager:exposure-lineage'
          ? new Promise((resolve) => {
              finish = resolve
            })
          : { ok: true },
      ),
    )
    await settle(() => controller.start(native, 'stub'))
    expect(controller.state?.agent).toBe('codex')
    expect(document.querySelector('[role="status"]')?.textContent).toContain('Preparing')
    expect(button('Cancel').disabled).toBe(false)
    if (event === 'Cancel') await settle(() => button('Cancel').click())
    if (event === 'Escape')
      await settle(() =>
        document.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
        ),
      )
    if (event === 'disable') await settle(() => root.render(<Harness visible={false} />))
    if (event === 'workspace')
      await settle(() => root.render(<Harness workspace={localPath('/other')} />))
    if (event === 'reconnect')
      await settle(() => root.render(<Harness connection="new" />))
    if (event === 'selection') await settle(() => root.render(<Harness detail="other" />))
    expect(invoke).toHaveBeenCalledWith('skillager:cancel-exposure', { requestId: 1 })
    await settle(() => finish({ ok: true, value: syncStatus() }))
    expect(controller.state).toBeUndefined()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(
      invoke.mock.calls.filter(([channel]) => channel === 'skillager:exposure-lineage'),
    ).toHaveLength(1)
    expect(
      invoke.mock.calls.some(([channel]) =>
        ['skillager:sync-approved', 'skillager:preview-exposure'].includes(channel),
      ),
    ).toBe(false)
  },
)
it('gives native rows and details the same mouse and keyboard lifecycle menu', async () => {
  await settle(() =>
    document
      .querySelector('.native-row strong')!
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })),
  )
  const labels = [...document.querySelectorAll('[role="menuitem"]')].map(
    (item) => item.textContent,
  )
  expect(labels).toContain('Stub…')
  expect(labels).toContain('Remove in Files…')
  await settle(() =>
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    ),
  )
  expect(document.activeElement).toBe(document.querySelector('.native-row'))
  await settle(() =>
    document
      .querySelector('.native-details')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true })),
  )
  expect(
    [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent),
  ).toEqual(labels)
})
it('allows a missing library member to depart with Remove without approval or restoring its body', async () => {
  await settle(() => controller.start(routerRow, 'edit-members'))
  expect(checkbox('lib/missing').checked).toBe(true)
  await settle(() => checkbox('lib/missing').click())
  const departure = document.querySelector<HTMLSelectElement>(
    '[aria-label="Departure for lib/missing"]',
  )!
  expect(departure.value).toBe('')
  await settle(() => {
    departure.value = 'remove'
    departure.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await settle(() => button('Preview changes').click())
  expect(
    invoke.mock.calls.find(([channel]) => channel === 'skillager:preview-exposure')?.[1],
  ).toMatchObject({
    action: 'plan',
    plan: {
      action: 'set-members',
      members: ['lib/example'],
      departures: [{ skill_id: 'lib/missing', mode: 'remove' }],
      replace: [],
    },
  })
  expect(invoke.mock.calls.some(([channel]) => channel === 'skillager:review')).toBe(
    false,
  )
})
it('deselecting a group member clears its visible replacement and permits the remaining selected member preview', async () => {
  await settle(() => controller.start(direct, 'group'))
  await settle(() => {
    input('New router name').value = 'New guidance'
    input('New router name').dispatchEvent(new Event('input', { bubbles: true }))
  })
  // React's controlled input events are exercised elsewhere; choose the same feature-owned state here.
  await settle(() =>
    controller.choose({
      curation: { ...controller.state!.curation!, name: 'New guidance' },
    }),
  )
  await settle(() => checkbox('Second').click())
  await settle(() => checkbox('Example').click())
  expect(controller.state!.curation!.replacements).toEqual([])
  await settle(() => button('Preview changes').click())
  expect(
    invoke.mock.calls.find(([channel]) => channel === 'skillager:preview-exposure')?.[1],
  ).toMatchObject({
    plan: {
      action: 'group',
      members: ['lib/second'],
      replace: [],
    },
  })
})
it('renders complete source/effect evidence and every partial recovery result without another confirmation', async () => {
  await settle(() => controller.start(canonical, 'group'))
  await settle(() =>
    controller.choose({ curation: { ...controller.state!.curation!, name: 'Guidance' } }),
  )
  await settle(() => button('Preview changes').click())
  expect(document.body.textContent).toContain('Selected source versions')
  expect(document.body.textContent).toContain('Complete project effects · 2 targets')
  expect(document.body.textContent).toContain('skillager.materialized.yaml')
  invoke.mockResolvedValueOnce({
    ok: true,
    value: {
      kind: 'plan',
      status: 'partial',
      targets: [
        {
          id: 'one',
          path: localPath('/workspace/.skillager/tags.json'),
          status: 'rolled_back',
          observedHash: null,
        },
        {
          id: 'two',
          path: router.target,
          status: 'recovery_required',
          observedHash: null,
          recoveryPath: localPath('/workspace/.stage/previous'),
          reason: 'cleanup-failed',
        },
      ],
    },
  })
  await settle(() => button('Confirm exact changes').click())
  expect(
    document.querySelector('[aria-label="Actual project outcomes"]')?.textContent,
  ).toContain('rolled back')
  expect(document.body.textContent).toContain('recovery required')
  expect(document.body.textContent).toContain('/workspace/.stage/previous')
  expect(button('Confirm exact changes')).toBeUndefined()
  expect(completed).toHaveBeenCalledTimes(1)
})
it('allows Cancel/Escape during the actual preview request and releases a late confirmation', async () => {
  await settle(() => controller.start(canonical, 'group'))
  await settle(() =>
    controller.choose({ curation: { ...controller.state!.curation!, name: 'Guidance' } }),
  )
  let finish!: (value: unknown) => void
  invoke.mockImplementation((channel) =>
    Promise.resolve(
      channel === 'skillager:preview-exposure'
        ? new Promise((resolve) => {
            finish = resolve
          })
        : { ok: true },
    ),
  )
  await settle(() => button('Preview changes').click())
  expect(button('Cancel').disabled).toBe(false)
  await settle(() =>
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    ),
  )
  await settle(() => finish({ ok: true, value: preview() }))
  expect(controller.state).toBeUndefined()
  expect(invoke).toHaveBeenCalledWith('skillager:release-exposure', {
    previewId: 'plan-preview',
  })
})
it('aborts a pending Files handoff when its originating action changes and never restores a late dialog', async () => {
  let finish!: () => void, signal!: AbortSignal
  reveal.mockImplementation((_path, at) => {
    signal = at
    return new Promise((resolve) => {
      finish = resolve
    })
  })
  await settle(() => controller.start({ ...native, trust: 'blocked' }, 'files'))
  expect(reveal).toHaveBeenCalledWith(native.projectSkill!.path, expect.any(AbortSignal))
  await settle(() => controller.close())
  expect(signal.aborted).toBe(true)
  await settle(() => finish())
  expect(controller.state).toBeUndefined()
  expect(
    invoke.mock.calls.some(
      ([channel]) =>
        channel === 'skillager:preview-exposure' ||
        channel === 'skillager:exposure-lineage',
    ),
  ).toBe(false)
})

it('does not route a foreign-library native-looking row into conversion or Files', async () => {
  const foreign = {
    ...native,
    source: { type: 'collection', ownership: 'library' as const, libraryId: 'foreign' },
  }
  invoke.mockClear()
  await settle(() => controller.start(foreign, 'stub'))
  await settle(() => controller.start(foreign, 'files'))
  expect(controller.state).toBeUndefined()
  expect(invoke).not.toHaveBeenCalled()
  expect(reveal).not.toHaveBeenCalled()
})
it.each(['original', 'managed', 'canonical'] as const)(
  'renders an actionable Files fallback only for an eligible failed %s action',
  async (kind) => {
    const row =
      kind === 'original'
        ? native
        : kind === 'managed'
          ? { ...routerRow, projectSkill: { ...native.projectSkill!, managed: true } }
          : { ...canonical, projectSkill: { ...native.projectSkill!, managed: true } }
    await settle(() =>
      controller.start(
        row,
        kind === 'original' ? 'stub' : kind === 'managed' ? 'remove' : 'group',
      ),
    )
    invoke.mockResolvedValueOnce({
      ok: false,
      reason: 'review-refused',
      message: 'Fixture refusal',
    })
    if (kind === 'canonical')
      await settle(() =>
        controller.choose({
          curation: { ...controller.state!.curation!, name: 'Guidance' },
        }),
      )
    await settle(() => button('Preview changes').click())
    expect(controller.state?.failed).toBe(true)
    const fallback = [
      ...document.querySelectorAll<HTMLButtonElement>(
        '.skillager-exposure-dialog button',
      ),
    ].find((item) => item.textContent === 'Remove in Files…')
    expect(Boolean(fallback)).toBe(kind === 'original')
    if (fallback) {
      await settle(() => fallback.click())
      expect(reveal).toHaveBeenCalledWith(
        native.projectSkill!.path,
        expect.any(AbortSignal),
      )
      expect(controller.state).toBeUndefined()
    }
  },
)
